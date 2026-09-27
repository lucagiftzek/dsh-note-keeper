# Note Keeper vs. leading note-taking apps

A working comparison of Note Keeper against the note apps it draws ideas
from, written to justify Note Keeper's design choices and to be honest about
what it deliberately does not do. Feature claims about third-party products
reflect their well-documented, long-standing behaviour (Obsidian, Notion,
Logseq, Joplin, Standard Notes, Apple Notes, Evernote, Google Keep and
OneNote); exact UI details change release to release, so treat this as a
snapshot rather than a live feature tracker.

## Feature matrix

| Feature | **Note Keeper** | Obsidian | Notion | Apple Notes | Logseq | Joplin | Standard Notes | Evernote | Google Keep / OneNote |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Local-first plain files | ✅ Markdown on disk | ✅ Markdown on disk | ❌ cloud database | ❌ cloud/CoreData | ✅ Markdown on disk | ✅ Markdown + SQLite | ❌ encrypted cloud blobs | ❌ proprietary cloud | ❌ cloud |
| Markdown source | ✅ | ✅ | Partial (block editor, MD import/export) | ❌ rich text | ✅ (outliner Markdown) | ✅ | ✅ (optional) | ❌ rich text | ❌ plain/rich text |
| Wikilinks / backlinks | ✅ | ✅ | Partial (page mentions) | ❌ | ✅ (page + block refs) | ❌ (manual links only) | ❌ | ❌ | ❌ |
| Graph view | ✅ local graph, tags, ghost nodes | ✅ (its signature feature) | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Tags (incl. nested) | ✅ | ✅ | Partial (properties, not native tags) | Partial (flat) | ✅ | ✅ (flat) | ✅ (flat) | ✅ (flat) | ❌ / ✅ (OneNote flat) |
| Full-text search | ✅ accent-insensitive, Greek+Latin, prefix+phrase | ✅ | ✅ (cloud-indexed) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| OCR (images/handwriting) | ✅ Tesseract, built in | ❌ (plugin only) | ✅ (cloud) | ✅ (on-device, Visual Look Up) | ❌ | ❌ | ❌ | ✅ (cloud) | ✅ (cloud, Keep) |
| Audio recording + transcription | ✅ built in, Greek/English pinned | ❌ (plugin only) | ❌ | ✅ (on-device dictation) | ❌ | ✅ audio attach only, no built-in STT | ❌ | ✅ (cloud) | ❌ |
| Drawing / whiteboard | ✅ retro paint canvas, raster+vector+OCR | Partial (Excalidraw plugin) | ✅ (whiteboard, paid tiers) | ✅ (Markup/Sketch) | ❌ | ❌ | ❌ | ✅ | ❌ |
| End-to-end / zero-knowledge encryption | ✅ client-side, per-note or per-folder, zero-knowledge | ❌ (relies on OS/disk encryption) | ❌ | ✅ (locked notes, Apple-key custody) | ❌ | ✅ (E2E sync, whole-notebook) | ✅ (E2E, its core feature) | ❌ | ❌ |
| Quick capture | ✅ Inbox.md | ✅ (plugin/QuickAdd) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (its core feature) |
| Daily notes | ✅ Daily/YYYY-MM-DD.md | ✅ | Partial (template pages) | ❌ | ✅ (core to its outliner model) | ❌ | ❌ | ❌ | ❌ |
| Templates | ✅ {{title}}/{{date}}/{{time}} | ✅ (core + plugins) | ✅ (rich templates) | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Databases / structured properties | ❌ | Partial (Dataview/Bases plugins) | ✅ (its core feature) | ❌ | Partial (queries) | ❌ | ❌ | ❌ | ❌ |
| Real-time multi-user collaboration | ❌ | ❌ (Obsidian Sync is not concurrent editing) | ✅ (its core strength) | ✅ (shared notes) | ❌ | ❌ | ❌ | ✅ (shared notebooks) | ✅ (shared notes) |
| Publishing / sharing to the web | ❌ | Partial (Obsidian Publish, paid) | ✅ | Partial (share link) | Partial (via hosting) | ❌ | ❌ | Partial (share link) | Partial (share link) |
| Plugin ecosystem / API | Partial (this plugin *is* a DSH plugin; no third-party plugin system of its own) | ✅ (huge ecosystem) | ✅ (API + integrations) | ❌ | ✅ (plugin API) | ✅ (plugin API) | ✅ (extensions) | ✅ (limited API) | ❌ |
| Built-in AI assistance | ✅ 12 `notes_*` tools for the host chat's AI | Partial (plugins call external APIs) | ✅ (Notion AI, paid) | ✅ (on-device, iOS 18+) | Partial (plugins) | ❌ | ❌ | ✅ (paid tiers) | ❌ |
| Mobile app | ❌ (desktop web GUI only; syncs to Obsidian mobile) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Works fully offline | ✅ | ✅ | ❌ (degraded) | Partial | ✅ | ✅ | Partial | Partial | Partial |

