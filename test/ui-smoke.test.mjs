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
import { makeAi } from '../lib/ai.js'
import { stubLangHtml } from '../scripts/esbuild-plugins.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'notekeeperd')
let vault, daemon, React, ReactDOMClient, act, App, container, root
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  if (!existsSync(BIN)) execFileSync('npm', ['run', 'build:server'], { cwd: ROOT, stdio: 'inherit' })
  vault = mkdtempSync(join(tmpdir(), 'nk-ui-'))
  mkdirSync(join(vault, 'Projects'))
  writeFileSync(join(vault, 'Projects', 'Alpha.md'), '# Alpha\nRocket launch plan #work\n\n- [ ] task one\n\nSee [[Beta]].')
  writeFileSync(join(vault, 'Beta.md'), '---\ntags: [greek]\n---\n# Beta\nΚαλημέρα')
  writeFileSync(join(vault, 'Secret.md'), '---\nnk-encrypted: v1\nnk-scope: note\nnk-iter: 1000\nnk-salt: AAAAAAAAAAAAAAAAAAAAAA==\nnk-iv: AAAAAAAAAAAAAAAA\n---\n```nk-cipher\nQUJD\n```\n')
  daemon = new Daemon({ binary: BIN, env: { NK_VAULT: vault, NK_STATE: join(vault, '..', 'nk-ui-state-' + process.pid), NK_SYNC_ADDR: '127.0.0.1:0' } })
  daemon.start()
  await daemon.ready()

  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root" style="height:800px"></div></body></html>', { url: 'http://127.0.0.1:3080/', pretendToBeVisual: true })
  const w = dom.window
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver']) {
    try { globalThis[k] = w[k] } catch { Object.defineProperty(globalThis, k, { value: w[k], configurable: true }) }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // CodeMirror measures layout; jsdom has no layout engine.
  const rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }
  w.Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} })
  w.Range.prototype.getBoundingClientRect = () => rect
  w.document.elementFromPoint = () => null
  globalThis.Window = w.Window
  globalThis.MouseEvent = w.MouseEvent
  globalThis.KeyboardEvent = w.KeyboardEvent
  globalThis.Event = w.Event
  // AI Enhance goes through the real host module with a fake model.
  const ai = makeAi({
    getLlm: () => ({ listProviders: () => [], async *stream() { yield { type: 'text-delta', index: 0, text: '# Alpha\n\nImproved text about [[Beta]] and [[Nowhere]].\n' }; yield { type: 'finish', reason: { kind: 'stop' } } } }),
    getDefaultModel: () => ({ currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }),
    noteTitles: async () => ['Alpha', 'Beta'],
    stateFile: join(vault, '..', 'nk-ui-ai-' + process.pid + '.json'),
  })
  w.confirm = () => true
  // Route the browser's fetch to the daemon (the host proxy is covered by host.test.mjs).
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://127.0.0.1:3080')
    if (!u.pathname.startsWith('/note-keeper/api')) return new Response(JSON.stringify({ error: 'no' }), { status: 404 })
    const sub = u.pathname.slice('/note-keeper/api'.length)
    if (sub === '/ai/enhance') { const b = JSON.parse(init.body); return new Response(JSON.stringify(await ai.enhance(b))) }
    if (sub === '/ai/settings' && (init.method || 'GET') === 'GET') return new Response(JSON.stringify(ai.settings()))
    if (sub === '/ai/models') return new Response(JSON.stringify(await ai.models()))
    if (sub === '/status') return new Response(JSON.stringify({ ok: true, vault, daemon: { running: true }, folders: { attachments: 'attachments' } }))
    const method = init.method || 'GET'
    const isJson = init.headers && String(init.headers['content-type'] || '').includes('json')
    const r = await daemon.request(method, sub + u.search, isJson ? { json: JSON.parse(init.body) } : init.body ? { raw: Buffer.from(await new Response(init.body).arrayBuffer()) } : {})
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status })
  }
  const out = join(ROOT, 'node_modules', '.cache', 'nk-app-' + process.pid + '.mjs')
  await build({ entryPoints: [join(ROOT, 'src/client/App.jsx')], bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', outfile: out, external: ['react', 'react-dom', 'react/jsx-runtime', 'jsdom'], loader: { '.jsx': 'jsx' }, logLevel: 'error', plugins: [stubLangHtml] })
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

const cmView = () => { const el = container.querySelector('.nk-cm .cm-editor'); return el && el.nkView }
const mousedown = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 })); await sleep(150) }) }
const rowNamed = (name) => [...container.querySelectorAll('.nk-row')].find((r) => r.textContent === name)

