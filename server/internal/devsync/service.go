package devsync

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"hash/fnv"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/vault"
)

// MaxSyncBytes caps one file transfer (Cloudflare's request limit is 100 MB).
const MaxSyncBytes = 95 << 20

// Prefix is the public URL prefix the edge routes to this listener.
const Prefix = "/nk-sync"

// Config configures the service.
type Config struct {
	StateDir   string                    // devices.json, cloud.json (outside the vault)
	PublicURL  string                    // e.g. https://llm.tzekos.eu/nk-sync
	VaultName  string                    // shown to clients
	IsEnvelope func(content []byte) bool // encrypted-note detector (api.IsEnvelope)
	Touch      func(rels ...string)      // reindex hook after writes
	Rclone     string                    // rclone binary for the cloud mirror
	Now        func() time.Time
	Logf       func(format string, args ...any)
}

// Service is the device-sync subsystem.
type Service struct {
	cfg      Config
	v        *vault.Vault
	store    *Store
	lim      *limiter
	nonce    nonces
	hash     hasher
	manifest manifestCache
	locks    [64]sync.Mutex
	cloud    *cloudRunner
}

// New opens the device store and cloud settings under cfg.StateDir.
func New(cfg Config, v *vault.Vault) (*Service, error) {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logf == nil {
		cfg.Logf = log.Printf
	}
	if cfg.IsEnvelope == nil {
		cfg.IsEnvelope = func([]byte) bool { return false }
	}
	if cfg.Touch == nil {
		cfg.Touch = func(...string) {}
	}
	if cfg.VaultName == "" {
		cfg.VaultName = filepath.Base(v.Root())
	}
	st, err := OpenStore(filepath.Join(cfg.StateDir, "devices.json"))
	if err != nil {
		return nil, err
	}
	s := &Service{cfg: cfg, v: v, store: st, lim: newLimiter()}
	s.cloud = newCloudRunner(s, filepath.Join(cfg.StateDir, "cloud.json"))
	return s, nil
}

// Store exposes the device store (admin API).
func (s *Service) Store() *Store { return s.store }

// Invalidate marks the cached manifest stale (call on any vault change).
func (s *Service) Invalidate() { s.manifest.invalidate() }

func (s *Service) lockFor(rel string) *sync.Mutex {
	h := fnv.New32a()
	h.Write([]byte(rel))
	return &s.locks[h.Sum32()%uint32(len(s.locks))]
}

// Handler serves the public sync API and WebDAV under Prefix.
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+Prefix+"/v1/hello", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"server": "note-keeper", "protocol": 1})
	})
	mux.HandleFunc("POST "+Prefix+"/v1/pair", s.pair)
	mux.HandleFunc("GET "+Prefix+"/v1/whoami", s.authed(s.whoami))
	mux.HandleFunc("GET "+Prefix+"/v1/manifest", s.authed(s.getManifest))
	mux.HandleFunc("GET "+Prefix+"/v1/file", s.authed(s.getFile))
	mux.HandleFunc("PUT "+Prefix+"/v1/file", s.authed(s.putFile))
	mux.HandleFunc("DELETE "+Prefix+"/v1/file", s.authed(s.deleteFile))
	mux.Handle(Prefix+"/dav/", s.davHandler())
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Cache-Control", "no-store")
		h.Set("Referrer-Policy", "no-referrer")
		mux.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

// ---- pairing -------------------------------------------------------------

