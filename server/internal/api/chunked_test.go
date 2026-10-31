package api

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// chunked helpers on top of the shared harness.
type upBegin struct {
	ID       string `json:"id"`
	ChunkMax int64  `json:"chunkMax"`
}

func (h *harness) begin(t *testing.T, name, dir string, size int64, encrypted int) upBegin {
	t.Helper()
	var out upBegin
	code := h.do("POST", "/attachment/begin", map[string]any{"name": name, "dir": dir, "size": size, "encrypted": encrypted}, &out)
	if code != 200 {
		t.Fatalf("begin %d %+v", code, out)
	}
	return out
}

func (h *harness) chunk(t *testing.T, id string, part []byte) int {
	t.Helper()
	req, _ := http.NewRequest("POST", h.srv.URL+"/attachment/chunk?id="+id, bytes.NewReader(part))
	req.Header.Set("X-NK-Secret", secret)
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	t.Logf("chunk %d bytes -> %d %s", len(part), res.StatusCode, strings.TrimSpace(string(b)))
	return res.StatusCode
}

func (h *harness) stagingFiles(t *testing.T) []string {
	t.Helper()
	var out []string
	_ = filepath.Walk(h.v.Root(), func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && strings.HasPrefix(info.Name(), ".nk-up-") {
			out = append(out, p)
		}
		return nil
	})
	return out
}

func TestChunkedUploadRoundTrip(t *testing.T) {
	h := newHarness(t)
	blob := []byte("The quick brown fox jumps over the lazy dog. 0123456789")
	up := h.begin(t, "big note.zip", "attachments", int64(len(blob)), 0)
	if up.ChunkMax != MaxChunkBytes {
		t.Fatalf("chunkMax %d", up.ChunkMax)
	}
	// Three chunks: split the blob.
	if c := h.chunk(t, up.ID, blob[:10]); c != 200 {
		t.Fatalf("chunk1 %d", c)
	}
	// While in flight the staging file is hidden from the tree.
	var tree struct {
		Entries []struct {
			Path string `json:"path"`
		} `json:"entries"`
	}
	h.do("GET", "/tree", nil, &tree)
	for _, e := range tree.Entries {
		if strings.Contains(e.Path, ".nk-up-") {
			t.Fatalf("staging visible in tree: %s", e.Path)
		}
	}
	if len(h.stagingFiles(t)) != 1 {
		t.Fatalf("expected one staging file, got %v", h.stagingFiles(t))
	}
	if c := h.chunk(t, up.ID, blob[10:30]); c != 200 {
		t.Fatalf("chunk2 %d", c)
	}
	if c := h.chunk(t, up.ID, blob[30:]); c != 200 {
		t.Fatalf("chunk3 %d", c)
	}
	var done struct {
		Path  string `json:"path"`
		Bytes int64  `json:"bytes"`
		Name  string `json:"name"`
	}
	if c := h.do("POST", "/attachment/finish", map[string]any{"id": up.ID}, &done); c != 200 {
		t.Fatalf("finish %d", c)
	}
	if done.Path != "attachments/big note.zip" || done.Bytes != int64(len(blob)) {
		t.Fatalf("finish %+v", done)
	}
	got, _, err := h.v.Read(done.Path, 0)
	if err != nil || !bytes.Equal(got, blob) {
		t.Fatalf("read back: %v, %d bytes", err, len(got))
	}
	if files := h.stagingFiles(t); len(files) != 0 {
		t.Fatalf("staging left behind: %v", files)
	}
}

func TestChunkedUploadRejectsOversize(t *testing.T) {
	h := newHarness(t)
	var out map[string]any
	code := h.do("POST", "/attachment/begin", map[string]any{"name": "huge.zip", "dir": "attachments", "size": DefaultMaxAttachmentBytes + 1}, &out)
	if code != 413 || out["code"] != "too_large" {
		t.Fatalf("oversize begin %d %v", code, out)
	}
	code = h.do("POST", "/attachment/begin", map[string]any{"name": "zero.bin", "dir": "attachments", "size": 0}, &out)
	if code != 400 {
		t.Fatalf("zero size begin %d", code)
	}
}

func TestChunkedUploadExceedsDeclared(t *testing.T) {
	h := newHarness(t)
	up := h.begin(t, "small.bin", "attachments", 10, 0)
	if c := h.chunk(t, up.ID, bytes.Repeat([]byte("a"), 20)); c != 413 {
		t.Fatalf("overflow chunk %d", c)
	}
	// Session is dropped: next chunk 404, staging removed.
	if c := h.chunk(t, up.ID, []byte("x")); c != 404 {
		t.Fatalf("chunk after drop %d", c)
	}
	if files := h.stagingFiles(t); len(files) != 0 {
		t.Fatalf("staging left behind: %v", files)
	}
}

