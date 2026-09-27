// Package api is the daemon's HTTP surface. It is bound to loopback and
// reachable only through the DSH host plugin, which authenticates the browser
// and forwards requests with the shared secret (X-NK-Secret).
//
// Routes (all JSON unless noted):
//
//	GET    /health                         liveness + stats
//	GET    /tree                           folders, files, note metadata, locked folders
//	GET    /note?path=                     content + metadata + backlinks
//	PUT    /note      {path,content,baseMtime?,create?}
//	POST   /note/new  {folder,title,content?,ext?}  -> unique path
//	POST   /move      {from,to,rewriteLinks?}  (file or folder)
//	DELETE /entry?path=                    move to .trash (recoverable)
//	POST   /folder    {path}
//	GET    /search?q=&tag=&folder=&kind=&limit=
//	GET    /tags
//	GET    /graph?tags=1
//	GET    /backlinks?path=
//	GET    /recent?limit=
//	POST   /attachment?dir=&name=          raw body -> {path}
//	GET    /file?path=                     raw bytes (Range supported)
//	POST   /ocr       {path,lang} | raw image body with ?lang=
//	POST   /capture   {text,target?,todo?}
//	POST   /daily     {date?}
//	GET    /templates
//	GET    /lock?folder=  POST /lock {folder,marker}  DELETE /lock?folder=
//	GET    /events                         Server-Sent Events stream
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/lucagiftzek/dsh-note-keeper/server/internal/index"
	"github.com/lucagiftzek/dsh-note-keeper/server/internal/note"
	"github.com/lucagiftzek/dsh-note-keeper/server/internal/vault"
	"github.com/lucagiftzek/dsh-note-keeper/server/internal/watch"
)

// Limits.
const (
	MaxNoteBytes       = 16 << 20
	MaxAttachmentBytes = 200 << 20
	MaxOCRBytes        = 25 << 20
	MaxJSONBytes       = 20 << 20
)

// Config holds daemon settings.
type Config struct {
	Secret       string        // required X-NK-Secret value ("" disables the check; tests only)
	Tesseract    string        // tesseract binary
	OCRTimeout   time.Duration // per OCR job
	OCRParallel  int           // concurrent OCR jobs
	DailyFolder  string        // e.g. "Daily"
	InboxNote    string        // e.g. "Inbox.md"
	AttachFolder string        // e.g. "attachments"
	TemplatesDir string        // e.g. "Templates"
	Version      string
}

// Server wires the vault, index and watcher into HTTP handlers.
type Server struct {
	cfg Config
	v   *vault.Vault
	ix  *index.Index
	w   *watch.Watcher
	ocr chan struct{} // semaphore bounding concurrent OCR processes
	now func() time.Time
}

// New builds a server.
func New(cfg Config, v *vault.Vault, ix *index.Index, w *watch.Watcher) *Server {
	if cfg.OCRParallel <= 0 {
		cfg.OCRParallel = 2
	}
	if cfg.OCRTimeout <= 0 {
		cfg.OCRTimeout = 90 * time.Second
	}
	if cfg.Tesseract == "" {
		cfg.Tesseract = "tesseract"
	}
	if cfg.DailyFolder == "" {
		cfg.DailyFolder = "Daily"
	}
	if cfg.InboxNote == "" {
		cfg.InboxNote = "Inbox.md"
	}
	if cfg.AttachFolder == "" {
		cfg.AttachFolder = "attachments"
	}
	if cfg.TemplatesDir == "" {
		cfg.TemplatesDir = "Templates"
	}
	return &Server{cfg: cfg, v: v, ix: ix, w: w, ocr: make(chan struct{}, cfg.OCRParallel), now: time.Now}
}

// Handler returns the routed, authenticated handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /tree", s.tree)
	mux.HandleFunc("GET /note", s.getNote)
	mux.HandleFunc("PUT /note", s.putNote)
	mux.HandleFunc("POST /note/new", s.newNote)
	mux.HandleFunc("POST /move", s.move)
	mux.HandleFunc("DELETE /entry", s.trash)
	mux.HandleFunc("POST /folder", s.mkdir)
	mux.HandleFunc("GET /search", s.search)
	mux.HandleFunc("GET /tags", s.tags)
	mux.HandleFunc("GET /graph", s.graph)
	mux.HandleFunc("GET /backlinks", s.backlinks)
	mux.HandleFunc("GET /recent", s.recent)
	mux.HandleFunc("POST /attachment", s.attach)
	mux.HandleFunc("GET /file", s.file)
	mux.HandleFunc("POST /ocr", s.ocrHandler)
	mux.HandleFunc("POST /capture", s.capture)
	mux.HandleFunc("POST /daily", s.daily)
	mux.HandleFunc("GET /templates", s.templates)
	mux.HandleFunc("GET /lock", s.getLock)
	mux.HandleFunc("POST /lock", s.setLock)
	mux.HandleFunc("DELETE /lock", s.delLock)
	mux.HandleFunc("GET /events", s.events)
	return s.auth(mux)
}

