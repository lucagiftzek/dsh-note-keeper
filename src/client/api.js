/**
 * Browser client for the /note-keeper/api route (served by the host plugin,
 * backed by the Go daemon). Every mutation carries the CSRF markers the host
 * gate requires; the harness session cookie rides along automatically.
 */

export const BASE = '/note-keeper/api'
const XRW = 'dsh-note-keeper'

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || 'HTTP ' + status)
    this.status = status
    this.code = body && body.code
    this.body = body
  }
}

async function parse(res) {
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { error: text } }
  if (!res.ok) throw new ApiError(res.status, body)
  return body
}

const qs = (o) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? '?' + s : ''
}

export function get(path, query) {
  return fetch(BASE + path + qs(query), { credentials: 'same-origin' }).then(parse)
}

export function send(method, path, json, query) {
  return fetch(BASE + path + qs(query), {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': XRW },
    body: json === undefined ? undefined : JSON.stringify(json),
  }).then(parse)
}

export function sendBinary(path, blob, query) {
  return fetch(BASE + path + qs(query), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream', 'x-requested-with': XRW },
    body: blob,
  }).then(parse)
}

/** URL for an attachment (images, audio, video, pdf) inside the vault. */
export const fileUrl = (path, download) => BASE + '/file' + qs({ path, download: download ? 1 : undefined })

export const api = {
  status: () => get('/status'),
  tree: () => get('/tree'),
  note: (path) => get('/note', { path }),
  save: (path, content, baseMtime, create) => send('PUT', '/note', { path, content, baseMtime: baseMtime || 0, create: Boolean(create) }),
  create: (folder, title, content) => send('POST', '/note/new', { folder, title, content: content || '' }),
  move: (from, to) => send('POST', '/move', { from, to }),
  trash: (path, purge) => send('DELETE', '/entry', undefined, { path, purge: purge ? 1 : undefined }),
  mkdir: (path) => send('POST', '/folder', { path }),
  search: (q, opts) => get('/search', { q, ...(opts || {}) }),
  tags: () => get('/tags'),
  graph: (tags) => get('/graph', { tags: tags ? 1 : undefined }),
  recent: (limit) => get('/recent', { limit }),
  upload: (blob, name, dir, encrypted) => sendBinary('/attachment', blob, { name, dir, encrypted: encrypted ? 1 : undefined }),
  fileBytes: async (path) => {
    const r = await fetch(fileUrl(path), { credentials: 'same-origin' })
    if (!r.ok) throw new ApiError(r.status, { error: 'download failed' })
    return new Uint8Array(await r.arrayBuffer())
  },
  ocrBlob: (blob, lang) => sendBinary('/ocr', blob, { lang }),
  ocrPath: (path, lang) => send('POST', '/ocr', { path, lang }),
  capture: (text, todo, target) => send('POST', '/capture', { text, todo: Boolean(todo), target: target || '' }),
  // Remote devices and cloud mirror (see docs/SYNC-PROTOCOL.md).
  syncStatus: () => get('/sync/status'),
  syncPair: () => send('POST', '/sync/pair', {}),
  syncRevoke: (id) => send('DELETE', '/sync/device', undefined, { id }),
  syncWebDAV: (name) => send('POST', '/sync/webdav', { name }),
  syncRemotes: () => get('/sync/remotes'),
  syncSetCloud: (cfg) => send('PUT', '/sync/cloud', cfg),
  syncRunCloud: () => send('POST', '/sync/cloud/run', {}),
  // Import (Markdown, text, HTML, Evernote .enex, Google Keep, Notion/Obsidian zip).
  importFile: (blob, name, dir) => sendBinary('/import', blob, { name, dir }),
  // AI Enhance (answered by the host: model access belongs to DSH).
  aiSettings: () => get('/ai/settings'),
  aiSaveSettings: (s) => send('PUT', '/ai/settings', s),
  aiModels: () => get('/ai/models'),
  aiEnhance: (text, title) => send('POST', '/ai/enhance', { text, title }),
  daily: (date) => send('POST', '/daily', { date: date || '' }),
  templates: () => get('/templates'),
  lockInfo: (folder) => get('/lock', { folder }),
  lock: (folder, marker) => send('POST', '/lock', { folder, marker }),
  unlockFolder: (folder) => send('DELETE', '/lock', undefined, { folder }),
}

/**
 * Subscribe to live vault changes (own writes, Obsidian, sync clients).
 * Reconnects with backoff; returns an unsubscribe function.
 */
export function subscribe(onEvent) {
  let es = null
  let closed = false
  let delay = 1000
  let timer = null
  const open = () => {
    if (closed || typeof EventSource === 'undefined') return
    es = new EventSource(BASE + '/events', { withCredentials: true })
    const handle = (e) => { delay = 1000; try { onEvent(JSON.parse(e.data)) } catch { /* ignore */ } }
    es.addEventListener('change', handle)
    es.addEventListener('rescan', handle)
    es.addEventListener('hello', () => { delay = 1000; onEvent({ type: 'hello', paths: [] }) })
    es.onerror = () => {
      es.close()
      if (closed) return
      timer = setTimeout(open, delay)
      delay = Math.min(30000, delay * 2)
    }
  }
  open()
  return () => { closed = true; clearTimeout(timer); if (es) es.close() }
}

/** Speech-to-text through dsh-voice (same origin). lang: 'el' | 'en' | 'auto' | ... */
export async function transcribe(blob, lang) {
  const fd = new FormData()
  const ext = /ogg/.test(blob.type) ? 'ogg' : /mp4|m4a/.test(blob.type) ? 'm4a' : /wav/.test(blob.type) ? 'wav' : 'webm'
  fd.append('file', blob, 'recording.' + ext)
  const q = lang && lang !== 'auto' ? '?lang=' + encodeURIComponent(lang) : ''
  const r = await fetch('/api/voice/stt' + q, { method: 'POST', body: fd, credentials: 'same-origin' })
  let body = null
  try { body = await r.json() } catch { /* not JSON */ }
  if (r.status === 404 && !body) throw new ApiError(404, { error: 'speech-to-text is unavailable (the dsh-voice plugin is not installed)' })
  if (!r.ok) throw new ApiError(r.status, body || { error: 'transcription failed' })
  return body // { text, language, engine }
}

/** Optional clean-up pass (punctuation, casing) through dsh-voice. */
export async function polish(text) {
  const r = await fetch('/api/voice/polish', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
  if (!r.ok) return { text, polished: false }
  return r.json()
}
