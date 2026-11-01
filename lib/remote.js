/**
 * dsh-note-keeper: server-side fetch of remote images shown in notes.
 *
 * A note may embed ![alt](https://example.com/pic.png). The preview used to
 * let the browser load it straight from that host: a third-party request that
 * leaked the reader's IP and escaped the DSH origin (and dsh-seal). The
 * browser now asks GET /note-keeper/api/remote-image?url=... and this module
 * fetches the image on the server, under an SSRF guard:
 *
 *   - https only, default port 443, no credentials in the URL;
 *   - every resolved address must be public (no loopback, private, link-local,
 *     CGNAT, multicast or reserved ranges, IPv4 and IPv6, mapped forms too);
 *     the check runs inside the socket's DNS lookup, so a rebinding answer
 *     cannot slip in between the check and the connect;
 *   - at most 3 redirects, each one validated again;
 *   - no cookies, no Referer, no browser headers forwarded;
 *   - image/* content types only, size and time limits, few concurrent fetches.
 *
 * @module dsh-note-keeper/remote
 */

'use strict'

import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'

export const REMOTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const REMOTE_IMAGE_TIMEOUT_MS = 15000
export const REMOTE_IMAGE_MAX_REDIRECTS = 3
export const REMOTE_IMAGE_MAX_CONCURRENT = 6
const MAX_URL_LENGTH = 4096

/** Content types the proxy passes back (SVG gets a sandboxing CSP). */
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/

const fail = (status, message) => Object.assign(new Error(message), { status })

function v4Parts(ip) {
  const p = ip.split('.').map((x) => Number(x))
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null
}

function isPublicV4(ip) {
  const p = v4Parts(ip)
  if (!p) return false
  const [a, b] = p
  if (a === 0 || a === 10 || a === 127) return false // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT 100.64/10
  if (a === 169 && b === 254) return false // link-local
  if (a === 172 && b >= 16 && b <= 31) return false // private
  if (a === 192 && b === 168) return false // private
  if (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) return false // IETF, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51 && p[2] === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && p[2] === 113) return false // TEST-NET-3
  if (a >= 224) return false // multicast, reserved, broadcast
  return true
}

/** Expand an IPv6 literal into 8 16-bit groups (null when malformed). */
function v6Groups(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  let tail = []
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (m) {
    const p = v4Parts(m[2])
    if (!p) return null
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]]
    s = m[1].endsWith('::') ? m[1] : m[1].slice(0, -1)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (h) => (h === '' ? [] : h.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)))
  const head = parse(halves[0])
  const back = halves.length === 2 ? parse(halves[1]) : []
  const fill = 8 - head.length - back.length - tail.length
  if (halves.length === 1 && fill !== 0) return null
  if (fill < 0) return null
  const groups = head.concat(new Array(halves.length === 2 ? fill : 0).fill(0), back, tail)
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

function isPublicV6(ip) {
  const g = v6Groups(ip)
  if (!g) return false
  if (g.every((x) => x === 0)) return false // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false // ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d: judge the IPv4 part.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isPublicV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.'))
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPublicV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.')) // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return false // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return false // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return false // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false // documentation
  if (g[0] === 0x2002) return false // 6to4 (embeds arbitrary IPv4)
  if (g[0] === 0x2001 && g[1] === 0) return false // Teredo
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false // discard 100::/64
  return true
}

/** Is this IP address publicly routable (safe for a server-side fetch)? */
export function isPublicAddress(ip) {
  const v = isIP(String(ip || '').replace(/^\[|\]$/g, ''))
  if (v === 4) return isPublicV4(ip)
  if (v === 6) return isPublicV6(ip)
  return false
}

/**
 * Parse and validate a remote image URL (shape only; addresses are checked
 * at connect time). Throws an Error with .status 400 when refused.
 * @param {string} raw
 * @returns {URL}
 */
export function checkRemoteUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL_LENGTH) throw fail(400, 'missing or oversized url')
  let u
  try { u = new URL(raw) } catch { throw fail(400, 'not a URL') }
  if (u.protocol !== 'https:') throw fail(400, 'only https images are fetched')
  if (u.username || u.password) throw fail(400, 'credentials in the URL are refused')
  if (u.port && u.port !== '443') throw fail(400, 'only the default https port is allowed')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw fail(400, 'local host names are refused')
  if (isIP(host) && !isPublicAddress(host)) throw fail(400, 'non-public address refused')
  return u
}