func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.Secret != "" {
			got := r.Header.Get("X-NK-Secret")
			if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Secret)) != 1 {
				writeErr(w, http.StatusUnauthorized, "unauthorized", errors.New("missing or wrong X-NK-Secret"))
				return
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

// ---- helpers ----------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code string, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error(), "code": code})
}

// fail maps vault errors onto HTTP statuses.
func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, vault.ErrBadPath):
		writeErr(w, http.StatusBadRequest, "bad_path", err)
	case errors.Is(err, vault.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", err)
	case errors.Is(err, vault.ErrExists):
		writeErr(w, http.StatusConflict, "exists", err)
	case errors.Is(err, vault.ErrConflict):
		writeErr(w, http.StatusConflict, "conflict", err)
	case errors.Is(err, vault.ErrLocked):
		writeErr(w, http.StatusForbidden, "locked", err)
	case errors.Is(err, vault.ErrTooLarge):
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large", err)
	default:
		log.Printf("internal error: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal", errors.New("internal error"))
	}
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, MaxJSONBytes))
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("%w: bad JSON body: %v", vault.ErrBadPath, err)
	}
	return nil
}

// IsEnvelope reports whether content is a Note Keeper encrypted envelope.
func IsEnvelope(content string) bool {
	fm, _, ok := note.SplitFrontmatter(content)
	if !ok {
		return false
	}
	m := note.ParseFrontmatter(fm)
	return m[note.EncryptedKey] != "" && m["nk-cipher"] != "" || (m[note.EncryptedKey] != "" && strings.Contains(content, "```nk-cipher"))
}

var illegalName = regexp.MustCompile(`[\\/:*?"<>|#^\[\]\x00-\x1f]+`)

// SafeTitle turns a free-form title into an Obsidian-safe file stem.
func SafeTitle(t string) string {
	t = illegalName.ReplaceAllString(strings.TrimSpace(t), " ")
	t = strings.Join(strings.Fields(t), " ")
	t = strings.TrimLeft(t, ".")
	if r := []rune(t); len(r) > 120 {
		t = string(r[:120])
	}
	if t == "" {
		t = "Untitled"
	}
	return t
}

func joinRel(folder, name string) string {
	folder = strings.Trim(folder, "/")
	if folder == "" {
		return name
	}
	return folder + "/" + name
}

// nonNil turns a nil slice into an empty one so JSON carries [] (never null):
// clients can then iterate every list field without null checks.
func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// ---- handlers ---------------------------------------------------------------

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "version": s.cfg.Version, "stats": s.ix.Stats(), "subscribers": s.w.Hub.Subscribers()})
}

func (s *Server) tree(w http.ResponseWriter, _ *http.Request) {
	entries, err := s.v.List()
	if err != nil {
		fail(w, err)
		return
	}
	docs := map[string]index.Doc{}
	for _, d := range s.ix.All() {
		docs[d.Path] = d
	}
	type row struct {
		vault.Entry
		Doc *index.Doc `json:"doc,omitempty"`
	}
	out := make([]row, 0, len(entries))
	for _, e := range entries {
		r := row{Entry: e}
		if d, ok := docs[e.Path]; ok {
			dd := d
			r.Doc = &dd
		}
		out = append(out, r)
	}
	writeJSON(w, 200, map[string]any{"entries": out, "locked": nonNil(s.v.LockedFolders()), "root": filepath.Base(s.v.Root())})
}

func (s *Server) getNote(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	b, mtime, err := s.v.Read(p, MaxNoteBytes)
	if err != nil {
		fail(w, err)
		return
	}
	_, c, _ := s.v.Resolve(p, false)
	doc, _ := s.ix.Get(c)
	writeJSON(w, 200, map[string]any{
		"path": c, "content": string(b), "mtime": mtime, "doc": doc,
		"backlinks": nonNil(s.ix.Backlinks(c)), "lockedScope": s.v.LockedScope(c),
	})
}

