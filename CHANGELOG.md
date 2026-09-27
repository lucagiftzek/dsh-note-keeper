# Changelog

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
