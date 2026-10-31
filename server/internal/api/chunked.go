package api

// Chunked attachments. A single POST /attachment body is capped by the edge
// in front of this daemon (Cloudflare refuses request bodies over 100 MB), so
// larger uploads arrive as a begin/chunk…/finish sequence:
//
//	POST   /attachment/begin   {name, dir, size, encrypted}  -> {id, chunkMax}
//	POST   /attachment/chunk?id=…   raw body appends one chunk -> {received, size}
//	POST   /attachment/finish  {id}  -> {path, bytes, name}  (same shape as POST /attachment)
//	DELETE /attachment/abort?id=…    discard the staging file
//
// Bytes land in a hidden .nk-up-* staging file inside the destination folder
// (vault.List skips dot files, so an upload in flight never shows up in the
// tree) and are renamed into their final unique path at finish. Any failure
// drops the session and removes the staging file, so nothing partial lingers.
// The metadata (name, dir) travels in the JSON body of begin — never in a
// URL — so edge and proxy logs never learn file names.

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/vault"
)

// MaxChunkBytes caps one chunk request body (the browser slices at 64 MiB,
// comfortably below the 100 MB edge limit).
const MaxChunkBytes = 96 << 20

// uploadIdle is how long an untouched session may sit before a sweep drops it.
const uploadIdle = 6 * time.Hour

var attachExt = regexp.MustCompile(`^\.[a-z0-9]{1,8}$`)

// splitAttachName turns a client-provided file name into a safe stem and a
// validated lowercase extension (".bin" when unrecognised).
func splitAttachName(name string) (string, string) {
	stem := SafeTitle(strings.TrimSuffix(name, path.Ext(name)))
	ext := strings.ToLower(path.Ext(name))
	if !attachExt.MatchString(ext) {
		ext = ".bin"
	}
	return stem, ext
}

// maxAttach is the effective per-attachment byte cap.
func (s *Server) maxAttach() int64 {
	if s.cfg.MaxAttach > 0 {
		return s.cfg.MaxAttach
	}
	return DefaultMaxAttachmentBytes
}

// uploadSession is one in-flight chunked upload.
type uploadSession struct {
	mu        sync.Mutex
	dir       string // cleaned, vault-relative destination folder
	name      string // safe stem
	ext       string // validated extension
	encrypted bool
	size      int64 // declared total
	received  int64
	file      *os.File
	tmpPath   string // absolute staging path inside dir
	lastUsed  time.Time
}

type uploadBeginReq struct {
	Name      string `json:"name"`
	Dir       string `json:"dir"`
	Size      int64  `json:"size"`
	Encrypted int    `json:"encrypted"`
}

func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand does not fail on Linux
	}
	return hex.EncodeToString(b)
}

func (s *Server) uploadBegin(w http.ResponseWriter, r *http.Request) {
	var req uploadBeginReq
	if err := decode(r, &req); err != nil {
		fail(w, err)
		return
	}
	dir := req.Dir
	if dir == "" {
		dir = s.cfg.AttachFolder
	}
	if _, err := vault.Clean(dir, false); err != nil {
		fail(w, err)
		return
	}
	if req.Size <= 0 {
		fail(w, fmt.Errorf("%w: size must be a positive byte count", vault.ErrBadPath))
		return
	}
	if req.Size > s.maxAttach() {
		fail(w, fmt.Errorf("%w: %d bytes exceeds the attachment cap of %d", vault.ErrTooLarge, req.Size, s.maxAttach()))
		return
	}
	name, ext := splitAttachName(req.Name)
	encrypted := req.Encrypted == 1
	if s.v.LockedScope(joinRel(dir, "x")) != "" && ext != ".md" && !encrypted {
		// Same rule as POST /attachment: encrypted folders take sealed blobs only.
		fail(w, vault.ErrLocked)
		return
	}
	absDir := filepath.Join(s.v.Root(), filepath.FromSlash(dir))
	if err := os.MkdirAll(absDir, 0o700); err != nil {
		fail(w, err)
		return
	}
	f, err := os.CreateTemp(absDir, ".nk-up-*")
	if err != nil {
		fail(w, err)
		return
	}
	id := randomID()
	s.uploadsMu.Lock()
	s.sweepUploadsLocked()
	if s.uploads == nil {
		s.uploads = map[string]*uploadSession{}
	}
	s.uploads[id] = &uploadSession{
		dir: dir, name: name, ext: ext, encrypted: encrypted,
		size: req.Size, file: f, tmpPath: f.Name(), lastUsed: time.Now(),
	}
	s.uploadsMu.Unlock()
	writeJSON(w, 200, map[string]any{"id": id, "chunkMax": MaxChunkBytes})
}