type putReq struct {
	Path      string  `json:"path"`
	Content   *string `json:"content"`
	BaseMtime int64   `json:"baseMtime"`
	Create    bool    `json:"create"`
}

func (s *Server) putNote(w http.ResponseWriter, r *http.Request) {
	var req putReq
	if err := decode(r, &req); err != nil {
		fail(w, err)
		return
	}
	if req.Content == nil {
		fail(w, fmt.Errorf("%w: content is required", vault.ErrBadPath))
		return
	}
	if len(*req.Content) > MaxNoteBytes {
		fail(w, vault.ErrTooLarge)
		return
	}
	c, err := vault.Clean(req.Path, false)
	if err != nil {
		fail(w, err)
		return
	}
	if !index.IsNote(c) {
		fail(w, fmt.Errorf("%w: notes must end in .md", vault.ErrBadPath))
		return
	}
	mtime, err := s.v.Write(c, []byte(*req.Content), vault.WriteOpts{BaseMtime: req.BaseMtime, Create: req.Create, Encrypted: IsEnvelope(*req.Content)})
	if err != nil {
		if errors.Is(err, vault.ErrConflict) {
			// Hand the client the current disk version so it can merge.
			cur, m, rerr := s.v.Read(c, MaxNoteBytes)
			if rerr == nil {
				writeJSON(w, 409, map[string]any{"error": err.Error(), "code": "conflict", "content": string(cur), "mtime": m})
				return
			}
		}
		fail(w, err)
		return
	}
	s.w.Touch(c)
	writeJSON(w, 200, map[string]any{"path": c, "mtime": mtime})
}

type newReq struct {
	Folder  string `json:"folder"`
	Title   string `json:"title"`
	Content string `json:"content"`
	Ext     string `json:"ext"`
}

func (s *Server) newNote(w http.ResponseWriter, r *http.Request) {
	var req newReq
	if err := decode(r, &req); err != nil {
		fail(w, err)
		return
	}
	ext := ".md"
	if req.Ext != "" && req.Ext != ".md" {
		fail(w, fmt.Errorf("%w: only .md notes can be created here", vault.ErrBadPath))
		return
	}
	if _, err := vault.Clean(req.Folder, true); err != nil {
		fail(w, err)
		return
	}
	p, err := s.v.UniquePath(joinRel(req.Folder, SafeTitle(req.Title)+ext))
	if err != nil {
		fail(w, err)
		return
	}
	content := req.Content
	mtime, err := s.v.Write(p, []byte(content), vault.WriteOpts{Create: true, Encrypted: IsEnvelope(content)})
	if err != nil {
		fail(w, err)
		return
	}
	s.w.Touch(p)
	writeJSON(w, 200, map[string]any{"path": p, "mtime": mtime})
}

type moveReq struct {
	From         string `json:"from"`
	To           string `json:"to"`
	RewriteLinks *bool  `json:"rewriteLinks"`
}

func (s *Server) move(w http.ResponseWriter, r *http.Request) {
	var req moveReq
	if err := decode(r, &req); err != nil {
		fail(w, err)
		return
	}
	fc, err := vault.Clean(req.From, false)
	if err != nil {
		fail(w, err)
		return
	}
	tc, err := vault.Clean(req.To, false)
	if err != nil {
		fail(w, err)
		return
	}
	// Collect linkers before the move (resolution needs the old path).
	var linkers []string
	rewrite := req.RewriteLinks == nil || *req.RewriteLinks
	if rewrite && index.IsNote(fc) {
		linkers = s.ix.LinkersOf(fc)
	}
	if err := s.v.Move(fc, tc); err != nil {
		fail(w, err)
		return
	}
	s.w.Touch(fc, tc)
	rewritten := []string{}
	if rewrite && len(linkers) > 0 {
		for _, l := range linkers {
			if l == fc {
				l = tc
			}
			if s.rewriteLinks(l, fc, tc) {
				rewritten = append(rewritten, l)
			}
		}
		if len(rewritten) > 0 {
			s.w.Touch(rewritten...)
		}
	}
	writeJSON(w, 200, map[string]any{"from": fc, "to": tc, "rewritten": rewritten})
}

