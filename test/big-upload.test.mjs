// Large + opaque uploads, end to end: the real browser modules (api.js,
// crypto.js, upload.js) against the real Go daemon. fetch is routed straight
// to the daemon and every request is logged, so the test can prove that a
// sealed upload leaks neither its name nor its content on the wire or on disk.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { randomBytes as nodeRandom, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { Daemon } from '../lib/daemon.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'notekeeperd')
const sha = (b) => createHash('sha256').update(b).digest('hex')
let vault, daemon, log, api, nkc, up

before(async () => {
  if (!existsSync(BIN)) execFileSync('npm', ['run', 'build:server'], { cwd: ROOT, stdio: 'inherit' })
  vault = mkdtempSync(join(tmpdir(), 'nk-big-'))
  mkdirSync(join(vault, 'Vault'))
  writeFileSync(join(vault, 'Vault', '.nk-lock.json'), JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iter: 1000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', verifier: 'AAAA' }))
  daemon = new Daemon({ binary: BIN, env: { NK_VAULT: vault, NK_STATE: join(vault, '..', 'nk-big-state-' + process.pid), NK_SYNC_ADDR: '127.0.0.1:0' } })
  daemon.start()
  await daemon.ready()
  log = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://127.0.0.1:3080')
    const sub = u.pathname.slice('/note-keeper/api'.length)
    const method = init.method || 'GET'
    const isJson = init.headers && String(init.headers['content-type'] || '').includes('json')
    log.push({ method, url: u.pathname + u.search, json: isJson ? init.body : undefined })
    if (sub.startsWith('/file')) {
      // binary download: Daemon.request decodes as UTF-8, so stream it raw
      return new Promise((resolve, reject) => {
        daemon.open('GET', sub + u.search, {}, (res) => {
          const parts = []
          res.on('data', (c) => parts.push(c))
          res.on('end', () => resolve(new Response(Buffer.concat(parts), { status: res.statusCode })))
          res.on('error', reject)
        }).then((req) => req.end(), reject)
      })
    }
    const r = await daemon.request(method, sub + u.search, isJson && init.body !== undefined ? { json: JSON.parse(init.body) } : init.body ? { raw: Buffer.from(await new Response(init.body).arrayBuffer()) } : {})
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status })
  }
  ;({ api } = await import('../src/client/api.js'))
  nkc = await import('../src/client/crypto.js')
  up = await import('../src/client/upload.js')
})

after(() => {
  daemon && daemon.stop()
  vault && rmSync(vault, { recursive: true, force: true })
})

const staging = () => {
  const out = []
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : n.startsWith('.nk-up-') && out.push(p) } }
  walk(vault)
  return out
}

test('150 MB plain upload goes through in 64 MiB chunks, byte-exact', async () => {
  const data = nodeRandom(150 * 1000 * 1000)
  log.length = 0
  const r = await up.putFile(api, new Blob([data]), 'big.zip', 'attachments', false)
  assert.equal(r.path, 'attachments/big.zip')
  assert.equal(r.bytes, data.length)
  assert.equal(sha(readFileSync(join(vault, r.path))), sha(data))
  const chunks = log.filter((l) => l.url.startsWith('/note-keeper/api/attachment/chunk'))
  assert.equal(chunks.length, 3, 'ceil(150e6 / 64MiB) = 3 requests')
  assert.equal(staging().length, 0)
})

test('sealed 100 MB upload: opaque name, nothing identifying on the wire or at rest, decrypts to the real name', async () => {
  const data = nodeRandom(100 * 1000 * 1000)
  const salt = nkc.randomBytes(16)
  const key = await nkc.deriveKey('hunter2 hunter2', salt, 1000)
  log.length = 0
  const r = await up.putSealed(api, key, new Blob([data], { type: 'application/zip' }), 'my.zip', 'Vault/attachments')
  // 1. stored under an opaque name
  assert.match(r.path, /^Vault\/attachments\/enc-[0-9a-f]{18}\.nkenc$/)
  // 2. the connection never carried the original name (URLs and JSON bodies)
  const wire = JSON.stringify(log)
  assert.ok(!/my\.zip/i.test(wire), 'file name leaked on the wire: ' + wire.slice(0, 300))
  assert.ok(!/zip/i.test(wire), 'file type leaked on the wire')
  // 3. at rest: ciphertext only (envelope magic, no name, no plaintext prefix)
  const stored = readFileSync(join(vault, r.path))
  assert.equal(stored.subarray(0, 4).toString(), 'NKE1')
  assert.ok(!stored.includes(Buffer.from('my.zip')), 'name found inside stored bytes')
  assert.ok(!stored.includes(data.subarray(0, 64)), 'plaintext found inside stored bytes')
  assert.ok(stored.length > data.length && stored.length < data.length + 4096, 'ciphertext size = plaintext + small overhead')
  // 4. a password holder gets the name and the exact bytes back
  const { bytes, meta } = await nkc.openBlobNamed(key, new Uint8Array(await api.fileBytes(r.path)))
  assert.equal(meta.name, 'my.zip')
  assert.equal(meta.type, 'application/zip')
  assert.equal(sha(Buffer.from(bytes)), sha(data))
  // 5. wrong password fails
  const bad = await nkc.deriveKey('wrong password', salt, 1000)
  await assert.rejects(nkc.openBlob(bad, new Uint8Array(stored)))
  assert.equal(staging().length, 0)
})

test('a failing chunk aborts the session and leaves no staging file', async () => {
  const flaky = { ...api, uploadChunk: (() => { let n = 0; return (id, b) => (++n === 2 ? Promise.reject(new Error('network down')) : api.uploadChunk(id, b)) })() }
  const data = nodeRandom(10 * 1000 * 1000)
  await assert.rejects(up.putFile(flaky, new Blob([data]), 'flaky.bin', 'attachments', false, null, 4 * 1000 * 1000), /network down/)
  assert.equal(staging().length, 0, 'staging removed by abort')
  assert.ok(!existsSync(join(vault, 'attachments', 'flaky.bin')))
})

test('small sealed files round-trip too (single request path)', async () => {
  const key = await nkc.deriveKey('pw', nkc.randomBytes(16), 1000)
  const r = await up.putSealed(api, key, new Blob(['tiny secret note attachment']), 'notes.txt', 'Vault/attachments')
  const { bytes, meta } = await nkc.openBlobNamed(key, new Uint8Array(await api.fileBytes(r.path)))
  assert.equal(new TextDecoder().decode(bytes), 'tiny secret note attachment')
  assert.equal(meta.name, 'notes.txt')
  // legacy NKE1 blobs without metadata still open, and openBlob strips the header
  const legacy = await nkc.sealBlob(key, new TextEncoder().encode('old style'))
  assert.equal(new TextDecoder().decode(await nkc.openBlob(key, legacy)), 'old style')
  assert.equal((await nkc.openBlobNamed(key, legacy)).meta, null)
  assert.equal(new TextDecoder().decode(await nkc.openBlob(key, new Uint8Array(await api.fileBytes(r.path)))), 'tiny secret note attachment')
})
