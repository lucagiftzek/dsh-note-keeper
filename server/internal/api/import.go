package api

import (
	"errors"
	"io"
	"net/http"
	"path"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/importer"
	"github.com/lucagiftzek/dsh-note-keeper/server/internal/vault"
)

// MaxImportBytes caps one uploaded import file. Uploads through the public
// hostname are limited to 100 MB by Cloudflare anyway; split larger exports.
const MaxImportBytes = 100 << 20

// importFile converts and stores one uploaded file (POST /import?name=&dir=).
// The importer decides the format from the name and content: Markdown, text,
// HTML, Evernote .enex, Google Keep JSON, and zips (Notion, Obsidian, Keep).
func (s *Server) importFile(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	name := path.Base(q.Get("name"))
	if name == "" || name == "." || name == "/" {
		writeErr(w, http.StatusBadRequest, "bad_name", errors.New("name is required"))
		return
	}
	dest, err := vault.Clean(q.Get("dir"), true)
	if err != nil {
		fail(w, err)
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, MaxImportBytes+1))
	if err != nil {
		fail(w, err)
		return
	}
	if len(data) > MaxImportBytes {
		fail(w, vault.ErrTooLarge)
		return
	}
	rep, err := importer.Run(s.v, dest, name, data, importer.Options{AttachFolder: s.cfg.AttachFolder})
	if err != nil {
		writeErr(w, http.StatusBadRequest, "import_failed", err)
		return
	}
	if rep.Notes+rep.Attachments > 0 {
		s.w.Scan() // index everything at once instead of waiting for fsnotify
	}
	writeJSON(w, http.StatusOK, rep)
}
