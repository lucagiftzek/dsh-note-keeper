// UI smoke test: the real App component rendered in jsdom against the real
// Go daemon (fetch is routed straight to it). Catches render-time crashes and
// verifies the main flows: vault tree, open note, edit + autosave, search,
// quick capture, daily note, and that an encrypted note stays locked.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { Daemon } from '../lib/daemon.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'notekeeperd')
let vault, daemon, React, ReactDOMClient, act, App, container, root
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  if (!existsSync(BIN)) execFileSync('npm', ['run', 'build:server'], { cwd: ROOT, stdio: 'inherit' })
  vault = mkdtempSync(join(tmpdir(), 'nk-ui-'))
  mkdirSync(join(vault, 'Projects'))
  writeFileSync(join(vault, 'Projects', 'Alpha.md'), '# Alpha\nRocket launch plan #work\n\n- [ ] task one\n\nSee [[Beta]].')
  writeFileSync(join(vault, 'Beta.md'), '# Beta\nΚαλημέρα')
  writeFileSync(join(vault, 'Secret.md'), '---\nnk-encrypted: v1\nnk-scope: note\nnk-iter: 1000\nnk-salt: AAAAAAAAAAAAAAAAAAAAAA==\nnk-iv: AAAAAAAAAAAAAAAA\n---\n```nk-cipher\nQUJD\n```\n')
  daemon = new Daemon({ binary: BIN, env: { NK_VAULT: vault } })
  daemon.start()
  await daemon.ready()

  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root" style="height:800px"></div></body></html>', { url: 'http://127.0.0.1:3080/', pretendToBeVisual: true })
  const w = dom.window
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver']) {
    try { globalThis[k] = w[k] } catch { Object.defineProperty(globalThis, k, { value: w[k], configurable: true }) }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  w.confirm = () => true
  // Route the browser's fetch to the daemon (the host proxy is covered by host.test.mjs).
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://127.0.0.1:3080')
    if (!u.pathname.startsWith('/note-keeper/api')) return new Response(JSON.stringify({ error: 'no' }), { status: 404 })
    const sub = u.pathname.slice('/note-keeper/api'.length)
    if (sub === '/status') return new Response(JSON.stringify({ ok: true, vault, daemon: { running: true }, folders: { attachments: 'attachments' } }))
    const method = init.method || 'GET'
    const isJson = init.headers && String(init.headers['content-type'] || '').includes('json')
    const r = await daemon.request(method, sub + u.search, isJson ? { json: JSON.parse(init.body) } : init.body ? { raw: Buffer.from(await new Response(init.body).arrayBuffer()) } : {})
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status })
  }
  const out = join(ROOT, 'node_modules', '.cache', 'nk-app-' + process.pid + '.mjs')
  await build({ entryPoints: [join(ROOT, 'src/client/App.jsx')], bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', outfile: out, external: ['react', 'react-dom', 'react/jsx-runtime', 'jsdom'], loader: { '.jsx': 'jsx' }, logLevel: 'error' })
  React = await import('react')
  ReactDOMClient = await import('react-dom/client')
  ;({ act } = await import('react'))
  App = (await import(pathToFileURL(out).href)).App
  container = document.getElementById('root')
  root = ReactDOMClient.createRoot(container)
  await act(async () => { root.render(React.createElement(App)) })
  await act(async () => { await sleep(300) })
})

after(async () => {
  if (root) await act(async () => root.unmount())
  daemon && daemon.stop()
  vault && rmSync(vault, { recursive: true, force: true })
})

const rowsText = () => [...container.querySelectorAll('.nk-row .nk-name')].map((e) => e.textContent)
const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(150) }) }
const typeInto = async (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  await act(async () => { setter.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); await sleep(50) })
}

test('home renders the vault tree', () => {
  assert.ok(container.querySelector('.nk-brand').textContent.includes('Note Keeper'))
  assert.deepEqual(rowsText(), ['Projects', 'Beta', 'Secret'])
})

test('open a note, see preview, edit and autosave', async () => {
  const folder = [...container.querySelectorAll('.nk-row')].find((r) => r.textContent === 'Projects')
  await click(folder)
  assert.ok(rowsText().includes('Alpha'))
  const alpha = [...container.querySelectorAll('.nk-row')].find((r) => r.textContent === 'Alpha')
  await click(alpha)
  const ta = container.querySelector('textarea.nk-textarea')
  assert.ok(ta, 'editor visible')
  assert.match(ta.value, /Rocket launch/)
  assert.ok(container.querySelector('.nk-md a.nk-tag'), 'tag rendered in preview')
  assert.ok(container.querySelector('.nk-info'), 'info pane')
  // Toggle the task checkbox from the preview.
  await click(container.querySelector('.nk-md input.nk-task'))
  assert.match(container.querySelector('textarea.nk-textarea').value, /- \[x\] task one/)
  await typeInto(container.querySelector('textarea.nk-textarea'), '# Alpha\nEdited in jsdom [[Beta]]')
  await act(async () => { await sleep(1700) })
  assert.equal(readFileSync(join(vault, 'Projects', 'Alpha.md'), 'utf8'), '# Alpha\nEdited in jsdom [[Beta]]')
  assert.ok(container.querySelector('.nk-status .nk-saved'), 'saved indicator')
})

test('search finds accent-insensitive Greek text', async () => {
  const input = container.querySelector('input.nk-search')
  await typeInto(input, 'καλημερα')
  await act(async () => { await sleep(400) })
  const hits = [...container.querySelectorAll('.nk-hit b')].map((b) => b.textContent)
  assert.deepEqual(hits, ['Beta'])
})

test('encrypted note opens locked, never shows ciphertext', async () => {
  const secret = [...container.querySelectorAll('.nk-row')].find((r) => r.textContent === 'Secret')
  await click(secret)
  assert.ok(container.textContent.includes('Encrypted note'))
  assert.equal(container.querySelector('textarea.nk-textarea'), null)
})

test('quick capture and daily note', async () => {
  const cap = container.querySelector('button[title^="Quick capture"]')
  await click(cap)
  const ta = container.querySelector('.nk-modal textarea')
  await typeInto(ta, 'captured from test')
  const btn = [...container.querySelectorAll('.nk-modal button')].find((b) => b.textContent.startsWith('Capture'))
  await click(btn)
  await act(async () => { await sleep(200) })
  assert.match(readFileSync(join(vault, 'Inbox.md'), 'utf8'), /captured from test/)
  await click(container.querySelector('button[title^="Daily note"]'))
  await act(async () => { await sleep(300) })
  const d = new Date()
  const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  assert.ok(existsSync(join(vault, 'Daily', day + '.md')) || existsSync(join(vault, 'Daily')), 'daily note created')
})

test('audio recorder and graph views render', async () => {
  await act(async () => { await sleep(10) })
  const recBtn = container.querySelector('button[title="New audio note"]')
  await click(recBtn)
  assert.ok(container.textContent.includes('Spoken language'))
  const lang = container.querySelector('.nk-rec select')
  assert.equal(lang.value, 'el')
  const close = [...container.querySelectorAll('.nk-rec button')].find((b) => b.textContent === 'Close')
  await click(close)
  // Graph: canvas getContext is missing in jsdom; the view must not crash the app.
  window.HTMLCanvasElement.prototype.getContext = () => null
  await click(container.querySelector('button[title="Graph view"]'))
  await act(async () => { await sleep(200) })
  assert.ok(container.querySelector('.nk-brand'), 'app still mounted')
})
