package importer

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
)

func TestImportENEXBasicNoteWithFrontmatter(t *testing.T) {
	v := newVault(t)
	enex := "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
		"<en-export>" +
		"<note>" +
		"<title>My Trip</title>" +
		"<content><![CDATA[<en-note><div>Hello <b>world</b></div></en-note>]]></content>" +
		"<created>20230115T101500Z</created>" +
		"<updated>20230116T101500Z</updated>" +
		"<tag>travel</tag><tag>2023</tag>" +
		"<note-attributes><source-url>https://example.com/note</source-url></note-attributes>" +
		"</note>" +
		"</en-export>"
	rep, err := Run(v, "", "export.enex", []byte(enex), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Format != "evernote" || rep.Notes != 1 {
		t.Fatalf("rep = %+v", rep)
	}
	body := mustRead(t, v, "My Trip.md")
	for _, want := range []string{"created: \"2023-01-15T10:15:00Z\"", "updated: \"2023-01-16T10:15:00Z\"", "- travel", "- 2023", "source-url: \"https://example.com/note\"", "source: evernote", "Hello **world**"} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
}

func TestImportENEXTodoAndMediaEmbed(t *testing.T) {
	v := newVault(t)
	imgBytes := []byte("fake-png-bytes")
	sum := md5.Sum(imgBytes)
	hash := hex.EncodeToString(sum[:])
	b64 := base64.StdEncoding.EncodeToString(imgBytes)

	enex := "<?xml version=\"1.0\"?><en-export><note>" +
		"<title>Checklist</title>" +
		"<content><![CDATA[<en-note>" +
		"<div><en-todo checked=\"true\"/>Buy milk</div>" +
		"<div><en-todo checked=\"false\"/>Buy eggs</div>" +
		"<div><en-media hash=\"" + hash + "\" type=\"image/png\"/></div>" +
		"</en-note>]]></content>" +
		"<resource>" +
		"<data encoding=\"base64\">" + b64 + "</data>" +
		"<mime>image/png</mime>" +
		"<resource-attributes><file-name>photo.png</file-name></resource-attributes>" +
		"</resource>" +
		"</note></en-export>"

	rep, err := Run(v, "", "export.enex", []byte(enex), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 1 || rep.Attachments != 1 {
		t.Fatalf("rep = %+v", rep)
	}
	body := mustRead(t, v, "Checklist.md")
	if !strings.Contains(body, "[x] Buy milk") {
		t.Errorf("checked todo missing: %s", body)
	}
	if !strings.Contains(body, "[ ] Buy eggs") {
		t.Errorf("unchecked todo missing: %s", body)
	}
	if !strings.Contains(body, "![[photo.png]]") {
		t.Errorf("media embed missing: %s", body)
	}
	if _, _, err := v.Resolve("attachments/photo.png", false); err != nil {
		t.Fatalf("attachment not saved: %v", err)
	}
	saved := mustRead(t, v, "attachments/photo.png")
	if saved != string(imgBytes) {
		t.Fatalf("saved attachment bytes differ")
	}
}

func TestImportENEXMultipleNotesIndependentFailures(t *testing.T) {
	v := newVault(t)
	enex := "<en-export>" +
		"<note><title>Good One</title><content><![CDATA[<en-note>ok</en-note>]]></content></note>" +
		"<note><title></title><content><![CDATA[<en-note>no title</en-note>]]></content></note>" +
		"</en-export>"
	rep, err := Run(v, "", "x.enex", []byte(enex), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 2 {
		t.Fatalf("rep = %+v", rep)
	}
	if _, _, err := v.Resolve("Good One.md", false); err != nil {
		t.Fatalf("first note missing: %v", err)
	}
	if _, _, err := v.Resolve("Evernote Note 2.md", false); err != nil {
		t.Fatalf("fallback-titled note missing: %v", err)
	}
}

func TestEnexTimeToISO(t *testing.T) {
	got := enexTimeToISO("20230115T101500Z")
	want := "2023-01-15T10:15:00Z"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if enexTimeToISO("") != "" {
		t.Fatal("empty input should yield empty output")
	}
	if enexTimeToISO("garbage") != "" {
		t.Fatal("unparsable input should yield empty output")
	}
}

func TestInvalidENEXIsSkippedNotFatal(t *testing.T) {
	v := newVault(t)
	rep, err := Run(v, "", "broken.enex", []byte("not xml at all"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 0 {
		t.Fatalf("rep = %+v", rep)
	}
	if len(rep.Skipped) == 0 {
		t.Fatalf("expected a skip for the invalid document")
	}
}
