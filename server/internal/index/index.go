// Package index keeps an in-memory, incrementally updated view of the vault:
// per-note metadata, a folded inverted index for full-text search (Greek and
// Latin accents folded), tags, resolved links, backlinks and the link graph.
//
// Concurrency: one RWMutex guards all maps. Updates are cheap (one note is
// re-parsed at a time) so the watcher can call Update on every change.
package index

import (
	"path"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/note"
)

// Doc is the indexed view of one vault file.
type Doc struct {
	Path      string   `json:"path"`
	Title     string   `json:"title"`
	Kind      string   `json:"kind"` // note | attachment
	Type      string   `json:"type,omitempty"`
	Tags      []string `json:"tags,omitempty"`
	Links     []string `json:"links,omitempty"` // raw targets
	Encrypted bool     `json:"encrypted,omitempty"`
	Pinned    bool     `json:"pinned,omitempty"`
	Mtime     int64    `json:"mtime"`
	Size      int64    `json:"size"`

	folded string // folded title + body, kept for snippets
	body   string
	terms  map[string]int
}

// Index is the searchable vault model.
type Index struct {
	mu       sync.RWMutex
	docs     map[string]*Doc
	postings map[string]map[string]int // term -> path -> tf
}

// New returns an empty index.
func New() *Index {
	return &Index{docs: map[string]*Doc{}, postings: map[string]map[string]int{}}
}

// IsNote reports whether a path is a Markdown note.
func IsNote(p string) bool { return strings.EqualFold(path.Ext(p), ".md") }

// Update (re)indexes one file. content is ignored for attachments.
func (ix *Index) Update(p string, content []byte, mtime, size int64) {
	d := &Doc{Path: p, Mtime: mtime, Size: size, Kind: "attachment", Title: path.Base(p)}
	if IsNote(p) {
		d.Kind = "note"
		parsed := note.Parse(string(content), note.BaseName(p))
		d.Title = parsed.Title
		d.Type = parsed.Type
		d.Tags = parsed.Tags
		d.Links = parsed.Links
		d.Encrypted = parsed.Encrypted
		d.Pinned = parsed.Frontmatter["pinned"] == "true"
		d.body = parsed.Body
	}
	d.folded = note.Fold(d.Title + "\n" + d.body)
	d.terms = map[string]int{}
	for _, t := range note.Tokens(d.Title + " " + note.BaseName(p)) {
		d.terms[t] += 5 // title/file-name hits weigh more
	}
	for _, t := range note.Tokens(d.body) {
		d.terms[t]++
	}
	for _, t := range d.Tags {
		for _, tt := range note.Tokens(t) {
			d.terms[tt] += 3
		}
	}
	ix.mu.Lock()
	defer ix.mu.Unlock()
	ix.removeLocked(p)
	ix.docs[p] = d
	for t, n := range d.terms {
		m := ix.postings[t]
		if m == nil {
			m = map[string]int{}
			ix.postings[t] = m
		}
		m[p] = n
	}
}

// Remove drops a file (or, when p is a folder, everything below it).
func (ix *Index) Remove(p string) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	ix.removeLocked(p)
	prefix := p + "/"
	for k := range ix.docs {
		if strings.HasPrefix(k, prefix) {
			ix.removeLocked(k)
		}
	}
}

func (ix *Index) removeLocked(p string) {
	old := ix.docs[p]
	if old == nil {
		return
	}
	for t := range old.terms {
		if m := ix.postings[t]; m != nil {
			delete(m, p)
			if len(m) == 0 {
				delete(ix.postings, t)
			}
		}
	}
	delete(ix.docs, p)
}

// Paths returns every indexed path (for rescans).
func (ix *Index) Paths() []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := make([]string, 0, len(ix.docs))
	for k := range ix.docs {
		out = append(out, k)
	}
	return out
}

// Get returns a copy of one doc.
func (ix *Index) Get(p string) (Doc, bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	d, ok := ix.docs[p]
	if !ok {
		return Doc{}, false
	}
	return d.public(), true
}

