/**
 * dsh-note-keeper — the model-facing tool surface (notes_*).
 *
 * These let an AI read, search, create and modify notes on the user's behalf.
 * Every call goes through the same daemon API the sidebar uses, so path
 * validation, conflict detection and folder-lock rules apply identically.
 *
 * Zero-knowledge rule: encrypted notes are opaque to models. Tools never
 * return ciphertext and can never write plaintext into an encrypted folder
 * (the daemon refuses with "locked"); the model is told to ask the user to
 * open the note in Note Keeper instead.
 *
 * Writes are safe against concurrent edits: every modification reads the note
 * first and writes with baseMtime, retrying once on a conflict.
 * @module dsh-note-keeper/tools
 */

'use strict'

const TEXT = (s) => [{ type: 'text', text: String(s) }]
const MAX_READ_CHARS = 60000

const OUT = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      result: { type: 'json' },
      error: { type: 'string' },
    },
  },
  render: (_a, v) => TEXT(v.ok ? (typeof v.result === 'string' ? v.result : JSON.stringify(v.result, null, 1)) : 'error: ' + v.error),
}

const q = (o) => '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString()

function errOf(r) {
  const b = r.body || {}
  if (b.code === 'locked') return 'this folder is encrypted (zero-knowledge): models cannot write plaintext here. Ask the user to add it in Note Keeper.'
  return (b.error || 'HTTP ' + r.status) + (b.code ? ' [' + b.code + ']' : '')
}

function ensureMd(p) {
  const s = String(p || '').trim()
  return /\.md$/i.test(s) ? s : s + '.md'
}

/** Build frontmatter-bearing content for a new note. */
export function withTags(content, tags) {
  const list = (Array.isArray(tags) ? tags : []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean)
  if (!list.length) return content
  return '---\ntags: [' + list.map((t) => JSON.stringify(t)).join(', ') + ']\n---\n' + content
}

/** Apply an edit operation to current text. Throws on an ambiguous patch. */
export function applyEdit(current, args) {
  const mode = args.mode || 'replace'
  const text = String(args.content ?? '')
  switch (mode) {
    case 'replace': return text
    case 'append': return current.replace(/\n*$/, '') + '\n' + text + (text.endsWith('\n') ? '' : '\n')
    case 'prepend': {
      // Keep frontmatter on top: insert after it.
      const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(current)
      if (m) return m[0] + text + (text.endsWith('\n') ? '' : '\n') + current.slice(m[0].length)
      return text + (text.endsWith('\n') ? '' : '\n') + current
    }
    case 'replace_text': {
      const find = String(args.find ?? '')
      if (!find) throw new Error('replace_text needs "find"')
      const count = current.split(find).length - 1
      if (count === 0) throw new Error('"find" text not found in the note')
      if (count > 1 && !args.all) throw new Error('"find" occurs ' + count + ' times; make it unique or set all=true')
      return args.all ? current.split(find).join(text) : current.replace(find, () => text)
    }
    default: throw new Error('unknown mode ' + mode)
  }
}

