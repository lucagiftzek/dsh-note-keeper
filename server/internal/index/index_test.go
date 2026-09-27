package index

import "testing"

func build() *Index {
	ix := New()
	ix.Update("Projects/Alpha.md", []byte("---\ntags: [work]\n---\n# Alpha\nMeeting notes about the rocket launch. See [[Beta]] and [[Missing]].\n![[attachments/pic.png]]"), 10, 1)
	ix.Update("Beta.md", []byte("# Beta\nΚαλημέρα κόσμε! #greek #work/sub Links back to [[Projects/Alpha]]."), 20, 1)
	ix.Update("attachments/pic.png", nil, 5, 100)
	ix.Update("Vault/Secret.md", []byte("---\nnk-encrypted: v1\n---\nrocket"), 30, 1)
	return ix
}

func TestSearchFoldingPrefixPhrases(t *testing.T) {
	ix := build()
	if h := ix.Search("καλημερα", SearchOpts{}); len(h) != 1 || h[0].Path != "Beta.md" {
		t.Fatalf("greek folded search: %+v", h)
	}
	if h := ix.Search("ΚΑΛΗΜΈΡΑ", SearchOpts{}); len(h) != 1 {
		t.Fatalf("greek upper accent search: %+v", h)
	}
	if h := ix.Search("roc", SearchOpts{}); len(h) != 1 || h[0].Path != "Projects/Alpha.md" {
		t.Fatalf("prefix search (encrypted must not match): %+v", h)
	}
	if h := ix.Search("rocket meeting", SearchOpts{}); len(h) != 1 {
		t.Fatalf("AND search: %+v", h)
	}
	if h := ix.Search("rocket beta-nothing", SearchOpts{}); len(h) != 0 {
		t.Fatalf("AND miss: %+v", h)
	}
	if h := ix.Search(`"rocket launch"`, SearchOpts{}); len(h) != 1 {
		t.Fatalf("phrase: %+v", h)
	}
	if h := ix.Search(`"launch rocket"`, SearchOpts{}); len(h) != 0 {
		t.Fatalf("phrase order: %+v", h)
	}
	h := ix.Search("κοσμε", SearchOpts{})
	if len(h) != 1 || h[0].Snippet == "" || !contains(h[0].Snippet, "κόσμε") {
		t.Fatalf("snippet should show original accents: %+v", h)
	}
	if h := ix.Search("", SearchOpts{Tag: "work"}); len(h) != 2 {
		t.Fatalf("tag filter incl nested: %+v", h)
	}
	if h := ix.Search("", SearchOpts{Folder: "Projects"}); len(h) != 1 {
		t.Fatalf("folder filter: %+v", h)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || index(s, sub) >= 0)
}
func index(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestLinksBacklinksGraph(t *testing.T) {
	ix := build()
	if got := ix.Resolve("Projects/Alpha.md", "Beta"); got != "Beta.md" {
		t.Fatalf("resolve by base name: %q", got)
	}
	if got := ix.Resolve("Beta.md", "Projects/Alpha"); got != "Projects/Alpha.md" {
		t.Fatalf("resolve by path: %q", got)
	}
	bl := ix.Backlinks("Beta.md")
	if len(bl) != 1 || bl[0].Path != "Projects/Alpha.md" {
		t.Fatalf("backlinks %+v", bl)
	}
	nodes, edges := ix.Graph(false)
	kinds := map[string]string{}
	for _, n := range nodes {
		kinds[n.ID] = n.Kind
	}
	if kinds["ghost:Missing"] != "ghost" || kinds["attachments/pic.png"] != "attachment" || kinds["Vault/Secret.md"] != "note" {
		t.Fatalf("graph nodes %v", kinds)
	}
	if len(edges) != 4 {
		t.Fatalf("edges %+v", edges)
	}
	if _, e2 := ix.Graph(true); len(e2) != 7 {
		t.Fatalf("tag edges %d", len(e2))
	}
	if l := ix.LinkersOf("Beta.md"); len(l) != 1 {
		t.Fatalf("linkers %v", l)
	}
}

func TestUpdateRemoveTagsStats(t *testing.T) {
	ix := build()
	tags := ix.Tags()
	if len(tags) != 3 || tags[0].Tag != "work" && tags[0].Count != 1 {
		t.Fatalf("tags %+v", tags)
	}
	ix.Update("Beta.md", []byte("replaced"), 40, 1)
	if h := ix.Search("καλημερα", SearchOpts{}); len(h) != 0 {
		t.Fatal("stale postings after update")
	}
	ix.Remove("Projects")
	if _, ok := ix.Get("Projects/Alpha.md"); ok {
		t.Fatal("folder remove")
	}
	s := ix.Stats()
	if s.Notes != 2 || s.Attachments != 1 || s.Encrypted != 1 {
		t.Fatalf("stats %+v", s)
	}
	if r := ix.Recent(1); len(r) != 1 || r[0].Path != "Beta.md" {
		t.Fatalf("recent %+v", r)
	}
}