func (d *Doc) public() Doc {
	c := *d
	c.folded, c.body, c.terms = "", "", nil
	return c
}

// All returns every doc (public copies), sorted by path.
func (ix *Index) All() []Doc {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := make([]Doc, 0, len(ix.docs))
	for _, d := range ix.docs {
		out = append(out, d.public())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// Recent returns notes sorted by modification time, newest first.
func (ix *Index) Recent(limit int) []Doc {
	all := ix.All()
	notes := all[:0]
	for _, d := range all {
		if d.Kind == "note" {
			notes = append(notes, d)
		}
	}
	sort.SliceStable(notes, func(i, j int) bool { return notes[i].Mtime > notes[j].Mtime })
	if limit > 0 && len(notes) > limit {
		notes = notes[:limit]
	}
	return notes
}

// Hit is one search result.
type Hit struct {
	Doc
	Score   int    `json:"score"`
	Snippet string `json:"snippet"`
}

// SearchOpts filters a search.
type SearchOpts struct {
	Tag    string // exact tag (case-insensitive), nested tags match children
	Folder string // restrict to a folder prefix
	Kind   string // note | attachment
	Limit  int
}

// Search runs an AND query over folded terms; the last term matches as a
// prefix so results appear while the user is still typing. "quoted phrases"
// must also appear verbatim (folded) in the text.
func (ix *Index) Search(q string, o SearchOpts) []Hit {
	phrases, rest := splitPhrases(q)
	terms := note.Tokens(rest)
	for _, ph := range phrases {
		terms = append(terms, note.Tokens(ph)...)
	}
	if o.Limit <= 0 || o.Limit > 500 {
		o.Limit = 50
	}
	ix.mu.RLock()
	defer ix.mu.RUnlock()

	var cand map[string]int
	if len(terms) == 0 {
		if o.Tag == "" && o.Folder == "" && o.Kind == "" {
			return nil
		}
		cand = map[string]int{}
		for p := range ix.docs {
			cand[p] = 1
		}
	}
	for i, t := range terms {
		prefix := i == len(terms)-1 && len(phrases) == 0
		matched := map[string]int{}
		if m := ix.postings[t]; m != nil {
			for p, n := range m {
				matched[p] += n * 2 // exact term beats prefix
			}
		}
		if prefix {
			for term, m := range ix.postings {
				if term != t && strings.HasPrefix(term, t) {
					for p, n := range m {
						matched[p] += n
					}
				}
			}
		}
		if cand == nil {
			cand = matched
			continue
		}
		for p := range cand {
			if s, ok := matched[p]; ok {
				cand[p] += s
			} else {
				delete(cand, p)
			}
		}
	}
	var hits []Hit
	tagF := strings.ToLower(strings.TrimPrefix(o.Tag, "#"))
	for p, score := range cand {
		d := ix.docs[p]
		if d == nil {
			continue
		}
		if o.Kind != "" && d.Kind != o.Kind {
			continue
		}
		if o.Folder != "" && !strings.HasPrefix(p, strings.TrimSuffix(o.Folder, "/")+"/") {
			continue
		}
		if tagF != "" && !hasTag(d.Tags, tagF) {
			continue
		}
		ok := true
		for _, ph := range phrases {
			if !strings.Contains(d.folded, note.Fold(ph)) {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		hits = append(hits, Hit{Doc: d.public(), Score: score, Snippet: snippet(d, terms)})
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].Mtime > hits[j].Mtime
	})
	if len(hits) > o.Limit {
		hits = hits[:o.Limit]
	}
	return hits
}

func hasTag(tags []string, want string) bool {
	for _, t := range tags {
		lt := strings.ToLower(t)
		if lt == want || strings.HasPrefix(lt, want+"/") {
			return true
		}
	}
	return false
}

func splitPhrases(q string) ([]string, string) {
	var phrases []string
	var rest strings.Builder
	for {
		i := strings.IndexByte(q, '"')
		if i < 0 {
			rest.WriteString(q)
			break
		}
		j := strings.IndexByte(q[i+1:], '"')
		if j < 0 {
			rest.WriteString(q)
			break
		}
		rest.WriteString(q[:i])
		rest.WriteByte(' ')
		if ph := strings.TrimSpace(q[i+1 : i+1+j]); ph != "" {
			phrases = append(phrases, ph)
		}
		q = q[i+j+2:]
	}
	return phrases, rest.String()
}

// snippet returns ~180 characters of the ORIGINAL text around the first
// matched term. Matching happens on the folded form; a parallel rune map
// translates the folded position back. Encrypted notes never produce one.
func snippet(d *Doc, terms []string) string {
	if d.Encrypted || d.body == "" {
		return ""
	}
	raw := []rune(d.body)
	folded := make([]rune, 0, len(raw))
	back := make([]int, 0, len(raw)) // folded rune index -> raw rune index
	for i, r := range raw {
		f := []rune(note.Fold(string(r)))
		for _, fr := range f {
			folded = append(folded, fr)
			back = append(back, i)
		}
	}
	fs := string(folded)
	at := -1
	for _, t := range terms {
		if i := strings.Index(fs, t); i >= 0 {
			ri := utf8.RuneCountInString(fs[:i])
			if at < 0 || ri < at {
				at = ri
			}
		}
	}
	rawAt := 0
	if at >= 0 && at < len(back) {
		rawAt = back[at]
	}
	start := rawAt - 60
	if start < 0 {
		start = 0
	}
	end := start + 180
	if end > len(raw) {
		end = len(raw)
	}
	s := strings.Join(strings.Fields(string(raw[start:end])), " ")
	if start > 0 {
		s = "…" + s
	}
	if end < len(raw) {
		s += "…"
	}
	return s
}

// TagCount is a tag with its note count.
type TagCount struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

// Tags returns every tag with its count, most used first.
func (ix *Index) Tags() []TagCount {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	counts := map[string]int{}
	display := map[string]string{}
	for _, d := range ix.docs {
		for _, t := range d.Tags {
			k := strings.ToLower(t)
			counts[k]++
			if _, ok := display[k]; !ok {
				display[k] = t
			}
		}
	}
	out := make([]TagCount, 0, len(counts))
	for k, n := range counts {
		out = append(out, TagCount{Tag: display[k], Count: n})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Tag < out[j].Tag
	})
	return out
}

// Resolve maps a raw link target onto a vault path the way Obsidian does:
// an explicit path first, then the shortest path whose base name matches.
// It returns "" when the target does not exist (an "unresolved" link).
func (ix *Index) Resolve(from, target string) string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.resolveLocked(from, target)
}

