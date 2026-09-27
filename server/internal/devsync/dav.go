package devsync

import (
	"context"
	"crypto/subtle"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/vault"
	"golang.org/x/net/webdav"
)

// davHandler serves the vault over WebDAV for third-party apps (Remotely
// Save, Cyberduck, rclone, Files apps). Basic auth: user = device id,
// password = its secret. Hidden files are invisible, deletes go to .trash and
// the encrypted-folder rule is enforced when an upload is closed.
func (s *Service) davHandler() http.Handler {
	h := &webdav.Handler{
		Prefix:     Prefix + "/dav",
		FileSystem: &davFS{s: s},
		LockSystem: webdav.NewMemLS(),
		Logger: func(r *http.Request, err error) {
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				s.cfg.Logf("devsync: webdav %s %s: %v", r.Method, r.URL.Path, err)
			}
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		now := s.cfg.Now()
		ip := clientIP(r)
		if s.lim.isBlocked(ip, now) {
			http.Error(w, "too many failed attempts", http.StatusTooManyRequests)
			return
		}
		user, pass, ok := r.BasicAuth()
		d, found := s.store.Get(user)
		if !ok || !found || d.Kind != KindWebDAV || subtle.ConstantTimeCompare([]byte(pass), []byte(d.Secret)) != 1 {
			if ok { // a missing header is a normal first probe, not an attack
				s.lim.fail(ip, now)
			}
			w.Header().Set("WWW-Authenticate", `Basic realm="Note Keeper", charset="UTF-8"`)
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}
		s.store.Seen(d.ID, now)
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, MaxSyncBytes)
		}
		h.ServeHTTP(w, r)
	})
}

type davFS struct{ s *Service }

// resolve maps a WebDAV name onto the vault ("" is the root).
func (f *davFS) resolve(name string) (abs, clean string, err error) {
	rel := strings.Trim(name, "/")
	a, c, err := f.s.v.Resolve(rel, true)
	if err != nil {
		return "", "", os.ErrNotExist // hidden or invalid names simply do not exist
	}
	return a, c, nil
}

func (f *davFS) Mkdir(ctx context.Context, name string, perm os.FileMode) error {
	_, c, err := f.resolve(name)
	if err != nil || c == "" {
		return os.ErrPermission
	}
	if err := f.s.v.Mkdir(c); err != nil {
		return err
	}
	f.s.Invalidate()
	return nil
}

func (f *davFS) OpenFile(ctx context.Context, name string, flag int, perm os.FileMode) (webdav.File, error) {
	a, c, err := f.resolve(name)
	if err != nil {
		return nil, err
	}
	if flag&(os.O_WRONLY|os.O_RDWR|os.O_CREATE|os.O_TRUNC|os.O_APPEND) != 0 {
		if c == "" {
			return nil, os.ErrPermission
		}
		if fi, err := os.Stat(a); err == nil && fi.IsDir() {
			return nil, os.ErrPermission
		}
		return newDavWriter(f.s, a, c)
	}
	file, err := os.Open(a)
	if err != nil {
		return nil, err
	}
	return &davReadFile{File: file}, nil
}

func (f *davFS) RemoveAll(ctx context.Context, name string) error {
	_, c, err := f.resolve(name)
	if err != nil || c == "" {
		return os.ErrPermission
	}
	if _, err := f.s.v.Trash(c); err != nil {
		if errors.Is(err, vault.ErrNotFound) {
			return os.ErrNotExist
		}
		return err
	}
	f.s.Invalidate()
	f.s.cfg.Touch(c)
	return nil
}

func (f *davFS) Rename(ctx context.Context, oldName, newName string) error {
	_, from, err1 := f.resolve(oldName)
	_, to, err2 := f.resolve(newName)
	if err1 != nil || err2 != nil || from == "" || to == "" {
		return os.ErrPermission
	}
	if err := f.s.v.Move(from, to); err != nil {
		if errors.Is(err, vault.ErrLocked) {
			return os.ErrPermission
		}
		return err
	}
	f.s.Invalidate()
	f.s.cfg.Touch(from, to)
	return nil
}

func (f *davFS) Stat(ctx context.Context, name string) (os.FileInfo, error) {
	a, _, err := f.resolve(name)
	if err != nil {
		return nil, err
	}
	return os.Stat(a)
}

// davReadFile hides dot-entries from directory listings.
type davReadFile struct{ *os.File }

func (d *davReadFile) Readdir(count int) ([]fs.FileInfo, error) {
	all, err := d.File.Readdir(count)
	out := all[:0]
	for _, fi := range all {
		if !strings.HasPrefix(fi.Name(), ".") && (fi.Mode().IsRegular() || fi.IsDir()) {
			out = append(out, fi)
		}
	}
	return out, err
}

func (d *davReadFile) Write([]byte) (int, error) { return 0, os.ErrPermission }

// davWriter buffers an upload in a temp file beside the target and commits
// it atomically on Close, after checking the encrypted-folder rule.
type davWriter struct {
	*os.File
	s     *Service
	abs   string
	clean string
}

func newDavWriter(s *Service, abs, clean string) (*davWriter, error) {
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(abs), ".nk-tmp-dav-*")
	if err != nil {
		return nil, err
	}
	// WebDAV PUT always replaces the whole body, so the temp file starts empty.
	return &davWriter{File: tmp, s: s, abs: abs, clean: clean}, nil
}

func (w *davWriter) Readdir(int) ([]fs.FileInfo, error) { return nil, os.ErrInvalid }

// Stat reports the target's name so ETags and listings stay consistent.
func (w *davWriter) Stat() (fs.FileInfo, error) {
	fi, err := w.File.Stat()
	if err != nil {
		return nil, err
	}
	return namedInfo{fi, path.Base(w.clean)}, nil
}

func (w *davWriter) Close() error {
	tmpName := w.File.Name()
	defer os.Remove(tmpName)
	if err := w.File.Sync(); err != nil {
		w.File.Close()
		return err
	}
	if err := w.File.Close(); err != nil {
		return err
	}
	var body []byte
	if strings.HasSuffix(strings.ToLower(w.clean), ".md") {
		b, err := os.ReadFile(tmpName)
		if err != nil {
			return err
		}
		body = b
	}
	if !w.s.lockedRuleOK(w.clean, false, body) {
		w.s.cfg.Logf("devsync: webdav refused plaintext into encrypted folder: %s", w.clean)
		return os.ErrPermission
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmpName, w.abs); err != nil {
		return err
	}
	w.s.hash.forget(w.abs)
	w.s.Invalidate()
	w.s.cfg.Touch(w.clean)
	return nil
}

type namedInfo struct {
	fs.FileInfo
	name string
}

func (n namedInfo) Name() string { return n.name }
