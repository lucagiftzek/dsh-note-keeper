package importer

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

func TestNotionCleanPathStripsHexSuffix(t *testing.T) {
	used := map[string]struct{}{}
	got := notionCleanPath("Project Notes 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d/Sub Page 0011223344556677889900aabbccddee.md", used)
	want := "Project Notes/Sub Page.md"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestNotionCleanPathResolvesCollisions(t *testing.T) {
	used := map[string]struct{}{}
	a := notionCleanPath("Notes 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.md", used)
	b := notionCleanPath("Notes 00112233445566778899aabbccddeeff.md", used)
	if a == b {
		t.Fatalf("collision not resolved: both %q", a)
	}
	if a != "Notes.md" || b != "Notes 1.md" {
		t.Fatalf("a=%q b=%q", a, b)
	}
}

func TestDetectNotionRequiresHexSuffix(t *testing.T) {
	plain := &zipFileList{names: []string{"readme.md", "notes/plain.md"}}
	if detectNotion(plain.files()) {
		t.Fatal("plain export misdetected as Notion")
	}
	notion := &zipFileList{names: []string{"Page One 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.md"}}
	if !detectNotion(notion.files()) {
		t.Fatal("Notion export not detected")
	}
}

// zipFileList builds *zip.File values (names only, matched against a real
// zip.Reader) so detectNotion/notionCleanPath tests do not need a full
// archive round-trip just to exercise name matching.
type zipFileList struct{ names []string }

func (z *zipFileList) files() []*zip.File {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, n := range z.names {
		zw.Create(n)
	}
	zw.Close()
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		panic(err)
	}
	return zr.File
}

func TestNotionExportRewritesLinksAndEmbeds(t *testing.T) {
	v := newVault(t)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	hex1 := "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d"
	hex2 := "00112233445566778899aabbccddeeff"
	hex3 := "aabbccddeeff00112233445566778899"

	main, _ := zw.Create("Main Page " + hex1 + ".md")
	main.Write([]byte("See [Other Page](Other%20Page%20" + hex2 + ".md) and ![diagram](Main%20Page%20" + hex1 + "/diagram%20" + hex3 + ".png)."))

	other, _ := zw.Create("Other Page " + hex2 + ".md")
	other.Write([]byte("Just some content."))

	img, _ := zw.Create("Main Page " + hex1 + "/diagram " + hex3 + ".png")
	img.Write([]byte("fake-png"))
	zw.Close()

	rep, err := Run(v, "", "Notion Export.zip", buf.Bytes(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes != 2 || rep.Attachments != 1 {
		t.Fatalf("rep = %+v", rep)
	}
	if _, _, err := v.Resolve("Main Page.md", false); err != nil {
		t.Fatalf("Main Page.md not found: %v", err)
	}
	if _, _, err := v.Resolve("Other Page.md", false); err != nil {
		t.Fatalf("Other Page.md not found: %v", err)
	}
	if _, _, err := v.Resolve("Main Page/diagram.png", false); err != nil {
		t.Fatalf("diagram.png not found: %v", err)
	}
	body := mustRead(t, v, "Main Page.md")
	if !strings.Contains(body, "[[Other Page]]") {
		t.Errorf("wikilink not rewritten: %s", body)
	}
	if !strings.Contains(body, "![[Main Page/diagram.png]]") {
		t.Errorf("image embed not rewritten: %s", body)
	}
}

func TestNotionCSVDatabaseExport(t *testing.T) {
	v := newVault(t)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	hex1 := "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d"
	md, _ := zw.Create("Tasks " + hex1 + ".md")
	md.Write([]byte("A database page."))
	csvf, _ := zw.Create("Tasks " + hex1 + "_all/Tasks " + hex1 + "_all.csv")
	csvf.Write([]byte("Name,Status\nBuy milk,Done\n"))
	zw.Close()

	rep, err := Run(v, "", "Notion Export.zip", buf.Bytes(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Notes < 2 {
		t.Fatalf("rep = %+v", rep)
	}
	if _, _, err := v.Resolve("Tasks.md", false); err != nil {
		t.Fatalf("Tasks.md missing: %v", err)
	}
}
