package note

import (
	"reflect"
	"testing"
)

func TestParseFrontmatterTagsLinks(t *testing.T) {
	src := "---\ntitle: \"My Note\"\ntags:\n  - work\n  - project/alpha\naliases: [a, b]\n---\n# Heading\nText #inline and #123 not a tag, [[Other Note|alias]] ![[img.png]] [[Deep/Path#sec]]\n[md](Folder/Linked%20Note.md) [web](https://x.y)\n`#notatag [[notalink]]`\n```\n#nope [[nope]]\n```\n"
	p := Parse(src, "file")
	if p.Title != "My Note" {
		t.Errorf("title %q", p.Title)
	}
	if !reflect.DeepEqual(p.Tags, []string{"work", "project/alpha", "inline"}) {
		t.Errorf("tags %v", p.Tags)
	}
	want := []string{"Other Note", "img.png", "Deep/Path", "Folder/Linked Note.md"}
	if !reflect.DeepEqual(p.Links, want) {
		t.Errorf("links %v", p.Links)
	}
	if p.Frontmatter["aliases"] != "a, b" {
		t.Errorf("aliases %q", p.Frontmatter["aliases"])
	}
}

func TestTitleFallbacks(t *testing.T) {
	if p := Parse("# Top\nbody", "f"); p.Title != "Top" {
		t.Errorf("heading title %q", p.Title)
	}
	if p := Parse("no heading", "fname"); p.Title != "fname" {
		t.Errorf("name title %q", p.Title)
	}
	if p := Parse("---\nnk-type: audio\n---\nx", "f"); p.Type != "audio" {
		t.Errorf("type %q", p.Type)
	}
}

func TestEncryptedNeverParsed(t *testing.T) {
	src := "---\nnk-encrypted: v1\ntags: [secret]\n---\n#leak [[Leak]]\n```nk-cipher\nAAAA\n```\n"
	p := Parse(src, "Diary")
	if !p.Encrypted || p.Body != "" || len(p.Tags) != 0 || len(p.Links) != 0 || p.Title != "Diary" {
		t.Fatalf("encrypted parse leaked: %+v", p)
	}
}

func TestSplitFrontmatterEdgeCases(t *testing.T) {
	if _, b, ok := SplitFrontmatter("---\nunterminated"); ok || b != "---\nunterminated" {
		t.Error("unterminated fm")
	}
	if fm, b, ok := SplitFrontmatter("\ufeff---\r\na: 1\r\n---\r\nbody"); !ok || b != "body" || fm == "" {
		t.Errorf("crlf/bom fm: %q %q %v", fm, b, ok)
	}
}

func TestFoldGreekLatin(t *testing.T) {
	cases := map[string]string{"Καλημέρα": "καλημερα", "ΚΑΛΗΜΕΡΑ": "καλημερα", "λόγος": "λογοσ", "Ϊλιάδα": "ιλιαδα", "Perché Città": "perche citta"}
	for in, want := range cases {
		if got := Fold(in); got != want {
			t.Errorf("Fold(%q)=%q want %q", in, got, want)
		}
	}
	if got := Tokens("Γειά σου, κόσμε! a x2 test"); !reflect.DeepEqual(got, []string{"γεια", "σου", "κοσμε", "x2", "test"}) {
		t.Errorf("tokens %v", got)
	}
}
