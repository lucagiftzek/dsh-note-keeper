/**
 * Client-side, zero-knowledge encryption for notes, folders and attachments.
 *
 * Nothing secret ever leaves the browser: passwords are stretched with
 * PBKDF2-SHA-256 (600,000 iterations, OWASP 2023 guidance) into an AES-256-GCM
 * key held only in memory. The server stores ciphertext envelopes and, for a
 * locked folder, a marker with the salt plus a key *verifier* (the encryption
 * of a fixed string) so a wrong password is detected without decrypting notes.
 *
 * Envelope (a valid Markdown file, so Obsidian and sync tools treat it as an
 * ordinary note and show the placeholder text):
 *
 *   ---
 *   nk-encrypted: v1
 *   nk-scope: note | folder
 *   nk-kdf: PBKDF2-SHA256
 *   nk-iter: 600000
 *   nk-salt: <base64>        (folder notes repeat the folder marker's salt)
 *   nk-iv: <base64>          (fresh 96-bit IV per write)
 *   nk-hint: <optional>
 *   ---
 *   > Encrypted with Note Keeper ...
 *
 *   ```nk-cipher
 *   <base64 ciphertext, wrapped>
 *   ```
 *
 * There is no recovery path by design: lose the password, lose the data.
 */

export const ITERATIONS = 600000
export const VERIFIER_TEXT = 'note-keeper-verifier-v1'
const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64(bytes) {
  let s = ''
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000))
  return btoa(s)
}

export function unb64(s) {
  const bin = atob(String(s).replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))

/** Derive a non-extractable AES-GCM key from a password. */
export async function deriveKey(password, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptBytes(key, bytes) {
  const iv = randomBytes(12)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))
  return { iv, ct }
}

export async function decryptBytes(key, iv, ct) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct))
}

/** Binary attachment format: "NKE1" | iv(12) | ciphertext. */
export async function sealBlob(key, bytes) {
  const { iv, ct } = await encryptBytes(key, bytes)
  const out = new Uint8Array(4 + 12 + ct.length)
  out.set(enc.encode('NKE1'), 0)
  out.set(iv, 4)
  out.set(ct, 16)
  return out
}

export async function openBlob(key, sealed) {
  if (dec.decode(sealed.subarray(0, 4)) !== 'NKE1') throw new Error('not a Note Keeper encrypted file')
  return decryptBytes(key, sealed.subarray(4, 16), sealed.subarray(16))
}

const wrap = (s, n = 76) => s.replace(new RegExp('(.{' + n + '})', 'g'), '$1\n').trim()

/** Parse an envelope's metadata; returns null for plaintext notes. */
export function parseEnvelope(text) {
  const m = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  if (!m) return null
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')
  }
  if (!meta['nk-encrypted']) return null
  const c = /```nk-cipher\r?\n([\s\S]*?)\r?\n```/.exec(text)
  if (!c) return null
  return {
    version: meta['nk-encrypted'],
    scope: meta['nk-scope'] || 'note',
    iter: Number(meta['nk-iter']) || ITERATIONS,
    salt: meta['nk-salt'] || '',
    iv: meta['nk-iv'] || '',
    hint: meta['nk-hint'] || '',
    cipher: c[1],
  }
}

export const isEnvelope = (text) => parseEnvelope(text) !== null

/** Build an envelope around plaintext. salt is only written for note scope. */
export async function sealNote(key, plaintext, { scope = 'note', salt, iter = ITERATIONS, hint = '' } = {}) {
  const { iv, ct } = await encryptBytes(key, enc.encode(plaintext))
  const lines = ['---', 'nk-encrypted: v1', 'nk-scope: ' + scope, 'nk-kdf: PBKDF2-SHA256', 'nk-iter: ' + iter]
  // The salt is written for BOTH scopes: a folder note stays decryptable from
  // its own envelope even if the folder marker is lost mid-operation.
  if (salt) lines.push('nk-salt: ' + b64(salt))
  lines.push('nk-iv: ' + b64(iv))
  if (hint) lines.push('nk-hint: ' + JSON.stringify(String(hint).slice(0, 120)))
  lines.push('---')
  return lines.join('\n') + '\n> [!warning] Encrypted with Note Keeper\n> This note is end-to-end encrypted. Open it in Note Keeper and enter its password to read it.\n\n```nk-cipher\n' + wrap(b64(ct)) + '\n```\n'
}

/** Decrypt an envelope. Throws "wrong password" on authentication failure. */
export async function openNote(key, env) {
  try {
    return dec.decode(await decryptBytes(key, unb64(env.iv), unb64(env.cipher)))
  } catch {
    throw new Error('wrong password (or the note was tampered with)')
  }
}

/** Create a folder marker: salt + verifier, never the key. */
export async function makeFolderMarker(password, hint) {
  const salt = randomBytes(16)
  const key = await deriveKey(password, salt)
  const { iv, ct } = await encryptBytes(key, enc.encode(VERIFIER_TEXT))
  return { key, marker: { kdf: 'PBKDF2-SHA256', iter: ITERATIONS, salt: b64(salt), iv: b64(iv), verifier: b64(ct), hint: hint || '' } }
}

/** Check a password against a folder marker; returns the key or throws. */
export async function unlockFolderKey(password, marker) {
  const key = await deriveKey(password, unb64(marker.salt), marker.iter || ITERATIONS)
  try {
    const plain = dec.decode(await decryptBytes(key, unb64(marker.iv), unb64(marker.verifier)))
    if (plain !== VERIFIER_TEXT) throw new Error('verifier mismatch')
  } catch {
    throw new Error('wrong password')
  }
  return key
}

/**
 * In-memory key ring. Keys are CryptoKey objects (non-extractable), keyed by
 * "folder:<path>" or "note:<path>", and forgotten after an idle timeout or
 * an explicit "lock now". Nothing is ever written to storage.
 */
export class KeyRing {
  constructor(idleMs = 10 * 60 * 1000) {
    this.idleMs = idleMs
    this.keys = new Map()
    this.listeners = new Set()
  }
  set(id, key, extra) {
    this.keys.set(id, { key, extra, touched: Date.now() })
    this.emit()
  }
  get(id) {
    const e = this.keys.get(id)
    if (!e) return null
    if (Date.now() - e.touched > this.idleMs) { this.keys.delete(id); this.emit(); return null }
    e.touched = Date.now()
    return e
  }
  has(id) { return this.get(id) !== null }
  forget(id) { if (this.keys.delete(id)) this.emit() }
  clear() { if (this.keys.size) { this.keys.clear(); this.emit() } }
  sweep() {
    let changed = false
    for (const [id, e] of this.keys) if (Date.now() - e.touched > this.idleMs) { this.keys.delete(id); changed = true }
    if (changed) this.emit()
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  emit() { for (const fn of this.listeners) { try { fn() } catch { /* listener error */ } } }
}
