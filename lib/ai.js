/**
 * "AI Enhance": proofread, format and interlink one note with a DSH model.
 *
 * Runs in the host (not the Go daemon) because model access belongs to DSH:
 * requests go through the harness LLM service (ctx.llm), and the default
 * route is the one DSH uses for new chats (ctx.agentDefaultModel), unless the
 * user picked another model in the AI settings popup. Settings persist in
 * <stateDir>/ai.json. Encrypted notes are refused: their plaintext must never
 * leave the browser.
 * @module dsh-note-keeper/ai
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const AI_DEFAULTS = Object.freeze({
  provider: '',          // '' = follow the DSH default model for new chats
  model: '',
  reasoningEffort: '',
  fixSpelling: true,
  format: true,
  addLinks: true,
  custom: '',            // extra instruction appended to the system prompt
})

export const MAX_NOTE_CHARS = 60000
const MAX_TITLES = 800

/** Split YAML frontmatter from the body (kept byte-exact). */
export function splitFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return m ? { fm: m[0], body: text.slice(m[0].length) } : { fm: '', body: text }
}

export function isEnvelope(text) {
  return /^---\r?\n(?:[^\n]*\n)*?nk-encrypted:\s*v1/.test(text) && text.includes('```nk-cipher')
}

/** Build the system + user prompt. Pure, for tests. */
export function buildPrompt({ body, title, titles, opts }) {
  const rules = [
    'You are a meticulous editor for a personal Markdown notes app (Obsidian-compatible).',
    'Return ONLY the revised note body in Markdown: no preamble, no explanation, no frontmatter, and do not wrap the whole answer in a code fence.',
    'Keep the language(s) of the note exactly as written. Never translate. Greek stays Greek, English stays English, mixed stays mixed.',
    'Never remove information, never invent facts, never change the meaning.',
    'Preserve exactly: existing [[wikilinks]], ![[embeds]], #tags, URLs, inline code, fenced code blocks, math, HTML, task checkboxes and their checked state.',
  ]
  if (opts.fixSpelling) rules.push('Fix spelling, grammar, punctuation and obvious typos (including missing Greek accents).')
  if (opts.format) rules.push('Improve the Markdown structure where it helps readability: a clear heading hierarchy, bullet or numbered lists for enumerations, tables for tabular data, code fences for code, short paragraphs. Do not over-format short notes.')
  if (opts.addLinks && titles.length) {
    rules.push('Link related notes: where the text clearly mentions the subject of one of the EXISTING NOTES listed by the user, wrap its first mention as [[Exact Title]] or [[Exact Title|original words]] to keep the sentence grammatical. Use only titles from that list, never invent links, never link the note to itself, add at most 15 links.')
  }
  if (opts.custom && String(opts.custom).trim()) rules.push('Additional instruction from the user: ' + String(opts.custom).trim().slice(0, 1000))
  let user = ''
  if (opts.addLinks && titles.length) user += 'EXISTING NOTES:\n' + titles.map((t) => '- ' + t).join('\n') + '\n\n'
  user += 'NOTE TITLE: ' + title + '\n\nNOTE BODY BETWEEN THE MARKERS:\n<<<NOTE\n' + body + '\nNOTE>>>'
  return { system: rules.join('\n'), user }
}

const WIKI = /(!?)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g

/**
 * Clean the model output: strip a wrapping fence or the note markers, and
 * unwrap any NEW wikilink whose target is not an existing note (the model
 * may hallucinate one). Returns { text, added } where added lists new links.
 */
export function postProcess(out, original, titles) {
  let t = String(out || '').trim()
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(t)
  if (fence) t = fence[1]
  t = t.replace(/^<<<NOTE\s*\n?/, '').replace(/\n?NOTE>>>\s*$/, '')
  const had = new Set()
  for (const m of original.matchAll(WIKI)) had.add(m[2].trim().toLowerCase())
  const known = new Set(titles.map((x) => x.toLowerCase()))
  const added = []
  t = t.replace(WIKI, (all, bang, target, head, alias) => {
    const key = target.trim().toLowerCase()
    if (had.has(key) || bang) return all
    if (!known.has(key)) return alias != null ? alias : target
    if (!added.includes(target.trim())) added.push(target.trim())
    return all
  })
  if (original.endsWith('\n') && !t.endsWith('\n')) t += '\n'
  return { text: t, added }
}

/**
 * @param {object} deps
 * @param {() => any} deps.getLlm            the harness LLM service (ctx.llm) or null
 * @param {() => any} deps.getDefaultModel   ctx.agentDefaultModel or null
 * @param {() => Promise<string[]>} deps.noteTitles  existing note titles
 * @param {string} deps.stateFile
 * @param {(input: object) => object} [deps.createUserMessage]
 */