export function agentTools(defineTool, { daemon, config }) {
  const defs = []
  const call = (m, p, o) => daemon.request(m, p, o)
  const canWrite = () => config().aiWrite !== false
  const readOnlyErr = { ok: false, error: 'AI write access is disabled in Note Keeper settings (aiWrite: false).' }

  defs.push(defineTool({
    name: 'notes_list',
    description: 'List the Note Keeper vault (the user\'s notes, Obsidian-compatible Markdown). Returns folders and notes with titles, tags, type (text/audio/drawing) and whether each is encrypted. Use folder to narrow to one subtree.',
    parameters: {
      folder: { type: 'string', description: 'Vault-relative folder to list (default: whole vault).' },
      limit: { type: 'integer', description: 'Max rows (default 300).' },
    },
    output: OUT,
    async execute(args) {
      const r = await call('GET', '/tree')
      if (r.status !== 200) return { ok: false, error: errOf(r) }
      const folder = String(args.folder || '').replace(/^\/+|\/+$/g, '')
      const rows = r.body.entries
        .filter((e) => !folder || e.path === folder || e.path.startsWith(folder + '/'))
        .map((e) => e.dir ? { path: e.path + '/', dir: true }
          : { path: e.path, title: e.doc && e.doc.title, type: e.doc && e.doc.kind === 'note' ? e.doc.type : 'attachment', tags: e.doc && e.doc.tags, encrypted: Boolean(e.doc && e.doc.encrypted) || undefined, modified: new Date(e.mtime).toISOString() })
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 300))
      return { ok: true, result: { total: rows.length, encryptedFolders: r.body.locked, rows: rows.slice(0, limit) } }
    },
  }))

  defs.push(defineTool({
    name: 'notes_search',
    description: 'Full-text search across the user\'s notes (accent-insensitive, Greek and English aware; last word matches as a prefix; "quoted phrases" match exactly). Filter by tag (nested tags included) or folder. Encrypted notes are never searchable.',
    parameters: {
      query: { type: 'string', description: 'Words to find. May be empty when tag or folder is given.' },
      tag: { type: 'string', description: 'Only notes with this tag, e.g. "work" or "project/alpha".' },
      folder: { type: 'string', description: 'Only notes under this folder.' },
      limit: { type: 'integer', description: 'Max hits (default 20).' },
    },
    output: OUT,
    async execute(args) {
      const r = await call('GET', '/search' + q({ q: args.query, tag: args.tag, folder: args.folder, limit: args.limit || 20, kind: 'note' }))
      if (r.status !== 200) return { ok: false, error: errOf(r) }
      return { ok: true, result: r.body.hits.map((h) => ({ path: h.path, title: h.title, tags: h.tags, snippet: h.snippet, modified: new Date(h.mtime).toISOString() })) }
    },
  }))

  defs.push(defineTool({
    name: 'notes_read',
    description: 'Read one note\'s Markdown (including frontmatter), its tags, outgoing links and backlinks. Encrypted notes cannot be read by models: ask the user to open them in Note Keeper.',
    parameters: {
      path: { type: 'string', required: true, description: 'Vault-relative note path, e.g. "Projects/Alpha.md".' },
    },
    output: OUT,
    async execute(args) {
      const r = await call('GET', '/note' + q({ path: ensureMd(args.path) }))
      if (r.status !== 200) return { ok: false, error: errOf(r) }
      const b = r.body
      if (b.doc && b.doc.encrypted) {
        return { ok: false, error: 'note is encrypted (zero-knowledge); its content is not available to models. Ask the user to unlock and read it in Note Keeper.' }
      }
      let content = b.content
      let truncated = false
      if (content.length > MAX_READ_CHARS) { content = content.slice(0, MAX_READ_CHARS); truncated = true }
      return { ok: true, result: { path: b.path, title: b.doc && b.doc.title, tags: b.doc && b.doc.tags, links: b.doc && b.doc.links, backlinks: (b.backlinks || []).map((d) => d.path), modified: new Date(b.mtime).toISOString(), truncated, content } }
    },
  }))

  defs.push(defineTool({
    name: 'notes_create',
    description: 'Create a new Markdown note in the user\'s vault. The file name is derived from the title (made Obsidian-safe; a number is appended if it exists). Use [[Note Title]] wikilinks to connect notes and #tags inline or via the tags parameter.',
    parameters: {
      title: { type: 'string', required: true, description: 'Note title (becomes the file name).' },
      content: { type: 'string', required: true, description: 'Markdown body. Start with "# Title" for a heading.' },
      folder: { type: 'string', description: 'Vault-relative folder (created if missing). Default: vault root.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags to put in frontmatter.' },
    },
    output: OUT,
    async execute(args) {
      if (!canWrite()) return readOnlyErr
      const r = await call('POST', '/note/new', { json: { folder: args.folder || '', title: args.title, content: withTags(String(args.content ?? ''), args.tags) } })
      if (r.status !== 200) return { ok: false, error: errOf(r) }
      return { ok: true, result: { created: r.body.path } }
    },
  }))

  defs.push(defineTool({
    name: 'notes_update',
    description: 'Modify an existing note. mode "replace" overwrites the whole note with content; "append"/"prepend" add content at the end/start (prepend keeps frontmatter on top); "replace_text" swaps the exact text find for content (must be unique unless all=true). Safe against concurrent edits.',
    parameters: {
      path: { type: 'string', required: true, description: 'Vault-relative note path.' },
      mode: { type: 'string', enum: ['replace', 'append', 'prepend', 'replace_text'], description: 'Default "replace".' },
      content: { type: 'string', required: true, description: 'New text (the replacement for replace_text).' },
      find: { type: 'string', description: 'Exact text to replace (replace_text mode).' },
      all: { type: 'boolean', description: 'replace_text: replace every occurrence.' },
    },
    output: OUT,
    async execute(args) {
      if (!canWrite()) return readOnlyErr
      const p = ensureMd(args.path)
      for (let attempt = 0; attempt < 2; attempt++) {
        const cur = await call('GET', '/note' + q({ path: p }))
        if (cur.status !== 200) return { ok: false, error: errOf(cur) }
        if (cur.body.doc && cur.body.doc.encrypted) return { ok: false, error: 'note is encrypted (zero-knowledge); models cannot modify it.' }
        let next
        try { next = applyEdit(cur.body.content, args) } catch (e) { return { ok: false, error: e.message } }
        const w = await call('PUT', '/note', { json: { path: p, content: next, baseMtime: cur.body.mtime } })
        if (w.status === 200) return { ok: true, result: { updated: w.body.path, bytes: Buffer.byteLength(next) } }
        if (w.status !== 409 || w.body.code !== 'conflict') return { ok: false, error: errOf(w) }
      }
      return { ok: false, error: 'the note kept changing on disk (someone is editing it); try again.' }
    },
  }))

  defs.push(defineTool({
    name: 'notes_move',
    description: 'Rename or move a note or folder. Wikilinks in other notes that point to a renamed note are updated automatically (like Obsidian).',
    parameters: {
      from: { type: 'string', required: true, description: 'Current vault-relative path.' },
      to: { type: 'string', required: true, description: 'New vault-relative path (must not exist).' },
    },
    output: OUT,
    async execute(args) {
      if (!canWrite()) return readOnlyErr
      const r = await call('POST', '/move', { json: { from: args.from, to: args.to } })
      if (r.status !== 200) return { ok: false, error: errOf(r) }
      return { ok: true, result: r.body }
    },
  }))

  defs.push(defineTool({
    name: 'notes_delete',
    description: 'Delete a note or folder by moving it to the vault trash (.trash, recoverable from Obsidian or the file system). Only do this when the user explicitly asked.',
    parameters: {
      path: { type: 'string', required: true, description: 'Vault-relative path.' },
    },
    output: OUT,
    async execute(args) {
      if (!canWrite() || config().aiDelete === false) return { ok: false, error: 'AI delete access is disabled in Note Keeper settings.' }
      const r = await call('DELETE', '/entry' + q({ path: args.path }))
      if (r.status !== 200) return { ok: false, error: errOf(r) }
      return { ok: true, result: r.body }
    },
  }))

  defs.push(defineTool({
    name: 'notes_mkdir',
    description: 'Create a folder (and parents) in the vault.',
    parameters: { path: { type: 'string', required: true, description: 'Vault-relative folder path.' } },
    output: OUT,
    async execute(args) {
      if (!canWrite()) return readOnlyErr
      const r = await call('POST', '/folder', { json: { path: args.path } })
      if (r.status !== 200) return { ok: false, error: errOf(r) }
      return { ok: true, result: r.body }
    },
  }))

  defs.push(defineTool({
    name: 'notes_capture',
    description: 'Quick-capture a thought or to-do into the Inbox note (timestamped bullet, or "- [ ]" task when todo=true). Use for fast "note this down" requests.',
    parameters: {
      text: { type: 'string', required: true, description: 'What to capture.' },
      todo: { type: 'boolean', description: 'Add as an unchecked task.' },
      target: { type: 'string', description: 'Another note to append to instead of Inbox.md.' },
    },
    output: OUT,
    async execute(args) {
      if (!canWrite()) return readOnlyErr
      const r = await call('POST', '/capture', { json: { text: args.text, todo: Boolean(args.todo), target: args.target || '' } })
      if (r.status !== 200) return { ok: false, error: errOf(r) }
      return { ok: true, result: { appendedTo: r.body.path } }
    },
  }))

  defs.push(defineTool({
    name: 'notes_daily',
    description: 'Open (creating if needed) the daily note for a date (default today, Daily/YYYY-MM-DD.md, using Templates/Daily.md when present), optionally appending text to it.',
    parameters: {
      date: { type: 'string', description: 'YYYY-MM-DD (default today).' },
      append: { type: 'string', description: 'Text to append to the daily note.' },
    },
    output: OUT,
    async execute(args) {
      if (!canWrite()) return readOnlyErr
      const r = await call('POST', '/daily', { json: { date: args.date || '' } })
      if (r.status !== 200) return { ok: false, error: errOf(r) }
      if (args.append) {
        const c = await call('POST', '/capture', { json: { text: args.append, target: r.body.path } })
        if (c.status !== 200) return { ok: false, error: errOf(c) }
      }
      return { ok: true, result: { path: r.body.path, created: r.body.created } }
    },
  }))

  defs.push(defineTool({
    name: 'notes_tags',
    description: 'List every tag in the vault with its note count (most used first).',
    parameters: {},
    output: OUT,
    async execute() {
      const r = await call('GET', '/tags')
      if (r.status !== 200) return { ok: false, error: errOf(r) }
      return { ok: true, result: r.body.tags }
    },
  }))

  defs.push(defineTool({
    name: 'notes_links',
    description: 'Show how a note connects: its backlinks (notes linking to it) plus its resolved outgoing links. Omit path for a vault-wide summary of the most connected notes and unresolved links.',
    parameters: { path: { type: 'string', description: 'Vault-relative note path.' } },
    output: OUT,
    async execute(args) {
      const g = await call('GET', '/graph')
      if (g.status !== 200) return { ok: false, error: errOf(g) }
      const { nodes, edges } = g.body
      if (!args.path) {
        const top = nodes.filter((n) => n.kind === 'note').sort((a, b) => b.degree - a.degree).slice(0, 20).map((n) => ({ path: n.id, links: n.degree }))
        return { ok: true, result: { notes: nodes.filter((n) => n.kind === 'note').length, edges: edges.length, mostConnected: top, unresolved: nodes.filter((n) => n.kind === 'ghost').map((n) => n.title) } }
      }
      const p = ensureMd(args.path)
      return { ok: true, result: { path: p, outgoing: edges.filter((e) => e.source === p).map((e) => e.target), backlinks: edges.filter((e) => e.target === p).map((e) => e.source) } }
    },
  }))

  return defs
}