func (s *Service) pair(w http.ResponseWriter, r *http.Request) {
	now := s.cfg.Now()
	ip := clientIP(r)
	if s.lim.isBlocked(ip, now) {
		fail(w, 429, "too many failed attempts; try again later")
		return
	}
	var req struct {
		Code   string `json:"code"`
		Device struct {
			Name     string `json:"name"`
			Platform string `json:"platform"`
			App      string `json:"app"`
		} `json:"device"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil {
		fail(w, 400, "bad request")
		return
	}
	d, err := s.store.Redeem(req.Code, req.Device.Name, req.Device.Platform, req.Device.App, now)
	if err != nil {
		s.lim.fail(ip, now)
		fail(w, 403, err.Error())
		return
	}
	s.cfg.Logf("devsync: paired device %s (%s, %s)", d.ID, d.Name, d.Platform)
	writeJSON(w, 200, map[string]any{"deviceId": d.ID, "secret": d.Secret, "vault": s.cfg.VaultName, "protocol": 1, "name": d.Name})
}

// ---- authentication ---------------------------------------------------------

type authedFunc func(w http.ResponseWriter, r *http.Request, d Device, body []byte)

// authed verifies the HMAC request signature (docs/SYNC-PROTOCOL.md) and
// hands the handler the already-read, hash-verified body.
func (s *Service) authed(h authedFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		now := s.cfg.Now()
		ip := clientIP(r)
		if s.lim.isBlocked(ip, now) {
			fail(w, 429, "too many failed attempts; try again later")
			return
		}
		deny := func(msg string) {
			s.lim.fail(ip, now)
			fail(w, 401, msg)
		}
		id := r.Header.Get("X-NK-Device")
		d, ok := s.store.Get(id)
		if !ok || d.Kind != KindSync {
			deny("revoked")
			return
		}
		ts, nonce := r.Header.Get("X-NK-Time"), r.Header.Get("X-NK-Nonce")
		sec, err := strconv.ParseInt(ts, 10, 64)
		if err != nil || absDur(now.Sub(time.Unix(sec, 0))) > MaxSkew {
			deny("clock skew too large (check the device time)")
			return
		}
		if len(nonce) < minNonceLen || len(nonce) > maxNonceLen {
			deny("bad nonce")
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, MaxSyncBytes+1))
		if err != nil {
			fail(w, 400, "read error")
			return
		}
		if len(body) > MaxSyncBytes {
			fail(w, 413, "file too large for sync (max 95 MB)")
			return
		}
		bodySHA := BodySHA(body)
		if !strings.EqualFold(r.Header.Get("X-NK-Body-SHA256"), bodySHA) {
			deny("body hash mismatch")
			return
		}
		want := Sign(d.Secret, r.Method, r.RequestURI, ts, nonce, bodySHA)
		if subtle.ConstantTimeCompare([]byte(want), []byte(r.Header.Get("X-NK-Signature"))) != 1 {
			deny("bad signature")
			return
		}
		if !s.nonce.use(d.ID+"|"+nonce, now) {
			deny("replayed request")
			return
		}
		s.store.Seen(d.ID, now)
		h(w, r, d, body)
	}
}

func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

// ---- handlers ----------------------------------------------------------------

func (s *Service) whoami(w http.ResponseWriter, r *http.Request, d Device, _ []byte) {
	writeJSON(w, 200, map[string]any{"deviceId": d.ID, "name": d.Name, "vault": s.cfg.VaultName})
}

func (s *Service) getManifest(w http.ResponseWriter, r *http.Request, _ Device, _ []byte) {
	files, version, err := s.manifest.get(s.v.Root(), &s.hash, s.cfg.Now())
	if err != nil {
		fail(w, 500, "manifest failed")
		return
	}
	etag := `"` + version + `"`
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, 200, map[string]any{"version": version, "files": files})
}

// target resolves a sync path to its absolute file path. Lock markers are
// the one hidden name that syncs; everything else goes through vault.Resolve.
func (s *Service) target(rel string) (abs, clean string, marker bool, folder string, err error) {
	rel = strings.TrimPrefix(strings.TrimSpace(rel), "/")
	if folder, ok := splitMarker(rel); ok {
		fa, fc, err := s.v.Resolve(folder, true)
		if err != nil {
			return "", "", false, "", err
		}
		c := vault.LockMarker
		if fc != "" {
			c = fc + "/" + vault.LockMarker
		}
		return filepath.Join(fa, vault.LockMarker), c, true, fc, nil
	}
	a, c, err := s.v.Resolve(rel, false)
	if err != nil {
		return "", "", false, "", err
	}
	if !syncable(c) {
		return "", "", false, "", vault.ErrBadPath
	}
	return a, c, false, "", nil
}

// current returns the hash of the file now on disk ("" when absent).
func (s *Service) current(abs string) (string, fs.FileInfo, error) {
	fi, err := os.Stat(abs)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	if fi.IsDir() {
		return "", nil, vault.ErrExists
	}
	h, err := s.hash.hash(abs, fi)
	return h, fi, err
}

func (s *Service) vaultErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, vault.ErrBadPath):
		fail(w, 400, "invalid path")
	case errors.Is(err, vault.ErrNotFound), errors.Is(err, os.ErrNotExist):
		fail(w, 404, "not found")
	case errors.Is(err, vault.ErrLocked):
		fail(w, 423, vault.ErrLocked.Error())
	case errors.Is(err, vault.ErrExists):
		fail(w, 409, "a folder exists at this path")
	case errors.Is(err, vault.ErrTooLarge):
		fail(w, 413, "too large")
	default:
		s.cfg.Logf("devsync: %v", err)
		fail(w, 500, "internal error")
	}
}

func (s *Service) getFile(w http.ResponseWriter, r *http.Request, _ Device, _ []byte) {
	abs, _, _, _, err := s.target(r.URL.Query().Get("path"))
	if err != nil {
		s.vaultErr(w, err)
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		s.vaultErr(w, err)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		fail(w, 404, "not found")
		return
	}
	h, err := s.hash.hash(abs, fi)
	if err != nil {
		s.vaultErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	w.Header().Set("X-NK-Hash", h)
	w.Header().Set("X-NK-Mtime", strconv.FormatInt(fi.ModTime().UnixMilli(), 10))
	_, _ = io.Copy(w, f)
}

// lockedRuleOK enforces the encrypted-folder rule for a write: inside a
// locked scope only envelopes (.md), sealed attachments (.nkenc) and the
// marker itself may land.
func (s *Service) lockedRuleOK(clean string, marker bool, body []byte) bool {
	if marker {
		return true
	}
	dir := path.Dir(clean)
	if dir == "." {
		dir = ""
	}
	if s.v.LockedScope(dir) == "" {
		return true
	}
	lower := strings.ToLower(clean)
	switch {
	case strings.HasSuffix(lower, ".md"):
		return s.cfg.IsEnvelope(body)
	case strings.HasSuffix(lower, ".nkenc"):
		return true
	}
	return false
}

func (s *Service) putFile(w http.ResponseWriter, r *http.Request, d Device, body []byte) {
	q := r.URL.Query()
	abs, clean, marker, folder, err := s.target(q.Get("path"))
	if err != nil {
		s.vaultErr(w, err)
		return
	}
	mu := s.lockFor(clean)
	mu.Lock()
	defer mu.Unlock()
	cur, fi, err := s.current(abs)
	if err != nil {
		s.vaultErr(w, err)
		return
	}
	if base := q.Get("base"); base != cur {
		cm := int64(0)
		if fi != nil {
			cm = fi.ModTime().UnixMilli()
		}
		writeJSON(w, 409, map[string]any{"error": "conflict", "current": map[string]any{"hash": cur, "mtime": cm}})
		return
	}
	if !s.lockedRuleOK(clean, marker, body) {
		fail(w, 423, vault.ErrLocked.Error())
		return
	}
	if marker {
		if !json.Valid(body) {
			fail(w, 400, "lock marker must be JSON")
			return
		}
		// The marker may arrive before any file of its folder.
		if err = s.v.Mkdir(folder); err == nil || errors.Is(err, vault.ErrExists) {
			err = s.v.WriteLockMarker(folder, body)
		}
	} else {
		_, err = s.v.Write(clean, body, vault.WriteOpts{Encrypted: s.cfg.IsEnvelope(body)})
	}
	if err != nil {
		s.vaultErr(w, err)
		return
	}
	// Keep the author's modification time (Obsidian sorts by it), within sane bounds.
	if m, err := strconv.ParseInt(q.Get("mtime"), 10, 64); err == nil && m > 946684800000 && m < s.cfg.Now().Add(24*time.Hour).UnixMilli() {
		t := time.UnixMilli(m)
		_ = os.Chtimes(abs, t, t)
	}
	s.hash.forget(abs)
	nfi, err := os.Stat(abs)
	if err != nil {
		s.vaultErr(w, err)
		return
	}
	sum := BodySHA(body)
	s.Invalidate()
	if !marker {
		s.cfg.Touch(clean)
	}
	s.cfg.Logf("devsync: %s pushed %s (%d bytes)", d.ID, clean, len(body))
	writeJSON(w, 200, map[string]any{"hash": sum, "mtime": nfi.ModTime().UnixMilli()})
}

func (s *Service) deleteFile(w http.ResponseWriter, r *http.Request, d Device, _ []byte) {
	q := r.URL.Query()
	abs, clean, marker, folder, err := s.target(q.Get("path"))
	if err != nil {
		s.vaultErr(w, err)
		return
	}
	mu := s.lockFor(clean)
	mu.Lock()
	defer mu.Unlock()
	cur, fi, err := s.current(abs)
	if err != nil {
		s.vaultErr(w, err)
		return
	}
	if cur == "" {
		fail(w, 404, "not found")
		return
	}
	if q.Get("base") != cur {
		writeJSON(w, 409, map[string]any{"error": "conflict", "current": map[string]any{"hash": cur, "mtime": fi.ModTime().UnixMilli()}})
		return
	}
	if marker {
		err = s.v.RemoveLockMarker(folder)
	} else {
		_, err = s.v.Trash(clean)
	}
	if err != nil {
		s.vaultErr(w, err)
		return
	}
	s.hash.forget(abs)
	s.Invalidate()
	if !marker {
		s.cfg.Touch(clean)
	}
	s.cfg.Logf("devsync: %s deleted %s", d.ID, clean)
	writeJSON(w, 200, map[string]any{"deleted": clean})
}

// ---- admin (local, authenticated UI) -----------------------------------------------

// PairInfo is returned to the local UI when a pairing code is created.
type PairInfo struct {
	Code    string `json:"code"`
	Expires int64  `json:"expires"`
	URL     string `json:"url"`
}

// NewPairing issues a pairing code for the local UI.
func (s *Service) NewPairing() PairInfo {
	code, exp := s.store.NewPairCode(s.cfg.Now())
	return PairInfo{Code: FormatCode(code), Expires: exp.UnixMilli(), URL: s.cfg.PublicURL}
}

// NewWebDAV creates a WebDAV app password.
func (s *Service) NewWebDAV(name string) (map[string]any, error) {
	d, err := s.store.CreateDevice(KindWebDAV, name, "webdav", "", s.cfg.Now())
	if err != nil {
		return nil, err
	}
	return map[string]any{"deviceId": d.ID, "username": d.ID, "password": d.Secret, "url": strings.TrimRight(s.cfg.PublicURL, "/") + "/dav/", "name": d.Name}, nil
}

// Status summarises the subsystem for the UI.
func (s *Service) Status(listening string) map[string]any {
	return map[string]any{
		"enabled":   listening != "",
		"listening": listening,
		"url":       s.cfg.PublicURL,
		"devices":   s.store.List(),
		"cloud":     s.cloud.state(),
	}
}
