package devsync

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Signature parameters (see docs/SYNC-PROTOCOL.md).
const (
	MaxSkew      = 300 * time.Second
	nonceWindow  = 10 * time.Minute
	failWindow   = 10 * time.Minute
	failLimit    = 30
	blockFor     = 15 * time.Minute
	sigPrefix    = "NK1"
	minNonceLen  = 16
	maxNonceLen  = 128
	emptyBodySHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
)

// Sign computes the request signature for a device secret. Exported so the
// Go tests (and any Go client) share one implementation with the server.
func Sign(secret, method, requestURI, ts, nonce, bodySHA string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(sigPrefix + "\n" + method + "\n" + requestURI + "\n" + ts + "\n" + nonce + "\n" + bodySHA))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// BodySHA returns the hex sha256 of a body.
func BodySHA(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// limiter blocks client IPs that keep failing authentication.
type limiter struct {
	mu      sync.Mutex
	fails   map[string][]time.Time
	blocked map[string]time.Time
}

func newLimiter() *limiter {
	return &limiter{fails: map[string][]time.Time{}, blocked: map[string]time.Time{}}
}

func (l *limiter) isBlocked(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	until, ok := l.blocked[ip]
	if ok && now.Before(until) {
		return true
	}
	delete(l.blocked, ip)
	return false
}

func (l *limiter) fail(ip string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	keep := l.fails[ip][:0]
	for _, t := range l.fails[ip] {
		if now.Sub(t) < failWindow {
			keep = append(keep, t)
		}
	}
	keep = append(keep, now)
	l.fails[ip] = keep
	if len(keep) >= failLimit {
		l.blocked[ip] = now.Add(blockFor)
		delete(l.fails, ip)
	}
	if len(l.fails) > 10000 { // bound memory under a distributed attack
		l.fails = map[string][]time.Time{}
	}
}

// nonces remembers recently used nonces per device (replay protection).
type nonces struct {
	mu   sync.Mutex
	seen map[string]time.Time
	n    int
}

func (n *nonces) use(key string, now time.Time) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.seen == nil {
		n.seen = map[string]time.Time{}
	}
	if n.n++; n.n%256 == 0 {
		for k, t := range n.seen {
			if now.Sub(t) > nonceWindow {
				delete(n.seen, k)
			}
		}
	}
	if t, ok := n.seen[key]; ok && now.Sub(t) <= nonceWindow {
		return false
	}
	n.seen[key] = now
	return true
}

// clientIP returns the originating client address. The sync listener binds
// loopback and is reached only through the edge proxy (cloudflared then
// Traefik), which set these headers, so they are trusted here.
func clientIP(r *http.Request) string {
	if v := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); v != "" {
		return v
	}
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		return strings.TrimSpace(strings.Split(v, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
