// Package importer: enex.go imports an Evernote .enex export. Each <note>
// becomes one Markdown file with YAML frontmatter; its ENML body (XHTML
// wrapped in <en-note>) is rendered through the HTML converter after
// translating Evernote's own tags (<en-todo>, <en-media>); its <resource>
// children are decoded and saved as attachments, matched to <en-media hash>
// references by the md5 of the decoded bytes, exactly as Evernote itself
// links them.
package importer

import (
	"bytes"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"path"
	"regexp"
	"strings"
	"time"
)

// enexExport is the root <en-export> element of a .enex file.
type enexExport struct {
	XMLName xml.Name   `xml:"en-export"`
	Notes   []enexNote `xml:"note"`
}

type enexNote struct {
	Title      string         `xml:"title"`
	Content    string         `xml:"content"`
	Created    string         `xml:"created"`
	Updated    string         `xml:"updated"`
	Tags       []string       `xml:"tag"`
	Attributes enexNoteAttrs  `xml:"note-attributes"`
	Resources  []enexResource `xml:"resource"`
}

type enexNoteAttrs struct {
	SourceURL string `xml:"source-url"`
}

type enexResource struct {
	Data       enexData     `xml:"data"`
	Mime       string       `xml:"mime"`
	Attributes enexResAttrs `xml:"resource-attributes"`
}

type enexData struct {
	Encoding string `xml:"encoding,attr"`
	Value    string `xml:",chardata"`
}

type enexResAttrs struct {
	FileName string `xml:"file-name"`
}

// importENEX parses one .enex document and imports every <note> it
// contains. A document that fails to parse at all is recorded as a single
// skip; a note that fails is skipped individually, but the rest continue.
func (im *importer) importENEX(data []byte) {
	var exp enexExport
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = false
	dec.AutoClose = xml.HTMLAutoClose
	dec.Entity = xml.HTMLEntity
	if err := dec.Decode(&exp); err != nil {
		im.skip("<enex>", "invalid ENEX file: "+err.Error())
		return
	}
	for i, n := range exp.Notes {
		im.importENEXNote(i, n)
	}
}

type enexResourceRecord struct {
	hash string
	name string
	data []byte
}

// importENEXNote imports one Evernote note: its resources first (so their
// final vault names are known), then its content (so <en-media> references
// can be rewritten into ![[final name]] embeds).
func (im *importer) importENEXNote(idx int, n enexNote) {
	title := strings.TrimSpace(n.Title)
	if title == "" {
		title = fmt.Sprintf("Evernote Note %d", idx+1)
	}
	displayPrefix := fmt.Sprintf("enex note %q", title)

	var resources []enexResourceRecord
	for _, r := range n.Resources {
		raw := decodeENMLBase64(r.Data.Value)
		if raw == nil {
			continue
		}
		sum := md5.Sum(raw)
		hash := hex.EncodeToString(sum[:])
		fname := strings.TrimSpace(r.Attributes.FileName)
		if fname == "" {
			fname = hash + extForMime(r.Mime)
		}
		resources = append(resources, enexResourceRecord{hash: hash, name: sanitizeAttachmentName(fname), data: raw})
	}

	embedNames := map[string]string{}
	for _, r := range resources {
		target := joinRel(path.Join(im.dest, im.opt.AttachFolder), r.name)
		if final, ok := im.writeUnique(displayPrefix+"/"+r.name, target, r.data, false); ok {
			embedNames[r.hash] = path.Base(final)
		} else {
			im.skip(displayPrefix+"/"+r.name, "attachment could not be saved")
		}
	}

	body := convertENML(n.Content, embedNames)

	fields := []fmField{
		{key: "created", value: enexTimeToISO(n.Created)},
		{key: "updated", value: enexTimeToISO(n.Updated)},
		{key: "tags", list: n.Tags},
	}
	if src := strings.TrimSpace(n.Attributes.SourceURL); src != "" {
		fields = append(fields, fmField{key: "source-url", value: src})
	}
	fields = append(fields, fmField{key: "source", value: "evernote"})

	full := buildFrontmatter(fields) + body
	target := joinRel(im.dest, sanitizeFilename(title)+".md")
	im.writeFile(displayPrefix, target, []byte(full), true)
}

// sanitizeAttachmentName keeps a resource's own extension while making the
// base name filesystem-safe (mirrors sanitizeFilename but preserves ext).
func sanitizeAttachmentName(name string) string {
	ext := path.Ext(name)
	stem := sanitizeFilename(strings.TrimSuffix(name, ext))
	return stem + ext
}

