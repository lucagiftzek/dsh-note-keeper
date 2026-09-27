/**
 * Pure helpers turning the daemon's flat entry list into a folder tree and
 * resolving links the way Obsidian does. Kept framework-free so they are
 * unit-tested in node.
 */

/** Build nested nodes: { name, path, dir, children, entry }. Folders first. */
export function buildTree(entries) {
  const root = { name: '', path: '', dir: true, children: [] }
  const byPath = new Map([['', root]])
  const ensure = (p) => {
    if (byPath.has(p)) return byPath.get(p)
    const i = p.lastIndexOf('/')
    const parent = ensure(i < 0 ? '' : p.slice(0, i))
    const node = { name: p.slice(i + 1), path: p, dir: true, children: [] }
    parent.children.push(node)
    byPath.set(p, node)
    return node
  }
  for (const e of entries) {
    if (e.dir) { ensure(e.path).entry = e; continue }
    const i = e.path.lastIndexOf('/')
    const parent = ensure(i < 0 ? '' : e.path.slice(0, i))
    const node = { name: e.path.slice(i + 1), path: e.path, dir: false, entry: e }
    parent.children.push(node)
    byPath.set(e.path, node)
  }
  const sort = (n) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1))
    n.children.forEach((c) => c.dir && sort(c))
  }
  sort(root)
  return root
}

/** Flatten visible rows for rendering (respecting expanded folders). */
export function visibleRows(root, expanded, depth = 0, out = []) {
  for (const c of root.children) {
    out.push({ node: c, depth })
    if (c.dir && expanded.has(c.path)) visibleRows(c, expanded, depth + 1, out)
  }
  return out
}

export const stem = (p) => { const b = p.slice(p.lastIndexOf('/') + 1); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b }
export const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i) }
export const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1)

/**
 * Obsidian-style link resolution against the list of file paths: exact path,
 * path + .md, relative to the source folder, then the shortest path whose
 * tail matches.
 */
export function makeResolver(paths, from = '') {
  const set = new Set(paths)
  const lower = paths.map((p) => [p.toLowerCase(), p])
  return (target) => {
    let t = String(target || '').trim().replace(/^\/+/, '')
    if (!t) return null
    const cands = /\.[^/.]+$/.test(t) ? [t] : [t + '.md', t]
    for (const c of cands) {
      if (set.has(c)) return c
      const rel = from ? dirOf(from) + '/' + c : c
      if (set.has(rel)) return rel
    }
    const want = cands[0].toLowerCase()
    let best = null
    for (const [lp, p] of lower) {
      if (lp === want || lp.endsWith('/' + want)) {
        if (!best || p.length < best.length) best = p
      }
    }
    return best
  }
}

/** Kind of a vault file for icons and viewers. */
export function fileKind(entry) {
  const p = entry.path.toLowerCase()
  if (p.endsWith('.nkenc')) return 'sealed'
  if (p.endsWith('.md')) {
    const t = entry.doc && entry.doc.type
    return t === 'audio' ? 'audio' : t === 'drawing' ? 'draw' : 'note'
  }
  if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(p)) return 'image'
  if (/\.(mp3|wav|ogg|oga|m4a|webm|weba|flac|opus)$/.test(p)) return 'audiofile'
  if (/\.(mp4|mov|mkv)$/.test(p)) return 'video'
  if (p.endsWith('.pdf')) return 'pdf'
  return 'file'
}

/** Is path inside (or equal to) any locked folder? Returns that folder or null. */
export function lockedScopeOf(path, locked) {
  let best = null
  for (const f of locked || []) {
    if (f === '' || path === f || path.startsWith(f + '/')) {
      if (best === null || f.length > best.length) best = f
    }
  }
  return best
}

/** Human-readable size. */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}

export function fmtAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return Math.round(s / 60) + 'm ago'
  if (s < 86400) return Math.round(s / 3600) + 'h ago'
  if (s < 86400 * 30) return Math.round(s / 86400) + 'd ago'
  return new Date(ms).toISOString().slice(0, 10)
}
