package devsync

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/vault"
)

type harness struct {
	t    *testing.T
	v    *vault.Vault
	s    *Service
	srv  *httptest.Server
	dev  string
	sec  string
	now  time.Time
	logs []string
}

func envelope(b []byte) bool {
	return bytes.HasPrefix(b, []byte("---\nnk-encrypted: v1")) && bytes.Contains(b, []byte("```nk-cipher"))
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	v, err := vault.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, v: v, now: time.Now()}
	s, err := New(Config{StateDir: t.TempDir(), PublicURL: "https://example.test/nk-sync", IsEnvelope: envelope,
		Now: func() time.Time { return h.now }, Logf: func(f string, a ...any) { h.logs = append(h.logs, fmt.Sprintf(f, a...)) }}, v)
	if err != nil {
		t.Fatal(err)
	}
	h.s = s
	h.srv = httptest.NewServer(s.Handler())
	t.Cleanup(h.srv.Close)
	return h
}

func (h *harness) pair() {
	h.t.Helper()
	info := h.s.NewPairing()
	var out struct{ DeviceID, Secret string }
	code := h.raw("POST", "/nk-sync/v1/pair", map[string]any{"code": strings.ToLower(info.Code), "device": map[string]any{"name": "Phone", "platform": "ios"}}, &out, nil)
	if code != 200 || out.DeviceID == "" || out.Secret == "" {
		h.t.Fatalf("pair %d %+v", code, out)
	}
	h.dev, h.sec = out.DeviceID, out.Secret
}