// enexTimeToISO converts Evernote's "20060102T150405Z" timestamp to
// ISO-8601 (RFC 3339). An unparsable or empty timestamp yields "".
func enexTimeToISO(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	t, err := time.Parse("20060102T150405Z", s)
	if err != nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// decodeENMLBase64 decodes a <data> element's base64 payload, which
// Evernote wraps at a fixed column with embedded newlines.
func decodeENMLBase64(s string) []byte {
	clean := strings.Map(func(r rune) rune {
		switch r {
		case '\n', '\r', ' ', '\t':
			return -1
		}
		return r
	}, s)
	if clean == "" {
		return nil
	}
	b, err := base64.StdEncoding.DecodeString(clean)
	if err != nil {
		return nil
	}
	return b
}

var mimeExt = map[string]string{
	"image/png":       ".png",
	"image/jpeg":      ".jpg",
	"image/gif":       ".gif",
	"image/webp":      ".webp",
	"application/pdf": ".pdf",
	"audio/mpeg":      ".mp3",
	"audio/wav":       ".wav",
	"video/mp4":       ".mp4",
	"text/plain":      ".txt",
}

func extForMime(m string) string {
	if e, ok := mimeExt[strings.ToLower(strings.TrimSpace(m))]; ok {
		return e
	}
	return ".bin"
}

// ---- ENML -> Markdown ------------------------------------------------------

// markStart/markEnd delimit placeholders inserted before HTML conversion.
// They use Unicode Private Use Area code points rather than NUL bytes
// because the HTML5 tokenizer (used by golang.org/x/net/html) replaces NUL
// with U+FFFD, which would destroy a NUL-delimited marker; PUA code points
// pass through untouched and never occur in real note content.
const (
	markStart = ""
	markEnd   = ""
)

var (
	reEnTodo  = regexp.MustCompile("<en-todo([^>]*)/?>")
	reEnMedia = regexp.MustCompile("<en-media([^>]*)/?>")
	reAttr    = regexp.MustCompile("([\\w:-]+)\\s*=\\s*\"([^\"]*)\"")
	reEmbed   = regexp.MustCompile(markStart + "EMBED:([^" + markEnd + "]*)" + markEnd)
)

// convertENML renders one note's ENML content (XHTML in a <en-note>
// wrapper) as Markdown, translating Evernote-specific tags first:
//   - <en-todo checked="true|false"/>  -> "[x] "/"[ ] " (a task list item)
//   - <en-media hash="..." .../>       -> "![[<final attachment name>]]"
func convertENML(content string, embedNames map[string]string) string {
	content = reEnTodo.ReplaceAllStringFunc(content, func(m string) string {
		if parseTagAttrs(m)["checked"] == "true" {
			return markStart + "TODO:1" + markEnd
		}
		return markStart + "TODO:0" + markEnd
	})
	content = reEnMedia.ReplaceAllStringFunc(content, func(m string) string {
		hash := parseTagAttrs(m)["hash"]
		name := embedNames[hash]
		if name == "" {
			name = hash
		}
		return markStart + "EMBED:" + name + markEnd
	})
	_, body := ConvertHTML([]byte(content))
	body = strings.ReplaceAll(body, markStart+"TODO:1"+markEnd, "[x] ")
	body = strings.ReplaceAll(body, markStart+"TODO:0"+markEnd, "[ ] ")
	body = taskLines(body)
	body = reEmbed.ReplaceAllString(body, "![[$1]]")
	return body
}

func parseTagAttrs(tag string) map[string]string {
	out := map[string]string{}
	for _, m := range reAttr.FindAllStringSubmatch(tag, -1) {
		out[strings.ToLower(m[1])] = m[2]
	}
	return out
}

// taskLines turns bare "[x] item" lines (Evernote to-dos sit in <div>s, not
// lists) into Markdown task items, and joins consecutive ones into one list.
func taskLines(body string) string {
	lines := strings.Split(body, "\n")
	isTask := func(s string) bool {
		t := strings.TrimSpace(s)
		return strings.HasPrefix(t, "[x] ") || strings.HasPrefix(t, "[ ] ") || strings.HasPrefix(t, "- [x] ") || strings.HasPrefix(t, "- [ ] ")
	}
	out := make([]string, 0, len(lines))
	for i, l := range lines {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "[x] ") || strings.HasPrefix(t, "[ ] ") {
			l = "- " + t
		}
		// Drop a blank line sitting between two task items.
		if t == "" && len(out) > 0 && isTask(out[len(out)-1]) && i+1 < len(lines) && isTask(lines[i+1]) {
			continue
		}
		out = append(out, l)
	}
	return strings.Join(out, "\n")
}
