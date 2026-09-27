/**
 * dsh-note-keeper — the browser-facing route (/note-keeper/api/*).
 *
 * Every request passes the security gate (security.js), then only an
 * allow-listed (method, path) pair is streamed to the daemon, with the
 * browser's cookies stripped and the daemon secret added. Bodies and
 * responses are piped, never buffered, so attachment uploads, audio
 * streaming (Range) and the SSE event stream all work unchanged.
 * @module dsh-note-keeper/proxy
 */

'use strict'

import { checkRequest } from './security.js'

export const API_PREFIX = '/note-keeper/api'

/** Daemon routes the browser may reach (method + path). */
export const ALLOWED = new Set([
  'GET /health', 'GET /tree', 'GET /note', 'PUT /note', 'POST /note/new', 'POST /move',
  'DELETE /entry', 'POST /folder', 'GET /search', 'GET /tags', 'GET /graph', 'GET /backlinks',
  'GET /recent', 'POST /attachment', 'GET /file', 'POST /ocr', 'POST /capture', 'POST /daily',
  'GET /templates', 'GET /lock', 'POST /lock', 'DELETE /lock', 'GET /events',
])

/** Request headers worth forwarding (everything else, cookies included, is dropped). */
const FORWARD = ['content-type', 'content-length', 'range', 'if-modified-since', 'if-range', 'accept']
/** Response headers worth returning. */
const BACK = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'content-disposition', 'content-security-policy', 'cache-control', 'x-content-type-options']

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/**
 * @param {object} deps
 * @param {import('./daemon.js').Daemon} deps.daemon
 * @param {() => object} deps.config       effective config
 * @param {() => object} deps.statusInfo   host-side status payload
 * @param {(m:string)=>void} deps.warn
 */
export function makeHandler({ daemon, config, statusInfo, warn = () => {} }) {
  return async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://note-keeper.local')
    const sub = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : url.pathname
    const method = req.method || 'GET'
    const gate = checkRequest(req, { trustedHosts: config().trustedHosts || [], requireCookie: config().requireCookie !== false })
    if (!gate.ok) return sendJson(res, gate.status, { error: gate.reason, layer: gate.layer })

    if (method === 'GET' && sub === '/status') {
      return sendJson(res, 200, statusInfo())
    }
    if (!ALLOWED.has(method + ' ' + sub)) return sendJson(res, 404, { error: 'no such note-keeper route' })

    const headers = {}
    for (const h of FORWARD) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h]
    let upstream
    try {
      upstream = await daemon.open(method, sub + url.search, headers, (up) => {
        const out = {}
        for (const h of BACK) if (up.headers[h] !== undefined) out[h] = up.headers[h]
        if (sub === '/events') { out['x-accel-buffering'] = 'no'; out['cache-control'] = 'no-store' }
        res.writeHead(up.statusCode || 502, out)
        up.pipe(res)
      })
    } catch (e) {
      return sendJson(res, 503, { error: 'note-keeper daemon unavailable: ' + String(e && e.message || e), daemon: daemon.status() })
    }
    upstream.on('error', (e) => {
      warn('proxy ' + method + ' ' + sub + ' failed: ' + String(e && e.message || e))
      if (!res.headersSent) sendJson(res, 502, { error: 'note-keeper daemon error' })
      else res.destroy()
    })
    // A closed browser tab must also close the daemon-side stream (SSE).
    res.on('close', () => { try { upstream.destroy() } catch { /* done */ } })
    req.pipe(upstream)
  }
}