// rewriteLinks updates [[wikilinks]] in one note after from was renamed to to.
func (s *Server) rewriteLinks(notePath, from, to string) bool {
	b, mtime, err := s.v.Read(notePath, MaxNoteBytes)
	if err != nil || IsEnvelope(string(b)) {
		return false
	}
	out := RewriteWikilinks(string(b), from, to)
	if out == string(b) {
		return false
	}
	_, err = s.v.Write(notePath, []byte(out), vault.WriteOpts{BaseMtime: mtime})
	return err == nil
}

// RewriteWikilinks rewrites [[old]], [[old|alias]], [[old#h]], [[dir/old]]
// and embeds that point at from so they point at to. Links are written in
// the shortest form when only the base name changed, else as a full path.
func RewriteWikilinks(src, from, to string) string {
	oldBase := note.BaseName(from)
	oldFull := strings.TrimSuffix(from, path.Ext(from))
	newBase := note.BaseName(to)
	newFull := strings.TrimSuffix(to, path.Ext(to))
	re := regexp.MustCompile(`(!?\[\[)(` + regexp.QuoteMeta(oldFull) + `|(?:[^\]\|#\n]*/)?` + regexp.QuoteMeta(oldBase) + `)(\.md)?(\]\]|\||#)`)
	return re.ReplaceAllStringFunc(src, func(m string) string {
		sm := re.FindStringSubmatch(m)
		target := newBase
		if strings.Contains(sm[2], "/") || path.Dir(from) != path.Dir(to) && strings.Contains(sm[2], "/") {
			target = newFull
		}
		return sm[1] + target + sm[3] + sm[4]
	})
}

func (s *Server) trash(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	c, err := vault.Clean(p, false)
	if err != nil {
		fail(w, err)
		return
	}
	if r.URL.Query().Get("purge") == "1" {
		if err := s.v.Purge(c); err != nil {
			fail(w, err)
			return
		}
		s.w.Touch(c)
		writeJSON(w, 200, map[string]any{"path": c, "purged": true})
		return
	}
	dst, err := s.v.Trash(c)
	if err != nil {
		fail(w, err)
		return
	}
	s.w.Touch(c)
	writeJSON(w, 200, map[string]any{"path": c, "trashedTo": dst})
}

func (s *Server) mkdir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, err)
		return
	}
	c, err := vault.Clean(req.Path, false)
	if err != nil {
		fail(w, err)
		return
	}
	if err := s.v.Mkdir(c); err != nil {
		fail(w, err)
		return
	}
	s.w.Touch(c)
	writeJSON(w, 200, map[string]any{"path": c})
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	hits := s.ix.Search(q.Get("q"), index.SearchOpts{Tag: q.Get("tag"), Folder: q.Get("folder"), Kind: q.Get("kind"), Limit: limit})
	if hits == nil {
		hits = []index.Hit{}
	}
	writeJSON(w, 200, map[string]any{"hits": hits})
}

func (s *Server) tags(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"tags": nonNil(s.ix.Tags())})
}

func (s *Server) graph(w http.ResponseWriter, r *http.Request) {
	nodes, edges := s.ix.Graph(r.URL.Query().Get("tags") == "1")
	writeJSON(w, 200, map[string]any{"nodes": nonNil(nodes), "edges": nonNil(edges)})
}

func (s *Server) backlinks(w http.ResponseWriter, r *http.Request) {
	c, err := vault.Clean(r.URL.Query().Get("path"), false)
	if err != nil {
		fail(w, err)
		return
	}
	bl := s.ix.Backlinks(c)
	if bl == nil {
		bl = []index.Doc{}
	}
	writeJSON(w, 200, map[string]any{"backlinks": bl})
}

func (s *Server) recent(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 30
	}
	writeJSON(w, 200, map[string]any{"notes": nonNil(s.ix.Recent(limit))})
}