## What Note Keeper adopts and why

- **Plain-Markdown, local-first vault (Obsidian).** The single biggest
  design decision: a vault is just a directory Obsidian itself would
  recognise. This is what makes every other "adopted" feature below possible
  without reinventing sync, and it is what `server/internal/vault/vault.go`
  exists to police (every path is resolved through one choke point that
  refuses to let any handler escape the vault root). See
  `docs/ARCHITECTURE.md` for the full path-safety design.
- **Wikilinks, embeds, backlinks and the graph view (Obsidian).**
  `server/internal/note/note.go` parses `[[wikilinks]]`, `![[embeds]]` and
  `#tags` the way Obsidian's parser does; `server/internal/index/index.go`
  resolves them the same way Obsidian resolves an ambiguous link (shortest
  matching path wins) and exposes backlinks and a link graph, rendered by
  `src/client/Graph.jsx` with the same "ghost node for an unresolved link"
  convention Obsidian's graph uses.
- **Rename-safe links (Obsidian).** `RewriteWikilinks` in
  `server/internal/api/api.go` updates every note that referenced a moved
  file, so the graph and backlinks never silently rot the way they would in
  an app that treats notes as independent documents (e.g. Evernote,
  Notion pages by title).
- **Daily notes and templates (Obsidian / Logseq).** `notes_daily` and the
  `/daily`, `/templates` daemon routes replicate Obsidian's Daily Notes core
  plugin, including `{{title}}`/`{{date}}`/`{{time}}` template variable
  expansion (`ApplyTemplate` in `api.go`).
- **Quick capture (Google Keep's core loop, adapted to a single Inbox
  file).** `notes_capture` and the sidebar's capture dialog append a
  timestamped bullet or task to `Inbox.md` — the same "capture now, file
  later" workflow Keep is built around, but landing in an ordinary Markdown
  file instead of a proprietary note object.
- **Nested tags and full-text search (Logseq/Obsidian, tuned for a bilingual
  household).** `note.Fold` in `note.go` folds Greek and Latin diacritics
  (Καλημέρα ≈ καλημερα) so search and tag matching work the same regardless
  of accents or case — a refinement neither Obsidian nor Logseq ship out of
  the box, driven by the estate's actual bilingual (Greek/English/Italian)
  usage.
