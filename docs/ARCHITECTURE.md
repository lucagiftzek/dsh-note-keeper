# Architecture

```
 Browser (DSH web GUI)                        dsh-web (Node, 127.0.0.1:3080)                 notekeeperd (Go, 127.0.0.1:<random>)
 ┌─────────────────────────────┐   same-     ┌──────────────────────────────────┐  HTTP +    ┌───────────────────────────────┐
 │ sidebar.panellist "Notes"   │   origin    │ lib/index.js  apply()            │  X-NK-     │ api      routes, limits, OCR  │
 │ main slot "note-keeper"     │──fetch/SSE─▶│  ├ proxy.js  /note-keeper/api/*  │──Secret──▶ │ index    search/tags/links    │
 │  App.jsx  Editor Recorder   │             │  │   security.js gate R1–R4      │            │ watch    fsnotify + SSE hub   │
 │  Paint Graph crypto.js      │             │  ├ daemon.js  spawn/supervise    │◀─stdout────│ vault    safe paths, atomic   │
 │  (keys never leave the tab) │             │  └ tools.js   12 notes_* tools   │ NK_LISTEN  │          writes, locks, trash │
 └─────────────────────────────┘             └──────────────────────────────────┘            └──────────────┬────────────────┘
          │ /api/voice/stt (dsh-voice)                     ▲ model tool calls                               │ plain files
          ▼                                                │                                                ▼
   speech-to-text engines                         any DSH chat model                     ~/NoteKeeper  ◀── Obsidian / Syncthing /
                                                                                                         Obsidian Sync / git (mobile)
```

## Request flow

1. The browser calls `/note-keeper/api/<route>` with the harness session cookie;
   mutations also send `Origin`, `sec-fetch-site: same-origin`, a JSON or
   octet-stream body and `X-Requested-With: dsh-note-keeper`.
2. `lib/security.js` checks: R1 loopback peer, R2 trusted Host / no cross-site /
   matching Origin, R3 CSRF markers on mutations, R4 cookie present on every request.
3. `lib/proxy.js` forwards only allow-listed `METHOD /path` pairs, strips cookies,
   adds the per-spawn daemon secret, and streams bodies both ways (uploads, Range
   downloads, SSE).
4. `notekeeperd` validates every path through `vault.Resolve` (no absolute paths,
   `..`, hidden segments or symlink escapes) and serves the request.

AI tools call the same daemon API directly from the host process, so they share
every validation rule with the UI.

## Daemon packages (`server/internal`)

| Package | Responsibility |
|---|---|
| `vault` | Path choke point, atomic temp-file+rename writes, optimistic concurrency (`baseMtime`), `.trash`, purge, lock markers, refusal of plaintext in locked folders |
| `note` | Frontmatter/tag/link parsing (Obsidian rules), Greek/Latin accent folding, tokenizer |
| `index` | In-memory inverted index (RWMutex), AND + prefix + phrase search, snippets, tags, link resolution, backlinks, graph |
| `watch` | Recursive fsnotify with debounce, reindex, SSE hub fan-out, periodic rescan |
| `api` | HTTP handlers, limits, OCR worker pool (semaphore), capture/daily/templates, link rewrite |

Concurrency: HTTP handlers run concurrently; the index serialises writers with a
single RWMutex (reads are parallel); OCR runs at most `OCRParallel` Tesseract
processes; the watcher coalesces bursts (200 ms debounce) before reindexing.

## Encryption design (`src/client/crypto.js`)

- KDF: PBKDF2-SHA-256, 600,000 iterations, 16-byte random salt.
- Cipher: AES-256-GCM, fresh 96-bit IV per write; the key is a non-extractable
  `CryptoKey` held in an in-memory `KeyRing` (10-minute idle expiry, "Lock all").
- Note envelope (valid Markdown):

```
---
nk-encrypted: v1
nk-scope: note | folder
nk-kdf: PBKDF2-SHA256
nk-iter: 600000
nk-salt: <base64>
nk-iv: <base64>
nk-hint: "<optional>"
---
> [!warning] Encrypted with Note Keeper
> ...
\`\`\`nk-cipher
<base64 ciphertext, 76-column lines>
\`\`\`
```

- Folder lock marker `.nk-lock.json`: `{v, kdf, iter, salt, iv, verifier, hint, created}`;
  `verifier` is the encryption of a fixed string, so a wrong password is detected
  without touching notes. Folder notes repeat the salt, so they stay decryptable
  even if the marker is lost.
- Attachments in encrypted folders: `<name>.nkenc` = `"NKE1" | iv(12) | ciphertext`,
  decrypted to blob URLs in the browser.

### Threat model

| Party | Can see | Cannot see |
|---|---|---|
| Server / daemon / disk | file and folder names, sizes, times, envelope metadata, hint | note bodies, attachment contents, passwords, keys |
| Sync providers, Obsidian | same as server | same |
| AI tools | plaintext notes only | encrypted notes (tools refuse), cannot write into locked folders |
| Browser tab with key | everything in the unlocked scope | — |

Known limits: names stay visible; transcription of audio in an encrypted folder
sends the audio to the speech service (the UI asks first); a compromised browser
session can read what it unlocks.

## Remote sync (v0.2)

```
 Obsidian + Note Keeper Sync plugin ─┐   HTTPS  ┌ Cloudflare ─ Traefik router llm-nk-sync ┐
 WebDAV apps (Remotely Save, Files) ─┼────────▶ │ (PathPrefix /nk-sync/, no SSO,          │──▶ notekeeperd sync listener
                                     ┘          └  rate limited)                          ┘    127.0.0.1:3095 (devsync)
 notekeeperd ──rclone bisync──▶ Google Drive / OneDrive / Dropbox / iCloud Drive / S3
```

`server/internal/devsync` owns device pairing (`devices.json` in the state directory,
outside the vault), request signing, the manifest (hash cache by size+mtime, ETag),
compare-and-swap writes, WebDAV and the rclone runner. The public listener never
reaches dsh or the browser API; it enforces the same vault path rules and the
encrypted-folder rule. Full protocol: [SYNC-PROTOCOL.md](SYNC-PROTOCOL.md).

## AI Enhance (v0.2)

`lib/ai.js` runs in the host: it calls the harness LLM service (`ctx.llm`) with the
default model for new chats (`ctx.agentDefaultModel`) unless AI settings pick
another. The prompt forbids translation and invented facts; links are limited to
existing note titles and any invented wikilink is unwrapped before the diff is
shown. Frontmatter is never sent and is re-attached byte-exact.

## Failure modes

- Daemon crash: restarted with exponential backoff (0.5 s → 30 s); the route
  answers 503 while it is down.
- dsh-web exit: the daemon sees stdin EOF and shuts down (no orphans).
- Concurrent edits: 409 with the disk version; the UI offers load / keep both / overwrite.
- Missed filesystem events: the 5-minute rescan reconciles the index.
- Partial folder encryption: already-encrypted files stay encrypted; re-running finishes the job.

## Testing strategy

- Go: unit tests per package, API integration via `httptest` (lifecycle, conflicts,
  link rewrite, locks, purge, attachments/headers, OCR with a generated image,
  external edits through the watcher), `-race`, `go vet`, `gofmt`, staticcheck.
- Node: host proxy + gate + tools against the real daemon binary; client logic
  (crypto, markdown sanitising, tree, resolver); paint/graph core; a jsdom smoke
  test rendering the real App against the real daemon.