func (s *Server) attach(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	dir := q.Get("dir")
	if dir == "" {
		dir = s.cfg.AttachFolder
	}
	name := SafeTitle(strings.TrimSuffix(q.Get("name"), path.Ext(q.Get("name"))))
	ext := strings.ToLower(path.Ext(q.Get("name")))
	if !regexp.MustCompile(`^\.[a-z0-9]{1,8}$`).MatchString(ext) {
		ext = ".bin"
	}
	if _, err := vault.Clean(dir, false); err != nil {
		fail(w, err)
		return
	}
	p, err := s.v.UniquePath(joinRel(dir, name+ext))
	if err != nil {
		fail(w, err)
		return
	}
	if s.v.LockedScope(path.Dir(p)) != "" && ext != ".md" && q.Get("encrypted") != "1" {
		// Attachments inside an encrypted folder must be encrypted blobs.
		fail(w, vault.ErrLocked)
		return
	}
	n, err := s.v.WriteStream(p, r.Body, MaxAttachmentBytes)
	if err != nil {
		fail(w, err)
		return
	}
	s.w.Touch(p)
	writeJSON(w, 200, map[string]any{"path": p, "bytes": n, "name": path.Base(p)})
}

// inlineTypes are served inline; everything else (html, svg, js…) is forced
// to download so an uploaded file can never script the DSH origin.
var inlineTypes = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true, ".avif": true,
	".mp3": true, ".wav": true, ".ogg": true, ".oga": true, ".m4a": true, ".webm": true, ".weba": true, ".flac": true, ".opus": true,
	".mp4": true, ".mov": true, ".pdf": true, ".txt": true, ".md": true, ".csv": true, ".json": true,
}

func (s *Server) file(w http.ResponseWriter, r *http.Request) {
	f, fi, err := s.v.OpenFile(r.URL.Query().Get("path"))
	if err != nil {
		fail(w, err)
		return
	}
	defer f.Close()
	ext := strings.ToLower(path.Ext(fi.Name()))
	ct := mime.TypeByExtension(ext)
	switch ext {
	case ".md", ".txt", ".csv":
		ct = "text/plain; charset=utf-8"
	case ".json":
		ct = "application/json; charset=utf-8"
	case ".weba", ".webm":
		if ct == "" {
			ct = "audio/webm"
		}
	case ".opus", ".oga":
		ct = "audio/ogg"
	case ".m4a":
		ct = "audio/mp4"
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'")
	disp := "inline"
	if !inlineTypes[ext] || r.URL.Query().Get("download") == "1" {
		disp = "attachment"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disp, map[string]string{"filename": fi.Name()}))
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// OCR runs tesseract over an image file and returns the recognised text.
func (s *Server) OCR(ctx context.Context, imgPath, lang string) (string, error) {
	if !regexp.MustCompile(`^[a-z_]{3,8}(\+[a-z_]{3,8}){0,3}$`).MatchString(lang) {
		lang = "eng+ell"
	}
	select {
	case s.ocr <- struct{}{}:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	defer func() { <-s.ocr }()
	ctx, cancel := context.WithTimeout(ctx, s.cfg.OCRTimeout)
	defer cancel()
	// Normalise first (flatten transparency, crop to ink, scale); fall back to
	// the original file for formats the Go decoders do not know (webp, bmp).
	input := imgPath
	if tmp, err := os.CreateTemp("", "nk-ocr-prep-*.png"); err == nil {
		ok, perr := PrepareForOCR(imgPath, tmp)
		tmp.Close()
		defer os.Remove(tmp.Name())
		if perr == nil && !ok {
			return "", nil // blank image: nothing to read
		}
		if perr == nil {
			input = tmp.Name()
		}
	}
	// --psm 3 (automatic layout) suits pages; single short hand-written words
	// often need --psm 6/7. Take the first mode that yields real characters.
	var best string
	for _, psm := range []string{"3", "6", "7"} {
		out, err := s.runTesseract(ctx, input, lang, psm)
		if err != nil {
			return "", err
		}
		if countAlnum(out) > countAlnum(best) {
			best = out
		}
		if countAlnum(best) >= 2 {
			break
		}
	}
	return best, nil
}

func (s *Server) runTesseract(ctx context.Context, input, lang, psm string) (string, error) {
	cmd := exec.CommandContext(ctx, s.cfg.Tesseract, input, "stdout", "-l", lang, "--psm", psm)
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "OMP_THREAD_LIMIT=1"}
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return "", fmt.Errorf("tesseract failed: %s", strings.TrimSpace(string(ee.Stderr)))
		}
		return "", fmt.Errorf("tesseract failed: %v", err)
	}
	return strings.TrimSpace(string(out)), nil
}

func countAlnum(s string) int {
	n := 0
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			n++
		}
	}
	return n
}

