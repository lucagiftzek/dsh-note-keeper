package importer

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/vault"
)

func newVault(t *testing.T) *vault.Vault {
	t.Helper()
	v, err := vault.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func mustRead(t *testing.T, v *vault.Vault, rel string) string {
	t.Helper()
	b, _, err := v.Read(rel, 0)
	if err != nil {
		t.Fatalf("read %q: %v", rel, err)
	}
	return string(b)
}

func TestRunMarkdownAndTxt(t *testing.T) {
	v := newVault(t)
	rep, err := Run(v, "", "note.md", []byte("# Hi\n\nbody"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Format != "markdown" || rep.Notes != 1 {
		t.Fatalf("rep = %+v", rep)
	}
	if got := mustRead(t, v, "note.md"); got != "# Hi\n\nbody" {
		t.Fatalf("content changed: %q", got)
	}

	rep2, err := Run(v, "", "plain.txt", []byte("hello world"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep2.Notes != 1 || rep2.Created[0] != "plain.md" {
		t.Fatalf("rep2 = %+v", rep2)
	}
	if got := mustRead(t, v, "plain.md"); got != "hello world" {
		t.Fatalf("txt content changed: %q", got)
	}
}

func TestRunIntoDestFolder(t *testing.T) {
	v := newVault(t)
	rep, err := Run(v, "Imports/2024", "a.md", []byte("x"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Created) != 1 || rep.Created[0] != "Imports/2024/a.md" {
		t.Fatalf("rep.Created = %v", rep.Created)
	}
}

func TestRunCollisionUsesUniquePath(t *testing.T) {
	v := newVault(t)
	if _, err := v.Write("dup.md", []byte("existing"), vault.WriteOpts{Create: true}); err != nil {
		t.Fatal(err)
	}
	rep, err := Run(v, "", "dup.md", []byte("new"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 1 || rep.Created[0] != "dup 1.md" {
		t.Fatalf("rep = %+v", rep)
	}
	if got := mustRead(t, v, "dup.md"); got != "existing" {
		t.Fatalf("original overwritten: %q", got)
	}
	if got := mustRead(t, v, "dup 1.md"); got != "new" {
		t.Fatalf("new content missing: %q", got)
	}
}

func TestRunOtherFileIsAttachment(t *testing.T) {
	v := newVault(t)
	rep, err := Run(v, "", "photo.png", []byte{0x89, 0x50, 0x4e, 0x47}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Format != "file" || rep.Attachments != 1 || rep.Notes != 0 {
		t.Fatalf("rep = %+v", rep)
	}
}

func TestRunHTMLFile(t *testing.T) {
	v := newVault(t)
	htmlDoc := "<html><head><title>My Page</title></head><body><h1>Ignored</h1><p>Hello <b>world</b></p></body></html>"
	rep, err := Run(v, "", "export.html", []byte(htmlDoc), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Format != "html" || rep.Notes != 1 {
		t.Fatalf("rep = %+v", rep)
	}
	if rep.Created[0] != "My Page.md" {
		t.Fatalf("Created = %v", rep.Created)
	}
	body := mustRead(t, v, "My Page.md")
	if !strings.Contains(body, "Hello **world**") {
		t.Fatalf("body = %q", body)
	}
}

func TestDetectFormatSniffsContent(t *testing.T) {
	v := newVault(t)
	htmlDoc := []byte("<!DOCTYPE html><html><body><p>hi</p></body></html>")
	rep, err := Run(v, "", "upload", htmlDoc, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Format != "html" {
		t.Fatalf("format = %q, want html", rep.Format)
	}
}

// ---- zip: zip-slip, hidden segments, bombs ---------------------------------

func buildZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestZipSlipAndHiddenSegmentsSkipped(t *testing.T) {
	v := newVault(t)
	z := buildZip(t, map[string]string{
		"../evil.md":     "escape via parent traversal",
		"/abs.md":        "escape via absolute path",
		".obsidian/x.md": "hidden config folder",
		".trash/y.md":    "hidden trash folder",
		"good.md":        "this one is fine",
	})
	rep, err := Run(v, "", "export.zip", z, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 1 || rep.Created[0] != "good.md" {
		t.Fatalf("rep = %+v", rep)
	}
	if len(rep.Skipped) != 4 {
		t.Fatalf("Skipped = %+v", rep.Skipped)
	}
	for _, s := range rep.Skipped {
		if s.Reason == "" {
			t.Errorf("skip %q has empty reason", s.Path)
		}
	}
	// Nothing must have escaped the vault root.
	entries, err := v.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Path != "good.md" {
		t.Fatalf("vault entries = %+v", entries)
	}
}

func TestZipBombPerEntryLimit(t *testing.T) {
	v := newVault(t)
	z := buildZip(t, map[string]string{
		"huge.md":  strings.Repeat("a", 1000),
		"small.md": "ok",
	})
	rep, err := Run(v, "", "export.zip", z, Options{MaxEntry: 100})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 1 || rep.Created[0] != "small.md" {
		t.Fatalf("rep = %+v", rep)
	}
	found := false
	for _, s := range rep.Skipped {
		if s.Path == "huge.md" {
			found = true
		}
	}
	if !found {
		t.Fatalf("huge.md not skipped: %+v", rep.Skipped)
	}
}

func TestZipBombTotalLimit(t *testing.T) {
	v := newVault(t)
	z := buildZip(t, map[string]string{
		"a.md": strings.Repeat("a", 100),
		"b.md": strings.Repeat("b", 100),
		"c.md": strings.Repeat("c", 100),
	})
	rep, err := Run(v, "", "export.zip", z, Options{MaxTotal: 150})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes >= 3 {
		t.Fatalf("expected at least one entry skipped by total cap, rep = %+v", rep)
	}
	if len(rep.Skipped) == 0 {
		t.Fatalf("expected skips from total size cap")
	}
}

func TestZipMaxEntriesLimit(t *testing.T) {
	v := newVault(t)
	files := map[string]string{}
	for i := 0; i < 5; i++ {
		files[nameForIndex(i)] = "x"
	}
	z := buildZip(t, files)
	rep, err := Run(v, "", "export.zip", z, Options{MaxEntries: 2})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 2 {
		t.Fatalf("rep = %+v", rep)
	}
	if len(rep.Skipped) != 3 {
		t.Fatalf("Skipped = %+v", rep.Skipped)
	}
}

func nameForIndex(i int) string {
	return string(rune('a'+i)) + ".md"
}

func TestZipAttachmentPreservesSubfolder(t *testing.T) {
	v := newVault(t)
	z := buildZip(t, map[string]string{
		"notes/note.md":  "hello",
		"assets/pic.png": "binarydata",
	})
	rep, err := Run(v, "Imported", "export.zip", z, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 1 || rep.Attachments != 1 {
		t.Fatalf("rep = %+v", rep)
	}
	if _, _, err := v.Resolve("Imported/notes/note.md", false); err != nil {
		t.Fatalf("note not at expected path: %v", err)
	}
	if _, _, err := v.Resolve("Imported/assets/pic.png", false); err != nil {
		t.Fatalf("attachment not at expected path: %v", err)
	}
}

func TestRunLockedFolderIsSkippedNotFatal(t *testing.T) {
	v := newVault(t)
	if err := v.Mkdir("Vault-Locked"); err != nil {
		t.Fatal(err)
	}
	if err := v.WriteLockMarker("Vault-Locked", []byte("{}")); err != nil {
		t.Fatal(err)
	}
	rep, err := Run(v, "Vault-Locked", "note.md", []byte("secret"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 0 || len(rep.Skipped) != 1 {
		t.Fatalf("rep = %+v", rep)
	}
}

func TestCSVBecomesMarkdownTable(t *testing.T) {
	v := newVault(t)
	csvData := "name,age\nAda,30\nGrace,85\n"
	z := buildZip(t, map[string]string{"People.csv": csvData})
	rep, err := Run(v, "", "export.zip", z, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 1 || rep.Attachments != 1 {
		t.Fatalf("rep = %+v", rep)
	}
	body := mustRead(t, v, "People.md")
	if !strings.Contains(body, "| name | age |") || !strings.Contains(body, "| Ada | 30 |") {
		t.Fatalf("table body = %q", body)
	}
}
