import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeAi, buildPrompt, postProcess, splitFrontmatter, isEnvelope } from '../lib/ai.js'

test('postProcess keeps valid links, unwraps invented ones, strips fences', () => {
  const titles = ['Project Alpha', 'Γεια σου']
  const out = '```markdown\n# Title\nSee [[Project Alpha]] and [[Nonexistent|this thing]] and [[Old]] ![[img.png]] [[γεια σου|hello]]\n```'
  const r = postProcess(out, 'orig [[Old]]\n', titles)
  assert.equal(r.text, '# Title\nSee [[Project Alpha]] and this thing and [[Old]] ![[img.png]] [[γεια σου|hello]]\n')
  assert.deepEqual(r.added, ['Project Alpha', 'γεια σου'])
})

test('prompt respects options and language rule', () => {
  const p = buildPrompt({ body: 'Καλημερα', title: 'T', titles: ['A'], opts: { fixSpelling: true, format: false, addLinks: true, custom: 'Use British spelling' } })
  assert.match(p.system, /Never translate/)
  assert.match(p.system, /Fix spelling/)
  assert.doesNotMatch(p.system, /heading hierarchy/)
  assert.match(p.system, /British spelling/)
  assert.match(p.user, /EXISTING NOTES:\n- A/)
  const q = buildPrompt({ body: 'x', title: 'T', titles: ['A'], opts: { addLinks: false } })
  assert.doesNotMatch(q.user, /EXISTING NOTES/)
})

test('frontmatter and envelope helpers', () => {
  assert.deepEqual(splitFrontmatter('---\na: 1\n---\nbody'), { fm: '---\na: 1\n---\n', body: 'body' })
  assert.equal(isEnvelope('---\nnk-encrypted: v1\n---\n```nk-cipher\nx\n```'), true)
  assert.equal(isEnvelope('# plain'), false)
})

function fakeLlm(reply, seen) {
  return {
    listProviders: () => [{ id: 'p1', name: 'Prov' }, { id: 'broken', name: 'B' }],
    listModels: async (id) => { if (id === 'broken') throw new Error('x'); return [{ id: 'm1', name: 'Model One' }] },
    async *stream(req) {
      seen.push(req)
      for (const part of reply.match(/.{1,7}/gs)) yield { type: 'text-delta', index: 0, text: part }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('enhance: default model, frontmatter preserved, settings override, refusals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nk-ai-'))
  try {
    const seen = []
    const ai = makeAi({
      getLlm: () => fakeLlm('# Fixed\n\nText about [[Alpha]] and [[Ghost]].\n', seen),
      getDefaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }),
      noteTitles: async () => ['Alpha', 'Me'],
      stateFile: join(dir, 'ai.json'),
    })
    const r = await ai.enhance({ text: '---\ntags: [x]\n---\nfixd text about alpha\n', title: 'Me' })
    assert.equal(r.text, '---\ntags: [x]\n---\n# Fixed\n\nText about [[Alpha]] and Ghost.\n')
    assert.deepEqual(r.added, ['Alpha'])
    assert.deepEqual(r.model, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: '' })
    assert.equal(seen[0].provider, 'deepseek')
    assert.doesNotMatch(seen[0].messages[0].content[0].text, /- Me\n/, 'own title excluded from link targets')
    assert.doesNotMatch(seen[0].messages[0].content[0].text, /tags: \[x\]/, 'frontmatter not sent')

    const saved = ai.saveSettings({ provider: 'p1', model: 'm1', addLinks: false, bogus: 1 })
    assert.equal(saved.provider, 'p1')
    assert.equal(saved.bogus, undefined)
    await ai.enhance({ text: 'hello', title: 'T' })
    assert.equal(seen[1].provider, 'p1')
    assert.doesNotMatch(seen[1].messages[0].content[0].text, /EXISTING NOTES/)

    const models = await ai.models()
    assert.deepEqual(models.models.map((m) => m.provider + '/' + m.id), ['p1/m1'])
    assert.equal(models.default.model, 'deepseek-chat')

    await assert.rejects(ai.enhance({ text: '---\nnk-encrypted: v1\n---\n```nk-cipher\nQQ\n```\n' }), /encrypted/)
    await assert.rejects(ai.enhance({ text: '   ' }), /empty/)
    await assert.rejects(ai.enhance({ text: 'x'.repeat(70000) }), /too long/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('enhance surfaces model failures', async () => {
  const ai = makeAi({
    getLlm: () => ({ async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota' } } } } }),
    getDefaultModel: () => ({ currentSelection: () => ({ provider: 'x', model: 'y' }) }),
    noteTitles: async () => [], stateFile: join(tmpdir(), 'nk-ai-none-' + process.pid + '.json'),
  })
  await assert.rejects(ai.enhance({ text: 'hi' }), /quota/)
})
