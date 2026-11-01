// Server-side remote image proxy: SSRF guard, limits, and the HTTP answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { isPublicAddress, checkRemoteUrl, guardedLookup, fetchRemoteImage, serveRemoteImage } from '../lib/remote.js'
import { makeHandler } from '../lib/proxy.js'

test('isPublicAddress refuses every internal range, v4 and v6', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.40.7', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1',
    '::ffff:127.0.0.1', '::ffff:192.168.1.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', 'ff02::1', 'not-an-ip']) {
    assert.equal(isPublicAddress(ip), false, ip)
  }
  for (const ip of ['1.1.1.1', '9.9.9.9', '8.8.8.8', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(ip), true, ip)
  }
})

test('checkRemoteUrl: https only, default port, no credentials, no local names', () => {
  assert.equal(checkRemoteUrl('https://example.com/a.png').hostname, 'example.com')
  for (const bad of ['http://example.com/a.png', 'ftp://example.com/a', 'https://user:pw@example.com/a.png', 'https://example.com:8443/a.png',
    'https://localhost/a.png', 'https://printer.local/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://10.0.0.1/a.png',
    'javascript:alert(1)', '', 'https://' + 'a'.repeat(5000) + '.com/']) {
    assert.throws(() => checkRemoteUrl(bad), (e) => e.status === 400, bad)
  }
})

test('guardedLookup refuses a name that resolves to a private address (rebinding)', async () => {
  const fake = (answers) => (host, opts, cb) => cb(null, answers)
  const ok = await new Promise((r) => guardedLookup(fake([{ address: '93.184.216.34', family: 4 }]))('example.com', {}, (e, a) => r([e, a])))
  assert.deepEqual(ok, [null, '93.184.216.34'])
  const bad = await new Promise((r) => guardedLookup(fake([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]))('evil.example', {}, (e) => r(e)))
  assert.equal(bad.status, 403)
})

/** Minimal fake of https.request: answers each call with the next canned response. */
function fakeRequest(responses, seen = []) {
  return (opts, onRes) => {
    seen.push(opts)
    const req = new EventEmitter()
    req.end = () => {
      const spec = responses.shift()
      const res = new EventEmitter()
      res.statusCode = spec.status
      res.headers = spec.headers || {}
      res.resume = () => {}
      setImmediate(() => {
        onRes(res)
        for (const c of spec.chunks || []) res.emit('data', Buffer.from(c))
        res.emit('end')
      })
    }
    req.destroy = () => {}
    return req
  }
}

test('fetchRemoteImage returns the bytes, sends no cookie or referer, follows a checked redirect', async () => {
  const seen = []
  const request = fakeRequest([
    { status: 302, headers: { location: 'https://cdn.example.com/b.png' } },
    { status: 200, headers: { 'content-type': 'image/png' }, chunks: ['PNG', 'DATA'] },
  ], seen)
  const r = await fetchRemoteImage('https://example.com/a.png', { request })
  assert.equal(r.type, 'image/png')
  assert.equal(r.body.toString(), 'PNGDATA')
  assert.equal(r.finalUrl, 'https://cdn.example.com/b.png')
  assert.equal(seen.length, 2)
  for (const o of seen) {
    assert.equal(o.headers.cookie, undefined)
    assert.equal(o.headers.referer, undefined)
    assert.equal(typeof o.lookup, 'function')
    assert.equal(o.port, 443)
  }
})

test('fetchRemoteImage refuses redirects to internal hosts, non-images, oversize bodies', async () => {
  await assert.rejects(fetchRemoteImage('https://example.com/a.png', { request: fakeRequest([{ status: 301, headers: { location: 'https://127.0.0.1/admin' } }]) }), (e) => e.status === 400)
  await assert.rejects(fetchRemoteImage('https://example.com/a.png', { request: fakeRequest([{ status: 301, headers: { location: 'http://example.com/a.png' } }]) }), (e) => e.status === 400)
  await assert.rejects(fetchRemoteImage('https://example.com/a', { request: fakeRequest([{ status: 200, headers: { 'content-type': 'text/html' }, chunks: ['<html>'] }]) }), (e) => e.status === 415)
  await assert.rejects(fetchRemoteImage('https://example.com/a.png', { maxBytes: 4, request: fakeRequest([{ status: 200, headers: { 'content-type': 'image/png' }, chunks: ['123', '456'] }]) }), (e) => e.status === 413)
  await assert.rejects(fetchRemoteImage('https://example.com/a.png', { maxBytes: 4, request: fakeRequest([{ status: 200, headers: { 'content-type': 'image/png', 'content-length': '99' } }]) }), (e) => e.status === 413)
  await assert.rejects(fetchRemoteImage('https://example.com/a.png', { request: fakeRequest([{ status: 404 }]) }), (e) => e.status === 502)
  const loop = Array.from({ length: 5 }, () => ({ status: 302, headers: { location: 'https://example.com/again.png' } }))
  await assert.rejects(fetchRemoteImage('https://example.com/a.png', { request: fakeRequest(loop) }), /too many redirects/)
})

function fakeRes() {
  const res = { status: 0, headers: null, body: null }
  res.writeHead = (s, h) => { res.status = s; res.headers = h }
  res.end = (b) => { res.body = b === undefined ? null : Buffer.isBuffer(b) ? b : Buffer.from(String(b)) }
  return res
}

test('serveRemoteImage: probe 204, image with sandboxing headers, JSON error', async () => {
  const probe = fakeRes()
  await serveRemoteImage(new URL('http://x/note-keeper/api/remote-image?probe=1'), probe)
  assert.equal(probe.status, 204)
  const ok = fakeRes()
  await serveRemoteImage(new URL('http://x/note-keeper/api/remote-image?url=' + encodeURIComponent('https://example.com/i.svg')), ok,
    { request: fakeRequest([{ status: 200, headers: { 'content-type': 'image/svg+xml; charset=utf-8' }, chunks: ['<svg/>'] }]) })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['content-type'], 'image/svg+xml')
  assert.equal(ok.headers['x-content-type-options'], 'nosniff')
  assert.match(ok.headers['content-security-policy'], /sandbox/)
  const bad = fakeRes()
  await serveRemoteImage(new URL('http://x/note-keeper/api/remote-image?url=' + encodeURIComponent('http://example.com/i.png')), bad)
  assert.equal(bad.status, 400)
  assert.equal(JSON.parse(bad.body.toString()).error, 'only https images are fetched')
})

test('the /remote-image route sits behind the same security gate as every other route', async () => {
  const handler = makeHandler({ daemon: {}, config: () => ({ trustedHosts: [], requireCookie: true }), statusInfo: () => ({}) })
  const req = { url: '/note-keeper/api/remote-image?probe=1', method: 'GET', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await handler(req, res)
  assert.notEqual(res.status, 204, 'no session cookie: refused by the gate')
  assert.ok(res.status >= 400)
})
