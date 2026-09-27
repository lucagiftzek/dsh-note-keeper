// Package importer converts third-party note exports (plain Markdown/HTML
// files, Evernote .enex, Google Keep Takeout JSON, Notion .zip exports, or
// arbitrary zip archives of the above) into the vault's own Obsidian-
// compatible layout: Markdown notes with YAML frontmatter plus a folder of
// attachments.
//
// Every write goes through vault.Clean/vault.Write/vault.UniquePath, so the
// importer can never escape the destination folder, never overwrites an
// existing note, and never bypasses folder encryption. Nothing here is
// fatal except a bad destination: any per-item problem (a zip-slip path, a
// hidden segment, a corrupt entry, a locked folder) is recorded in
// Report.Skipped and the import continues.
package importer

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/vault"
)

// Options tunes an import run. Zero values are replaced by sane defaults in
// normalize.
type Options struct {
	MaxTotal     int64  // cap on total uncompressed bytes read from a zip (default 1<<30)
	MaxEntry     int64  // cap on a single zip entry's uncompressed size (default 200<<20)
	MaxEntries   int    // cap on the number of files inside a zip (default 50000)
	AttachFolder string // vault-relative-to-dest folder for attachments (default "attachments")
}

func (o *Options) normalize() {
	if o.MaxTotal <= 0 {
		o.MaxTotal = 1 << 30
	}
	if o.MaxEntry <= 0 {
		o.MaxEntry = 200 << 20
	}
	if o.MaxEntries <= 0 {
		o.MaxEntries = 50000
	}
	if o.AttachFolder == "" {
		o.AttachFolder = "attachments"
	}
}

// Skip records one item the importer chose not to write, and why.
type Skip struct {
	Path   string
	Reason string
}

// Report summarises one import run.
type Report struct {
	Notes       int
	Attachments int
	Created     []string // first 200 vault paths written (notes and attachments)
	Skipped     []Skip
	Format      string // "markdown" | "html" | "evernote" | "google-keep" | "notion" | "zip" | "file"
}

// maxCreatedListed bounds Report.Created; the counters (Notes/Attachments)
// stay exact even once the list itself stops growing.
const maxCreatedListed = 200

// importer carries the mutable state of one Run call.
type importer struct {
	v    *vault.Vault
	dest string
	opt  Options
	rep  Report
}

// Run imports data (named name, as the user's browser/uploader saw it) into
// dest (a vault-relative folder; "" is the vault root, which is created if
// missing). The format is decided from name's extension, falling back to
// content sniffing.
func Run(v *vault.Vault, dest string, name string, data []byte, opt Options) (Report, error) {
	opt.normalize()
	im := &importer{v: v, dest: dest, opt: opt}

	if dest != "" {
		if _, err := vault.Clean(dest, true); err != nil {
			return im.rep, fmt.Errorf("invalid destination: %w", err)
		}
		if err := v.Mkdir(dest); err != nil {
			return im.rep, fmt.Errorf("create destination: %w", err)
		}
	}

	switch detectFormat(name, data) {
	case fmtMarkdown:
		im.rep.Format = "markdown"
		im.importMarkdownFile(name, data)
	case fmtHTML:
		im.rep.Format = "html"
		im.importHTMLFile(name, data)
	case fmtENEX:
		im.rep.Format = "evernote"
		im.importENEX(data)
	case fmtKeepJSON:
		im.rep.Format = "google-keep"
		im.importKeepNote(name, data, nil)
	case fmtZip:
		im.rep.Format = "zip"
		im.importZip(data)
	default:
		im.rep.Format = "file"
		im.importAttachment(name, path.Base(name), data)
	}
	return im.rep, nil
}

// kind is the detected source format of one imported item.
type kind int

const (
	fmtOther kind = iota
	fmtMarkdown
	fmtHTML
	fmtENEX
	fmtKeepJSON
	fmtZip
)

// detectFormat decides a format primarily from the file extension, falling
// back to sniffing the content for extension-less or misnamed uploads.
func detectFormat(name string, data []byte) kind {
	switch strings.ToLower(path.Ext(name)) {
	case ".md", ".markdown", ".txt":
		return fmtMarkdown
	case ".html", ".htm":
		return fmtHTML
	case ".enex":
		return fmtENEX
	case ".json":
		if looksLikeKeepJSON(data) {
			return fmtKeepJSON
		}
		return fmtOther
	case ".zip":
		return fmtZip
	}

	if len(data) >= 2 && data[0] == 'P' && data[1] == 'K' {
		return fmtZip
	}
	head := data
	if len(head) > 4096 {
		head = head[:4096]
	}
	trimmed := bytes.TrimSpace(head)
	if bytes.Contains(trimmed, []byte("<en-export")) {
		return fmtENEX
	}
	lower := bytes.ToLower(trimmed)
	if bytes.HasPrefix(lower, []byte("<!doctype html")) || bytes.HasPrefix(lower, []byte("<html")) {
		return fmtHTML
	}
	if looksLikeKeepJSON(data) {
		return fmtKeepJSON
	}
	return fmtOther
}

