package devsync

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/vault"
)

// FileInfo is one manifest row.
type FileInfo struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"` // unix ms
	Hash  string `json:"hash"`  // hex sha256
}

type cacheEntry struct {
	size  int64
	mtime int64 // ns
	hash  string
}

// hasher caches content hashes by (size, mtime) so a manifest poll only
// re-reads files that actually changed.
type hasher struct {
	mu sync.Mutex
	m  map[string]cacheEntry
}

func (h *hasher) hash(abs string, fi fs.FileInfo) (string, error) {
	key := abs
	h.mu.Lock()
	if h.m == nil {
		h.m = map[string]cacheEntry{}
	}
	e, ok := h.m[key]
	h.mu.Unlock()
	if ok && e.size == fi.Size() && e.mtime == fi.ModTime().UnixNano() {
		return e.hash, nil
	}
	f, err := os.Open(abs)
	if err != nil {
		return "", err
	}
	defer f.Close()
	s := sha256.New()
	if _, err := io.Copy(s, f); err != nil {
		return "", err
	}
	sum := hex.EncodeToString(s.Sum(nil))
	h.mu.Lock()
	h.m[key] = cacheEntry{size: fi.Size(), mtime: fi.ModTime().UnixNano(), hash: sum}
	h.mu.Unlock()
	return sum, nil
}

func (h *hasher) forget(abs string) {
	h.mu.Lock()
	delete(h.m, abs)
	h.mu.Unlock()
}

// syncable reports whether a vault-relative path takes part in sync: no
// hidden segments (.obsidian, .trash, .git, temp files) except lock markers.
func syncable(rel string) bool {
	segs := strings.Split(rel, "/")
	for i, s := range segs {
		if s == "" {
			return false
		}
		if strings.HasPrefix(s, ".") {
			if i == len(segs)-1 && s == vault.LockMarker {
				continue
			}
			return false
		}
	}
	return true
}

// manifestCache holds the last computed manifest; it is invalidated by vault
// change events and refreshed at least every maxAge.
type manifestCache struct {
	mu      sync.Mutex
	files   []FileInfo
	version string
	at      time.Time
	dirty   bool
}

const manifestMaxAge = 30 * time.Second

func (c *manifestCache) invalidate() {
	c.mu.Lock()
	c.dirty = true
	c.mu.Unlock()
}

// get returns the manifest, recomputing it when stale. Recomputation holds
// the lock, so concurrent polls share one walk.
func (c *manifestCache) get(root string, h *hasher, now time.Time) ([]FileInfo, string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.files != nil && !c.dirty && now.Sub(c.at) < manifestMaxAge {
		return c.files, c.version, nil
	}
	files, err := walk(root, h)
	if err != nil {
		return nil, "", err
	}
	v := sha256.New()
	for _, f := range files {
		io.WriteString(v, f.Path+"\t"+f.Hash+"\n")
	}
	c.files, c.version, c.at, c.dirty = files, hex.EncodeToString(v.Sum(nil))[:32], now, false
	return c.files, c.version, nil
}

func walk(root string, h *hasher) ([]FileInfo, error) {
	files := []FileInfo{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == root {
				return err
			}
			return nil // unreadable entry: skip, keep walking
		}
		if p == root {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() { // symlinks, sockets
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if !syncable(rel) {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		sum, err := h.hash(p, fi)
		if err != nil {
			return nil
		}
		files = append(files, FileInfo{Path: rel, Size: fi.Size(), Mtime: fi.ModTime().UnixMilli(), Hash: sum})
		return nil
	})
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, err
}

// splitMarker returns (folder, true) when rel names a lock marker.
func splitMarker(rel string) (string, bool) {
	if path.Base(rel) != vault.LockMarker {
		return "", false
	}
	d := path.Dir(rel)
	if d == "." {
		d = ""
	}
	return d, true
}
