// Regression for DSH 0.2.1: every notes_* tool result (success and error paths) must be lossless JSON.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { Daemon } from '../lib/daemon.js'
import { agentTools } from '../lib/tools.js'
import { assertLossless } from './lossless-check.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'bin', 'notekeeperd')
let vault, daemon

before(async () => {
  if (!existsSync(BIN)) execFileSync('npm', ['run', 'build:server'], { cwd: ROOT, stdio: 'inherit' })
  vault = mkdtempSync(join(tmpdir(), 'nk-lossless-'))
  mkdirSync(join(vault, 'Attach'), { recursive: true })
  writeFileSync(join(vault, 'Attach', 'pic.png'), Buffer.from([137, 80, 78, 71]))
  writeFileSync(join(vault, 'Plain.md'), 'no frontmatter, no title heading\n')
  writeFileSync(join(vault, 'Linked.md'), '---\ntags: [a]\n---\n# Linked\nsee [[Plain]] and [[Ghost]] #b\n')
  daemon = new Daemon({ binary: BIN, env: { NK_VAULT: vault } })
  daemon.start()
  await daemon.ready()
})
after(() => { daemon && daemon.stop(); vault && rmSync(vault, { recursive: true, force: true }) })

const CASES = {
  notes_list: [{}, { folder: 'Attach' }, { folder: 'nope' }, { limit: 1 }, { limit: -5 }],
  notes_search: [{ query: 'linked' }, { query: '' }, { tag: 'a' }, { folder: 'nope' }, { query: '"quoted phrase"', limit: 3 }, {}],
  notes_read: [{ path: 'Plain' }, { path: 'Linked.md' }, { path: 'nope.md' }, { path: '../../etc/passwd' }, { path: 'Attach/pic.png' }, {}],
  notes_create: [{ title: 'T1', content: 'c' }, { title: 'T1', content: 'c', folder: 'F', tags: ['x', 'y'] }, { title: '', content: '' }, { title: 'a/b', content: undefined }, {}],
  notes_update: [{ path: 'T1.md', content: 'more', mode: 'append' }, { path: 'T1.md', content: 'x', mode: 'prepend' }, { path: 'T1.md', content: 'x', mode: 'replace' }, { path: 'T1.md', mode: 'replace_text', find: 'zzz', content: 'q' }, { path: 'nope.md', content: 'x' }, { path: 'T1.md', mode: 'bogus', content: 'x' }, {}],
  notes_move: [{ from: 'T1.md', to: 'T2.md' }, { from: 'nope.md', to: 'x.md' }, { from: 'Plain.md', to: 'Linked.md' }, {}],
  notes_delete: [{ path: 'T2.md' }, { path: 'nope.md' }, { path: '' }, {}],
  notes_mkdir: [{ path: 'NewDir/Sub' }, { path: '../escape' }, {}],
  notes_capture: [{ text: 'idea' }, { text: 'todo', todo: true }, { text: 'to target', target: 'Plain.md' }, { text: '' }, {}],
  notes_daily: [{}, { date: '2026-01-02', append: 'hello' }, { date: 'not-a-date' }],
  notes_tags: [{}],
  notes_links: [{}, { path: 'Linked.md' }, { path: 'Plain' }, { path: 'nope' }],
}

for (const [label, cfg] of [['write enabled', { aiWrite: true, aiDelete: true }], ['AI write disabled', { aiWrite: false }], ['AI delete disabled', { aiWrite: true, aiDelete: false }]]) {
  test('notes_* results are lossless JSON: ' + label, async () => {
    const defs = agentTools((d) => d, { daemon, config: () => cfg })
    assert.deepEqual(defs.map((d) => d.name).sort(), Object.keys(CASES).sort(), 'every tool is covered')
    for (const d of defs) for (const args of CASES[d.name]) {
      const out = await d.execute(args)
      await assertLossless(out, `${d.name}(${JSON.stringify(args)})`)
    }
  })
}

test('notes_* results are lossless JSON when the daemon is down', async () => {
  const dead = { request: async () => { throw new Error('ECONNREFUSED notekeeperd') } }
  const defs = agentTools((d) => d, { daemon: dead, config: () => ({ aiWrite: true }) })
  for (const d of defs) for (const args of CASES[d.name]) {
    let out
    try { out = await d.execute(args) } catch { continue /* a throw is reported by the core as a tool error */ }
    await assertLossless(out, `${d.name}(${JSON.stringify(args)}) daemon down`)
  }
})
