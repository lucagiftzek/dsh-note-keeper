package importer

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

func TestImportKeepPlainNote(t *testing.T) {
	v := newVault(t)
	j := `{
		"title": "Grocery ideas",
		"textContent": "Milk, eggs, bread",
		"labels": [{"name": "Shopping"}, {"name": "Home"}],
		"createdTimestampUsec": 1700000000000000,
		"userEditedTimestampUsec": 1700003600000000,
		"isArchived": false,
		"isTrashed": false
	}`
	rep, err := Run(v, "", "Grocery ideas.json", []byte(j), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Format != "google-keep" || rep.Notes != 1 {
		t.Fatalf("rep = %+v", rep)
	}
	body := mustRead(t, v, "Grocery ideas.md")
	for _, want := range []string{"source: google-keep", "- Shopping", "- Home", "Milk, eggs, bread"} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
}

func TestImportKeepChecklistNote(t *testing.T) {
	v := newVault(t)
	j := `{
		"title": "Packing list",
		"listContent": [
			{"text": "Passport", "isChecked": true},
			{"text": "Sunscreen", "isChecked": false}
		],
		"isTrashed": false
	}`
	rep, err := Run(v, "", "Packing list.json", []byte(j), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 1 {
		t.Fatalf("rep = %+v", rep)
	}
	body := mustRead(t, v, "Packing list.md")
	if !strings.Contains(body, "- [x] Passport") {
		t.Errorf("checked item missing: %s", body)
	}
	if !strings.Contains(body, "- [ ] Sunscreen") {
		t.Errorf("unchecked item missing: %s", body)
	}
}

func TestImportKeepTrashedNoteIsSkipped(t *testing.T) {
	v := newVault(t)
	j := `{"title": "Old note", "textContent": "gone", "isTrashed": true}`
	rep, err := Run(v, "", "Old note.json", []byte(j), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 0 || len(rep.Skipped) != 1 {
		t.Fatalf("rep = %+v", rep)
	}
}

func TestImportKeepArchivedFlagInFrontmatter(t *testing.T) {
	v := newVault(t)
	j := `{"title": "Old but kept", "textContent": "x", "isArchived": true, "isTrashed": false}`
	rep, err := Run(v, "", "a.json", []byte(j), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 1 {
		t.Fatalf("rep = %+v", rep)
	}
	body := mustRead(t, v, "Old but kept.md")
	if !strings.Contains(body, "archived: true") {
		t.Errorf("archived flag missing: %s", body)
	}
}

func TestImportKeepAttachmentFromSameZip(t *testing.T) {
	v := newVault(t)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	noteJSON := `{
		"title": "With photo",
		"textContent": "see attached",
		"attachments": [{"filePath": "photo.jpg", "mimetype": "image/jpeg"}],
		"isTrashed": false
	}`
	w1, _ := zw.Create("note.json")
	w1.Write([]byte(noteJSON))
	w2, _ := zw.Create("photo.jpg")
	w2.Write([]byte("fake-jpeg-bytes"))
	zw.Close()

	rep, err := Run(v, "", "keep-export.zip", buf.Bytes(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	// The photo is imported twice: once as the note's own embedded copy
	// (attachments/photo.jpg) and once as the archive's independent copy of
	// that file (photo.jpg, preserving its own path) -- the zip walker does
	// not know a sibling file was already consumed by a note.
	if rep.Notes != 1 || rep.Attachments != 2 {
		t.Fatalf("rep = %+v", rep)
	}
	body := mustRead(t, v, "With photo.md")
	if !strings.Contains(body, "![[photo.jpg]]") {
		t.Errorf("attachment embed missing: %s", body)
	}
}

func TestImportKeepMissingAttachmentIsSkipped(t *testing.T) {
	v := newVault(t)
	j := `{"title": "Orphan", "textContent": "x", "attachments": [{"filePath": "missing.jpg"}], "isTrashed": false}`
	rep, err := Run(v, "", "Orphan.json", []byte(j), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 1 {
		t.Fatalf("rep = %+v", rep)
	}
	found := false
	for _, s := range rep.Skipped {
		if s.Path == "missing.jpg" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a skip for missing.jpg, got %+v", rep.Skipped)
	}
}

func TestLooksLikeKeepJSONRejectsUnrelatedJSON(t *testing.T) {
	if looksLikeKeepJSON([]byte(`{"hello": "world"}`)) {
		t.Fatal("plain JSON misdetected as Keep note")
	}
	if !looksLikeKeepJSON([]byte(`{"textContent": "x"}`)) {
		t.Fatal("Keep-shaped JSON not detected")
	}
}

func TestNonKeepJSONImportsAsAttachment(t *testing.T) {
	v := newVault(t)
	rep, err := Run(v, "", "config.json", []byte(`{"hello": "world"}`), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Format != "file" || rep.Attachments != 1 || rep.Notes != 0 {
		t.Fatalf("rep = %+v", rep)
	}
}