func (s *Server) uploadChunk(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	s.uploadsMu.Lock()
	sess := s.uploads[id]
	s.uploadsMu.Unlock()
	if sess == nil {
		writeErr(w, http.StatusNotFound, "not_found", errors.New("unknown upload id"))
		return
	}
	sess.mu.Lock()
	n, err := io.Copy(sess.file, io.LimitReader(r.Body, MaxChunkBytes+1))
	if err != nil {
		sess.mu.Unlock()
		s.dropUpload(id)
		fail(w, err)
		return
	}
	if n > MaxChunkBytes {
		sess.mu.Unlock()
		s.dropUpload(id)
		fail(w, fmt.Errorf("%w: chunk exceeds %d bytes", vault.ErrTooLarge, MaxChunkBytes))
		return
	}
	sess.received += n
	sess.lastUsed = time.Now()
	received := sess.received
	over := received > sess.size
	sess.mu.Unlock()
	if over {
		s.dropUpload(id)
		fail(w, fmt.Errorf("%w: upload exceeds its declared size", vault.ErrTooLarge))
		return
	}
	writeJSON(w, 200, map[string]any{"received": received, "size": sess.size})
}

func (s *Server) uploadFinish(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, err)
		return
	}
	s.uploadsMu.Lock()
	sess := s.uploads[req.ID]
	s.uploadsMu.Unlock()
	if sess == nil {
		writeErr(w, http.StatusNotFound, "not_found", errors.New("unknown upload id"))
		return
	}
	sess.mu.Lock()
	received, size := sess.received, sess.size
	sess.mu.Unlock()
	if received != size {
		s.dropUpload(req.ID)
		fail(w, fmt.Errorf("%w: upload is incomplete (%d of %d bytes)", vault.ErrBadPath, received, size))
		return
	}
	if err := sess.file.Close(); err != nil {
		s.dropUpload(req.ID)
		fail(w, err)
		return
	}
	p, err := s.v.UniquePath(joinRel(sess.dir, sess.name+sess.ext))
	if err != nil {
		s.dropUpload(req.ID)
		fail(w, err)
		return
	}
	if s.v.LockedScope(path.Dir(p)) != "" && sess.ext != ".md" && !sess.encrypted {
		s.dropUpload(req.ID)
		fail(w, vault.ErrLocked)
		return
	}
	absFinal, _, err := s.v.Resolve(p, false)
	if err != nil {
		s.dropUpload(req.ID)
		fail(w, err)
		return
	}
	if err := os.Rename(sess.tmpPath, absFinal); err != nil {
		s.dropUpload(req.ID)
		fail(w, err)
		return
	}
	s.forgetUpload(req.ID) // the staging file became the attachment
	s.w.Touch(p)
	writeJSON(w, 200, map[string]any{"path": p, "bytes": received, "name": path.Base(p)})
}

func (s *Server) uploadAbort(w http.ResponseWriter, r *http.Request) {
	s.dropUpload(r.URL.Query().Get("id"))
	writeJSON(w, 200, map[string]any{"ok": true})
}

// dropUpload removes a session and its staging file (safe on unknown ids).
func (s *Server) dropUpload(id string) {
	s.uploadsMu.Lock()
	sess := s.uploads[id]
	if sess != nil {
		delete(s.uploads, id)
	}
	s.uploadsMu.Unlock()
	if sess == nil {
		return
	}
	sess.mu.Lock()
	_ = sess.file.Close()
	os.Remove(sess.tmpPath)
	sess.mu.Unlock()
}

// forgetUpload removes a session without touching the staging file (renamed).
func (s *Server) forgetUpload(id string) {
	s.uploadsMu.Lock()
	delete(s.uploads, id)
	s.uploadsMu.Unlock()
}

// sweepUploadsLocked drops sessions idle beyond uploadIdle. Caller holds uploadsMu.
func (s *Server) sweepUploadsLocked() {
	for id, sess := range s.uploads {
		sess.mu.Lock()
		idle := time.Since(sess.lastUsed) > uploadIdle
		if idle {
			_ = sess.file.Close()
			os.Remove(sess.tmpPath)
		}
		sess.mu.Unlock()
		if idle {
			delete(s.uploads, id)
		}
	}
}

// SweepStaging removes orphaned .nk-up-* staging files. A daemon start cannot
// have sessions in flight, so anything left over is garbage from a crash.
func SweepStaging(v *vault.Vault) {
	_ = filepath.WalkDir(v.Root(), func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasPrefix(d.Name(), ".nk-up-") {
			return nil
		}
		if os.Remove(p) == nil {
			log.Printf("removed stale upload staging %s", p)
		}
		return nil
	})
}
