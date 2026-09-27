// Package note parses Markdown notes the way Obsidian reads them: YAML
// frontmatter, "#tags", [[wikilinks]], ![[embeds]] and relative Markdown
// links. It also recognises Note Keeper's encrypted-note envelope, whose body
// must never be indexed or shown to a model.
package note

import (
	"path"
	"regexp"
	"strings"
	"unicode"
)

// EncryptedKey is the frontmatter key that marks an encrypted envelope.
const EncryptedKey = "nk-encrypted"

// Parsed is everything the index needs from one note.
type Parsed struct {
	Title       string            `json:"title"`
	Type        string            `json:"type"` // text | audio | drawing (frontmatter nk-type)
	Tags        []string          `json:"tags"`
	Links       []string          `json:"links"` // raw link targets, de-duplicated
	Frontmatter map[string]string `json:"frontmatter"`
	Encrypted   bool              `json:"encrypted"`
	Body        string            `json:"-"` // body without frontmatter ("" when encrypted)
}

// SplitFrontmatter separates a leading "---" YAML block from the body.
func SplitFrontmatter(src string) (fm string, body string, ok bool) {
	s := strings.TrimPrefix(src, "\ufeff")
	if !strings.HasPrefix(s, "---\n") && !strings.HasPrefix(s, "---\r\n") {
		return "", s, false
	}
	rest := s[strings.Index(s, "\n")+1:]
	// Closing fence: a line that is exactly --- (or ...).
	idx := 0
	for idx <= len(rest) {
		nl := strings.IndexByte(rest[idx:], '\n')
		line := rest[idx:]
		if nl >= 0 {
			line = rest[idx : idx+nl]
		}
		t := strings.TrimRight(line, "\r ")
		if t == "---" || t == "..." {
			body := ""
			if nl >= 0 {
				body = rest[idx+nl+1:]
			}
			return rest[:idx], body, true
		}
		if nl < 0 {
			break
		}
		idx += nl + 1
	}
	return "", s, false
}

// ParseFrontmatter reads the YAML subset notes actually use: "key: value"
// scalars, inline lists "[a, b]" and block lists ("- a"). List values are
// joined with ", " in the flat map; ParseList splits them again.
func ParseFrontmatter(fm string) map[string]string {
	out := map[string]string{}
	var cur string
	var list []string
	flush := func() {
		if cur != "" && list != nil {
			out[cur] = strings.Join(list, ", ")
		}
		list = nil
	}
	for _, raw := range strings.Split(fm, "\n") {
		line := strings.TrimRight(raw, "\r")
		if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "- ") && cur != "" && (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "-")) {
			list = append(list, unquote(strings.TrimSpace(trim[2:])))
			continue
		}
		colon := strings.Index(line, ":")
		if colon <= 0 || strings.HasPrefix(line, " ") {
			continue
		}
		flush()
		cur = strings.TrimSpace(line[:colon])
		val := strings.TrimSpace(line[colon+1:])
		if val == "" {
			list = []string{}
			continue
		}
		if strings.HasPrefix(val, "[") && strings.HasSuffix(val, "]") {
			var items []string
			for _, it := range strings.Split(val[1:len(val)-1], ",") {
				if t := unquote(strings.TrimSpace(it)); t != "" {
					items = append(items, t)
				}
			}
			out[cur] = strings.Join(items, ", ")
			continue
		}
		out[cur] = unquote(val)
	}
	flush()
	return out
}

