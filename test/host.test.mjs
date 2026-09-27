// Host-half integration tests: the real Go daemon behind the real proxy and
// the real notes_* tool bodies (with an identity defineTool).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { Daemon } from '../lib/daemon.js'
import { makeHandler } from '../lib/proxy.js'
import { agentTools, applyEdit, withTags } from '../lib/tools.js'
import { checkRequest, harnessCookieName } from '../lib/security.js'
import { effectiveConfig } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'notekeeperd')
let vault, daemon, server, base, tools
const cfg = { trustedHosts: ['llm.tzekos.eu'], aiWrite: true, aiDelete: true }

before(async () => {
  if (!existsSync(BIN)) execFileSync('npm', ['run', 'build:server'], { cwd: ROOT, stdio: 'inherit' })
  vault = mkdtempSync(join(tmpdir(), 'nk-host-'))
  daemon = new Daemon({ binary: BIN, env: { NK_VAULT: vault } })
  daemon.start()
  await daemon.ready()
  const handler = makeHandler({ daemon, config: () => cfg, statusInfo: () => ({ ok: true }) })
  server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + server.address().port
  tools = Object.fromEntries(agentTools((d) => d, { daemon, config: () => cfg }).map((d) => [d.name, d]))
})

after(() => {
  server && server.close()
  daemon && daemon.stop()
  vault && rmSync(vault, { recursive: true, force: true })
})

function browserHeaders(extra = {}) {
  const host = '127.0.0.1:' + server.address().port
  return { host, cookie: harnessCookieName(host) + '=x', ...extra }
}

test('proxy gate: cookie required, mutations need CSRF headers', async () => {
  let r = await fetch(base + '/note-keeper/api/tree')
  assert.equal(r.status, 403)
  r = await fetch(base + '/note-keeper/api/tree', { headers: browserHeaders() })
  assert.equal(r.status, 200)
  r = await fetch(base + '/note-keeper/api/capture', { method: 'POST', headers: browserHeaders({ 'content-type': 'application/json' }), body: '{"text":"x"}' })
  assert.equal(r.status, 403, 'mutation without sec-fetch-site/origin/x-requested-with')
  r = await fetch(base + '/note-keeper/api/capture', {
    method: 'POST', body: '{"text":"from browser"}',
    headers: browserHeaders({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: base, 'x-requested-with': 'dsh-note-keeper' }),
  })
  assert.equal(r.status, 200)
  r = await fetch(base + '/note-keeper/api/nope', { headers: browserHeaders() })
  assert.equal(r.status, 404)
  r = await fetch(base + '/note-keeper/api/tree', { headers: browserHeaders({ origin: 'https://evil.example' }) })
  assert.equal(r.status, 403)
})

test('proxy streams binary uploads and ranged downloads', async () => {
  const h = browserHeaders({ 'content-type': 'application/octet-stream', 'sec-fetch-site': 'same-origin', origin: base, 'x-requested-with': 'dsh-note-keeper' })
  const body = Buffer.alloc(300000, 7)
  let r = await fetch(base + '/note-keeper/api/attachment?name=clip.webm', { method: 'POST', headers: h, body })
  assert.equal(r.status, 200)
  const up = await r.json()
  assert.equal(up.bytes, body.length)
  r = await fetch(base + '/note-keeper/api/file?path=' + encodeURIComponent(up.path), { headers: browserHeaders({ range: 'bytes=10-19' }) })
  assert.equal(r.status, 206)
  assert.equal((await r.arrayBuffer()).byteLength, 10)
})

test('SSE events arrive through the proxy', async () => {
  const ctrl = new AbortController()
  const res = await fetch(base + '/note-keeper/api/events', { headers: browserHeaders(), signal: ctrl.signal })
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  await tools.notes_capture.execute({ text: 'event me' })
  let got = ''
  const deadline = Date.now() + 3000
  while (!got.includes('Inbox.md') && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    got += Buffer.from(value).toString()
  }
  ctrl.abort()
  assert.match(got, /Inbox\.md/)
})

