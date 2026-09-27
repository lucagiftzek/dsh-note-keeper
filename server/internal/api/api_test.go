package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/index"
	"github.com/lucagiftzek/dsh-note-keeper/server/internal/vault"
	"github.com/lucagiftzek/dsh-note-keeper/server/internal/watch"
)

const secret = "test-secret-0123456789"

type harness struct {
	t   *testing.T
	srv *httptest.Server
	v   *vault.Vault
	w   *watch.Watcher
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	v, err := vault.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ix := index.New()
	w := watch.New(v, ix, watch.NewHub())
	w.Scan()
	s := New(Config{Secret: secret, Version: "test"}, v, ix, w)
	s.now = func() time.Time { return time.Date(2026, 9, 28, 9, 30, 0, 0, time.UTC) }
	hs := httptest.NewServer(s.Handler())
	t.Cleanup(hs.Close)
	return &harness{t: t, srv: hs, v: v, w: w}
}

func (h *harness) do(method, path string, body any, out any) int {
	h.t.Helper()
	var rd io.Reader
	ct := "application/json"
	switch b := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(b)
		ct = "application/octet-stream"
	default:
		j, _ := json.Marshal(b)
		rd = bytes.NewReader(j)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, rd)
	req.Header.Set("X-NK-Secret", secret)
	req.Header.Set("Content-Type", ct)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	if out != nil {
		_ = json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode
}

func TestAuthRequired(t *testing.T) {
	h := newHarness(t)
	res, err := http.Get(h.srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatalf("no secret -> %d", res.StatusCode)
	}
	var out map[string]any
	if c := h.do("GET", "/health", nil, &out); c != 200 || out["ok"] != true {
		t.Fatalf("health %d %v", c, out)
	}
}

func TestNoteLifecycle(t *testing.T) {
	h := newHarness(t)
	var created struct {
		Path  string
		Mtime int64
	}
	if c := h.do("POST", "/note/new", map[string]any{"folder": "Work", "title": "Plan: Q4/launch?", "content": "# Plan\nlaunch #work [[Other]]"}, &created); c != 200 {
		t.Fatalf("new %d", c)
	}
	if created.Path != "Work/Plan Q4 launch.md" {
		t.Fatalf("safe title path %q", created.Path)
	}
	var dup struct{ Path string }
	h.do("POST", "/note/new", map[string]any{"folder": "Work", "title": "Plan: Q4/launch?"}, &dup)
	if dup.Path != "Work/Plan Q4 launch 1.md" {
		t.Fatalf("unique path %q", dup.Path)
	}
	var got struct {
		Content string
		Mtime   int64
		Doc     index.Doc
	}
	if c := h.do("GET", "/note?path="+urlq(created.Path), nil, &got); c != 200 || !strings.Contains(got.Content, "launch") || got.Doc.Title != "Plan" {
		t.Fatalf("get %d %+v", c, got)
	}
	var put map[string]any
	if c := h.do("PUT", "/note", map[string]any{"path": created.Path, "content": "v2", "baseMtime": got.Mtime - 1000}, &put); c != 409 || put["content"] == nil {
		t.Fatalf("stale write should 409 with current content: %d %v", c, put)
	}
	if c := h.do("PUT", "/note", map[string]any{"path": created.Path, "content": "v2 #fresh", "baseMtime": got.Mtime}, &put); c != 200 {
		t.Fatalf("put %d %v", c, put)
	}
	if c := h.do("PUT", "/note", map[string]any{"path": "../x.md", "content": "x"}, nil); c != 400 {
		t.Fatalf("traversal %d", c)
	}
	if c := h.do("PUT", "/note", map[string]any{"path": "x.exe", "content": "x"}, nil); c != 400 {
		t.Fatalf("non-md %d", c)
	}
	var s struct{ Hits []index.Hit }
	h.do("GET", "/search?q=fresh", nil, &s)
	if len(s.Hits) != 1 {
		t.Fatalf("search after write %+v", s)
	}
	var tags struct{ Tags []index.TagCount }
	h.do("GET", "/tags", nil, &tags)
	if len(tags.Tags) != 1 || tags.Tags[0].Tag != "fresh" {
		t.Fatalf("tags %+v", tags)
	}
	if c := h.do("DELETE", "/entry?path="+urlq(created.Path), nil, nil); c != 200 {
		t.Fatalf("trash %d", c)
	}
	h.do("GET", "/search?q=fresh", nil, &s)
	if len(s.Hits) != 0 {
		t.Fatal("trashed note still searchable")
	}
}

