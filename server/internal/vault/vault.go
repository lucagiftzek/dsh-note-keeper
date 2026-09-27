// Package vault owns every filesystem operation Note Keeper performs.
//
// The vault is a plain directory of Markdown files and attachments, laid out
// exactly the way Obsidian expects (folders, .md notes, wikilinks, a .trash
// folder). Keeping the on-disk format boring is what makes bi-directional
// sync with Obsidian desktop/mobile work: any tool that syncs a directory
// (Obsidian Sync, Syncthing, git, iCloud) syncs a Note Keeper vault.
//
// Security model: every caller-supplied path is a vault-relative, slash
// separated path. Resolve() is the single choke point that rejects absolute
// paths, parent traversal, hidden segments and symlink escapes, so no handler
// can ever touch a file outside the vault root.
package vault

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Errors returned by the vault. Handlers map them onto HTTP status codes.
var (
	ErrBadPath  = errors.New("invalid vault path")
	ErrNotFound = errors.New("not found")
	ErrExists   = errors.New("already exists")
	ErrConflict = errors.New("file changed on disk since it was read")
	ErrLocked   = errors.New("folder is encrypted: only encrypted content may be written here")
	ErrTooLarge = errors.New("content too large")
)

// LockMarker is the file that marks a folder (and everything below it) as
// encrypted. It holds the KDF salt and a key verifier, never a key.
const LockMarker = ".nk-lock.json"

// TrashDir is Obsidian's own trash folder name, so deletes made here show up
// in Obsidian's "Deleted files" view and vice versa.
const TrashDir = ".trash"

// MaxPathLen bounds a relative path (defence against pathological input).
const MaxPathLen = 1024

// Vault is a rooted note store.
type Vault struct {
	root string // absolute, symlink-resolved
}

// Entry describes one file or folder in the tree listing.
type Entry struct {
	Path  string `json:"path"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"` // unix milliseconds
}

