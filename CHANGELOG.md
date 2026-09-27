# Changelog

## 0.2.0 — 2026-09-27

- **Live preview editor** (CodeMirror 6): [[wikilinks]], [markdown](links) and #tags render
  as clickable links and tag pills while typing; heading/emphasis markers hide, tasks become
  checkboxes, image embeds render inline. Source, split and reading modes remain.
  [[ and # autocompletion, Ctrl+K link, search (Ctrl+F).
- **Connect** dialog, with every way to sync:
  - **Note Keeper Sync for Obsidian** (`obsidian-plugin/`, desktop and mobile): pairing code
    handshake, HMAC-signed requests, three-way merge with conflict copies, deletion guard,
    encrypted-folder rules. Public endpoint `/nk-sync/` with its own authentication.
  - **WebDAV** (`/nk-sync/dav/`) with per-app passwords, for Remotely Save, Cyberduck,
    rclone and Files apps.
  - **Cloud drives**: two-way rclone bisync mirror to Google Drive, OneDrive, Dropbox,
    iCloud Drive, S3 and others, from the server.
  - Device list with revoke.
- **Import**: Markdown/text folders (Obsidian, Bear, Logseq, Joplin), HTML, Evernote .enex
  (with attachments), Google Keep Takeout, Notion export zips (IDs stripped, links
  rewritten to wikilinks, CSV databases to tables).
- **AI Enhance** button on every note: fixes spelling and grammar, formats Markdown and
  links related notes, using the DSH default model for new chats or a model chosen in the
  gear's settings. Always previewed as a diff; invented links are dropped; encrypted notes
  are never sent.
- The lock button is context-aware: it encrypts the open plain note, or locks an unlocked one.

## 0.1.0 — 2026-09-28

Initial release.

- Left-sidebar "Notes" entry opening a full-page Note Keeper panel.
- Go backend `notekeeperd`: Obsidian-compatible vault, live fsnotify watching with
  SSE refresh, full-text search with Greek/Latin accent folding, tags, backlinks,
  link graph, link rewrite on rename, conflict detection, attachments, OCR
  (Tesseract eng+ell), quick capture, daily notes, templates, folder lock markers.
- Markdown editor with split/preview, toolbar, [[ autocompletion, task toggling,
  paste/drag-and-drop attachments, autosave.
- Audio notes with transcription through dsh-voice (Greek/English pinned).
- Retro paint canvas (raster + editable vector) with OCR.
- Client-side zero-knowledge encryption for notes, folders and attachments
  (PBKDF2-SHA-256 600k + AES-256-GCM) with the mandatory data-loss warning.
- 12 `notes_*` AI tools with write/delete switches; encrypted content is never
  exposed to models.
- Tests: Go unit/integration (race detector), host integration against the real
  daemon, client logic, jsdom UI smoke test; staticcheck, go vet, gofmt; CI.