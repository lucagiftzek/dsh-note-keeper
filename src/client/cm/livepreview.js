/**
 * Obsidian-style "live preview" for CodeMirror 6.
 *
 * Links, tags, emphasis and headings render as what they are while you type:
 *   - [[Note]], [[Note|alias]], [[Note#Heading]] show as a clickable link
 *     (brackets and target hidden until the cursor enters the link);
 *   - [text](https://…) shows only "text", clickable;
 *   - #tag / #nested/tag render as a tag pill, clickable;
 *   - **bold**, *italic*, ~~strike~~, `code` hide their markers;
 *   - "# " heading marks hide and the line is sized like a heading;
 *   - "- [ ]" task markers become real checkboxes;
 *   - ![[image.png]] embeds render the image under the line.
 * The raw Markdown is always one cursor-move away: any construct touching the
 * selection is shown as source, exactly like Obsidian.
 *
 * In source mode (live = false) the same constructs are only *styled* (link
 * and tag colours) and open with Ctrl/Cmd+click.
 * @module dsh-note-keeper/client/cm/livepreview
 */
import { ViewPlugin, Decoration, WidgetType, EditorView } from '@codemirror/view'
import { StateField } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

export const WIKI_RE = /(!?)\[\[([^\[\]|#\n]*)(#[^\[\]|\n]*)?(?:\|([^\[\]\n]*))?\]\]/g
export const TAG_RE = /(^|[\s(])(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i
const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'HTMLBlock', 'CommentBlock', 'URL', 'Autolink'])

class CheckboxWidget extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos }
  eq(o) { return o.checked === this.checked && o.pos === this.pos }
  toDOM() {
    const el = document.createElement('input')
    el.type = 'checkbox'
    el.className = 'nk-cm-task'
    el.checked = this.checked
    el.dataset.taskPos = String(this.pos)
    return el
  }
  ignoreEvent() { return false }
}

class BulletWidget extends WidgetType {
  eq() { return true }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'nk-cm-bullet'
    el.textContent = '•'
    return el
  }
}

class PropsWidget extends WidgetType {
  constructor(text) { super(); this.text = text }
  eq(o) { return o.text === this.text }
  toDOM() {
    const box = document.createElement('div')
    box.className = 'nk-cm-props'
    for (const line of this.text.split('\n')) {
      const m = /^([^:#\s][^:]*):\s*(.*)$/.exec(line)
      if (!m || m[1].startsWith('nk-')) continue
      const row = document.createElement('span')
      const k = document.createElement('b')
      k.textContent = m[1]
      row.appendChild(k)
      row.appendChild(document.createTextNode(' ' + m[2].replace(/^\[|\]$/g, '').replace(/"/g, '')))
      box.appendChild(row)
    }
    if (!box.childNodes.length) box.textContent = 'properties'
    return box
  }
  ignoreEvent() { return false }
}

/** End offset of a leading YAML frontmatter block, or -1. */
export function frontmatterEnd(doc) {
  if (doc.lines < 2 || doc.line(1).text !== '---') return -1
  for (let i = 2; i <= Math.min(doc.lines, 400); i++) {
    const t = doc.line(i).text
    if (t === '---' || t === '...') return doc.line(i).to
  }
  return -1
}

class EmbedWidget extends WidgetType {
  constructor(target, url, label) { super(); this.target = target; this.url = url; this.label = label }
  eq(o) { return o.target === this.target && o.url === this.url }
  toDOM() {
    if (this.url && IMAGE_EXT.test(this.target)) {
      const img = document.createElement('img')
      img.className = 'nk-cm-embed-img'
      img.src = this.url
      img.alt = this.label
      img.dataset.target = this.target
      return img
    }
    const a = document.createElement('span')
    a.className = 'nk-cm-wikilink nk-cm-embed-chip' + (this.url ? '' : ' nk-unresolved')
    a.textContent = '↳ ' + this.label
    a.dataset.target = this.target
    return a
  }
  ignoreEvent() { return false }
}

/** Does any selection range touch [from, to]? */
function touches(state, from, to) {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true
  return false
}

/** Collect code ranges (no link/tag detection inside them). */
function codeRanges(state, from, to) {
  const out = []
  syntaxTree(state).iterate({ from, to, enter(n) { if (CODE_NODES.has(n.name)) { out.push([n.from, n.to]); return false } } })
  return out
}
const inRanges = (ranges, a, b) => ranges.some(([f, t]) => a < t && b > f)

/**
 * Build decorations for the visible viewport.
 * @param {EditorView} view
 * @param {{ live: boolean, resolve: (t:string)=>string|null, fileUrl: (p:string)=>string }} opts
 */
export function buildDecorations(view, opts) {
  const { state } = view
  const live = opts.live
  const decos = []
  const hide = (a, b) => { if (b > a) decos.push(Decoration.replace({}).range(a, b)) }
  const mark = (a, b, cls, attrs) => { if (b > a) decos.push(Decoration.mark({ class: cls, attributes: attrs }).range(a, b)) }

  // Frontmatter is YAML, not Markdown (lezer would read "key: v" + "---" as a
  // setext heading): muted in source, a compact property strip in live
  // preview while the cursor is elsewhere.
  // (The collapsed property strip itself is a block widget, which CodeMirror
  // only accepts from a state field: see frontmatterField below.)
  const fmEnd = frontmatterEnd(state.doc)
  if (fmEnd > 0 && !(live && !touches(state, 0, fmEnd))) {
    for (let i = 1; i <= state.doc.lineAt(fmEnd).number; i++) decos.push(Decoration.line({ class: 'nk-cm-fm' }).range(state.doc.line(i).from))
  }

  for (const { from, to } of view.visibleRanges) {
    const code = codeRanges(state, from, to)
    // --- syntax-tree driven constructs -----------------------------------
    syntaxTree(state).iterate({
      from, to,
      enter(n) {
        const name = n.name
        if (fmEnd > 0 && n.from < fmEnd) return n.to > fmEnd ? undefined : false
        if (/^ATXHeading[1-6]$/.test(name)) {
          const line = state.doc.lineAt(n.from)
          decos.push(Decoration.line({ class: 'nk-cm-h nk-cm-h' + name.slice(-1) }).range(line.from))
          if (live && !touches(state, line.from, line.to)) {
            const markNode = n.node.getChild('HeaderMark')
            if (markNode) hide(markNode.from, Math.min(markNode.to + 1, line.to))
          }
          return
        }
        if (!live) return
        if (name === 'Emphasis' || name === 'StrongEmphasis' || name === 'Strikethrough' || (name === 'InlineCode')) {
          if (touches(state, n.from, n.to)) return
          const markName = name === 'InlineCode' ? 'CodeMark' : name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark'
          for (let c = n.node.firstChild; c; c = c.nextSibling) if (c.name === markName) hide(c.from, c.to)
          return
        }
        if (name === 'Link') {
          const marks = []
          let url = null
          for (let c = n.node.firstChild; c; c = c.nextSibling) {
            if (c.name === 'LinkMark') marks.push(c)
            else if (c.name === 'URL') url = state.doc.sliceString(c.from, c.to)
          }
          if (marks.length >= 2 && url && !touches(state, n.from, n.to)) {
            hide(n.from, marks[0].to) // "["
            mark(marks[0].to, marks[1].from, 'nk-cm-link', { 'data-href': url, title: url })
            hide(marks[1].from, n.to) // "](url)"
          } else if (marks.length >= 2) {
            mark(n.from, n.to, 'nk-cm-link-raw')
          }
          return false
        }
        if (name === 'ListMark') {
          const mk = state.doc.sliceString(n.from, n.to)
          if (!/^[-*+]$/.test(mk)) return
          const line = state.doc.lineAt(n.from)
          if (touches(state, line.from, line.to)) return
          const rest = state.doc.sliceString(n.to, Math.min(line.to, n.to + 5))
          if (/^ \[[ xX]\]/.test(rest)) hide(n.from, n.to + 1) // task: the checkbox is the bullet
          else decos.push(Decoration.replace({ widget: new BulletWidget() }).range(n.from, n.to))
          return
        }
        if (name === 'TaskMarker') {
          if (touches(state, n.from, n.to)) return
          const checked = /x/i.test(state.doc.sliceString(n.from, n.to))
          decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, n.from) }).range(n.from, n.to))
          if (checked) {
            const line = state.doc.lineAt(n.from)
            mark(n.to, line.to, 'nk-cm-done')
          }
        }
      },
    })

    // --- regex constructs: wikilinks/embeds and tags ------------------------
    const text = state.doc.sliceString(from, to)
    WIKI_RE.lastIndex = 0
    const linkSpans = []
    for (let m; (m = WIKI_RE.exec(text));) {
      const a = from + m.index
      const b = a + m[0].length
      if (inRanges(code, a, b)) continue
      linkSpans.push([a, b])
      const bang = m[1] === '!'
      const target = (m[2] || '').trim()
      const heading = m[3] || ''
      const alias = m[4]
      const resolved = target ? opts.resolve(target) : null
      const cls = 'nk-cm-wikilink' + (resolved || !target ? '' : ' nk-unresolved')
      const attrs = { 'data-target': target + heading }
      if (!live || touches(state, a, b)) {
        mark(a, b, live ? 'nk-cm-wikilink-raw' : cls, attrs)
        continue
      }
      if (bang) {
        decos.push(Decoration.replace({ widget: new EmbedWidget(target, resolved ? opts.fileUrl(resolved) : '', alias || target) }).range(a, b))
        continue
      }
      // [[ target#heading | alias ]] -> show alias, else target#heading
      const inner0 = a + 2 + (bang ? 1 : 0)
      const pipeAt = alias != null ? b - 2 - alias.length - 1 : -1
      if (alias != null) {
        hide(a, pipeAt + 1)
        mark(pipeAt + 1, b - 2, cls, attrs)
      } else {
        hide(a, inner0)
        mark(inner0, b - 2, cls, attrs)
      }
      hide(b - 2, b)
    }
    TAG_RE.lastIndex = 0
    for (let m; (m = TAG_RE.exec(text));) {
      const a = from + m.index + m[1].length
      const b = a + m[2].length
      if (inRanges(code, a, b) || inRanges(linkSpans, a, b) || (fmEnd > 0 && a < fmEnd)) continue
      const line = state.doc.lineAt(a)
      if (a === line.from && /^#{1,6}\s/.test(line.text)) continue // heading mark, not a tag
      mark(a, b, 'nk-cm-tag', { 'data-tag': m[2].slice(1) })
    }
  }
  return Decoration.set(decos, true)
}

/** Block widget for collapsed frontmatter (must come from a state field). */
function frontmatterField(getOpts) {
  const build = (state) => {
    const fmEnd = frontmatterEnd(state.doc)
    if (fmEnd <= 0 || !getOpts().live || touches(state, 0, fmEnd)) return Decoration.none
    return Decoration.set([Decoration.replace({ widget: new PropsWidget(state.doc.sliceString(4, Math.max(4, fmEnd - 4))), block: true }).range(0, fmEnd)])
  }
  return StateField.define({
    create: build,
    update: (v, tr) => (tr.docChanged || tr.selection || tr.reconfigured ? build(tr.state) : v),
    provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.from(f)],
  })
}

/**
 * The live-preview extension set.
 * @param {() => { live: boolean, resolve: Function, fileUrl: Function }} getOpts
 */
export function livePreview(getOpts) {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = buildDecorations(view, getOpts()) }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.transactions.some((t) => t.reconfigured) || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildDecorations(u.view, getOpts())
      }
    }
  }, {
    decorations: (v) => v.decorations,
    provide: (p) => EditorView.atomicRanges.of((view) => {
      const inst = view.plugin(p)
      if (!inst) return Decoration.none
      // Only replaced (hidden) ranges are atomic.
      const out = []
      inst.decorations.between(0, view.state.doc.length, (f, t, d) => { if (d.spec && !d.spec.class && !d.spec.attributes && f < t) out.push(Decoration.replace({}).range(f, t)) })
      return Decoration.set(out, true)
    }),
  })
  return [plugin, frontmatterField(getOpts)]
}

/**
 * Click handling: open links/tags, toggle checkboxes.
 * @param {() => { live: boolean }} getOpts
 * @param {{ onOpenLink: Function, onTag: Function, onHref: Function }} handlers
 */
export function clickHandlers(getOpts, handlers) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      const t = e.target
      if (!(t instanceof Element)) return false
      if (t.matches('input.nk-cm-task')) {
        e.preventDefault()
        const pos = Number(t.dataset.taskPos)
        const cur = view.state.doc.sliceString(pos, pos + 3)
        if (/^\[[ xX]\]$/.test(cur)) view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: cur[1] === ' ' ? 'x' : ' ' } })
        return true
      }
      const live = getOpts().live
      const mod = e.metaKey || e.ctrlKey
      if (!live && !mod) return false
      if (e.button !== 0) return false
      const el = t.closest('[data-target],[data-tag],[data-href]')
      if (!el) return false
      e.preventDefault()
      if (el.dataset.target != null) handlers.onOpenLink(el.dataset.target)
      else if (el.dataset.tag != null) handlers.onTag(el.dataset.tag)
      else if (el.dataset.href) handlers.onHref(el.dataset.href)
      return true
    },
  })
}