// ParseList splits a flattened frontmatter list value.
func ParseList(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func unquote(s string) string {
	if len(s) >= 2 && ((s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'')) {
		return s[1 : len(s)-1]
	}
	return s
}

var (
	reWiki     = regexp.MustCompile(`!?\[\[([^\]\|#\n]+)(?:#[^\]\|\n]*)?(?:\|[^\]\n]*)?\]\]`)
	reMdLink   = regexp.MustCompile(`\]\(([^)\s]+)\)`)
	reTag      = regexp.MustCompile(`(?:^|[\s(])#([\p{L}\p{N}_/\-]+)`)
	reHeading  = regexp.MustCompile(`(?m)^#\s+(.+?)\s*#*\s*$`)
	reFence    = regexp.MustCompile("(?ms)^(```|~~~).*?^(```|~~~)[^\n]*$")
	reInline   = regexp.MustCompile("`[^`\n]*`")
	reAllDigit = regexp.MustCompile(`^[0-9]+$`)
)

// StripCode removes fenced and inline code so tags/links inside code are ignored.
func StripCode(body string) string {
	b := reFence.ReplaceAllString(body, "")
	return reInline.ReplaceAllString(b, "")
}

// Parse extracts metadata from a note. name is the file's base name without
// extension (the title fallback, as in Obsidian).
func Parse(src string, name string) Parsed {
	fmRaw, body, _ := SplitFrontmatter(src)
	fm := ParseFrontmatter(fmRaw)
	p := Parsed{Frontmatter: fm, Type: "text"}
	if t := fm["nk-type"]; t != "" {
		p.Type = t
	}
	if fm[EncryptedKey] != "" {
		// Zero-knowledge: nothing from an encrypted body is ever parsed.
		p.Encrypted = true
		p.Title = name
		if t := fm["title"]; t != "" && fm["nk-title-plain"] == "true" {
			p.Title = t
		}
		return p
	}
	p.Body = body
	seen := map[string]bool{}
	addTag := func(t string) {
		t = strings.TrimPrefix(strings.TrimSpace(t), "#")
		if t == "" || reAllDigit.MatchString(t) {
			return
		}
		k := strings.ToLower(t)
		if !seen[k] {
			seen[k] = true
			p.Tags = append(p.Tags, t)
		}
	}
	for _, key := range []string{"tags", "tag"} {
		for _, t := range ParseList(fm[key]) {
			for _, f := range strings.Fields(t) {
				addTag(f)
			}
		}
	}
	clean := StripCode(body)
	for _, m := range reTag.FindAllStringSubmatch(clean, -1) {
		addTag(m[1])
	}
	lseen := map[string]bool{}
	addLink := func(t string) {
		t = strings.TrimSpace(t)
		if t == "" || lseen[t] {
			return
		}
		lseen[t] = true
		p.Links = append(p.Links, t)
	}
	for _, m := range reWiki.FindAllStringSubmatch(clean, -1) {
		addLink(m[1])
	}
	for _, m := range reMdLink.FindAllStringSubmatch(clean, -1) {
		t := m[1]
		if strings.Contains(t, "://") || strings.HasPrefix(t, "#") || strings.HasPrefix(t, "mailto:") {
			continue
		}
		if i := strings.IndexByte(t, '#'); i >= 0 {
			t = t[:i]
		}
		t = strings.ReplaceAll(t, "%20", " ")
		addLink(t)
	}
	switch {
	case fm["title"] != "":
		p.Title = fm["title"]
	default:
		if m := reHeading.FindStringSubmatch(clean); m != nil {
			p.Title = strings.TrimSpace(m[1])
		} else {
			p.Title = name
		}
	}
	return p
}

// BaseName returns a path's file name without extension.
func BaseName(rel string) string {
	b := path.Base(rel)
	return strings.TrimSuffix(b, path.Ext(b))
}

// greekFold maps accented Greek letters onto their bare forms, and final
// sigma onto sigma, so "Καλημέρα" matches "καλημερα" and "ΚΑΛΗΜΕΡΑ".
var greekFold = map[rune]rune{
	'ά': 'α', 'έ': 'ε', 'ή': 'η', 'ί': 'ι', 'ό': 'ο', 'ύ': 'υ', 'ώ': 'ω',
	'ϊ': 'ι', 'ϋ': 'υ', 'ΐ': 'ι', 'ΰ': 'υ', 'ς': 'σ',
	'Ά': 'α', 'Έ': 'ε', 'Ή': 'η', 'Ί': 'ι', 'Ό': 'ο', 'Ύ': 'υ', 'Ώ': 'ω',
	'Ϊ': 'ι', 'Ϋ': 'υ',
}

// latinFold strips the common Latin diacritics (Italian, etc.).
var latinFold = map[rune]rune{
	'à': 'a', 'á': 'a', 'â': 'a', 'ä': 'a', 'ã': 'a', 'å': 'a',
	'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
	'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
	'ò': 'o', 'ó': 'o', 'ô': 'o', 'ö': 'o', 'õ': 'o',
	'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u',
	'ç': 'c', 'ñ': 'n', 'ý': 'y', 'ÿ': 'y',
}

// Fold lower-cases and strips accents: the normal form for search.
func Fold(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		r = unicode.ToLower(r)
		if f, ok := greekFold[r]; ok {
			r = f
		} else if f, ok := latinFold[r]; ok {
			r = f
		} else if unicode.Is(unicode.Mn, r) {
			continue // stray combining marks (decomposed input)
		}
		b.WriteRune(r)
	}
	return b.String()
}

// Tokens splits text into folded search terms (letters/digits runs, len>=2).
func Tokens(s string) []string {
	f := Fold(s)
	var out []string
	start := -1
	for i, r := range f {
		word := unicode.IsLetter(r) || unicode.IsDigit(r)
		if word && start < 0 {
			start = i
		} else if !word && start >= 0 {
			if tok := f[start:i]; len([]rune(tok)) >= 2 {
				out = append(out, tok)
			}
			start = -1
		}
	}
	if start >= 0 {
		if tok := f[start:]; len([]rune(tok)) >= 2 {
			out = append(out, tok)
		}
	}
	return out
}