func (ix *Index) resolveLocked(from, target string) string {
	t := strings.TrimPrefix(strings.TrimSpace(target), "/")
	if strings.HasPrefix(t, "./") || strings.HasPrefix(t, "../") {
		t = path.Join(path.Dir(from), t)
	}
	cands := []string{t}
	if path.Ext(t) == "" {
		cands = []string{t + ".md", t}
	}
	for _, c := range cands {
		if _, ok := ix.docs[c]; ok {
			return c
		}
		// relative to the linking note's folder
		rel := path.Join(path.Dir(from), c)
		if _, ok := ix.docs[rel]; ok {
			return rel
		}
	}
	base := strings.ToLower(path.Base(cands[0]))
	best := ""
	for p := range ix.docs {
		if strings.ToLower(path.Base(p)) == base && strings.HasSuffix(strings.ToLower(p), strings.ToLower(cands[0])) {
			if best == "" || len(p) < len(best) || (len(p) == len(best) && p < best) {
				best = p
			}
		}
	}
	return best
}

// Backlinks lists notes that link to p.
func (ix *Index) Backlinks(p string) []Doc {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	var out []Doc
	for _, d := range ix.docs {
		if d.Path == p {
			continue
		}
		for _, l := range d.Links {
			if ix.resolveLocked(d.Path, l) == p {
				out = append(out, d.public())
				break
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// GraphNode / GraphEdge describe the link graph.
type GraphNode struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Kind       string   `json:"kind"` // note | attachment | ghost | tag
	Tags       []string `json:"tags,omitempty"`
	Degree     int      `json:"degree"`
	Unresolved bool     `json:"unresolved,omitempty"`
}

type GraphEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

// Graph returns every note, the attachments they embed, unresolved links as
// "ghost" nodes (Obsidian shows them the same way), and optionally tag nodes.
func (ix *Index) Graph(withTags bool) ([]GraphNode, []GraphEdge) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	nodes := map[string]*GraphNode{}
	var edges []GraphEdge
	for _, d := range ix.docs {
		if d.Kind == "note" {
			nodes[d.Path] = &GraphNode{ID: d.Path, Title: d.Title, Kind: "note", Tags: d.Tags}
		}
	}
	seen := map[[2]string]bool{}
	for _, d := range ix.docs {
		if d.Kind != "note" {
			continue
		}
		for _, l := range d.Links {
			tgt := ix.resolveLocked(d.Path, l)
			if tgt == "" {
				tgt = "ghost:" + l
				if nodes[tgt] == nil {
					nodes[tgt] = &GraphNode{ID: tgt, Title: l, Kind: "ghost", Unresolved: true}
				}
			} else if nodes[tgt] == nil {
				nodes[tgt] = &GraphNode{ID: tgt, Title: path.Base(tgt), Kind: "attachment"}
			}
			k := [2]string{d.Path, tgt}
			if tgt == d.Path || seen[k] {
				continue
			}
			seen[k] = true
			edges = append(edges, GraphEdge{Source: d.Path, Target: tgt})
		}
		if withTags {
			for _, t := range d.Tags {
				id := "tag:" + strings.ToLower(t)
				if nodes[id] == nil {
					nodes[id] = &GraphNode{ID: id, Title: "#" + t, Kind: "tag"}
				}
				edges = append(edges, GraphEdge{Source: d.Path, Target: id})
			}
		}
	}
	for _, e := range edges {
		nodes[e.Source].Degree++
		nodes[e.Target].Degree++
	}
	out := make([]GraphNode, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, *n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].Source != edges[j].Source {
			return edges[i].Source < edges[j].Source
		}
		return edges[i].Target < edges[j].Target
	})
	return out, edges
}

