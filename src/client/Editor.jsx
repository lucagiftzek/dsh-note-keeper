/**
 * Markdown editor: source textarea with a formatting toolbar, live preview
 * (split / preview-only), clickable wikilinks, tags and task checkboxes,
 * paste/drag-and-drop attachments, and Obsidian-style [[ autocompletion.
 */
import * as React from 'react'
import { IBtn } from './ui.jsx'
import { splitFrontmatter, toggleTask } from './markdown.js'

const { useRef, useMemo, useState, useEffect, useCallback } = React

/** Wrap/insert helpers operating on a textarea selection. Pure. */
export function applyFormat(text, start, end, kind) {
  const sel = text.slice(start, end)
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const wrap = (a, b = a, ph = 'text') => {
    const inner = sel || ph
    return { text: text.slice(0, start) + a + inner + b + text.slice(end), start: start + a.length, end: start + a.length + inner.length }
  }
  const prefixLines = (p) => {
    const endLine = text.indexOf('\n', end) < 0 ? text.length : text.indexOf('\n', end)
    const block = text.slice(lineStart, endLine)
    const next = block.split('\n').map((l) => (l.startsWith(p) ? l.slice(p.length) : p + l)).join('\n')
    return { text: text.slice(0, lineStart) + next + text.slice(endLine), start: lineStart, end: lineStart + next.length }
  }
  switch (kind) {
    case 'bold': return wrap('**')
    case 'italic': return wrap('*')
    case 'code': return sel.includes('\n') ? wrap('\n```\n', '\n```\n', 'code') : wrap('`')
    case 'link': return wrap('[[', ']]', 'Note')
    case 'h': return prefixLines('## ')
    case 'list': return prefixLines('- ')
    case 'task': return prefixLines('- [ ] ')
    case 'quote': return prefixLines('> ')
    case 'table': {
      const t = '\n| Column | Column |\n| --- | --- |\n| | |\n'
      return { text: text.slice(0, end) + t + text.slice(end), start: end + 3, end: end + 9 }
    }
    default: return { text, start, end }
  }
}

/** Insert text at the caret (used for attachments and drawings). */
export function insertAt(text, pos, snippet) {
  const before = text.slice(0, pos)
  const pad = before && !before.endsWith('\n') ? '\n' : ''
  return { text: before + pad + snippet + '\n' + text.slice(pos), pos: pos + pad.length + snippet.length + 1 }
}

