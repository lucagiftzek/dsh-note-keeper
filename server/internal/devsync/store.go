// Package devsync lets remote devices sync with the vault: the Obsidian
// plugin (native protocol, see docs/SYNC-PROTOCOL.md), WebDAV apps, and an
// rclone bisync cloud mirror. It owns device pairing and request signing.
//
// Everything here is reachable from the public internet through a dedicated
// edge route, so every entry point is authenticated (pairing codes, HMAC
// request signatures, per-device WebDAV passwords), rate-limited, and bound to
// the same path rules as the local API (vault.Clean / vault.Resolve).
package devsync

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Device kinds.
const (
	KindSync   = "sync"   // native protocol (Obsidian plugin)
	KindWebDAV = "webdav" // Basic-auth WebDAV client
)

// Pairing code settings.
const (
	codeAlphabet    = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" // Crockford base32
	codeLen         = 10
	codeTTL         = 10 * time.Minute
	codeMaxAttempts = 5
	maxActiveCodes  = 5
	maxDevices      = 64
)

// ErrBadCode is returned for unknown, expired or exhausted pairing codes.
var ErrBadCode = errors.New("invalid or expired pairing code")

// Device is one paired client. Secret never leaves the server except once,
// in the pairing response (or the WebDAV creation response).
type Device struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Platform string `json:"platform,omitempty"`
	App      string `json:"app,omitempty"`
	Created  int64  `json:"created"`
	LastSeen int64  `json:"lastSeen,omitempty"`
	Secret   string `json:"secret,omitempty"`
}

// Public returns a copy without the secret, for listings.
func (d Device) Public() Device { d.Secret = ""; return d }

type pairCode struct {
	expires  time.Time
	attempts int
}

// Store persists devices in a 0600 JSON file outside the vault (so it is
// never synced) and keeps pairing codes in memory only.
type Store struct {
	mu       sync.Mutex
	path     string
	devices  map[string]*Device
	codes    map[string]*pairCode
	lastSave time.Time
}

// OpenStore loads (or creates) the device store at path.
func OpenStore(path string) (*Store, error) {
	s := &Store{path: path, devices: map[string]*Device{}, codes: map[string]*pairCode{}}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(path)
	if err == nil {
		var list []*Device
		if err := json.Unmarshal(b, &list); err != nil {
			return nil, err
		}
		for _, d := range list {
			if d.ID != "" && d.Secret != "" {
				s.devices[d.ID] = d
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return s, nil
}

// save writes the store atomically. Caller holds s.mu.
func (s *Store) save() error {
	list := make([]*Device, 0, len(s.devices))
	for _, d := range s.devices {
		list = append(list, d)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Created < list[j].Created })
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	s.lastSave = time.Now()
	return os.Rename(tmp, s.path)
}

func randomString(alphabet string, n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	out := make([]byte, n)
	for i := range b {
		out[i] = alphabet[int(b[i])%len(alphabet)] // 256 % 32 == 0: unbiased
	}
	return string(out)
}

func newSecret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// NormalizeCode upper-cases a typed code, drops separators and maps the
// Crockford look-alikes (O→0, I/L→1).
func NormalizeCode(c string) string {
	c = strings.ToUpper(c)
	var b strings.Builder
	for _, r := range c {
		switch {
		case r == 'O':
			b.WriteRune('0')
		case r == 'I' || r == 'L':
			b.WriteRune('1')
		case strings.ContainsRune(codeAlphabet, r):
			b.WriteRune(r)
		}
	}
	return b.String()
}

// FormatCode renders a code as XXXXX-XXXXX for display.
func FormatCode(c string) string {
	if len(c) != codeLen {
		return c
	}
	return c[:5] + "-" + c[5:]
}

// NewPairCode issues a one-time pairing code.
func (s *Store) NewPairCode(now time.Time) (string, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneCodes(now)
	for len(s.codes) >= maxActiveCodes { // drop the oldest
		var oldest string
		for k, v := range s.codes {
			if oldest == "" || v.expires.Before(s.codes[oldest].expires) {
				oldest = k
			}
		}
		delete(s.codes, oldest)
	}
	code := randomString(codeAlphabet, codeLen)
	exp := now.Add(codeTTL)
	s.codes[code] = &pairCode{expires: exp}
	return code, exp
}

func (s *Store) pruneCodes(now time.Time) {
	for k, v := range s.codes {
		if now.After(v.expires) || v.attempts >= codeMaxAttempts {
			delete(s.codes, k)
		}
	}
}

// Redeem consumes a pairing code and creates a sync device.
func (s *Store) Redeem(code, name, platform, app string, now time.Time) (Device, error) {
	code = NormalizeCode(code)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneCodes(now)
	pc, ok := s.codes[code]
	if !ok {
		// Count the attempt against every live code: guessing is spread
		// across codes, so each wrong guess burns budget on all of them.
		for _, v := range s.codes {
			v.attempts++
		}
		return Device{}, ErrBadCode
	}
	_ = pc
	delete(s.codes, code)
	return s.createLocked(KindSync, name, platform, app, now)
}

// CreateDevice creates a device directly (WebDAV app passwords, created from
// the authenticated local UI).
func (s *Store) CreateDevice(kind, name, platform, app string, now time.Time) (Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.createLocked(kind, name, platform, app, now)
}

func (s *Store) createLocked(kind, name, platform, app string, now time.Time) (Device, error) {
	if len(s.devices) >= maxDevices {
		return Device{}, errors.New("too many devices: revoke one first")
	}
	d := &Device{
		ID:       "d_" + strings.ToLower(randomString(codeAlphabet, 12)),
		Name:     clip(name, 80, "Device"),
		Kind:     kind,
		Platform: clip(platform, 40, ""),
		App:      clip(app, 40, ""),
		Created:  now.UnixMilli(),
		Secret:   newSecret(),
	}
	s.devices[d.ID] = d
	if err := s.save(); err != nil {
		delete(s.devices, d.ID)
		return Device{}, err
	}
	return *d, nil
}

func clip(s string, n int, def string) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s))
	if s == "" {
		return def
	}
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// Get returns a device (with secret) by id.
func (s *Store) Get(id string) (Device, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.devices[id]
	if !ok {
		return Device{}, false
	}
	return *d, true
}

// List returns all devices without secrets, oldest first.
func (s *Store) List() []Device {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Device, 0, len(s.devices))
	for _, d := range s.devices {
		out = append(out, d.Public())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created < out[j].Created })
	return out
}

// Revoke deletes a device. It reports whether it existed.
func (s *Store) Revoke(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.devices[id]; !ok {
		return false, nil
	}
	delete(s.devices, id)
	return true, s.save()
}

// Seen records activity; the file is rewritten at most once a minute.
func (s *Store) Seen(id string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, ok := s.devices[id]; ok {
		d.LastSeen = now.UnixMilli()
		if now.Sub(s.lastSave) > time.Minute {
			_ = s.save()
		}
	}
}