- **Zero-knowledge end-to-end encryption (Standard Notes' core promise,
  Joplin's E2E sync).** `src/client/crypto.js` follows the same shape as
  Standard Notes and Joplin: the server never sees a key, only ciphertext
  envelopes and (for a folder) a salt + verifier. Note Keeper goes further
  than either by scoping encryption per-note or per-folder rather than
  whole-account, and by keeping the vault fully readable by Obsidian
  side-by-side (the envelope is valid Markdown with a visible warning, not
  an opaque proprietary blob).
- **Drawing/whiteboard with OCR (Apple Notes' Markup, Evernote's OCR).**
  `src/client/Paint.jsx` plus `server/internal/api/api.go`'s `/ocr` route
  combine what Apple Notes and Evernote each do separately: a native
  drawing surface (raster + editable vector shapes, not just an image) and
  automatic text extraction from what was drawn or attached, using
  Tesseract (`eng+ell`) rather than a cloud OCR service.
- **Built-in audio transcription (Apple's on-device dictation, adapted to a
  proper note format).** `src/client/Recorder.jsx` pins the transcription
  language explicitly (Greek and English first-class, several others
  offered) instead of relying on auto-detect, because the estate's own
  measurements found pinned-language whisper-large-v3 more accurate for
  Greek than auto-detection.
- **AI-native tool surface (none of the compared apps ship this natively;
  Notion AI and Apple Intelligence are the closest, both cloud/OS-vendor
  features, not app-defined tools).** `lib/tools.js`'s 12 `notes_*` tools
  let the DSH host chat's model read, search and edit the vault under the
  same conflict-detection and path-safety rules as the human — and under a
  hard "never touch encrypted content" rule no compared app enforces because
  none of them expose a first-class AI tool surface at all.

## Deliberately not adopted (yet)

- **Real-time multi-user collaboration (Notion, Google Keep, shared Apple
  Notes, Evernote shared notebooks).** Note Keeper is single-writer per
  session by design: the conflict-detection model (`baseMtime` +
  a conflict banner) assumes edits are rare collisions between a human, an
  AI tool and a sync client landing an offline edit — not simultaneous
  cursors in the same document. True operational-transform or CRDT-based
  concurrent editing is a different architecture (a live document server,
  not a filesystem watcher) and would conflict with the "it's just files on
  disk" design that makes Obsidian/Syncthing/git compatibility free.
- **Notion-style databases and structured properties.** Notion's core
  strength — typed properties, views, relations, formulas — needs a real
  schema and query engine, which is exactly what a plain-Markdown vault
  avoids. Dataview/Bases-style plugins bolt something similar onto
  Obsidian; Note Keeper could eventually parse frontmatter into filterable
  "properties" views without adopting Notion's database model wholesale,
  but that is out of scope for now.
- **Publishing to the web.** Obsidian Publish, Notion's public pages, and
  share links in Apple Notes/Evernote/Keep/OneNote all assume the note
  server is reachable from the internet. Note Keeper's daemon is
  loopback-only by design (see `docs/ARCHITECTURE.md`'s threat model); a
  publish feature would need a deliberate, separate exposure mechanism, not
  a toggle on the existing route.
- **A first-party mobile app.** Note Keeper is a DSH web GUI plugin; DSH
  itself does not ship a mobile client. The vault stays reachable from a
  phone through the same channel Obsidian mobile users already use
  (Syncthing, Obsidian Sync, iCloud/Möbius Sync, or git), so mobile access
  exists today without Note Keeper needing to build and maintain a second
  client.
- **A third-party plugin API.** Obsidian's and Joplin's plugin ecosystems
  are a major part of their value, but building and securing a second
  plugin surface inside a DSH plugin is a lot of attack surface for a
  single-maintainer project; the `notes_*` AI tools already give
  programmatic access to the vault without it.

## Roadmap (prioritized)

1. **Frontmatter "properties" view** — a lightweight, read-only table view
   over a folder's frontmatter keys (closest useful subset of Notion's
   databases without adopting its data model).
2. **Mobile-friendly layout** for the existing web GUI (a phone browser
   hitting `llm.tzekos.eu` today gets the desktop layout).
3. **Version history / snapshotting** for notes outside `.trash`, so a bad
   overwrite (choosing "mine" on a conflict) is recoverable without relying
   on an external sync tool's own history.
4. **Optional cloud OCR fallback** for handwriting Tesseract struggles with,
   kept strictly opt-in given the zero-knowledge encryption promise.
5. **A read-only public share link** for a single unencrypted note, built on
   the estate's existing `/report-public/` pattern rather than exposing the
   daemon itself.
