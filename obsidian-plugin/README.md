# Note Keeper Sync

An Obsidian community plugin that syncs your vault two ways with a
[Note Keeper](../README.md) server: pairing codes, HMAC-signed requests,
a three-way merge (with a local base map so it survives interruptions),
conflict copies, and awareness of encrypted (locked) folders. Works on
desktop and mobile — the protocol and every wire call are described in
`../docs/SYNC-PROTOCOL.md`.

## Install

### Via BRAT (recommended while this stays outside the community plugin list)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. BRAT → "Add beta plugin", repository `lucagiftzek/dsh-note-keeper`.
   BRAT finds this plugin via the `manifest.json` at the repository root
   (a copy of `obsidian-plugin/manifest.json`) and installs the built
   `main.js`, `manifest.json` and `styles.css` from the latest release/tag.
3. Enable "Note Keeper Sync" in Settings → Community plugins.

### Manual install

1. Build the plugin (or download a release): `npm install && npm run build`
   inside `obsidian-plugin/`. This produces `main.js` next to
   `manifest.json` and `styles.css`.
2. Copy `main.js`, `manifest.json` and `styles.css` into
   `<your-vault>/.obsidian/plugins/note-keeper-sync/`.
3. Reload Obsidian (or disable/re-enable community plugins) and turn the
   plugin on in Settings → Community plugins.

## Pairing

1. In Note Keeper (the server's own UI), choose **Connect → Obsidian /
   other device**. This creates a one-time pairing code (10 characters,
   valid 10 minutes, at most 5 attempts).
2. In Obsidian, open Settings → Note Keeper Sync, paste the code into
   "Pairing code", and click **Connect**.
3. The plugin receives and stores a device id and secret, then starts
   syncing per your interval/trigger settings.

You can re-pair a new device at any time; each device gets its own
credentials and can be revoked independently from the Note Keeper UI.

## How sync works

Every run computes, for each path in *local ∪ remote ∪ last-known-base*,
which of the three-way cases from `docs/SYNC-PROTOCOL.md` applies:
unchanged, pull, push, a delete propagated either direction, "never lose
an edit" when one side deleted while the other edited, or — when both
sides changed independently — a **conflict**.

- **Conflicts** rename the local copy to
  `Name (conflict <device> YYYY-MM-DD HHmm).ext`, push that copy to the
  server under its new name, and pull the server's version into the
  original path. Nothing is silently overwritten or lost.
- **Deletes** go to the platform trash on both sides (Obsidian's own
  trash locally, `.trash/` on the server) — never a hard delete.
- **The deletion guard** refuses to delete more than half the synced
  files (and more than 10) in a single pass, to protect against e.g. a
  botched vault move being read as "everything is gone". Use
  Settings → **Allow one mass-deletion sync** to permit it exactly once.
- **A race with another device** (the server answers 409 on push or
  delete) is not an error: that one file is skipped and retried on the
  next sync pass.
- **Encrypted (locked) folders**: once a folder holds a Note Keeper
  `.nk-lock.json` marker, the server refuses any plaintext write into it
  (423). The plugin surfaces this in the sync log as "encrypted folder
  refused plaintext" and leaves the file unsynced rather than failing
  the whole run; encrypted envelopes and sealed `.nkenc` attachments
  sync normally.
- Files over 95 MB are skipped (logged), matching the server's own cap.
- The base map (what each side last agreed on, per path) is written to
  the plugin's data file after every single successful operation, so an
  interrupted sync simply resumes where it left off next time.

## Status and logs

The status bar shows "not connected", "syncing…", "✓ HH:MM" (idle, with
the last sync time), or "⚠ …" (an error or an aborted mass-deletion).
The ribbon icon and the **Sync now** command trigger a sync immediately.
**Show sync log** (command or settings button) opens a modal with the
last 100 sync operations (push/pull/delete/conflict/skip/error, with a
path and a one-line detail).

## Security notes

- The device secret is stored in this plugin's `data.json`, inside your
  vault's config folder (`.obsidian/plugins/note-keeper-sync/data.json`
  by default). Treat that file like a password: anything that can read
  your vault's config folder can read it. It is never sent anywhere
  except as an HMAC key (the secret itself never goes over the wire
  after pairing).
- Every authenticated request is individually signed
  (HMAC-SHA256 over method, path+query, time, a random nonce and the
  body hash) with a fresh nonce and a 300-second clock-skew window, so a
  captured request cannot be replayed.
- Revoke a device any time from the Note Keeper server UI; a revoked
  device gets 401 on its next request and the plugin surfaces that as
  "not connected" — reconnect with a fresh pairing code to resume.
- **Disconnect** in the plugin settings forgets the stored credentials
  and the local base map (it does not revoke the device server-side —
  do that from Note Keeper too if the device should no longer be able
  to sync at all).

## Mobile notes

The plugin is built to run unmodified on iOS and Android:

- All HTTP goes through `obsidian.requestUrl` (never `fetch`/`XHR`), so
  it is not subject to CORS and works the same in the mobile WebView as
  in the desktop Electron app.
- All cryptography (SHA-256, HMAC-SHA256) uses `globalThis.crypto.subtle`
  (Web Crypto) — no Node `crypto` module, which does not exist on
  mobile.
- The filesystem layer uses only `app.vault.adapter` and `app.vault`
  APIs (list/stat/read/write/trash/rename), never Node's `fs`.
- `manifest.json` sets `"isDesktopOnly": false`.

## Development

```sh
npm install
npm run build       # bundles src/main.ts -> main.js (esbuild, CJS, target es2020)
npm run dev         # esbuild in watch mode
npm run type-check  # tsc --noEmit --strict
npm test            # type-check, then the unit + integration test suites
```

`npm test` runs two Node test files:

- `test/engine.test.ts` — unit tests for the three-way decision table,
  exclusions and the deletion guard, entirely in-memory (no filesystem,
  no network).
- `test/integration.test.ts` — builds (or reuses `../bin/notekeeperd`)
  and spawns the real Go server, pairs real devices through its admin
  and sync APIs, and drives the actual `RemoteClient`/`SyncEngine`
  against it: initial sync, edits, conflicts, deletes, Greek/space
  filenames, a binary file, the encrypted-folder rule, and two
  independent clients converging through the server. The daemon is
  killed at the end of the run.

## Module layout

- `src/crypto.ts` — Web Crypto helpers (SHA-256, HMAC-SHA256 signing,
  nonces, base64url), no Node APIs.
- `src/remote.ts` — `RemoteClient`, a signed HTTP client for the sync
  protocol, driven by an injected transport (`obsidian.requestUrl` in
  production, `fetch` in tests).
- `src/engine.ts` — `SyncEngine`, the pure three-way sync algorithm
  against the `LocalFS`/`RemoteSyncClient` interfaces; no Obsidian or
  Node dependency, so it is unit-testable in isolation.
- `src/obsidian-fs.ts` — `ObsidianFS`, the `LocalFS` implementation over
  `app.vault.adapter`.
- `src/main.ts` — the `Plugin` subclass: settings tab, status bar,
  ribbon icon, commands, vault event wiring, scheduling and the sync log
  modal.
