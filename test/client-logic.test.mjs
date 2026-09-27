// Client pure-logic tests (crypto envelopes, markdown rendering + sanitising,
// tree/link resolution, editor text transforms). JSX-free modules are
// imported directly; the markdown renderer needs a DOM for DOMPurify.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import * as nkc from '../src/client/crypto.js'
import { buildTree, visibleRows, makeResolver, lockedScopeOf, fileKind } from '../src/client/tree.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
const { createRenderer, toggleTask, outline, counts, setFrontmatterKey, splitFrontmatter } = await import('../src/client/markdown.js')

test('note envelope round trip and wrong password', async () => {
  const salt = nkc.randomBytes(16)
  const key = await nkc.deriveKey('correct horse battery', salt, 1000)
  const plain = '---\ntags: [x]\n---\n# Γεια σου\nsecret ✓'
  const env = await nkc.sealNote(key, plain, { scope: 'note', salt, iter: 1000, hint: 'the horse' })
  assert.ok(!env.includes('secret') && !env.includes('Γεια'), 'no plaintext in envelope')
  assert.match(env, /^---\nnk-encrypted: v1\n/)
  assert.match(env, /```nk-cipher\n/)
  const meta = nkc.parseEnvelope(env)
  assert.equal(meta.hint, 'the horse')
  assert.equal(meta.iter, 1000)
  const key2 = await nkc.deriveKey('correct horse battery', nkc.unb64(meta.salt), meta.iter)
  assert.equal(await nkc.openNote(key2, meta), plain)
  const bad = await nkc.deriveKey('wrong', salt, 1000)
  await assert.rejects(nkc.openNote(bad, meta), /wrong password/)
  // Tampering is detected (GCM authentication).
  const t = { ...meta, cipher: meta.cipher.slice(0, 10) + (meta.cipher[10] === 'A' ? 'B' : 'A') + meta.cipher.slice(11) }
  await assert.rejects(nkc.openNote(key2, t))
  assert.equal(nkc.parseEnvelope('# plain note'), null)
})

test('folder marker verifier and sealed blobs', async () => {
  const { key, marker } = await nkc.makeFolderMarker('folder pass 123', 'hint')
  assert.equal(marker.iter, nkc.ITERATIONS)
  assert.ok(!JSON.stringify(marker).includes('folder pass'))
  const k2 = await nkc.unlockFolderKey('folder pass 123', marker)
  await assert.rejects(nkc.unlockFolderKey('nope', marker), /wrong password/)
  const bytes = new Uint8Array([1, 2, 3, 250])
  const sealed = await nkc.sealBlob(key, bytes)
  assert.deepEqual([...await nkc.openBlob(k2, sealed)], [...bytes])
  await assert.rejects(nkc.openBlob(k2, new Uint8Array([1, 2, 3, 4, 5])), /not a Note Keeper/)
})

test('key ring expires idle keys', () => {
  const r = new nkc.KeyRing(50)
  r.set('a', 'K')
  assert.ok(r.has('a'))
  r.keys.get('a').touched -= 100
  assert.equal(r.get('a'), null)
})

test('markdown: obsidian syntax and sanitising', () => {
  const resolve = makeResolver(['Notes/Other.md', 'attachments/pic.png', 'attachments/voice.webm', 'Sec/attachments/s.png.nkenc'])
  const render = createRenderer(resolve)
  const html = render('---\ntitle: x\n---\n# H\n[[Other|alias]] [[Missing]] #tag/sub ![[pic.png|200]] ![[voice.webm]] ![[s.png]]\n\n- [ ] one\n- [x] two\n\n> [!warning] Careful\n> body\n\n<script>alert(1)</script><img src=x onerror=alert(1)>[x](javascript:alert(1))')
  assert.match(html, /class="nk-wikilink" data-target="Other"[^>]*>alias</)
  assert.match(html, /nk-unresolved" data-target="Missing"/)
  assert.match(html, /data-tag="tag\/sub"/)
  assert.match(html, /<img[^>]+src="\/note-keeper\/api\/file\?path=attachments%2Fpic\.png"[^>]*width="200"/)
  assert.match(html, /<audio[^>]+src="\/note-keeper\/api\/file\?path=attachments%2Fvoice\.webm"/)
  assert.match(html, /data-nk-sealed="Sec\/attachments\/s\.png\.nkenc"/)
  assert.match(html, /nk-callout-warning/)
  assert.equal((html.match(/class="nk-task"/g) || []).length, 2)
  assert.doesNotMatch(html, /<script|onerror|href="javascript:/)
  assert.doesNotMatch(html, /title: x/, 'frontmatter hidden from preview')
})

test('markdown helpers', () => {
  assert.equal(toggleTask('- [ ] a\n- [x] b\n* [ ] c', 1), '- [ ] a\n- [ ] b\n* [ ] c')
  assert.equal(toggleTask('- [ ] a\n- [x] b\n* [ ] c', 2), '- [ ] a\n- [x] b\n* [x] c')
  assert.deepEqual(outline('# A\n```\n# not\n```\n## B ##'), [{ level: 1, text: 'A' }, { level: 2, text: 'B' }])
  assert.equal(counts('---\na: b\n---\nΚαλημέρα κόσμε, it\'s me').words, 4)
  assert.equal(setFrontmatterKey('# x', 'k', 'v'), '---\nk: v\n---\n# x')
  assert.equal(setFrontmatterKey('---\ntags:\n  - a\nz: 1\n---\nb', 'tags', '[q]'), '---\ntags: [q]\nz: 1\n---\nb')
  assert.deepEqual(splitFrontmatter('---\ntags: [a, "b c"]\nlist:\n  - x\n---\nbody').props, { tags: ['a', 'b c'], list: ['x'] })
})

test('tree building, rows and resolver', () => {
  const entries = [
    { path: 'b.md', dir: false }, { path: 'A', dir: true }, { path: 'A/z.md', dir: false, doc: { type: 'audio' } },
    { path: 'A/B', dir: true }, { path: 'A/B/deep.md', dir: false }, { path: 'a.png', dir: false },
  ]
  const root = buildTree(entries)
  assert.deepEqual(root.children.map((c) => c.name), ['A', 'a.png', 'b.md'])
  assert.deepEqual(visibleRows(root, new Set()).map((r) => r.node.path), ['A', 'a.png', 'b.md'])
  assert.deepEqual(visibleRows(root, new Set(['A'])).map((r) => r.node.path), ['A', 'A/B', 'A/z.md', 'a.png', 'b.md'])
  const res = makeResolver(['x/Deep.md', 'y/z/Deep.md', 'Top.md', 'x/img.png'], 'x/note.md')
  assert.equal(res('Deep'), 'x/Deep.md')
  assert.equal(res('z/deep'), 'y/z/Deep.md')
  assert.equal(res('img.png'), 'x/img.png')
  assert.equal(res('nope'), null)
  assert.equal(lockedScopeOf('S/a/b.md', ['S', 'S/a']), 'S/a')
  assert.equal(lockedScopeOf('T/b.md', ['S']), null)
  assert.equal(fileKind(entries[2]), 'audio')
  assert.equal(fileKind({ path: 'q.png.nkenc' }), 'sealed')
})