export function Editor({ text, setText, mode, render, onOpenLink, onTag, onUpload, linkTargets, readOnly, onSaveNow }) {
  const ta = useRef(null)
  const pv = useRef(null)
  const [drag, setDrag] = useState(false)
  const [suggest, setSuggest] = useState(null) // { q, at, items, i }
  const html = useMemo(() => (mode === 'edit' ? '' : render(text)), [text, mode, render])
  const props = useMemo(() => splitFrontmatter(text).props, [text])

  const fmt = (kind) => {
    const el = ta.current
    if (!el) return
    const r = applyFormat(text, el.selectionStart, el.selectionEnd, kind)
    setText(r.text)
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(r.start, r.end) })
  }

  const insert = useCallback((snippet) => {
    const el = ta.current
    const pos = el ? el.selectionEnd : text.length
    const r = insertAt(text, pos, snippet)
    setText(r.text)
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(r.pos, r.pos) } })
  }, [text, setText])

  const uploadFiles = async (files) => {
    const list = Array.from(files || [])
    if (!list.length || !onUpload) return
    const snippets = []
    for (const f of list) {
      const s = await onUpload(f)
      if (s) snippets.push(s)
    }
    if (snippets.length) insert(snippets.join('\n'))
  }

  // Clicks inside the rendered preview: links, tags, task boxes.
  const onPreviewClick = (e) => {
    const a = e.target.closest && e.target.closest('a')
    if (e.target.classList && e.target.classList.contains('nk-task')) {
      e.preventDefault()
      if (readOnly) return
      const boxes = Array.from(pv.current.querySelectorAll('input.nk-task'))
      const n = boxes.indexOf(e.target)
      if (n >= 0) setText(toggleTask(text, n))
      return
    }
    if (!a) return
    if (a.dataset.target) { e.preventDefault(); onOpenLink(a.dataset.target) } else if (a.dataset.tag) { e.preventDefault(); onTag(a.dataset.tag) }
  }

  // [[ autocompletion.
  const onInput = (e) => {
    const v = e.target.value
    setText(v)
    const pos = e.target.selectionStart
    const lineBefore = v.slice(v.lastIndexOf('\n', pos - 1) + 1, pos)
    const m = /\[\[([^\]|#\n]*)$/.exec(lineBefore)
    if (m && linkTargets) {
      const q = m[1].toLowerCase()
      const items = linkTargets.filter((t) => t.toLowerCase().includes(q)).slice(0, 8)
      setSuggest(items.length ? { at: pos - m[1].length, q: m[1], items, i: 0 } : null)
    } else if (suggest) setSuggest(null)
  }
  const accept = (item) => {
    const el = ta.current
    const pos = el.selectionStart
    const next = text.slice(0, suggest.at) + item + ']]' + text.slice(pos).replace(/^\]\]/, '')
    setText(next)
    setSuggest(null)
    const c = suggest.at + item.length + 2
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(c, c) })
  }
  const onKeyDown = (e) => {
    if (suggest) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSuggest({ ...suggest, i: (suggest.i + 1) % suggest.items.length }); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSuggest({ ...suggest, i: (suggest.i + suggest.items.length - 1) % suggest.items.length }); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(suggest.items[suggest.i]); return }
      if (e.key === 'Escape') { setSuggest(null); return }
    }
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); fmt('bold') }
    else if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); fmt('italic') }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); onSaveNow && onSaveNow() }
    else if (e.key === 'Tab' && !mod) {
      // Indent/outdent list items instead of leaving the textarea.
      e.preventDefault()
      const el = e.target
      const s = el.selectionStart
      const ls = text.lastIndexOf('\n', s - 1) + 1
      if (e.shiftKey) {
        if (text.startsWith('  ', ls)) { setText(text.slice(0, ls) + text.slice(ls + 2)); requestAnimationFrame(() => el.setSelectionRange(Math.max(ls, s - 2), Math.max(ls, s - 2))) }
      } else {
        setText(text.slice(0, ls) + '  ' + text.slice(ls))
        requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2))
      }
    } else if (e.key === 'Enter' && !mod) {
      // Continue lists and tasks.
      const el = e.target
      const s = el.selectionStart
      const ls = text.lastIndexOf('\n', s - 1) + 1
      const line = text.slice(ls, s)
      const m = /^(\s*)([-*+]|\d+\.)(\s+\[[ xX]\])?\s+(.*)$/.exec(line)
      if (m) {
        e.preventDefault()
        if (!m[4]) { setText(text.slice(0, ls) + text.slice(s)); requestAnimationFrame(() => el.setSelectionRange(ls, ls)); return }
        const bullet = /\d+\./.test(m[2]) ? (parseInt(m[2], 10) + 1) + '.' : m[2]
        const ins = '\n' + m[1] + bullet + (m[3] ? ' [ ]' : '') + ' '
        setText(text.slice(0, s) + ins + text.slice(el.selectionEnd))
        requestAnimationFrame(() => el.setSelectionRange(s + ins.length, s + ins.length))
      }
    }
  }

  useEffect(() => { if (mode !== 'preview' && ta.current && !readOnly) ta.current.focus() }, [mode])

  return (
    <>
      {mode !== 'preview' && !readOnly ? (
        <div className="nk-toolbar" role="toolbar" aria-label="Formatting">
          <IBtn icon="bold" title="Bold (Ctrl+B)" onClick={() => fmt('bold')} />
          <IBtn icon="italic" title="Italic (Ctrl+I)" onClick={() => fmt('italic')} />
          <IBtn icon="h" title="Heading" onClick={() => fmt('h')} />
          <span className="nk-sep" />
          <IBtn icon="list" title="Bullet list" onClick={() => fmt('list')} />
          <IBtn icon="task" title="Task" onClick={() => fmt('task')} />
          <IBtn icon="quote" title="Quote / callout" onClick={() => fmt('quote')} />
          <IBtn icon="table" title="Table" onClick={() => fmt('table')} />
          <IBtn icon="code" title="Code" onClick={() => fmt('code')} />
          <IBtn icon="link" title="Link to note [[ ]]" onClick={() => fmt('link')} />
          <span className="nk-sep" />
          <label className="nk-ibtn" title="Attach files" aria-label="Attach files" style={{ cursor: 'pointer' }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M11 5l-5.5 5.5a1.5 1.5 0 0 0 2 2L13 7a3 3 0 0 0-4-4L3.5 8.5a4.5 4.5 0 0 0 6 6L14 10" /></svg>
            <input type="file" multiple hidden onChange={(e) => { uploadFiles(e.target.files); e.target.value = '' }} />
          </label>
        </div>
      ) : null}
      <div className={'nk-editwrap' + (mode === 'split' ? ' nk-split' : '') + (drag ? ' nk-dropzone' : '')}
        onDragOver={(e) => { if (!readOnly && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true) } }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { if (readOnly || !e.dataTransfer.files.length) return; e.preventDefault(); setDrag(false); uploadFiles(e.dataTransfer.files) }}>
        {mode !== 'preview' ? (
          <div style={{ position: 'relative', minHeight: 0 }}>
            <textarea ref={ta} className="nk-textarea" value={text} onChange={onInput} onKeyDown={onKeyDown} spellCheck
              readOnly={readOnly} aria-label="Note source"
              onPaste={(e) => { if (e.clipboardData && e.clipboardData.files.length) { e.preventDefault(); uploadFiles(e.clipboardData.files) } }} />
            {suggest ? (
              <div className="nk-menu" style={{ position: 'absolute', left: 20, bottom: 12, top: 'auto' }} role="listbox">
                {suggest.items.map((it, i) => (
                  <button key={it} type="button" style={i === suggest.i ? { background: 'color-mix(in srgb,var(--nk-accent) 16%,transparent)' } : undefined}
                    onMouseDown={(e) => { e.preventDefault(); accept(it) }}>{it}</button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {mode !== 'edit' ? (
          <div className="nk-preview" ref={pv} onClick={onPreviewClick}>
            {props && Object.keys(props).length ? (
              <div className="nk-props">{Object.entries(props).filter(([k]) => !k.startsWith('nk-')).map(([k, v]) => (
                <div key={k}><b>{k}</b><span>{Array.isArray(v) ? v.join(', ') : String(v)}</span></div>
              ))}</div>
            ) : null}
            <div className="nk-md" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        ) : null}
      </div>
    </>
  )
}
