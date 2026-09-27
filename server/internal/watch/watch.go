// Package watch keeps the index in step with the vault directory, whoever
// changes it: this daemon, Obsidian on the same machine, or a sync client
// (Obsidian Sync, Syncthing, git) delivering edits made on a phone.
//
// fsnotify delivers per-directory events; new folders are added to the watch
// set as they appear. Events are debounced and coalesced, then fanned out to
// SSE subscribers so every open browser tab refreshes live. A periodic full
// rescan repairs anything the kernel queue dropped (IN_Q_OVERFLOW).
package watch

import (
	"context"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/lucagiftzek/dsh-note-keeper/server/internal/index"
	"github.com/lucagiftzek/dsh-note-keeper/server/internal/vault"
)

// MaxIndexedNote bounds how much of one note is read for indexing.
const MaxIndexedNote = 8 << 20

// Event is what subscribers receive.
type Event struct {
	Type  string   `json:"type"` // change | rescan
	Paths []string `json:"paths"`
	At    int64    `json:"at"`
}

// Hub fans events out to subscribers (SSE connections).
type Hub struct {
	mu   sync.Mutex
	subs map[chan Event]struct{}
}

// NewHub returns an empty hub.
func NewHub() *Hub { return &Hub{subs: map[chan Event]struct{}{}} }

// Subscribe registers a buffered channel; call the returned func to leave.
func (h *Hub) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 64)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		if _, ok := h.subs[ch]; ok {
			delete(h.subs, ch)
			close(ch)
		}
		h.mu.Unlock()
	}
}

// Publish delivers an event; slow subscribers drop it rather than block.
func (h *Hub) Publish(e Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- e:
		default:
		}
	}
}

// Subscribers returns the live subscriber count.
func (h *Hub) Subscribers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

// Watcher binds a vault, its index and the hub.
type Watcher struct {
	V   *vault.Vault
	Ix  *index.Index
	Hub *Hub

	fw       *fsnotify.Watcher
	mu       sync.Mutex
	pending  map[string]struct{}
	timer    *time.Timer
	Debounce time.Duration
	Rescan   time.Duration
}

// New builds a watcher (call Scan once, then Run).
func New(v *vault.Vault, ix *index.Index, hub *Hub) *Watcher {
	return &Watcher{V: v, Ix: ix, Hub: hub, pending: map[string]struct{}{}, Debounce: 200 * time.Millisecond, Rescan: 5 * time.Minute}
}

// Scan reconciles the index with the disk: new/changed files are parsed,
// vanished ones removed. It returns the paths that changed.
func (w *Watcher) Scan() []string {
	entries, err := w.V.List()
	if err != nil {
		log.Printf("scan: %v", err)
	}
	seen := map[string]bool{}
	var changed []string
	for _, e := range entries {
		if e.Dir {
			continue
		}
		seen[e.Path] = true
		if d, ok := w.Ix.Get(e.Path); ok && d.Mtime == e.Mtime && d.Size == e.Size {
			continue
		}
		w.indexFile(e.Path, e.Mtime, e.Size)
		changed = append(changed, e.Path)
	}
	for _, p := range w.Ix.Paths() {
		if !seen[p] {
			w.Ix.Remove(p)
			changed = append(changed, p)
		}
	}
	sort.Strings(changed)
	return changed
}

func (w *Watcher) indexFile(rel string, mtime, size int64) {
	var content []byte
	if index.IsNote(rel) {
		b, m, err := w.V.Read(rel, MaxIndexedNote)
		if err != nil {
			if err == vault.ErrNotFound {
				w.Ix.Remove(rel)
			}
			return
		}
		content, mtime = b, m
	}
	w.Ix.Update(rel, content, mtime, size)
}

// Touch reindexes one path now (used after the API's own writes so a read
// that follows a write is always consistent) and notifies subscribers.
func (w *Watcher) Touch(rels ...string) {
	for _, rel := range rels {
		w.refresh(rel)
	}
	w.Hub.Publish(Event{Type: "change", Paths: rels, At: time.Now().UnixMilli()})
}

// refresh reindexes a path that may be a file, a folder, or gone.
func (w *Watcher) refresh(rel string) {
	if rel == "" || vault.Hidden(rel) {
		return
	}
	abs := filepath.Join(w.V.Root(), filepath.FromSlash(rel))
	fi, err := os.Stat(abs)
	switch {
	case err != nil:
		w.Ix.Remove(rel)
	case fi.IsDir():
		w.addTree(abs)
		_ = filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if strings.HasPrefix(d.Name(), ".") {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if !d.IsDir() {
				if r, ok := w.V.Rel(p); ok {
					if i, err := d.Info(); err == nil {
						w.indexFile(r, i.ModTime().UnixMilli(), i.Size())
					}
				}
			}
			return nil
		})
	default:
		w.indexFile(rel, fi.ModTime().UnixMilli(), fi.Size())
	}
}

// addTree adds a folder and its visible sub-folders to the fsnotify set.
func (w *Watcher) addTree(root string) {
	if w.fw == nil {
		return
	}
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		if p != w.V.Root() && strings.HasPrefix(d.Name(), ".") {
			return filepath.SkipDir
		}
		if err := w.fw.Add(p); err != nil {
			log.Printf("watch add %s: %v", p, err)
		}
		return nil
	})
}

// Run starts watching until ctx is cancelled.
func (w *Watcher) Run(ctx context.Context) error {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	w.fw = fw
	defer fw.Close()
	w.addTree(w.V.Root())
	tick := time.NewTicker(w.Rescan)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-fw.Events:
			if !ok {
				return nil
			}
			rel, ok := w.V.Rel(ev.Name)
			if !ok || vault.Hidden(rel) {
				continue
			}
			w.queue(rel)
		case err, ok := <-fw.Errors:
			if !ok {
				return nil
			}
			log.Printf("watch error (full rescan follows): %v", err)
			if ch := w.Scan(); len(ch) > 0 {
				w.Hub.Publish(Event{Type: "rescan", Paths: ch, At: time.Now().UnixMilli()})
			}
		case <-tick.C:
			if ch := w.Scan(); len(ch) > 0 {
				w.Hub.Publish(Event{Type: "rescan", Paths: ch, At: time.Now().UnixMilli()})
			}
		}
	}
}

func (w *Watcher) queue(rel string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pending[rel] = struct{}{}
	if w.timer == nil {
		w.timer = time.AfterFunc(w.Debounce, w.flush)
	}
}

func (w *Watcher) flush() {
	w.mu.Lock()
	paths := make([]string, 0, len(w.pending))
	for p := range w.pending {
		paths = append(paths, p)
	}
	w.pending = map[string]struct{}{}
	w.timer = nil
	w.mu.Unlock()
	sort.Strings(paths)
	for _, p := range paths {
		w.refresh(p)
	}
	if len(paths) > 0 {
		w.Hub.Publish(Event{Type: "change", Paths: paths, At: time.Now().UnixMilli()})
	}
}