export function makeAi({ getLlm, getDefaultModel, noteTitles, stateFile, createUserMessage, warn = () => {} }) {
  const load = () => {
    try { return { ...AI_DEFAULTS, ...JSON.parse(readFileSync(stateFile, 'utf8')) } } catch { return { ...AI_DEFAULTS } }
  }
  const userMsg = (text) => {
    const content = [{ type: 'text', text }]
    if (createUserMessage) { try { return createUserMessage({ content, source: 'user' }) } catch { /* fall through */ } }
    return { id: randomUUID(), role: 'user', content }
  }
  const defaultRoute = () => {
    try {
      const sel = getDefaultModel()?.currentSelection?.()
      if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || '' }
    } catch { /* service missing */ }
    return null
  }

  return {
    settings() { return { ...load(), default: defaultRoute() } },

    saveSettings(input) {
      const cur = load()
      const next = { ...cur }
      for (const [k, def] of Object.entries(AI_DEFAULTS)) {
        if (input[k] !== undefined && typeof input[k] === typeof def) next[k] = typeof def === 'string' ? String(input[k]).slice(0, 1000) : input[k]
      }
      if (!next.provider || !next.model) { next.provider = ''; next.model = '' }
      mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 })
      writeFileSync(stateFile + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 })
      renameSync(stateFile + '.tmp', stateFile)
      return { ...next, default: defaultRoute() }
    },

    async models() {
      const llm = getLlm()
      if (!llm) return { models: [], default: defaultRoute(), error: 'LLM service unavailable' }
      const out = []
      let providers = []
      try { providers = llm.listProviders() || [] } catch (e) { warn('listProviders: ' + e.message) }
      await Promise.all(providers.map(async (p) => {
        try {
          const list = await Promise.race([llm.listModels(p.id), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))])
          for (const m of list || []) out.push({ provider: p.id, providerName: p.name || p.id, id: m.id, name: m.name || m.id })
        } catch { /* provider without a catalog: skip */ }
      }))
      out.sort((a, b) => (a.providerName + a.name).localeCompare(b.providerName + b.name))
      return { models: out, default: defaultRoute() }
    },

    async enhance({ text, title, options = {} }, signal) {
      if (typeof text !== 'string') throw Object.assign(new Error('text required'), { status: 400 })
      if (isEnvelope(text)) throw Object.assign(new Error('encrypted notes are never sent to a model'), { status: 403 })
      const { fm, body } = splitFrontmatter(text)
      if (!body.trim()) throw Object.assign(new Error('the note is empty'), { status: 400 })
      if (body.length > MAX_NOTE_CHARS) throw Object.assign(new Error('note too long for AI Enhance (max ' + MAX_NOTE_CHARS + ' characters)'), { status: 413 })
      const s = { ...load(), ...options }
      const route = s.provider && s.model ? { provider: s.provider, model: s.model, reasoningEffort: s.reasoningEffort } : defaultRoute()
      if (!route) throw Object.assign(new Error('no model configured: pick one in AI settings'), { status: 503 })
      const llm = getLlm()
      if (!llm) throw Object.assign(new Error('the DSH LLM service is unavailable'), { status: 503 })
      let titles = []
      if (s.addLinks) {
        try { titles = (await noteTitles()).filter((t) => t && t !== title).slice(0, MAX_TITLES) } catch { titles = [] }
      }
      const { system, user } = buildPrompt({ body, title: title || 'Untitled', titles, opts: s })
      const req = {
        provider: route.provider, model: route.model, system,
        messages: [userMsg(user)],
        maxTokens: Math.min(32000, Math.max(2048, Math.ceil(body.length / 2) + 1024)),
        temperature: 0.2,
        signal,
      }
      if (route.reasoningEffort) req.reasoningEffort = route.reasoningEffort
      let out = ''
      for await (const ch of llm.stream(req)) {
        if (ch.type === 'text-delta') out += ch.text
        else if (ch.type === 'finish') {
          const kind = typeof ch.reason === 'string' ? ch.reason : ch.reason?.kind
          if (kind !== 'stop' && kind !== 'max-tokens') {
            const why = ch.reason?.failure?.message || ch.reason?.failure?.code || ''
            throw Object.assign(new Error('model call failed (' + kind + (why ? ': ' + why : '') + ')'), { status: 502 })
          }
        }
      }
      const res = postProcess(out, body, titles)
      if (!res.text.trim()) throw Object.assign(new Error('the model returned an empty answer'), { status: 502 })
      return { text: fm + res.text, added: res.added, model: route }
    },
  }
}