// LinkersOf returns notes whose raw links point at the given note base name
// (used to rewrite links after a rename).
func (ix *Index) LinkersOf(p string) []string {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	var out []string
	for _, d := range ix.docs {
		if d.Kind != "note" || d.Encrypted || d.Path == p {
			continue
		}
		for _, l := range d.Links {
			if ix.resolveLocked(d.Path, l) == p {
				out = append(out, d.Path)
				break
			}
		}
	}
	sort.Strings(out)
	return out
}

// Stats summarises the vault.
type Stats struct {
	Notes       int `json:"notes"`
	Attachments int `json:"attachments"`
	Encrypted   int `json:"encrypted"`
	Tags        int `json:"tags"`
	Links       int `json:"links"`
	Terms       int `json:"terms"`
}

// Stats counts what the index holds.
func (ix *Index) Stats() Stats {
	ix.mu.RLock()
	var s Stats
	tags := map[string]bool{}
	for _, d := range ix.docs {
		if d.Kind == "note" {
			s.Notes++
		} else {
			s.Attachments++
		}
		if d.Encrypted {
			s.Encrypted++
		}
		s.Links += len(d.Links)
		for _, t := range d.Tags {
			tags[strings.ToLower(t)] = true
		}
	}
	s.Terms = len(ix.postings)
	ix.mu.RUnlock()
	s.Tags = len(tags)
	return s
}