test('AI tools: create, read, search, update, move, links, delete', async () => {
  let r = await tools.notes_create.execute({ title: 'Σημειώσεις Συνάντησης', content: '# Meeting\nΣυζητήσαμε το έργο. See [[Plan]].', folder: 'Work', tags: ['work', 'greek'] })
  assert.equal(r.ok, true, r.error)
  const p = r.result.created
  assert.equal(p, 'Work/Σημειώσεις Συνάντησης.md')
  await tools.notes_create.execute({ title: 'Plan', content: '# Plan\nsteps', folder: 'Work' })
  r = await tools.notes_search.execute({ query: 'συζητησαμε' })
  assert.equal(r.result[0].path, p)
  r = await tools.notes_read.execute({ path: p })
  assert.deepEqual(r.result.tags, ['work', 'greek'])
  r = await tools.notes_update.execute({ path: p, mode: 'append', content: '- action item' })
  assert.equal(r.ok, true, r.error)
  r = await tools.notes_update.execute({ path: p, mode: 'replace_text', find: 'το έργο', content: 'the project' })
  assert.equal(r.ok, true, r.error)
  r = await tools.notes_read.execute({ path: p })
  assert.match(r.result.content, /Συζητήσαμε the project\. See \[\[Plan\]\]\.\n- action item\n$/)
  r = await tools.notes_update.execute({ path: p, mode: 'replace_text', find: 'zzz', content: 'x' })
  assert.equal(r.ok, false)
  r = await tools.notes_move.execute({ from: 'Work/Plan.md', to: 'Work/Roadmap.md' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.result.rewritten, [p])
  r = await tools.notes_links.execute({ path: 'Work/Roadmap.md' })
  assert.deepEqual(r.result.backlinks, [p])
  r = await tools.notes_daily.execute({ date: '2026-01-02', append: 'daily line' })
  assert.equal(r.result.path, 'Daily/2026-01-02.md')
  r = await tools.notes_tags.execute({})
  assert.ok(r.result.find((t) => t.tag === 'greek'))
  r = await tools.notes_delete.execute({ path: 'Work/Roadmap.md' })
  assert.equal(r.ok, true)
  r = await tools.notes_list.execute({ folder: 'Work' })
  assert.equal(r.result.rows.filter((x) => !x.dir).length, 1)
})

test('AI tools never see or write into encrypted content', async () => {
  const env = '---\nnk-encrypted: v1\n---\n```nk-cipher\nQUJD\n```\n'
  writeFileSync(join(vault, 'Diary.md'), env)
  await new Promise((r) => setTimeout(r, 400))
  let r = await tools.notes_read.execute({ path: 'Diary.md' })
  assert.equal(r.ok, false)
  assert.match(r.error, /encrypted/)
  r = await tools.notes_update.execute({ path: 'Diary.md', content: 'overwrite' })
  assert.equal(r.ok, false)
  await daemon.request('POST', '/folder', { json: { path: 'Vaulted' } })
  const lk = await daemon.request('POST', '/lock', { json: { folder: 'Vaulted', marker: { kdf: 'PBKDF2-SHA256', iter: 600000, salt: 'cw==', iv: 'aQ==', verifier: 'dg==' } } })
  assert.equal(lk.status, 200)
  r = await tools.notes_create.execute({ title: 'leak', content: 'plaintext', folder: 'Vaulted' })
  assert.equal(r.ok, false)
  assert.match(r.error, /encrypted/)
})

test('aiWrite=false makes tools read-only', async () => {
  cfg.aiWrite = false
  try {
    const r = await tools.notes_create.execute({ title: 'x', content: 'y' })
    assert.equal(r.ok, false)
  } finally { cfg.aiWrite = true }
})

test('import, sync admin and AI routes through the proxy', async () => {
  const H = (extra) => browserHeaders({ 'sec-fetch-site': 'same-origin', origin: base, 'x-requested-with': 'dsh-note-keeper', ...extra })
  // Import a Markdown file and an HTML page.
  let r = await fetch(base + '/note-keeper/api/import?name=Hello.md&dir=Imported', { method: 'POST', headers: H({ 'content-type': 'application/octet-stream' }), body: '# Hello import' })
  assert.equal(r.status, 200)
  let j = await r.json()
  assert.equal(j.Notes, 1)
  r = await fetch(base + '/note-keeper/api/import?name=page.html&dir=Imported', { method: 'POST', headers: H({ 'content-type': 'application/octet-stream' }), body: '<html><head><title>Web Page</title></head><body><h1>Web Page</h1><p>Some <b>bold</b> text</p></body></html>' })
  j = await r.json()
  assert.equal(j.Notes, 1)
  r = await fetch(base + '/note-keeper/api/tree', { headers: browserHeaders() })
  const paths = (await r.json()).entries.map((e) => e.path)
  assert.ok(paths.includes('Imported/Hello.md'))
  assert.ok(paths.some((p) => p.startsWith('Imported/') && /Web Page/.test(p)))
  // Import without CSRF markers is refused by the gate.
  r = await fetch(base + '/note-keeper/api/import?name=x.md', { method: 'POST', headers: browserHeaders({ 'content-type': 'application/octet-stream' }), body: 'x' })
  assert.equal(r.status, 403)
  // Sync admin: status answers (sync disabled in this daemon: no NK_SYNC_ADDR).
  r = await fetch(base + '/note-keeper/api/sync/status', { headers: browserHeaders() })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).enabled, false)
  // AI routes are host-handled; without an AI backend they answer 503, and
  // mutations still need CSRF markers.
  r = await fetch(base + '/note-keeper/api/ai/settings', { headers: browserHeaders() })
  assert.equal(r.status, 503)
  r = await fetch(base + '/note-keeper/api/ai/enhance', { method: 'POST', headers: browserHeaders({ 'content-type': 'application/json' }), body: '{"text":"x"}' })
  assert.equal(r.status, 403)
})


test('pure helpers', () => {
  assert.equal(applyEdit('---\na: 1\n---\nbody\n', { mode: 'prepend', content: 'top' }), '---\na: 1\n---\ntop\nbody\n')
  assert.equal(applyEdit('a b a', { mode: 'replace_text', find: 'a', content: 'x', all: true }), 'x b x')
  assert.throws(() => applyEdit('a a', { mode: 'replace_text', find: 'a', content: 'x' }), /2 times/)
  assert.equal(applyEdit('x', { mode: 'replace_text', find: 'x', content: '$&$&' }), '$&$&', 'no regex replacement patterns')
  assert.equal(withTags('b', ['#a', 'c d']), '---\ntags: ["a", "c d"]\n---\nb')
  const c = effectiveConfig({ vault: '~/V', aiWrite: 'nope', trustedHosts: 'x' })
  assert.ok(c.vault.endsWith('/V') && !c.vault.startsWith('~'))
  assert.equal(c.aiWrite, true)
  assert.deepEqual(c.trustedHosts, ['llm.tzekos.eu'])
  const fake = (h) => ({ method: 'GET', socket: { remoteAddress: '10.0.0.1' }, headers: h })
  assert.equal(checkRequest(fake({ host: 'localhost' })).layer, 'R1')
})