/**
 * dsh-note-keeper — browser request gate for the /note-keeper/api route.
 *
 * dsh does NOT authenticate plugin routes, so every request is checked here
 * before it may reach the Go daemon. The gate is a behavioural copy of the
 * estate's proven pattern (dsh-orchestrator/lib/security.js, dsh-workspace-
 * rail/src/host/api.ts), itself derived from the harness's isTrustedApiRequest:
 *
 *   R1 loopback peer     dsh-web binds 127.0.0.1; public traffic arrives via
 *                        the local reverse proxy, never directly.
 *   R2 trust fence       Host must be loopback or a configured trusted host;
 *                        sec-fetch-site must not be cross-site; an Origin, if
 *                        present, must match the Host (DNS-rebinding defence).
 *   R3 CSRF (mutations)  sec-fetch-site same-origin, Origin present, a JSON or
 *                        octet-stream body, and X-Requested-With naming this
 *                        plugin — a cross-site form can set none of these
 *                        without a CORS preflight this route never answers.
 *   R4 session cookie    the harness browser-session cookie must be present on
 *                        EVERY request (notes are private, reads included).
 *
 * @module dsh-note-keeper/security
 */

'use strict'

import { createHash } from 'node:crypto'

export const PLUGIN_ID = 'dsh-note-keeper'
const COOKIE_PREFIX = 'dsh-auth-'

function header(headers, name) {
  const v = headers ? headers[name] : undefined
  return typeof v === 'string' ? v : undefined
}

function parseAuthority(authority) {
  try { return new URL('http://' + authority) } catch { return undefined }
}

export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = String(hostname).split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

export function isLoopbackPeer(remoteAddress) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(remoteAddress ?? ''))
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/** R2: the harness's own fence, behaviour for behaviour. */
export function isTrustedApiRequest(req, trustedHosts = []) {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

/** The harness browser-session cookie name for this request's authority. */
export function harnessCookieName(hostHeader) {
  const hostUrl = parseAuthority(String(hostHeader ?? ''))
  if (!hostUrl) return null
  const digest = createHash('sha256').update(hostUrl.host).digest()
  return COOKIE_PREFIX + digest.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** Presence-only read of one exact cookie. */
export function hasCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || !name) return false
  for (const segment of cookieHeader.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim().length > 0
  }
  return false
}

const MUTATING = new Set(['POST', 'PUT', 'DELETE'])
const BODY_TYPES = new Set(['application/json', 'application/octet-stream'])

/**
 * Check one browser request. Returns { ok: true } or
 * { ok: false, status, layer, reason } naming exactly one failed layer.
 */
export function checkRequest(req, { trustedHosts = [], requireCookie = true } = {}) {
  const method = req.method || 'GET'
  if (method !== 'GET' && method !== 'HEAD' && !MUTATING.has(method)) {
    return { ok: false, status: 405, layer: 'R0', reason: 'method not allowed' }
  }
  if (!isLoopbackPeer(req.socket && req.socket.remoteAddress)) {
    return { ok: false, status: 403, layer: 'R1', reason: 'non-loopback peer' }
  }
  if (!isTrustedApiRequest(req, trustedHosts)) {
    return { ok: false, status: 403, layer: 'R2', reason: 'cross-site or untrusted Host' }
  }
  if (MUTATING.has(method)) {
    const site = header(req.headers, 'sec-fetch-site')
    if (site !== 'same-origin') {
      return { ok: false, status: 403, layer: 'R3', reason: 'sec-fetch-site must be same-origin on a mutation (got ' + String(site) + ')' }
    }
    if (header(req.headers, 'origin') === undefined) {
      return { ok: false, status: 403, layer: 'R3', reason: 'Origin must be present on a mutation' }
    }
    const ctype = (header(req.headers, 'content-type') || '').split(';')[0].trim().toLowerCase()
    if (method !== 'DELETE' && !BODY_TYPES.has(ctype)) {
      return { ok: false, status: 415, layer: 'R3', reason: 'content-type must be application/json or application/octet-stream' }
    }
    if (header(req.headers, 'x-requested-with') !== PLUGIN_ID) {
      return { ok: false, status: 403, layer: 'R3', reason: 'x-requested-with must name this plugin' }
    }
  }
  if (requireCookie) {
    const name = harnessCookieName(header(req.headers, 'host'))
    if (!name || !hasCookie(header(req.headers, 'cookie'), name)) {
      return { ok: false, status: 403, layer: 'R4', reason: 'no harness browser-session cookie on this request' }
    }
  }
  return { ok: true }
}