func (s *Server) ocrHandler(w http.ResponseWriter, r *http.Request) {
	lang := r.URL.Query().Get("lang")
	var imgPath string
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var req struct {
			Path string `json:"path"`
			Lang string `json:"lang"`
		}
		if err := decode(r, &req); err != nil {
			fail(w, err)
			return
		}
		if req.Lang != "" {
			lang = req.Lang
		}
		a, _, err := s.v.Resolve(req.Path, false)
		if err != nil {
			fail(w, err)
			return
		}
		if _, err := os.Stat(a); err != nil {
			fail(w, vault.ErrNotFound)
			return
		}
		imgPath = a
	} else {
		tmp, err := os.CreateTemp("", "nk-ocr-*.png")
		if err != nil {
			fail(w, err)
			return
		}
		defer os.Remove(tmp.Name())
		n, err := io.Copy(tmp, io.LimitReader(r.Body, MaxOCRBytes+1))
		tmp.Close()
		if err != nil {
			fail(w, err)
			return
		}
		if n > MaxOCRBytes {
			fail(w, vault.ErrTooLarge)
			return
		}
		imgPath = tmp.Name()
	}
	text, err := s.OCR(r.Context(), imgPath, lang)
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "ocr_failed", err)
		return
	}
	writeJSON(w, 200, map[string]any{"text": text, "lang": lang})
}

func (s *Server) capture(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text   string `json:"text"`
		Target string `json:"target"`
		Todo   bool   `json:"todo"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, err)
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		fail(w, fmt.Errorf("%w: text is empty", vault.ErrBadPath))
		return
	}
	target := req.Target
	if target == "" {
		target = s.cfg.InboxNote
	}
	c, err := vault.Clean(target, false)
	if err != nil || !index.IsNote(c) {
		fail(w, vault.ErrBadPath)
		return
	}
	now := s.now()
	line := "- " + now.Format("2006-01-02 15:04") + " " + strings.ReplaceAll(text, "\n", "\n  ")
	if req.Todo {
		line = "- [ ] " + strings.ReplaceAll(text, "\n", "\n  ")
	}
	// Retry on concurrent edits (Obsidian may be writing the same file).
	for attempt := 0; attempt < 5; attempt++ {
		cur, mtime, err := s.v.Read(c, MaxNoteBytes)
		var content string
		switch {
		case errors.Is(err, vault.ErrNotFound):
			content = "# " + note.BaseName(c) + "\n\n" + line + "\n"
			mtime = 0
		case err != nil:
			fail(w, err)
			return
		default:
			if IsEnvelope(string(cur)) {
				fail(w, vault.ErrLocked)
				return
			}
			content = strings.TrimRight(string(cur), "\n") + "\n" + line + "\n"
		}
		m, err := s.v.Write(c, []byte(content), vault.WriteOpts{BaseMtime: mtime, Create: mtime == 0})
		if errors.Is(err, vault.ErrConflict) || errors.Is(err, vault.ErrExists) {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		if err != nil {
			fail(w, err)
			return
		}
		s.w.Touch(c)
		writeJSON(w, 200, map[string]any{"path": c, "mtime": m})
		return
	}
	fail(w, vault.ErrConflict)
}

func (s *Server) daily(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Date string `json:"date"`
	}
	_ = decode(r, &req)
	day := s.now()
	if req.Date != "" {
		d, err := time.Parse("2006-01-02", req.Date)
		if err != nil {
			fail(w, fmt.Errorf("%w: date must be YYYY-MM-DD", vault.ErrBadPath))
			return
		}
		day = d
	}
	ds := day.Format("2006-01-02")
	p := joinRel(s.cfg.DailyFolder, ds+".md")
	if st, err := s.v.Stat(p); err == nil {
		writeJSON(w, 200, map[string]any{"path": p, "mtime": st.Mtime, "created": false})
		return
	}
	content := "# " + ds + "\n\n"
	if tpl, _, err := s.v.Read(joinRel(s.cfg.TemplatesDir, "Daily.md"), MaxNoteBytes); err == nil {
		content = ApplyTemplate(string(tpl), ds, day)
	}
	m, err := s.v.Write(p, []byte(content), vault.WriteOpts{Create: true})
	if err != nil && !errors.Is(err, vault.ErrExists) {
		fail(w, err)
		return
	}
	s.w.Touch(p)
	writeJSON(w, 200, map[string]any{"path": p, "mtime": m, "created": true})
}

// ApplyTemplate expands Obsidian core-template variables.
func ApplyTemplate(tpl, title string, t time.Time) string {
	r := strings.NewReplacer(
		"{{title}}", title,
		"{{date}}", t.Format("2006-01-02"),
		"{{time}}", t.Format("15:04"),
	)
	return r.Replace(tpl)
}

func (s *Server) templates(w http.ResponseWriter, _ *http.Request) {
	var out []index.Doc
	prefix := s.cfg.TemplatesDir + "/"
	for _, d := range s.ix.All() {
		if d.Kind == "note" && strings.HasPrefix(d.Path, prefix) {
			out = append(out, d)
		}
	}
	if out == nil {
		out = []index.Doc{}
	}
	writeJSON(w, 200, map[string]any{"templates": out, "folder": s.cfg.TemplatesDir})
}

// ---- folder locks (zero-knowledge: the marker holds salt + verifier only) ---

type lockMarker struct {
	V        int    `json:"v"`
	KDF      string `json:"kdf"`
	Iter     int    `json:"iter"`
	Salt     string `json:"salt"`
	Verifier string `json:"verifier"` // AES-GCM(iv||ct) of a fixed string
	IV       string `json:"iv"`
	Hint     string `json:"hint,omitempty"`
	Created  int64  `json:"created"`
}

func (s *Server) getLock(w http.ResponseWriter, r *http.Request) {
	folder := r.URL.Query().Get("folder")
	c, err := vault.Clean(folder, true)
	if err != nil {
		fail(w, err)
		return
	}
	scope := s.v.LockedScope(c)
	if scope == "" && c != "" {
		writeJSON(w, 200, map[string]any{"locked": false})
		return
	}
	b, err := s.v.ReadLockMarker(scope)
	if err != nil {
		writeJSON(w, 200, map[string]any{"locked": false})
		return
	}
	var m lockMarker
	if json.Unmarshal(b, &m) != nil {
		fail(w, errors.New("corrupt lock marker"))
		return
	}
	writeJSON(w, 200, map[string]any{"locked": true, "scope": scope, "marker": m})
}

func (s *Server) setLock(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Folder string     `json:"folder"`
		Marker lockMarker `json:"marker"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, err)
		return
	}
	c, err := vault.Clean(req.Folder, false)
	if err != nil {
		fail(w, err)
		return
	}
	m := req.Marker
	if m.Salt == "" || m.Verifier == "" || m.IV == "" || m.Iter < 100000 {
		fail(w, fmt.Errorf("%w: marker needs salt, iv, verifier and iter>=100000", vault.ErrBadPath))
		return
	}
	if scope := s.v.LockedScope(c); scope != "" {
		fail(w, fmt.Errorf("%w: already inside encrypted folder %q", vault.ErrExists, scope))
		return
	}
	m.V, m.Created = 1, s.now().UnixMilli()
	b, _ := json.MarshalIndent(m, "", "  ")
	if err := s.v.WriteLockMarker(c, b); err != nil {
		fail(w, err)
		return
	}
	s.w.Touch(c)
	writeJSON(w, 200, map[string]any{"locked": true, "scope": c})
}