func TestMoveRewritesLinks(t *testing.T) {
	h := newHarness(t)
	h.do("PUT", "/note", map[string]any{"path": "Old Name.md", "content": "# Old"}, nil)
	h.do("PUT", "/note", map[string]any{"path": "A.md", "content": "see [[Old Name]] and [[Old Name|alias]] and ![[Old Name#sec]] and [[Unrelated]]"}, nil)
	var mv struct{ Rewritten []string }
	if c := h.do("POST", "/move", map[string]any{"from": "Old Name.md", "to": "Sub/New Name.md"}, &mv); c != 200 {
		t.Fatalf("move %d", c)
	}
	var got struct{ Content string }
	h.do("GET", "/note?path=A.md", nil, &got)
	want := "see [[New Name]] and [[New Name|alias]] and ![[New Name#sec]] and [[Unrelated]]"
	if got.Content != want || len(mv.Rewritten) != 1 {
		t.Fatalf("rewrite:\n got %q\nwant %q (%v)", got.Content, want, mv.Rewritten)
	}
	var bl struct{ Backlinks []index.Doc }
	h.do("GET", "/backlinks?path="+urlq("Sub/New Name.md"), nil, &bl)
	if len(bl.Backlinks) != 1 {
		t.Fatalf("backlinks after move %+v", bl)
	}
}

func TestRewriteWikilinksPaths(t *testing.T) {
	got := RewriteWikilinks("[[dir/Old]] [[Old.md]] [[Older]]", "dir/Old.md", "other/New.md")
	if got != "[[other/New]] [[New.md]] [[Older]]" {
		t.Fatalf("got %q", got)
	}
}

func TestCaptureDailyTemplates(t *testing.T) {
	h := newHarness(t)
	var r struct{ Path string }
	h.do("POST", "/capture", map[string]any{"text": "buy milk"}, &r)
	h.do("POST", "/capture", map[string]any{"text": "call Nikos", "todo": true}, &r)
	var got struct{ Content string }
	h.do("GET", "/note?path=Inbox.md", nil, &got)
	if got.Content != "# Inbox\n\n- 2026-09-28 09:30 buy milk\n- [ ] call Nikos\n" {
		t.Fatalf("inbox %q", got.Content)
	}
	h.do("PUT", "/note", map[string]any{"path": "Templates/Daily.md", "content": "# {{date}}\n## Log {{time}}\n"}, nil)
	var d struct {
		Path    string
		Created bool
	}
	h.do("POST", "/daily", map[string]any{}, &d)
	if d.Path != "Daily/2026-09-28.md" || !d.Created {
		t.Fatalf("daily %+v", d)
	}
	h.do("GET", "/note?path="+urlq(d.Path), nil, &got)
	if got.Content != "# 2026-09-28\n## Log 09:30\n" {
		t.Fatalf("daily template %q", got.Content)
	}
	h.do("POST", "/daily", map[string]any{}, &d)
	if d.Created {
		t.Fatal("daily recreated")
	}
	if c := h.do("POST", "/daily", map[string]any{"date": "nope"}, nil); c != 400 {
		t.Fatalf("bad date %d", c)
	}
	var tp struct{ Templates []index.Doc }
	h.do("GET", "/templates", nil, &tp)
	if len(tp.Templates) != 1 {
		t.Fatalf("templates %+v", tp)
	}
}

const envelope = "---\nnk-encrypted: v1\nnk-kdf: PBKDF2-SHA256\n---\n```nk-cipher\nQUJD\n```\n"

func TestFolderLockZeroKnowledge(t *testing.T) {
	h := newHarness(t)
	h.do("POST", "/folder", map[string]any{"path": "Private"}, nil)
	h.do("PUT", "/note", map[string]any{"path": "Private/plain.md", "content": "secret diary"}, nil)
	marker := map[string]any{"kdf": "PBKDF2-SHA256", "iter": 600000, "salt": "c2FsdA==", "iv": "aXY=", "verifier": "dmVy"}
	if c := h.do("POST", "/lock", map[string]any{"folder": "Private", "marker": map[string]any{"salt": "x"}}, nil); c != 400 {
		t.Fatalf("weak marker accepted %d", c)
	}
	if c := h.do("POST", "/lock", map[string]any{"folder": "Private", "marker": marker}, nil); c != 200 {
		t.Fatalf("lock %d", c)
	}
	if c := h.do("PUT", "/note", map[string]any{"path": "Private/new.md", "content": "plaintext"}, nil); c != 403 {
		t.Fatalf("plaintext in locked folder -> %d", c)
	}
	if c := h.do("PUT", "/note", map[string]any{"path": "Private/plain.md", "content": envelope}, nil); c != 200 {
		t.Fatalf("envelope write %d", c)
	}
	var lk struct {
		Locked bool
		Scope  string
		Marker map[string]any
	}
	h.do("GET", "/lock?folder=Private/sub", nil, &lk)
	if !lk.Locked || lk.Scope != "Private" || lk.Marker["verifier"] != "dmVy" {
		t.Fatalf("lock info %+v", lk)
	}
	var s struct{ Hits []index.Hit }
	h.do("GET", "/search?q=diary", nil, &s)
	if len(s.Hits) != 0 {
		t.Fatal("ciphertext note searchable")
	}
	if c := h.do("DELETE", "/lock?folder=Private", nil, nil); c != 409 {
		t.Fatalf("unlock with ciphertext remaining -> %d", c)
	}
	if c := h.do("POST", "/attachment?dir=Private&name=a.png", []byte("PNG"), nil); c != 403 {
		t.Fatalf("plaintext attachment in locked folder -> %d", c)
	}
	h.do("PUT", "/note", map[string]any{"path": "Private/plain.md", "content": envelope}, nil)
	if c := h.do("PUT", "/note", map[string]any{"path": "Private/plain.md", "content": "---\nnk-encrypted: v1\n---\nnot really"}, nil); c != 403 {
		t.Fatalf("fake envelope (no cipher block) accepted -> %d", c)
	}
}

