# Note Keeper Sync protocol, version 1

Two-way sync between the Note Keeper vault on the server and remote clients
(the Obsidian plugin in `obsidian-plugin/`, WebDAV apps, rclone cloud mirrors).

## Research summary and choice

| Option | Mobile | Two-way | Needs 3rd party | Verdict |
|---|---|---|---|---|
| Obsidian Sync (official) | yes | yes | Obsidian account; no public API or server | cannot be connected to a server. It can run alongside Note Keeper Sync on the same vault |
| Syncthing / iCloud folder / Drive desktop app on the server | partly (no Syncthing on iOS) | yes | a desktop agent per device | still documented, but not "direct" |
| Self-hosted LiveSync (CouchDB) | yes | yes | CouchDB, its own storage format | heavy; vault stored as chunks, not files |
| Remotely Save (WebDAV/S3/Dropbox) | yes | yes | the plugin | good fit: Note Keeper serves **WebDAV** so it works as-is |
| **Note Keeper Sync plugin (native protocol)** | yes (`requestUrl`, no CORS) | yes, three-way merge | none | **primary**: pairing codes, signed requests, locked-folder rules, conflict copies |
| rclone bisync from the server | n/a | yes | rclone remote | **cloud mirror** to Google Drive, OneDrive, Dropbox, iCloud Drive, S3, and others |

The three-way decision table follows Remotely Save's v3 sync algorithm
(itself based on synclone, rsinc and rclone bisync): each client keeps the
hashes from its last successful sync as the common base.

## Transport and endpoint

- Public base URL: `https://llm.tzekos.eu/nk-sync` (TLS by Cloudflare). A
  dedicated edge route sends only `/nk-sync/` to the daemon's sync listener
  (`127.0.0.1:3095`), bypassing the SSO gate. Every request except
  `hello` and `pair` must be authenticated by a paired device.
- All paths are vault-relative, `/`-separated and NFC. Hidden segments are
  never synced, except lock markers named `.nk-lock.json`, which must travel
  with encrypted folders.

## Pairing (handshake)

1. In Note Keeper, **Connect → Obsidian / other device** creates a one-time
   pairing code: 10 characters of Crockford base32, valid 10 minutes, at most
   5 attempts.
2. The client calls `POST /nk-sync/v1/pair` with
   `{"code": "...", "device": {"name": "...", "platform": "...", "app": "..."}}`.
3. The server replies `{"deviceId": "d_…", "secret": "<base64url 32 bytes>", "vault": "<name>", "protocol": 1}`.
   The secret is shown to the client once, stored on the server in a 0600
   state file outside the vault, and revocable from the UI.

Failed pairings and failed signatures are rate-limited per client IP: after
30 failures in 10 minutes, the IP gets 429 for 15 minutes.

## Request signing

Every authenticated request carries:

```
X-NK-Device:      d_…
X-NK-Time:        <unix seconds>
X-NK-Nonce:       <16+ random base64url chars>
X-NK-Body-SHA256: <hex sha256 of the exact body bytes; of "" when empty>
X-NK-Signature:   base64url( HMAC-SHA256(secret, "NK1\n" + METHOD + "\n" + REQUEST_URI + "\n" + time + "\n" + nonce + "\n" + bodyHash) )
```

`REQUEST_URI` is the path and query exactly as sent, for example
`/nk-sync/v1/file?path=Notes%2FA.md&base=`. Query values are encoded with
`encodeURIComponent`. The server rejects clock skew over 300 s, reused
nonces (10-minute window), a body hash mismatch and a bad signature (401).
Revoked devices get 401 `{"error":"revoked"}`.

## Endpoints

| Method and path | Purpose |
|---|---|
| `GET /nk-sync/v1/hello` | unauthenticated: `{"server":"note-keeper","protocol":1}` |
| `POST /nk-sync/v1/pair` | pairing, see above |
| `GET /nk-sync/v1/whoami` | `{"deviceId","name","vault"}` |
| `GET /nk-sync/v1/manifest` | `{"version":"…","files":[{"path","size","mtime","hash"}]}` with `ETag`; `If-None-Match` → 304. `hash` = hex sha256, `mtime` = unix ms |
| `GET /nk-sync/v1/file?path=P` | raw bytes; headers `X-NK-Hash`, `X-NK-Mtime` |
| `PUT /nk-sync/v1/file?path=P&base=H&mtime=M` | compare-and-swap write. `base` = hash the client last saw, empty = must not exist. Replies 200 `{"hash","mtime"}`; 409 `{"error":"conflict","current":{"hash","mtime"}}`; 423 when plaintext would land in an encrypted folder; 413 over 95 MB |
| `DELETE /nk-sync/v1/file?path=P&base=H` | moves to `.trash`; 409 when the hash differs; 404 when already gone (treat as success) |

## Client algorithm (three-way)

For every path in local ∪ remote ∪ base, with `L`, `R` and `B` the
local, remote and base hashes (null when absent):

| Case | Action |
|---|---|
| L = R | record B := L (drop the record when both are null) |
| L = B, R ≠ B | remote changed: pull, or delete locally when R is null (to the Obsidian trash) |
| R = B, L ≠ B | local changed: push with `base=B`, or remote DELETE when L is null |
| L null, R ≠ B | local delete vs remote edit: **pull** (never lose an edit) |
| R null, L ≠ B | remote delete vs local edit: **push** as a create |
| otherwise | conflict: rename the local file to `Name (conflict <device> YYYY-MM-DD HHmm).ext`, push it, pull the remote version into the original path |

- A 409 on push or delete means the remote changed between manifest and
  write. Skip the file and retry next cycle.
- Deletion guard: if one cycle would delete more than 50% of the files
  (and more than 10), stop and ask the user.
- The base record is written only after each operation succeeds, so an
  interrupted sync resumes safely.
- Cadence: on start, every N seconds (default 20, using `If-None-Match`),
  and 3 s after local edits settle.

## WebDAV (for other apps)

`https://llm.tzekos.eu/nk-sync/dav/` uses Basic auth: user = device id,
password = the device secret, from **Connect → WebDAV app**. It works with
Remotely Save (Obsidian), Cyberduck, rclone, the iOS/Android Files apps and
most Markdown editors with WebDAV sync. Deletes go to `.trash`, and hidden
files are not exposed. Plaintext writes into encrypted folders are refused
(403) when the upload finishes.

## Cloud mirror (rclone bisync)

The server can mirror the vault two ways with any configured rclone remote
(`gdrive:`, OneDrive, Dropbox, iCloud Drive via `iclouddrive`, S3, WebDAV)
on an interval. The first run is a union merge (`--resync`). Later runs
propagate edits and deletes on both sides; on conflict the newer copy wins
and the loser is kept as a numbered copy. `.obsidian/` and `.trash/` are
excluded.