// joinRel joins a dest-relative name onto dest, tolerating an empty dest
// (vault root).
func joinRel(dest, name string) string {
	if dest == "" {
		return name
	}
	if name == "" {
		return dest
	}
	return dest + "/" + name
}

// skip records a skipped item.
func (im *importer) skip(displayPath, reason string) {
	im.rep.Skipped = append(im.rep.Skipped, Skip{Path: displayPath, Reason: reason})
}

func (im *importer) noteCreated(rel string) {
	im.rep.Notes++
	if len(im.rep.Created) < maxCreatedListed {
		im.rep.Created = append(im.rep.Created, rel)
	}
}

func (im *importer) attachmentCreated(rel string) {
	im.rep.Attachments++
	if len(im.rep.Created) < maxCreatedListed {
		im.rep.Created = append(im.rep.Created, rel)
	}
}

// skipReasonForCleanErr turns a vault.Clean failure into a specific,
// human-readable reason: a hidden segment, a zip-slip attempt, or a generic
// invalid path.
func skipReasonForCleanErr(raw string, err error) string {
	trimmed := strings.TrimPrefix(raw, "/")
	for _, seg := range strings.Split(trimmed, "/") {
		if seg != "" && strings.HasPrefix(seg, ".") {
			return "hidden path segment (skipped)"
		}
	}
	if strings.HasPrefix(raw, "/") {
		return "zip-slip: absolute path rejected"
	}
	for _, seg := range strings.Split(raw, "/") {
		if seg == ".." {
			return "zip-slip: parent directory reference rejected"
		}
	}
	return "invalid path: " + err.Error()
}

// writeUnique validates targetRel, makes it unique against the existing
// vault content with vault.UniquePath, and writes data. It never overwrites
// an existing file. Any failure (bad path, hidden segment, locked folder,
// disk error) is recorded as a Skip instead of aborting the whole import.
func (im *importer) writeUnique(displayPath, targetRel string, data []byte, isNote bool) (string, bool) {
	clean, err := vault.Clean(targetRel, false)
	if err != nil {
		im.skip(displayPath, skipReasonForCleanErr(targetRel, err))
		return "", false
	}
	unique, err := im.v.UniquePath(clean)
	if err != nil {
		im.skip(displayPath, "path error: "+err.Error())
		return "", false
	}
	if _, err := im.v.Write(unique, data, vault.WriteOpts{Create: true}); err != nil {
		im.skip(displayPath, "write failed: "+err.Error())
		return "", false
	}
	if isNote {
		im.noteCreated(unique)
	} else {
		im.attachmentCreated(unique)
	}
	return unique, true
}

// writeFile is writeUnique without the caller needing the final path back.
func (im *importer) writeFile(displayPath, targetRel string, data []byte, isNote bool) {
	im.writeUnique(displayPath, targetRel, data, isNote)
}

// importMarkdownFile handles a standalone .md/.markdown/.txt file. Content
// is never touched; only .txt gets renamed to .md.
func (im *importer) importMarkdownFile(name string, data []byte) {
	base := path.Base(name)
	ext := strings.ToLower(path.Ext(base))
	outName := base
	if ext == ".txt" {
		outName = strings.TrimSuffix(base, path.Ext(base)) + ".md"
	}
	im.writeFile(name, joinRel(im.dest, outName), data, true)
}

// importHTMLFile converts one HTML document to Markdown, naming the note
// after its <title>/first <h1> when present.
func (im *importer) importHTMLFile(name string, data []byte) {
	title, body := ConvertHTML(data)
	stem := path.Base(strings.TrimSuffix(name, path.Ext(name)))
	if title != "" {
		stem = sanitizeFilename(title)
	}
	im.writeFile(name, joinRel(im.dest, stem+".md"), []byte(body), true)
}

// importAttachment copies one non-note file into dest, preserving relName
// (which may include sub-folders, e.g. for zip entries).
func (im *importer) importAttachment(displayPath, relName string, data []byte) {
	im.writeFile(displayPath, joinRel(im.dest, relName), data, false)
}