func TestChunkedFinishIncomplete(t *testing.T) {
	h := newHarness(t)
	up := h.begin(t, "partial.bin", "attachments", 100, 0)
	h.chunk(t, up.ID, bytes.Repeat([]byte("b"), 40))
	var out map[string]any
	code := h.do("POST", "/attachment/finish", map[string]any{"id": up.ID}, &out)
	if code != 400 {
		t.Fatalf("incomplete finish %d %v", code, out)
	}
	if files := h.stagingFiles(t); len(files) != 0 {
		t.Fatalf("staging left behind: %v", files)
	}
}

func TestChunkedAbort(t *testing.T) {
	h := newHarness(t)
	up := h.begin(t, "gone.bin", "attachments", 50, 0)
	h.chunk(t, up.ID, bytes.Repeat([]byte("c"), 10))
	var out map[string]any
	if c := h.do("DELETE", "/attachment/abort?id="+up.ID, nil, &out); c != 200 || out["ok"] != true {
		t.Fatalf("abort %d %v", c, out)
	}
	if files := h.stagingFiles(t); len(files) != 0 {
		t.Fatalf("staging left behind: %v", files)
	}
	if c := h.do("POST", "/attachment/finish", map[string]any{"id": up.ID}, &out); c != 404 {
		t.Fatalf("finish after abort %d", c)
	}
}

func TestChunkedLockedFolderRules(t *testing.T) {
	h := newHarness(t)
	vault := filepath.Join(h.v.Root(), "Vault")
	if err := os.MkdirAll(vault, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := `{"v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt":"AAAA","iv":"AAAA","verifier":"AAAA"}`
	if err := os.WriteFile(filepath.Join(vault, ".nk-lock.json"), []byte(marker), 0o600); err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	// Plaintext into a locked folder is refused at begin (fail fast).
	code := h.do("POST", "/attachment/begin", map[string]any{"name": "plain.zip", "dir": "Vault/attachments", "size": 10, "encrypted": 0}, &out)
	if code != 403 || out["code"] != "locked" {
		t.Fatalf("plaintext into locked folder: %d %v", code, out)
	}
	// A sealed blob (encrypted=1) is allowed.
	up := h.begin(t, "enc-abc123.nkenc", "Vault/attachments", 4, 1)
	if c := h.chunk(t, up.ID, []byte("NKE1")); c != 200 {
		t.Fatalf("sealed chunk %d", c)
	}
	var done struct{ Path string }
	if c := h.do("POST", "/attachment/finish", map[string]any{"id": up.ID}, &done); c != 200 {
		t.Fatalf("sealed finish %d", c)
	}
	if done.Path != "Vault/attachments/enc-abc123.nkenc" {
		t.Fatalf("sealed path %q", done.Path)
	}
}

// TestChunkedAcceptsOver200MB pins the regression this change fixes: the old
// single-shot cap was 200 MB; the new default cap is 1 GiB and a chunked upload
// just above the old limit must succeed.
func TestChunkedAcceptsOver200MB(t *testing.T) {
	if testing.Short() {
		t.Skip("writes 200+ MB")
	}
	h := newHarness(t)
	size := int64(200<<20) + 1
	up := h.begin(t, "big.bin", "attachments", size, 0)
	pattern := bytes.Repeat([]byte("0123456789abcdef"), 4<<20) // 64 MiB
	sent := int64(0)
	for sent < size {
		n := size - sent
		if n > int64(len(pattern)) {
			n = int64(len(pattern))
		}
		if c := h.chunk(t, up.ID, pattern[:n]); c != 200 {
			t.Fatalf("chunk at %d -> %d", sent, c)
		}
		sent += n
	}
	var done struct {
		Path  string `json:"path"`
		Bytes int64  `json:"bytes"`
	}
	if c := h.do("POST", "/attachment/finish", map[string]any{"id": up.ID}, &done); c != 200 {
		t.Fatalf("finish %d", c)
	}
	if done.Bytes != size || done.Path != "attachments/big.bin" {
		t.Fatalf("finish %+v", done)
	}
	st, err := h.v.Stat(done.Path)
	if err != nil || st.Size != size {
		t.Fatalf("stat %+v %v", st, err)
	}
}