func (h *harness) raw(method, uri string, body any, out any, hdr http.Header) int {
	h.t.Helper()
	var rb []byte
	switch b := body.(type) {
	case nil:
	case []byte:
		rb = b
	default:
		rb, _ = json.Marshal(b)
	}
	req, _ := http.NewRequest(method, h.srv.URL+uri, bytes.NewReader(rb))
	for k, vs := range hdr {
		req.Header[k] = vs
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if out != nil {
		if bp, ok := out.(*[]byte); ok {
			*bp = data
		} else {
			_ = json.Unmarshal(data, out)
		}
	}
	return res.StatusCode
}

func nonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (h *harness) signed(method, uri string, body []byte, out any) int {
	return h.signedWith(method, uri, body, out, h.sec, nonce(), h.now)
}

func (h *harness) signedWith(method, uri string, body []byte, out any, secret, n string, at time.Time) int {
	h.t.Helper()
	ts := strconv.FormatInt(at.Unix(), 10)
	bs := BodySHA(body)
	hdr := http.Header{}
	hdr.Set("X-NK-Device", h.dev)
	hdr.Set("X-NK-Time", ts)
	hdr.Set("X-NK-Nonce", n)
	hdr.Set("X-NK-Body-SHA256", bs)
	hdr.Set("X-NK-Signature", Sign(secret, method, uri, ts, n, bs))
	return h.raw(method, uri, body, out, hdr)
}

func fileURI(p string, extra string) string {
	return "/nk-sync/v1/file?path=" + url.QueryEscape(p) + extra
}

type manifestResp struct {
	Version string
	Files   []FileInfo
}

func TestPairingAndAuth(t *testing.T) {
	h := newHarness(t)
	if c := h.raw("GET", "/nk-sync/v1/hello", nil, nil, nil); c != 200 {
		t.Fatalf("hello %d", c)
	}
	if c := h.raw("POST", "/nk-sync/v1/pair", map[string]any{"code": "AAAAAAAAAA"}, nil, nil); c != 403 {
		t.Fatalf("bad code -> %d", c)
	}
	h.pair()
	// A code is single use.
	info := h.s.NewPairing()
	if c := h.raw("POST", "/nk-sync/v1/pair", map[string]any{"code": info.Code}, nil, nil); c != 200 {
		t.Fatal("fresh code refused")
	}
	if c := h.raw("POST", "/nk-sync/v1/pair", map[string]any{"code": info.Code}, nil, nil); c != 403 {
		t.Fatal("code reused")
	}
	var who map[string]any
	if c := h.signed("GET", "/nk-sync/v1/whoami", nil, &who); c != 200 || who["name"] != "Phone" {
		t.Fatalf("whoami %d %v", c, who)
	}
	// Wrong secret, replay, skew, unsigned, tampered body.
	if c := h.signedWith("GET", "/nk-sync/v1/whoami", nil, nil, "nope", nonce(), h.now); c != 401 {
		t.Fatalf("wrong secret %d", c)
	}
	n := nonce()
	if c := h.signedWith("GET", "/nk-sync/v1/whoami", nil, nil, h.sec, n, h.now); c != 200 {
		t.Fatal("first use refused")
	}
	if c := h.signedWith("GET", "/nk-sync/v1/whoami", nil, nil, h.sec, n, h.now); c != 401 {
		t.Fatal("replay accepted")
	}
	if c := h.signedWith("GET", "/nk-sync/v1/whoami", nil, nil, h.sec, nonce(), h.now.Add(-10*time.Minute)); c != 401 {
		t.Fatal("stale timestamp accepted")
	}
	if c := h.raw("GET", "/nk-sync/v1/manifest", nil, nil, nil); c != 401 {
		t.Fatal("unsigned accepted")
	}
	// Body swapped after signing.
	ts := strconv.FormatInt(h.now.Unix(), 10)
	nn := nonce()
	hdr := http.Header{}
	hdr.Set("X-NK-Device", h.dev)
	hdr.Set("X-NK-Time", ts)
	hdr.Set("X-NK-Nonce", nn)
	hdr.Set("X-NK-Body-SHA256", BodySHA([]byte("a")))
	uri := fileURI("x.md", "&base=")
	hdr.Set("X-NK-Signature", Sign(h.sec, "PUT", uri, ts, nn, BodySHA([]byte("a"))))
	if c := h.raw("PUT", uri, []byte("b"), nil, hdr); c != 401 {
		t.Fatalf("tampered body -> %d", c)
	}
	// Revocation.
	if ok, _ := h.s.Store().Revoke(h.dev); !ok {
		t.Fatal("revoke")
	}
	if c := h.signed("GET", "/nk-sync/v1/whoami", nil, nil); c != 401 {
		t.Fatal("revoked device accepted")
	}
	// Devices persist across restarts (new store on the same file).
	if _, err := OpenStore(filepath.Join(h.s.cfg.StateDir, "devices.json")); err != nil {
		t.Fatal(err)
	}
}

func TestRateLimit(t *testing.T) {
	h := newHarness(t)
	for i := 0; i < failLimit; i++ {
		h.raw("POST", "/nk-sync/v1/pair", map[string]any{"code": "ZZZZZZZZZZ"}, nil, nil)
	}
	if c := h.raw("POST", "/nk-sync/v1/pair", map[string]any{"code": h.s.NewPairing().Code}, nil, nil); c != 429 {
		t.Fatalf("expected 429, got %d", c)
	}
	h.now = h.now.Add(blockFor + time.Second)
	if c := h.raw("POST", "/nk-sync/v1/pair", map[string]any{"code": h.s.NewPairing().Code}, nil, nil); c != 200 {
		t.Fatalf("after block %d", c)
	}
}

func TestFileLifecycleAndCAS(t *testing.T) {
	h := newHarness(t)
	h.pair()
	os.MkdirAll(filepath.Join(h.v.Root(), ".obsidian"), 0o700)
	os.WriteFile(filepath.Join(h.v.Root(), ".obsidian", "app.json"), []byte("{}"), 0o600)
	os.WriteFile(filepath.Join(h.v.Root(), "Server.md"), []byte("from server"), 0o600)

	var m manifestResp
	if c := h.signed("GET", "/nk-sync/v1/manifest", nil, &m); c != 200 || len(m.Files) != 1 || m.Files[0].Path != "Server.md" {
		t.Fatalf("manifest %d %+v", c, m)
	}
	// Create, then CAS update, then stale update conflicts.
	var put struct{ Hash string }
	mt := time.Date(2024, 5, 1, 10, 0, 0, 0, time.UTC).UnixMilli()
	if c := h.signed("PUT", fileURI("Notes/Α σημείωση.md", "&base=&mtime="+strconv.FormatInt(mt, 10)), []byte("one"), &put); c != 200 || put.Hash != BodySHA([]byte("one")) {
		t.Fatalf("create %d", c)
	}
	fi, _ := os.Stat(filepath.Join(h.v.Root(), "Notes", "Α σημείωση.md"))
	if fi.ModTime().UnixMilli() != mt {
		t.Fatal("mtime not preserved")
	}
	if c := h.signed("PUT", fileURI("Notes/Α σημείωση.md", "&base="), []byte("again"), nil); c != 409 {
		t.Fatalf("create over existing %d", c)
	}
	if c := h.signed("PUT", fileURI("Notes/Α σημείωση.md", "&base="+put.Hash), []byte("two"), nil); c != 200 {
		t.Fatalf("cas update %d", c)
	}
	var conflict struct {
		Error   string
		Current struct{ Hash string }
	}
	if c := h.signed("PUT", fileURI("Notes/Α σημείωση.md", "&base="+put.Hash), []byte("three"), &conflict); c != 409 || conflict.Current.Hash != BodySHA([]byte("two")) {
		t.Fatalf("stale update %d %+v", c, conflict)
	}
	var body []byte
	if c := h.signed("GET", fileURI("Notes/Α σημείωση.md", ""), nil, &body); c != 200 || string(body) != "two" {
		t.Fatalf("get %d %q", c, body)
	}
	// ETag short-circuit, and invalidation after a write.
	var m2 manifestResp
	h.signed("GET", "/nk-sync/v1/manifest", nil, &m2)
	ts := strconv.FormatInt(h.now.Unix(), 10)
	nn := nonce()
	hdr := http.Header{}
	hdr.Set("X-NK-Device", h.dev)
	hdr.Set("X-NK-Time", ts)
	hdr.Set("X-NK-Nonce", nn)
	hdr.Set("X-NK-Body-SHA256", emptyBodySHA)
	hdr.Set("X-NK-Signature", Sign(h.sec, "GET", "/nk-sync/v1/manifest", ts, nn, emptyBodySHA))
	hdr.Set("If-None-Match", `"`+m2.Version+`"`)
	if c := h.raw("GET", "/nk-sync/v1/manifest", nil, nil, hdr); c != 304 {
		t.Fatalf("etag %d", c)
	}
	// Delete: wrong base conflicts, right base trashes, second delete 404.
	if c := h.signed("DELETE", fileURI("Notes/Α σημείωση.md", "&base="+put.Hash), nil, nil); c != 409 {
		t.Fatalf("stale delete %d", c)
	}
	if c := h.signed("DELETE", fileURI("Notes/Α σημείωση.md", "&base="+BodySHA([]byte("two"))), nil, nil); c != 200 {
		t.Fatalf("delete %d", c)
	}
	if m, _ := filepath.Glob(filepath.Join(h.v.Root(), ".trash", "*", "Notes", "Α σημείωση.md")); len(m) != 1 {
		t.Fatal("deleted note not in .trash")
	}
	if c := h.signed("DELETE", fileURI("Notes/Α σημείωση.md", "&base=x"), nil, nil); c != 404 {
		t.Fatalf("second delete %d", c)
	}
	// Hidden and traversal paths are rejected.
	for _, p := range []string{".obsidian/app.json", "../x.md", "a/../../x.md", ".trash/x.md"} {
		if c := h.signed("PUT", fileURI(p, "&base="), []byte("x"), nil); c != 400 {
			t.Errorf("%s -> %d", p, c)
		}
	}
}

func TestLockedFoldersAndMarkers(t *testing.T) {
	h := newHarness(t)
	h.pair()
	marker := []byte(`{"v":1,"salt":"AAAA"}`)
	if c := h.signed("PUT", fileURI("Secret/.nk-lock.json", "&base="), marker, nil); c != 200 {
		t.Fatalf("marker push %d", c)
	}
	if c := h.signed("PUT", fileURI("Secret/plain.md", "&base="), []byte("# plaintext"), nil); c != 423 {
		t.Fatalf("plaintext into locked folder %d", c)
	}
	if c := h.signed("PUT", fileURI("Secret/pic.png", "&base="), []byte("png"), nil); c != 423 {
		t.Fatalf("plain attachment into locked folder %d", c)
	}
	env := []byte("---\nnk-encrypted: v1\n---\n```nk-cipher\nQUJD\n```\n")
	if c := h.signed("PUT", fileURI("Secret/enc.md", "&base="), env, nil); c != 200 {
		t.Fatalf("envelope %d", c)
	}
	if c := h.signed("PUT", fileURI("Secret/pic.png.nkenc", "&base="), []byte("NKE1..."), nil); c != 200 {
		t.Fatalf("sealed attachment %d", c)
	}
	var m manifestResp
	h.signed("GET", "/nk-sync/v1/manifest", nil, &m)
	paths := []string{}
	for _, f := range m.Files {
		paths = append(paths, f.Path)
	}
	if strings.Join(paths, ",") != "Secret/.nk-lock.json,Secret/enc.md,Secret/pic.png.nkenc" {
		t.Fatalf("manifest paths %v", paths)
	}
	var got []byte
	if c := h.signed("GET", fileURI("Secret/.nk-lock.json", ""), nil, &got); c != 200 || !bytes.Equal(got, marker) {
		t.Fatalf("marker get %d %s", c, got)
	}
	if c := h.signed("PUT", fileURI("Secret/.nk-lock.json", "&base="+BodySHA(marker)), []byte("not json"), nil); c != 400 {
		t.Fatalf("invalid marker %d", c)
	}
}

func TestWebDAV(t *testing.T) {
	h := newHarness(t)
	creds, err := h.s.NewWebDAV("Remotely Save")
	if err != nil {
		t.Fatal(err)
	}
	user, pass := creds["username"].(string), creds["password"].(string)
	do := func(method, p string, body string, hdr map[string]string, auth bool) (int, string) {
		req, _ := http.NewRequest(method, h.srv.URL+"/nk-sync/dav/"+p, strings.NewReader(body))
		if auth {
			req.SetBasicAuth(user, pass)
		}
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	if c, _ := do("PROPFIND", "", "", map[string]string{"Depth": "1"}, false); c != 401 {
		t.Fatalf("unauthenticated %d", c)
	}
	os.MkdirAll(filepath.Join(h.v.Root(), ".obsidian"), 0o700)
	if c, _ := do("MKCOL", "Folder", "", nil, true); c != 201 {
		t.Fatalf("mkcol %d", c)
	}
	if c, _ := do("PUT", "Folder/Note.md", "# hi from webdav", nil, true); c != 201 && c != 204 {
		t.Fatalf("put %d", c)
	}
	if b, _ := os.ReadFile(filepath.Join(h.v.Root(), "Folder", "Note.md")); string(b) != "# hi from webdav" {
		t.Fatalf("content %q", b)
	}
	c, listing := do("PROPFIND", "", "", map[string]string{"Depth": "1"}, true)
	if c != 207 || !strings.Contains(listing, "Folder") || strings.Contains(listing, ".obsidian") {
		t.Fatalf("propfind %d %s", c, listing)
	}
	if c, b := do("GET", "Folder/Note.md", "", nil, true); c != 200 || b != "# hi from webdav" {
		t.Fatalf("get %d", c)
	}
	if c, _ := do("GET", ".obsidian/app.json", "", nil, true); c != 404 {
		t.Fatalf("hidden get %d", c)
	}
	if c, _ := do("MOVE", "Folder/Note.md", "", map[string]string{"Destination": h.srv.URL + "/nk-sync/dav/Folder/Renamed.md"}, true); c != 201 && c != 204 {
		t.Fatalf("move %d", c)
	}
	// Encrypted folder refuses plaintext.
	os.MkdirAll(filepath.Join(h.v.Root(), "Secret"), 0o700)
	os.WriteFile(filepath.Join(h.v.Root(), "Secret", vault.LockMarker), []byte("{}"), 0o600)
	if c, _ := do("PUT", "Secret/p.md", "plain", nil, true); c < 400 {
		t.Fatalf("plaintext into locked folder via webdav %d", c)
	}
	if _, err := os.Stat(filepath.Join(h.v.Root(), "Secret", "p.md")); err == nil {
		t.Fatal("plaintext landed")
	}
	if c, _ := do("DELETE", "Folder/Renamed.md", "", nil, true); c != 204 {
		t.Fatalf("delete %d", c)
	}
	if _, err := os.Stat(filepath.Join(h.v.Root(), "Folder", "Renamed.md")); err == nil {
		t.Fatal("not deleted")
	}
	// A sync device cannot use WebDAV and vice versa.
	h.dev, h.sec = user, pass
	if c := h.signed("GET", "/nk-sync/v1/whoami", nil, nil); c != 401 {
		t.Fatal("webdav device used the sync API")
	}
}

func TestCloudMirrorWithLocalRemote(t *testing.T) {
	if _, err := exec.LookPath("rclone"); err != nil {
		t.Skip("rclone not installed")
	}
	h := newHarness(t)
	remoteDir := t.TempDir()
	conf := filepath.Join(t.TempDir(), "rclone.conf")
	os.WriteFile(conf, []byte("[testlocal]\ntype = local\n"), 0o600)
	t.Setenv("RCLONE_CONFIG", conf)
	os.WriteFile(filepath.Join(h.v.Root(), "Local.md"), []byte("local"), 0o600)
	os.MkdirAll(filepath.Join(remoteDir, "mirror"), 0o700)
	os.WriteFile(filepath.Join(remoteDir, "mirror", "Remote.md"), []byte("remote"), 0o600)

	ctx := context.Background()
	rs, err := h.s.Remotes(ctx)
	if err != nil || len(rs) != 1 || rs[0].Name != "testlocal:" {
		t.Fatalf("remotes %v %v", rs, err)
	}
	if _, err := h.s.SetCloud(ctx, CloudConfig{Remote: "nope:", Enabled: true}); err == nil {
		t.Fatal("unknown remote accepted")
	}
	if _, err := h.s.SetCloud(ctx, CloudConfig{Remote: "testlocal:", Path: filepath.Join(remoteDir, "mirror"), IntervalMin: 60}); err != nil {
		t.Fatal(err)
	}
	h.s.cloud.run(ctx) // first run: --resync union merge
	st := h.s.CloudState()
	if !st.LastOK || !st.Resynced {
		t.Fatalf("first run failed: %s", st.Log)
	}
	if b, _ := os.ReadFile(filepath.Join(h.v.Root(), "Remote.md")); string(b) != "remote" {
		t.Fatal("remote file not pulled")
	}
	if b, _ := os.ReadFile(filepath.Join(remoteDir, "mirror", "Local.md")); string(b) != "local" {
		t.Fatal("local file not pushed")
	}
	// Second run propagates a delete made on the remote side.
	os.Remove(filepath.Join(remoteDir, "mirror", "Remote.md"))
	h.s.cloud.run(ctx)
	if st := h.s.CloudState(); !st.LastOK {
		t.Fatalf("second run failed: %s", st.Log)
	}
	if _, err := os.Stat(filepath.Join(h.v.Root(), "Remote.md")); err == nil {
		t.Fatal("remote delete not propagated")
	}
}