// sanitizeFilename makes a title safe to use as a file name on every
// platform Obsidian runs on.
var illegalFilenameChars = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]`)

func sanitizeFilename(s string) string {
	s = strings.TrimSpace(s)
	s = illegalFilenameChars.ReplaceAllString(s, "-")
	s = strings.Join(strings.Fields(s), " ")
	s = strings.Trim(s, ". ")
	if s == "" {
		return "Untitled"
	}
	if len(s) > 150 {
		s = strings.TrimSpace(s[:150])
	}
	return s
}

// collapseWS collapses any run of whitespace (including newlines) to a
// single space, without trimming the ends (callers trim where it matters).
var reWS = regexp.MustCompile(`\s+`)

func collapseWS(s string) string { return reWS.ReplaceAllString(s, " ") }

// ---- zip import -----------------------------------------------------------

// zipEntryProblem reports why a raw zip entry name must never be written,
// without needing to decompress it first: zip-slip (absolute path, drive
// letter, parent traversal), a hidden path segment (which vault.Clean would
// reject anyway, but we want a precise reason before spending CPU on it),
// or a known noise folder that every export tool leaves behind.
func zipEntryProblem(name string) string {
	if name == "" {
		return "empty entry name"
	}
	if strings.ContainsRune(name, 0) {
		return "nul byte in entry name"
	}
	norm := strings.ReplaceAll(name, "\\", "/")
	if strings.HasPrefix(norm, "/") {
		return "zip-slip: absolute path rejected"
	}
	if len(norm) >= 2 && norm[1] == ':' {
		return "zip-slip: drive-letter path rejected"
	}
	segs := strings.Split(norm, "/")
	if segs[0] == "__MACOSX" {
		return "macOS metadata folder (skipped)"
	}
	for _, seg := range segs {
		if seg == ".." {
			return "zip-slip: parent directory reference rejected"
		}
		if seg != "" && strings.HasPrefix(seg, ".") {
			return "hidden path segment (skipped)"
		}
	}
	return ""
}

// importZip walks a zip archive entry by entry, applying the single-file
// import rules to each member and copying anything else through as a plain
// attachment. It guards against zip bombs (per-entry and total uncompressed
// size caps, entry count cap) and zip-slip, and detects a Notion export to
// clean up its "<Name> <32 hex>" naming and rewrite internal links.
func (im *importer) importZip(data []byte) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		im.skip(path.Clean("."), "invalid zip archive: "+err.Error())
		return
	}

	files := make([]*zip.File, 0, len(zr.File))
	for _, f := range zr.File {
		if !f.FileInfo().IsDir() {
			files = append(files, f)
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })

	isNotion := detectNotion(files)
	used := map[string]struct{}{}
	cleanPath := map[string]string{}

	entryData := map[string][]byte{}
	order := make([]string, 0, len(files))

	var total int64
	processed := 0
	for _, f := range files {
		name := f.Name
		if reason := zipEntryProblem(name); reason != "" {
			im.skip(name, reason)
			continue
		}
		processed++
		if processed > im.opt.MaxEntries {
			im.skip(name, "archive exceeds the maximum entry count")
			continue
		}
		size := int64(f.UncompressedSize64)
		if size > im.opt.MaxEntry {
			im.skip(name, "entry exceeds the per-file size limit (possible zip bomb)")
			continue
		}
		total += size
		if total > im.opt.MaxTotal {
			im.skip(name, "archive exceeds the total uncompressed size limit (possible zip bomb)")
			continue
		}
		rc, err := f.Open()
		if err != nil {
			im.skip(name, "cannot open entry: "+err.Error())
			continue
		}
		buf, err := io.ReadAll(io.LimitReader(rc, im.opt.MaxEntry+1))
		rc.Close()
		if err != nil {
			im.skip(name, "read failed: "+err.Error())
			continue
		}
		if int64(len(buf)) > im.opt.MaxEntry {
			im.skip(name, "entry exceeds the per-file size limit (possible zip bomb)")
			continue
		}
		entryData[name] = buf
		order = append(order, name)
		if isNotion {
			cleanPath[name] = notionCleanPath(name, used)
		}
	}

	for _, name := range order {
		buf := entryData[name]
		relForDest := name
		if isNotion {
			relForDest = cleanPath[name]
		}
		im.importZipEntry(name, relForDest, buf, isNotion, cleanPath, entryData)
	}
}

// importZipEntry applies the single-file format rules to one already-read
// zip member. siblings gives access to every other member's bytes by their
// original archive path, for formats (Google Keep) that reference sibling
// files by relative path.
func (im *importer) importZipEntry(origName, relForDest string, buf []byte, isNotion bool, cleanPath map[string]string, siblings map[string][]byte) {
	ext := strings.ToLower(path.Ext(origName))
	switch ext {
	case ".md", ".markdown":
		content := string(buf)
		if isNotion {
			content = rewriteNotionLinks(content, path.Dir(origName), cleanPath)
		}
		im.writeFile(origName, joinRel(im.dest, relForDest), []byte(content), true)
	case ".txt":
		out := strings.TrimSuffix(relForDest, path.Ext(relForDest)) + ".md"
		im.writeFile(origName, joinRel(im.dest, out), buf, true)
	case ".html", ".htm":
		title, body := ConvertHTML(buf)
		dir := path.Dir(relForDest)
		stem := path.Base(strings.TrimSuffix(relForDest, path.Ext(relForDest)))
		if title != "" {
			stem = sanitizeFilename(title)
		}
		out := stem + ".md"
		if dir != "." && dir != "" {
			out = dir + "/" + out
		}
		im.writeFile(origName, joinRel(im.dest, out), []byte(body), true)
	case ".enex":
		im.importENEX(buf)
	case ".json":
		if looksLikeKeepJSON(buf) {
			im.importKeepNote(origName, buf, siblings)
		} else {
			im.importAttachment(origName, relForDest, buf)
		}
	case ".csv":
		im.importCSV(origName, relForDest, buf)
	default:
		im.importAttachment(origName, relForDest, buf)
	}
}

// importCSV converts a CSV file into a Markdown table note (Notion database
// exports are plain CSV) and keeps the original file as an attachment next
// to it.
func (im *importer) importCSV(displayPath, relForDest string, buf []byte) {
	table, err := csvToMarkdownTable(buf)
	if err != nil {
		im.skip(displayPath, "invalid CSV: "+err.Error())
		return
	}
	stem := strings.TrimSuffix(relForDest, path.Ext(relForDest))
	im.writeFile(displayPath, joinRel(im.dest, stem+".md"), []byte(table), true)
	attTarget := joinRel(path.Join(im.dest, im.opt.AttachFolder), path.Base(relForDest))
	im.writeFile(displayPath, attTarget, buf, false)
}

func csvToMarkdownTable(data []byte) (string, error) {
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", fmt.Errorf("empty CSV")
	}
	header := rows[0]
	var b strings.Builder
	writeRow := func(cells []string) {
		b.WriteString("| ")
		for i := range header {
			if i > 0 {
				b.WriteString(" | ")
			}
			var cell string
			if i < len(cells) {
				cell = cells[i]
			}
			b.WriteString(escapeTableCell(cell))
		}
		b.WriteString(" |\n")
	}
	writeRow(header)
	seps := make([]string, len(header))
	for i := range seps {
		seps[i] = "---"
	}
	b.WriteString("| " + strings.Join(seps, " | ") + " |\n")
	for _, row := range rows[1:] {
		writeRow(row)
	}
	return b.String(), nil
}

func escapeTableCell(s string) string {
	s = strings.ReplaceAll(s, "|", "\\|")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", "")
	return s
}

// ---- YAML frontmatter -------------------------------------------------

// fmField is one ordered frontmatter entry: a scalar value, or a list when
// list is non-nil (nil and empty are both "omit this field").
type fmField struct {
	key   string
	value string
	list  []string
}

// buildFrontmatter renders an ordered "---\n...\n---\n" YAML block. Fields
// with an empty scalar value or an empty list are omitted, so callers can
// pass optional metadata unconditionally.
func buildFrontmatter(fields []fmField) string {
	var b strings.Builder
	b.WriteString("---\n")
	for _, f := range fields {
		if f.list != nil {
			if len(f.list) == 0 {
				continue
			}
			b.WriteString(f.key + ":\n")
			for _, v := range f.list {
				b.WriteString("  - " + yamlScalar(v) + "\n")
			}
			continue
		}
		if f.value == "" {
			continue
		}
		b.WriteString(f.key + ": " + yamlScalar(f.value) + "\n")
	}
	b.WriteString("---\n")
	return b.String()
}

// yamlScalar quotes a scalar only when it contains characters that would
// otherwise change its meaning (colon, quote, hash, newline, or leading/
// trailing space).
func yamlScalar(s string) string {
	if s == "" {
		return `""`
	}
	needsQuote := strings.ContainsAny(s, ":#\"'\n") || strings.HasPrefix(s, " ") || strings.HasSuffix(s, " ")
	if !needsQuote {
		return s
	}
	esc := strings.ReplaceAll(s, `"`, `\"`)
	return `"` + esc + `"`
}
