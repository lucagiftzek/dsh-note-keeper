// Package importer: notion.go handles the two Notion-export quirks that
// would otherwise litter the vault: every exported file/folder name carries
// a " <32 hex>" suffix (Notion's page-id disambiguator), and every internal
// Markdown link/image points at another export file by its raw,
// URL-encoded, still-suffixed name.
package importer

import (
	"archive/zip"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
)

// notionHexSuffix matches Notion's "<Name> <32 lowercase-or-uppercase hex>"
// export naming, applied to a file's stem or a folder's whole name.
var notionHexSuffix = regexp.MustCompile("^(.*) ([0-9a-fA-F]{32})$")

// detectNotion reports whether a zip looks like a Notion export: at least
// one entry's base name (stem, for files) matches the "<Name> <32 hex>"
// pattern Notion appends to every exported page and database.
func detectNotion(files []*zip.File) bool {
	for _, f := range files {
		base := path.Base(strings.TrimRight(f.Name, "/"))
		stem := strings.TrimSuffix(base, path.Ext(base))
		if notionHexSuffix.MatchString(stem) {
			return true
		}
	}
	return false
}

// notionCleanPath strips the "<Name> <32 hex>" suffix from every segment of
// a zip-internal path, resolving collisions between siblings that collapse
// onto the same cleaned name (used tracks every cleaned path assigned so
// far, keyed the same way regardless of call order as long as callers walk
// entries in a stable, deterministic order such as lexical sort).
func notionCleanPath(name string, used map[string]struct{}) string {
	segs := strings.Split(name, "/")
	var out []string
	prefix := ""
	for i, seg := range segs {
		last := i == len(segs)-1
		ext := ""
		base := seg
		if last {
			ext = path.Ext(seg)
			base = strings.TrimSuffix(seg, ext)
		}
		if m := notionHexSuffix.FindStringSubmatch(base); m != nil {
			base = m[1]
		}
		cand := base + ext
		key := prefix + "/" + cand
		for n := 1; ; n++ {
			if _, exists := used[key]; !exists {
				used[key] = struct{}{}
				break
			}
			if last {
				cand = fmt.Sprintf("%s %d%s", base, n, ext)
			} else {
				cand = fmt.Sprintf("%s %d", base, n)
			}
			key = prefix + "/" + cand
		}
		out = append(out, cand)
		prefix = key
	}
	return strings.Join(out, "/")
}

// reMdLinkOrImage matches a Markdown link or image: an optional leading "!"
// (image), link text in [...], and a target in (...) with no unescaped
// whitespace (a plain relative or absolute URL).
var reMdLinkOrImage = regexp.MustCompile(`(!?)\[([^\]]*)\]\(([^)\s]+)\)`)

// rewriteNotionLinks rewrites every Markdown link/image in content that
// points at another file inside the same export into an Obsidian wikilink
// ([[Page]]) or embed (![[cleaned/path.png]]). curDir is the exporting
// file's own directory inside the archive (used to resolve relative
// targets); cleanPath maps every archive-original path to its Notion-
// suffix-stripped equivalent. A target that does not resolve to a known
// sibling (an external URL, an anchor, a link to something excluded from
// the import) is left untouched.
func rewriteNotionLinks(content, curDir string, cleanPath map[string]string) string {
	return reMdLinkOrImage.ReplaceAllStringFunc(content, func(m string) string {
		sub := reMdLinkOrImage.FindStringSubmatch(m)
		bang, target := sub[1], sub[3]
		if strings.Contains(target, "://") || strings.HasPrefix(target, "#") || strings.HasPrefix(target, "mailto:") {
			return m
		}
		decoded, err := url.PathUnescape(target)
		if err != nil {
			decoded = target
		}
		if i := strings.IndexByte(decoded, '#'); i >= 0 {
			decoded = decoded[:i]
		}
		resolved := path.Clean(path.Join(curDir, decoded))
		cleaned, ok := cleanPath[resolved]
		if !ok {
			return m
		}
		if bang == "!" {
			return "![[" + cleaned + "]]"
		}
		base := strings.TrimSuffix(path.Base(cleaned), path.Ext(cleaned))
		return "[[" + base + "]]"
	})
}