func (s *Server) delLock(w http.ResponseWriter, r *http.Request) {
	c, err := vault.Clean(r.URL.Query().Get("folder"), false)
	if err != nil {
		fail(w, err)
		return
	}
	// Refuse while any envelope remains, unless the client says it is about to
	// decrypt them (force=1: the browser holds the key and every envelope
	// carries its own salt, so an interrupted decrypt stays recoverable). The
	// AI tools never expose this route.
	force := r.URL.Query().Get("force") == "1"
	for _, d := range s.ix.All() {
		if force {
			break
		}
		if d.Encrypted && strings.HasPrefix(d.Path, c+"/") {
			writeErr(w, http.StatusConflict, "still_encrypted", fmt.Errorf("decrypt %s before unlocking the folder", d.Path))
			return
		}
	}
	if err := s.v.RemoveLockMarker(c); err != nil {
		fail(w, err)
		return
	}
	s.w.Touch(c)
	writeJSON(w, 200, map[string]any{"locked": false, "scope": c})
}

// ---- live events ------------------------------------------------------------

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "internal", errors.New("streaming unsupported"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	ch, leave := s.w.Hub.Subscribe()
	defer leave()
	fmt.Fprintf(w, "event: hello\ndata: {\"at\":%d}\n\n", s.now().UnixMilli())
	fl.Flush()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			b, _ := json.Marshal(ev)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, b)
			fl.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}