func TestAttachmentsAndFileHeaders(t *testing.T) {
	h := newHarness(t)
	var up struct {
		Path  string
		Bytes int
	}
	if c := h.do("POST", "/attachment?name=photo.PNG", []byte("\x89PNGfake"), &up); c != 200 || up.Path != "attachments/photo.png" {
		t.Fatalf("upload %d %+v", c, up)
	}
	h.do("POST", "/attachment?name=evil.html", []byte("<script>alert(1)</script>"), &up)
	req, _ := http.NewRequest("GET", h.srv.URL+"/file?path="+urlq(up.Path), nil)
	req.Header.Set("X-NK-Secret", secret)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if !strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment") || !strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("html served inline: %v", res.Header)
	}
	req, _ = http.NewRequest("GET", h.srv.URL+"/file?path=attachments/photo.png", nil)
	req.Header.Set("X-NK-Secret", secret)
	req.Header.Set("Range", "bytes=0-3")
	res, _ = http.DefaultClient.Do(req)
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 206 || string(b) != "\x89PNG" || res.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("range %d %q %v", res.StatusCode, b, res.Header.Get("Content-Type"))
	}
	var tr struct {
		Entries []map[string]any
		Locked  []string
	}
	h.do("GET", "/tree", nil, &tr)
	if len(tr.Entries) != 3 { // attachments/, photo.png, evil.html
		t.Fatalf("tree %+v", tr.Entries)
	}
}

func TestOCRWithTesseract(t *testing.T) {
	if _, err := exec.LookPath("tesseract"); err != nil {
		t.Skip("tesseract not installed")
	}
	if _, err := exec.LookPath("convert"); err != nil {
		t.Skip("imagemagick not installed")
	}
	h := newHarness(t)
	img := filepath.Join(h.v.Root(), "ocr.png")
	cmd := exec.Command("convert", "-size", "600x160", "xc:white", "-fill", "black", "-pointsize", "56", "-annotate", "+20+100", "Hello Notes", img)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("convert failed: %s", out)
	}
	var r struct{ Text string }
	if c := h.do("POST", "/ocr", map[string]any{"path": "ocr.png", "lang": "eng"}, &r); c != 200 || !strings.Contains(strings.ToLower(r.Text), "hello") {
		t.Fatalf("ocr %d %q", c, r.Text)
	}
	raw, _ := os.ReadFile(img)
	if c := h.do("POST", "/ocr?lang=eng", raw, &r); c != 200 || !strings.Contains(strings.ToLower(r.Text), "notes") {
		t.Fatalf("raw ocr %d %q", c, r.Text)
	}
}

func TestExternalEditsReachSubscribers(t *testing.T) {
	h := newHarness(t)
	h.w.Debounce = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.w.Run(ctx)
	ch, leave := h.w.Hub.Subscribe()
	defer leave()
	time.Sleep(100 * time.Millisecond)
	// Simulate Obsidian (or a sync client) writing straight to disk.
	if err := os.MkdirAll(filepath.Join(h.v.Root(), "Phone"), 0o700); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if err := os.WriteFile(filepath.Join(h.v.Root(), "Phone", "from-mobile.md"), []byte("synced #mobile"), 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(3 * time.Second)
	for {
		select {
		case ev := <-ch:
			for _, p := range ev.Paths {
				if p == "Phone/from-mobile.md" {
					var s struct{ Hits []index.Hit }
					h.do("GET", "/search?q=synced", nil, &s)
					if len(s.Hits) != 1 {
						t.Fatalf("external edit not indexed: %+v", s)
					}
					return
				}
			}
		case <-deadline:
			t.Fatal("no event for external write")
		}
	}
}

func urlq(s string) string { return strings.ReplaceAll(strings.ReplaceAll(s, " ", "%20"), "#", "%23") }
