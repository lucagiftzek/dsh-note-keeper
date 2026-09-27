/**
 * Markdown rendering with Obsidian syntax: [[wikilinks|alias]], ![[embeds]]
 * (images, audio, video, pdf, notes), #tags, > [!callouts], task lists and
 * GFM tables. Output is always sanitised with DOMPurify before it reaches the
 * DOM, and embedded media may only point at this plugin's own file route.
 */
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { fileUrl } from './api.js'

const IMG = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i
const AUDIO = /\.(mp3|wav|ogg|oga|m4a|webm|weba|flac|opus)$/i
const VIDEO = /\.(mp4|mov|mkv)$/i
const PDF = /\.pdf$/i

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** Split "---" frontmatter from the body; returns { props, body }. */
export function splitFrontmatter(src) {
  const m = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!m) return { props: null, raw: '', body: src }
  const props = {}
  let cur = null
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && cur) { (props[cur] = Array.isArray(props[cur]) ? props[cur] : []).push(item[1].replace(/^["']|["']$/g, '')); continue }
    const kv = /^([^\s:][^:]*):\s*(.*)$/.exec(line)
    if (kv) {
      cur = kv[1].trim()
      let v = kv[2].trim()
      if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      else v = v.replace(/^["'](.*)["']$/, '$1')
      props[cur] = v === '' ? [] : v
    }
  }
  return { props, raw: m[0], body: src.slice(m[0].length) }
}

/**
 * Create a renderer bound to a link resolver.
 * @param {(target:string)=>string|null} resolve  vault path for a link target
 */
export function createRenderer(resolve) {
  const marked = new Marked({ gfm: true, breaks: false })
  marked.use({
    extensions: [
      {
        name: 'nkEmbed', level: 'inline',
        start: (src) => src.indexOf('![['),
        tokenizer(src) {
          const m = /^!\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/.exec(src)
          if (m) return { type: 'nkEmbed', raw: m[0], target: m[1].trim(), size: m[3] || '' }
        },
        renderer(t) {
          const direct = resolve(t.target)
          const sealed = direct ? null : resolve(t.target + '.nkenc')
          if (sealed) {
            // Encrypted attachment: the view decrypts it into a blob URL.
            const tag = IMG.test(t.target) ? 'img' : AUDIO.test(t.target) ? 'audio' : VIDEO.test(t.target) ? 'video' : null
            if (tag === 'img') return '<img class="nk-embed-img nk-sealed" data-nk-sealed="' + esc(sealed) + '" alt="' + esc(t.target) + '">'
            if (tag) return '<' + tag + ' class="nk-embed-' + (tag === 'audio' ? 'audio' : 'video') + ' nk-sealed" controls data-nk-sealed="' + esc(sealed) + '"></' + tag + '>'
            return '<a class="nk-wikilink" data-target="' + esc(sealed) + '" href="#">' + esc(t.target) + ' (encrypted)</a>'
          }
          const path = direct || t.target
          const url = fileUrl(path)
          const w = /^\d+$/.test(t.size) ? ' width="' + t.size + '"' : ''
          if (IMG.test(path)) return '<img class="nk-embed-img" src="' + esc(url) + '" alt="' + esc(t.target) + '"' + w + ' loading="lazy">'
          if (AUDIO.test(path)) return '<audio class="nk-embed-audio" controls preload="metadata" src="' + esc(url) + '"></audio>'
          if (VIDEO.test(path)) return '<video class="nk-embed-video" controls preload="metadata" src="' + esc(url) + '"></video>'
          if (PDF.test(path)) return '<a class="nk-embed-file" href="' + esc(url) + '" target="_blank" rel="noopener">PDF: ' + esc(t.target) + '</a>'
          return '<a class="nk-wikilink nk-embed-note" data-target="' + esc(t.target) + '" href="#">' + esc(t.target) + '</a>'
        },
      },
      {
        name: 'nkWiki', level: 'inline',
        start: (src) => src.indexOf('[['),
        tokenizer(src) {
          const m = /^\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/.exec(src)
          if (m) return { type: 'nkWiki', raw: m[0], target: m[1].trim(), heading: m[2] || '', alias: m[3] }
        },
        renderer(t) {
          const exists = Boolean(resolve(t.target))
          const label = t.alias || (t.target + (t.heading ? ' > ' + t.heading.slice(1) : ''))
          return '<a class="nk-wikilink' + (exists ? '' : ' nk-unresolved') + '" data-target="' + esc(t.target) + '" href="#">' + esc(label) + '</a>'
        },
      },
      {
        name: 'nkTag', level: 'inline',
        start(src) { const m = /(^|[\s(])#[\p{L}\p{N}_/-]/u.exec(src); return m ? m.index + m[1].length : undefined },
        tokenizer(src) {
          const m = /^#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/u.exec(src)
          if (m) return { type: 'nkTag', raw: m[0], tag: m[1] }
        },
        renderer(t) { return '<a class="nk-tag" data-tag="' + esc(t.tag) + '" href="#">#' + esc(t.tag) + '</a>' },
      },
    ],
    renderer: {
      // Obsidian callouts: > [!note] Title
      blockquote(token) {
        const body = this.parser.parse(token.tokens)
        const m = /^<p>\[!(\w+)\][+-]?\s*([^\n<]*)/.exec(body)
        if (!m) return '<blockquote>' + body + '</blockquote>'
        const kind = m[1].toLowerCase()
        const rest = body.slice(m[0].length).replace(/^\s*(<br>)?\n?/, '<p>')
        return '<div class="nk-callout nk-callout-' + esc(kind) + '"><div class="nk-callout-title">' + esc(m[2] || kind) + '</div>' + (rest === '<p></p>' ? '' : rest) + '</div>'
      },
      // Task list checkboxes become clickable (index recorded for toggling).
      checkbox({ checked }) {
        return '<input type="checkbox" class="nk-task"' + (checked ? ' checked' : '') + '>'
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens)
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
          return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + text + '</a>'
        }
        const target = decodeURIComponent(href.split('#')[0])
        return '<a class="nk-wikilink" data-target="' + esc(target) + '" href="#">' + text + '</a>'
      },
      image({ href, text }) {
        const external = /^[a-z][a-z0-9+.-]*:/i.test(href)
        const src = external ? href : fileUrl(resolve(decodeURIComponent(href)) || decodeURIComponent(href))
        return '<img class="nk-embed-img" src="' + esc(src) + '" alt="' + esc(text) + '" loading="lazy">'
      },
    },
  })
  return (src) => {
    const { body } = splitFrontmatter(src)
    const html = marked.parse(body)
    return DOMPurify.sanitize(html, {
      ADD_ATTR: ['target', 'data-target', 'data-tag', 'controls', 'preload', 'loading'],
      ADD_TAGS: ['audio', 'video'],
      FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed'],
      // Only http(s)/mailto/blob schemes; scheme-less values (relative URLs,
      // and plain attribute values such as type="checkbox") pass, while
      // javascript:, data: and every other scheme are stripped.
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    })
  }
}

/** Toggle the n-th Markdown task checkbox in source text. */
export function toggleTask(src, n) {
  let i = -1
  return src.replace(/^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/gm, (m, a, c, b) => {
    i += 1
    if (i !== n) return m
    return a + (c === ' ' ? 'x' : ' ') + b
  })
}

/** Headings for the outline pane. */
export function outline(src) {
  const { body } = splitFrontmatter(src)
  const out = []
  let fence = false
  for (const line of body.split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) out.push({ level: m[1].length, text: m[2] })
  }
  return out
}

/** Word / character counts for the status bar (frontmatter excluded). */
export function counts(src) {
  const { body } = splitFrontmatter(src)
  const words = (body.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length
  return { words, chars: body.length, minutes: Math.max(1, Math.round(words / 220)) }
}

/** Set (or add) one frontmatter key, keeping everything else intact. */
export function setFrontmatterKey(src, key, value) {
  const line = key + ': ' + value
  const { raw, body } = splitFrontmatter(src)
  if (!raw) return '---\n' + line + '\n---\n' + src
  const inner = raw.replace(/^\ufeff?---\r?\n/, '').replace(/\r?\n---\r?\n?$/, '')
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':.*(?:\n\\s+-.*)*', 'm')
  const next = re.test(inner) ? inner.replace(re, line) : inner + '\n' + line
  return '---\n' + next + '\n---\n' + body
}