/** dns.lookup wrapper that refuses any non-public answer (rebinding-safe). */
export function guardedLookup(lookupImpl = dnsLookup) {
  return function lookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback
    const opts = typeof options === 'object' && options ? options : {}
    lookupImpl(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err)
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: isIP(addresses) }]
      if (!list.length) return cb(fail(502, 'no address for ' + hostname))
      const bad = list.find((a) => !isPublicAddress(a.address))
      if (bad) return cb(fail(403, 'non-public address refused for ' + hostname))
      if (opts.all) return cb(null, list)
      return cb(null, list[0].address, list[0].family)
    })
  }
}

let inFlight = 0

/**
 * Fetch one remote image on the server.
 * @param {string} raw
 * @param {object} [o]
 * @returns {Promise<{ type: string, body: Buffer, finalUrl: string }>}
 */
export async function fetchRemoteImage(raw, o = {}) {
  const maxBytes = o.maxBytes || REMOTE_IMAGE_MAX_BYTES
  const timeoutMs = o.timeoutMs || REMOTE_IMAGE_TIMEOUT_MS
  const requestImpl = o.request || httpsRequest
  const lookup = o.lookup || guardedLookup()
  const maxConcurrent = o.maxConcurrent || REMOTE_IMAGE_MAX_CONCURRENT
  if (inFlight >= maxConcurrent) throw fail(429, 'too many remote images at once')
  inFlight += 1
  try {
    let url = checkRemoteUrl(raw)
    for (let hop = 0; ; hop += 1) {
      const r = await getOnce(url, { requestImpl, lookup, maxBytes, timeoutMs })
      if (r.redirect) {
        if (hop >= REMOTE_IMAGE_MAX_REDIRECTS) throw fail(502, 'too many redirects')
        let next
        try { next = new URL(r.redirect, url).href } catch { throw fail(502, 'bad redirect') }
        url = checkRemoteUrl(next)
        continue
      }
      return { type: r.type, body: r.body, finalUrl: url.href }
    }
  } finally {
    inFlight -= 1
  }
}

function getOnce(url, { requestImpl, lookup, maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v) } }
    const req = requestImpl({
      protocol: 'https:',
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: 443,
      path: url.pathname + url.search,
      method: 'GET',
      lookup,
      servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
      headers: {
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml;q=0.8,image/*;q=0.5',
        'user-agent': 'Mozilla/5.0 (compatible; dsh-note-keeper image proxy)',
        'accept-encoding': 'identity',
      },
    }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        return done(resolve, { redirect: String(res.headers.location) })
      }
      if (status !== 200) { res.resume(); return done(reject, fail(502, 'remote answered HTTP ' + status)) }
      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (!IMAGE_TYPE.test(type)) { res.resume(); return done(reject, fail(415, 'not an image (' + (type || 'no type') + ')')) }
      const declared = Number(res.headers['content-length'] || 0)
      if (declared > maxBytes) { res.resume(); return done(reject, fail(413, 'image too large')) }
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > maxBytes) { req.destroy(); done(reject, fail(413, 'image too large')); return }
        chunks.push(c)
      })
      res.on('end', () => done(resolve, { type, body: Buffer.concat(chunks) }))
      res.on('error', (e) => done(reject, fail(502, 'remote read failed: ' + (e && e.message || e))))
    })
    const timer = setTimeout(() => { req.destroy(); done(reject, fail(504, 'remote image timed out')) }, timeoutMs)
    req.on('error', (e) => done(reject, e && e.status ? e : fail(502, 'remote fetch failed: ' + (e && e.message || e))))
    req.end()
  })
}

/**
 * HTTP answer for GET /remote-image. ?probe=1 answers 204 so the browser can
 * tell this server half is present (the client falls back otherwise).
 * @param {URL} url request URL
 * @param {import('node:http').ServerResponse} res
 * @param {object} [o] fetchRemoteImage options (tests)
 */
export async function serveRemoteImage(url, res, o = {}) {
  if (url.searchParams.get('probe') === '1') {
    res.writeHead(204, { 'cache-control': 'no-store', 'x-note-keeper-remote-image': '1' })
    return res.end()
  }
  try {
    const img = await fetchRemoteImage(url.searchParams.get('url') || '', o)
    res.writeHead(200, {
      'content-type': img.type,
      'content-length': img.body.length,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      // An SVG opened directly must not run script in the DSH origin.
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      'content-disposition': 'inline',
      'referrer-policy': 'no-referrer',
    })
    res.end(img.body)
  } catch (e) {
    const status = (e && e.status) || 502
    const text = JSON.stringify({ error: String(e && e.message || e) })
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }
}