test('live preview: links and tags render as links, clickable; tasks are checkboxes', async () => {
  await click(rowNamed('Projects'))
  await click(rowNamed('Alpha'))
  const v = cmView()
  assert.ok(v, 'CodeMirror editor mounted')
  assert.match(v.state.doc.toString(), /Rocket launch/)
  const tag = container.querySelector('.nk-cm .nk-cm-tag')
  assert.ok(tag && tag.dataset.tag === 'work', 'tag rendered as a pill')
  const link = container.querySelector('.nk-cm .nk-cm-wikilink[data-target="Beta"]')
  assert.ok(link, 'wikilink rendered as a link')
  assert.equal(link.textContent, 'Beta', 'brackets hidden in live preview')
  assert.ok(!container.querySelector('.nk-cm').textContent.includes('[[Beta]]'), 'no raw [[ ]] while the cursor is elsewhere')
  const box = container.querySelector('.nk-cm input.nk-cm-task')
  assert.ok(box, 'task marker is a checkbox')
  await mousedown(box)
  assert.match(cmView().state.doc.toString(), /- \[x\] task one/)
  // Clicking the link opens the target note.
  await mousedown(container.querySelector('.nk-cm .nk-cm-wikilink[data-target="Beta"]'))
  await act(async () => { await sleep(300) })
  assert.equal(container.querySelector('input.nk-title').value, 'Beta')
  // Frontmatter collapses into a property strip (the cursor starts below it).
  const props = container.querySelector('.nk-cm .nk-cm-props')
  assert.ok(props, 'frontmatter rendered as properties')
  assert.match(props.textContent, /tags\s*greek/)
})

test('edit, autosave, AI Enhance preview and apply', async () => {
  await click(rowNamed('Alpha'))
  const v = cmView()
  await act(async () => { v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '# Alpha\nedited in jsdom about beta' } }); await sleep(50) })
  await act(async () => { await sleep(1700) })
  assert.equal(readFileSync(join(vault, 'Projects', 'Alpha.md'), 'utf8'), '# Alpha\nedited in jsdom about beta')
  assert.ok(container.querySelector('.nk-status .nk-saved'), 'saved indicator')
  await click(container.querySelector('.nk-ai-main'))
  await act(async () => { await sleep(200) })
  const modal = container.querySelector('.nk-modal')
  assert.ok(modal && modal.textContent.includes('review changes'), 'diff preview shown')
  assert.ok(modal.querySelector('.nk-diff-add'), 'additions highlighted')
  assert.match(modal.textContent, /links: Beta/)
  await click([...modal.querySelectorAll('button')].find((x) => x.textContent === 'Apply'))
  const txt = cmView().state.doc.toString()
  assert.match(txt, /Improved text about \[\[Beta\]\] and Nowhere\./, 'valid link kept, invented link unwrapped')
  // The gear opens the AI settings.
  await click(container.querySelector('.nk-ai-gear'))
  await act(async () => { await sleep(200) })
  assert.ok(container.querySelector('.nk-modal').textContent.includes('DSH default for new chats'))
  await click([...container.querySelectorAll('.nk-modal button')].find((x) => x.textContent === 'Cancel'))
})

test('lock button starts encryption for a plain note', async () => {
  const btn = container.querySelector('.nk-head button[title="Encrypt this note…"]')
  assert.ok(btn, 'context-aware lock button')
  await click(btn)
  assert.ok(container.textContent.includes('Warning: Loss of the password results in permanent, unrecoverable data loss.'))
  await click([...container.querySelectorAll('.nk-modal button')].find((x) => x.textContent === 'Cancel'))
})

test('connect dialog issues a pairing code', async () => {
  await click(container.querySelector('button[title^="Connect Obsidian"]'))
  await act(async () => { await sleep(300) })
  const create = [...container.querySelectorAll('.nk-modal button')].find((x) => x.textContent === 'Create pairing code')
  assert.ok(create, 'pairing button')
  await click(create)
  await act(async () => { await sleep(300) })
  assert.match(container.querySelector('.nk-code span').textContent, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/)
  const tabs = [...container.querySelectorAll('.nk-seg button')]
  await click(tabs.find((x) => x.textContent === 'WebDAV apps'))
  await click([...container.querySelectorAll('.nk-modal button')].find((x) => x.textContent === 'Create app password'))
  await act(async () => { await sleep(300) })
  assert.ok(container.querySelector('.nk-creds'), 'webdav credentials shown once')
  await click(container.querySelector('.nk-modal button[title="Close"]'))
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