// Open creates the root directory when missing and returns a Vault.
func Open(root string) (*Vault, error) {
	if root == "" {
		return nil, fmt.Errorf("vault root is empty")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	return &Vault{root: real}, nil
}

// Root returns the absolute vault root.
func (v *Vault) Root() string { return v.root }

// Clean normalises a caller path and validates it without touching disk.
// allowRoot permits the empty path (the vault root itself, used for folders).
func Clean(rel string, allowRoot bool) (string, error) {
	if len(rel) > MaxPathLen || strings.ContainsAny(rel, "\x00\\") {
		return "", ErrBadPath
	}
	rel = strings.TrimSpace(rel)
	if strings.HasPrefix(rel, "/") {
		rel = strings.TrimLeft(rel, "/")
	}
	if rel == "" || rel == "." {
		if allowRoot {
			return "", nil
		}
		return "", ErrBadPath
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == ".." {
			return "", ErrBadPath
		}
	}
	c := path.Clean(rel)
	if c == "." || c == "" {
		if allowRoot {
			return "", nil
		}
		return "", ErrBadPath
	}
	for _, seg := range strings.Split(c, "/") {
		// Hidden segments (.obsidian, .trash, .git, lock markers) are never
		// addressable through the API: they belong to the tools that own them.
		if seg == "" || strings.HasPrefix(seg, ".") {
			return "", ErrBadPath
		}
	}
	return c, nil
}

// abs joins a cleaned relative path onto the root and verifies that the
// nearest existing ancestor does not escape the root through a symlink.
func (v *Vault) abs(clean string) (string, error) {
	p := filepath.Join(v.root, filepath.FromSlash(clean))
	probe := p
	for {
		if _, err := os.Lstat(probe); err == nil {
			real, err := filepath.EvalSymlinks(probe)
			if err != nil {
				return "", ErrBadPath
			}
			if real != v.root && !strings.HasPrefix(real, v.root+string(os.PathSeparator)) {
				return "", ErrBadPath
			}
			return p, nil
		}
		parent := filepath.Dir(probe)
		if parent == probe || len(parent) < len(v.root) {
			return "", ErrBadPath
		}
		probe = parent
	}
}

// Resolve validates a relative path and returns (absolute, cleaned).
func (v *Vault) Resolve(rel string, allowRoot bool) (string, string, error) {
	c, err := Clean(rel, allowRoot)
	if err != nil {
		return "", "", err
	}
	a, err := v.abs(c)
	if err != nil {
		return "", "", err
	}
	return a, c, nil
}

// Rel converts an absolute path inside the vault to its relative slash form.
func (v *Vault) Rel(abs string) (string, bool) {
	r, err := filepath.Rel(v.root, abs)
	if err != nil || r == "." || strings.HasPrefix(r, "..") {
		return "", false
	}
	return filepath.ToSlash(r), true
}

// Hidden reports whether a relative path contains a hidden segment.
func Hidden(rel string) bool {
	for _, seg := range strings.Split(rel, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

func mtimeMs(fi fs.FileInfo) int64 { return fi.ModTime().UnixMilli() }

// List walks the vault and returns every visible file and folder, sorted.
func (v *Vault) List() ([]Entry, error) {
	var out []Entry
	err := filepath.WalkDir(v.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries are skipped, not fatal
		}
		if p == v.root {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil // never follow links out of the vault
		}
		rel, ok := v.Rel(p)
		if !ok {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		e := Entry{Path: rel, Dir: d.IsDir(), Mtime: mtimeMs(fi)}
		if !d.IsDir() {
			e.Size = fi.Size()
		}
		out = append(out, e)
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, err
}

// Stat returns the entry for one path.
func (v *Vault) Stat(rel string) (Entry, error) {
	a, c, err := v.Resolve(rel, false)
	if err != nil {
		return Entry{}, err
	}
	fi, err := os.Stat(a)
	if err != nil {
		return Entry{}, ErrNotFound
	}
	e := Entry{Path: c, Dir: fi.IsDir(), Mtime: mtimeMs(fi)}
	if !fi.IsDir() {
		e.Size = fi.Size()
	}
	return e, nil
}

// Read returns a file's bytes and its mtime.
func (v *Vault) Read(rel string, max int64) ([]byte, int64, error) {
	a, _, err := v.Resolve(rel, false)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(a)
	if err != nil {
		return nil, 0, ErrNotFound
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		return nil, 0, ErrNotFound
	}
	if max > 0 && fi.Size() > max {
		return nil, 0, ErrTooLarge
	}
	b, err := io.ReadAll(f)
	if err != nil {
		return nil, 0, err
	}
	return b, mtimeMs(fi), nil
}

// Open returns a read handle for streaming (attachments).
func (v *Vault) OpenFile(rel string) (*os.File, fs.FileInfo, error) {
	a, _, err := v.Resolve(rel, false)
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(a)
	if err != nil {
		return nil, nil, ErrNotFound
	}
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		f.Close()
		return nil, nil, ErrNotFound
	}
	return f, fi, nil
}

// LockedScope returns the relative folder carrying the lock marker that
// governs rel (rel itself when it is a locked folder), or "" when unlocked.
func (v *Vault) LockedScope(rel string) string {
	dir := rel
	for {
		marker := filepath.Join(v.root, filepath.FromSlash(dir), LockMarker)
		if dir == "" {
			marker = filepath.Join(v.root, LockMarker)
		}
		if _, err := os.Stat(marker); err == nil {
			return dir
		}
		if dir == "" || dir == "." {
			return ""
		}
		d := path.Dir(dir)
		if d == "." {
			d = ""
		}
		dir = d
	}
}

// WriteOpts tunes Write.
type WriteOpts struct {
	BaseMtime int64 // when >0, fail with ErrConflict if the file changed since
	Create    bool  // fail with ErrExists when the file already exists
	Encrypted bool  // caller asserts content is an encrypted envelope
}

// Write atomically writes a file (temp file + rename in the same folder), so
// Obsidian or a sync client never observes a half-written note.
func (v *Vault) Write(rel string, data []byte, o WriteOpts) (int64, error) {
	a, c, err := v.Resolve(rel, false)
	if err != nil {
		return 0, err
	}
	if scope := v.LockedScope(path.Dir(c)); scope != "" || v.LockedScope(c) != "" {
		if !o.Encrypted && strings.HasSuffix(strings.ToLower(c), ".md") {
			return 0, ErrLocked
		}
	}
	if fi, err := os.Stat(a); err == nil {
		if fi.IsDir() {
			return 0, ErrExists
		}
		if o.Create {
			return 0, ErrExists
		}
		if o.BaseMtime > 0 && mtimeMs(fi) != o.BaseMtime {
			return 0, ErrConflict
		}
	}
	if err := os.MkdirAll(filepath.Dir(a), 0o700); err != nil {
		return 0, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(a), ".nk-tmp-*")
	if err != nil {
		return 0, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return 0, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return 0, err
	}
	if err := tmp.Close(); err != nil {
		return 0, err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return 0, err
	}
	if err := os.Rename(tmpName, a); err != nil {
		return 0, err
	}
	fi, err := os.Stat(a)
	if err != nil {
		return 0, err
	}
	return mtimeMs(fi), nil
}

// WriteStream writes a (possibly large) attachment from a reader, capped.
func (v *Vault) WriteStream(rel string, r io.Reader, max int64) (int64, error) {
	a, _, err := v.Resolve(rel, false)
	if err != nil {
		return 0, err
	}
	if _, err := os.Stat(a); err == nil {
		return 0, ErrExists
	}
	if err := os.MkdirAll(filepath.Dir(a), 0o700); err != nil {
		return 0, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(a), ".nk-tmp-*")
	if err != nil {
		return 0, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	n, err := io.Copy(tmp, io.LimitReader(r, max+1))
	if err != nil {
		tmp.Close()
		return 0, err
	}
	if n > max {
		tmp.Close()
		return 0, ErrTooLarge
	}
	if err := tmp.Close(); err != nil {
		return 0, err
	}
	if err := os.Rename(tmpName, a); err != nil {
		return 0, err
	}
	return n, nil
}

// UniquePath returns rel, or rel with " 1", " 2"… inserted before the
// extension, whichever does not exist yet (Obsidian's own naming scheme).
func (v *Vault) UniquePath(rel string) (string, error) {
	c, err := Clean(rel, false)
	if err != nil {
		return "", err
	}
	ext := path.Ext(c)
	stem := strings.TrimSuffix(c, ext)
	cand := c
	for i := 1; i < 10000; i++ {
		a, err := v.abs(cand)
		if err != nil {
			return "", err
		}
		if _, err := os.Lstat(a); errors.Is(err, fs.ErrNotExist) {
			return cand, nil
		}
		cand = fmt.Sprintf("%s %d%s", stem, i, ext)
	}
	return "", ErrExists
}

// Mkdir creates a folder (and parents).
func (v *Vault) Mkdir(rel string) error {
	a, _, err := v.Resolve(rel, false)
	if err != nil {
		return err
	}
	return os.MkdirAll(a, 0o700)
}

// Move renames a file or folder. The destination must not exist.
func (v *Vault) Move(from, to string) error {
	fa, fc, err := v.Resolve(from, false)
	if err != nil {
		return err
	}
	ta, tc, err := v.Resolve(to, false)
	if err != nil {
		return err
	}
	if fc == tc {
		return nil
	}
	if strings.HasPrefix(tc+"/", fc+"/") {
		return ErrBadPath // a folder cannot move inside itself
	}
	if _, err := os.Lstat(fa); err != nil {
		return ErrNotFound
	}
	if _, err := os.Lstat(ta); err == nil {
		return ErrExists
	}
	// Moving plaintext into an encrypted scope would leak it: refuse.
	if v.LockedScope(fc) == "" && v.LockedScope(path.Dir(tc)) != "" {
		return ErrLocked
	}
	if err := os.MkdirAll(filepath.Dir(ta), 0o700); err != nil {
		return err
	}
	return os.Rename(fa, ta)
}

// Trash moves a file or folder into .trash/<stamp>/<rel> (recoverable).
func (v *Vault) Trash(rel string) (string, error) {
	a, c, err := v.Resolve(rel, false)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(a); err != nil {
		return "", ErrNotFound
	}
	stamp := time.Now().UTC().Format("20060102-150405.000")
	dst := filepath.Join(v.root, TrashDir, stamp, filepath.FromSlash(c))
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return "", err
	}
	if err := os.Rename(a, dst); err != nil {
		return "", err
	}
	return filepath.ToSlash(filepath.Join(TrashDir, stamp, filepath.FromSlash(c))), nil
}

// Purge permanently deletes a file or folder (used when encrypting a folder:
// the plaintext originals of attachments must not linger in .trash).
func (v *Vault) Purge(rel string) error {
	a, _, err := v.Resolve(rel, false)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(a); err != nil {
		return ErrNotFound
	}
	return os.RemoveAll(a)
}

// WriteLockMarker stores a folder's lock metadata (salt + verifier JSON).
func (v *Vault) WriteLockMarker(folder string, data []byte) error {
	a, _, err := v.Resolve(folder, false)
	if err != nil {
		return err
	}
	fi, err := os.Stat(a)
	if err != nil || !fi.IsDir() {
		return ErrNotFound
	}
	return os.WriteFile(filepath.Join(a, LockMarker), data, 0o600)
}

// ReadLockMarker returns a folder's lock metadata, or ErrNotFound.
func (v *Vault) ReadLockMarker(folder string) ([]byte, error) {
	a, _, err := v.Resolve(folder, true)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(a, LockMarker))
	if err != nil {
		return nil, ErrNotFound
	}
	return b, nil
}

// RemoveLockMarker unlocks a folder permanently (after the client decrypted
// every note in it).
func (v *Vault) RemoveLockMarker(folder string) error {
	a, _, err := v.Resolve(folder, false)
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(a, LockMarker)); err != nil {
		return ErrNotFound
	}
	return nil
}

// LockedFolders lists every folder carrying a lock marker.
func (v *Vault) LockedFolders() []string {
	var out []string
	_ = filepath.WalkDir(v.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && p != v.root && strings.HasPrefix(d.Name(), ".") {
			return filepath.SkipDir
		}
		if !d.IsDir() && d.Name() == LockMarker {
			if rel, ok := v.Rel(filepath.Dir(p)); ok {
				out = append(out, rel)
			} else if filepath.Dir(p) == v.root {
				out = append(out, "")
			}
		}
		return nil
	})
	sort.Strings(out)
	return out
}
