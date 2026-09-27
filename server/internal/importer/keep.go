// Package importer: keep.go imports a Google Keep Takeout .json note.
// Plain notes become a text body; checklist notes ("listContent") become a
// task list; labels become tags; attachments referenced by a sibling file
// inside the same archive are embedded, others are recorded as a skip so
// nothing referenced is silently lost.
package importer

import (
	"encoding/json"
	"fmt"
	"path"
	"strings"
	"time"
)

type keepListItem struct {
	Text      string `json:"text"`
	IsChecked bool   `json:"isChecked"`
}

type keepLabel struct {
	Name string `json:"name"`
}

type keepAttachment struct {
	FilePath string `json:"filePath"`
	Mimetype string `json:"mimetype"`
}

type keepAnnotation struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

type keepNote struct {
	Title                   string           `json:"title"`
	TextContent             string           `json:"textContent"`
	ListContent             []keepListItem   `json:"listContent"`
	Labels                  []keepLabel      `json:"labels"`
	CreatedTimestampUsec    int64            `json:"createdTimestampUsec"`
	UserEditedTimestampUsec int64            `json:"userEditedTimestampUsec"`
	IsArchived              bool             `json:"isArchived"`
	IsTrashed               bool             `json:"isTrashed"`
	Attachments             []keepAttachment `json:"attachments"`
	Annotations             []keepAnnotation `json:"annotations"`
}

// keepProbeFields are the JSON keys that identify a Google Keep Takeout
// note, distinct from an arbitrary .json file.
var keepProbeFields = []string{
	"createdTimestampUsec", "userEditedTimestampUsec", "textContent",
	"listContent", "isTrashed", "isPinned", "isArchived",
}

// looksLikeKeepJSON reports whether data parses as a JSON object carrying at
// least one field unique to a Google Keep Takeout export.
func looksLikeKeepJSON(data []byte) bool {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		return false
	}
	for _, k := range keepProbeFields {
		if _, ok := probe[k]; ok {
			return true
		}
	}
	return false
}

// usecToISO converts a microsecond Unix epoch (Google's timestamp unit) to
// ISO-8601. Zero (field absent) yields "".
func usecToISO(usec int64) string {
	if usec == 0 {
		return ""
	}
	return time.UnixMicro(usec).UTC().Format(time.RFC3339)
}

// importKeepNote imports one Keep note. siblings, when non-nil, is every
// other file already read from the same zip archive (keyed by its original
// archive path) so attachments can be embedded; it is nil for a standalone
// upload, in which case attachments are recorded as unresolved.
func (im *importer) importKeepNote(displayName string, data []byte, siblings map[string][]byte) {
	var n keepNote
	if err := json.Unmarshal(data, &n); err != nil {
		im.skip(displayName, "invalid Google Keep JSON: "+err.Error())
		return
	}
	if n.IsTrashed {
		im.skip(displayName, "trashed note (skipped)")
		return
	}

	var body strings.Builder
	switch {
	case len(n.ListContent) > 0:
		for _, item := range n.ListContent {
			box := " "
			if item.IsChecked {
				box = "x"
			}
			fmt.Fprintf(&body, "- [%s] %s\n", box, item.Text)
		}
	case n.TextContent != "":
		body.WriteString(n.TextContent)
		body.WriteString("\n")
	}
	for _, a := range n.Annotations {
		if a.URL == "" {
			continue
		}
		label := a.Title
		if label == "" {
			label = a.URL
		}
		fmt.Fprintf(&body, "\n[%s](%s)\n", label, a.URL)
	}
	for _, at := range n.Attachments {
		if at.FilePath == "" {
			continue
		}
		raw, found := siblings[at.FilePath]
		if !found {
			im.skip(at.FilePath, "attachment referenced by Keep note not found in archive")
			continue
		}
		target := joinRel(path.Join(im.dest, im.opt.AttachFolder), path.Base(at.FilePath))
		if final, ok := im.writeUnique(at.FilePath, target, raw, false); ok {
			fmt.Fprintf(&body, "\n![[%s]]\n", path.Base(final))
		}
	}

	var tags []string
	for _, l := range n.Labels {
		if l.Name != "" {
			tags = append(tags, l.Name)
		}
	}
	fields := []fmField{
		{key: "created", value: usecToISO(n.CreatedTimestampUsec)},
		{key: "updated", value: usecToISO(n.UserEditedTimestampUsec)},
		{key: "tags", list: tags},
		{key: "source", value: "google-keep"},
	}
	if n.IsArchived {
		fields = append(fields, fmField{key: "archived", value: "true"})
	}

	title := strings.TrimSpace(n.Title)
	if title == "" {
		title = "Untitled note"
	}
	full := buildFrontmatter(fields) + body.String()
	target := joinRel(im.dest, sanitizeFilename(title)+".md")
	im.writeFile(displayName, target, []byte(full), true)
}
