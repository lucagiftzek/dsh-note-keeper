/**
 * Markdown editor built on CodeMirror 6.
 *
 * Modes:
 *   live    - Obsidian-style live preview: [[links]], [md](links) and #tags
 *             render as clickable links/pills while typing (default);
 *   edit    - plain source with syntax colouring (Ctrl/Cmd+click opens links);
 *   split   - source + rendered preview side by side;
 *   preview - rendered reading view.
 * Plus: formatting toolbar, [[ and # autocompletion, list continuation,
 * paste/drag-and-drop attachments.
 */
import * as React from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder, drawSelection, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle, indentUnit } from '@codemirror/language'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'
import { IBtn } from './ui.jsx'
import { splitFrontmatter, toggleTask } from './markdown.js'
import { livePreview, clickHandlers } from './cm/livepreview.js'

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


/** Smallest single change turning a into b (keeps undo history meaningful). */
export function minimalChange(a, b) {
  let s = 0
  const n = Math.min(a.length, b.length)
  while (s < n && a.charCodeAt(s) === b.charCodeAt(s)) s++
  let e = 0
  while (e < n - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) }
}

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700', color: 'var(--nk-fg)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.monospace, fontFamily: 'var(--nk-mono)', color: 'var(--nk-accent-2)' },
  { tag: t.quote, color: 'var(--nk-fg2)' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--nk-fg3)' },
  { tag: t.url, color: 'var(--nk-fg3)' },
  { tag: t.link, color: 'var(--nk-accent)' },
])

/** Autocomplete: [[note titles]] and #tags. */
function completions(getLists) {
  return (ctx) => {
    const { linkTargets = [], tagList = [] } = getLists()
    const link = ctx.matchBefore(/\[\[[^\]|#\n]*$/)
    if (link) {
      const q = link.text.slice(2).toLowerCase()
      const after = ctx.state.doc.sliceString(ctx.pos, ctx.pos + 2)
      const options = linkTargets.filter((x) => x.toLowerCase().includes(q)).slice(0, 50).map((label) => ({
        label, type: 'text', apply: (view, c, from, to) => {
          const ins = label + (after === ']]' ? '' : ']]')
          view.dispatch({ changes: { from, to, insert: ins }, selection: { anchor: from + label.length + 2 } })
        },
      }))
      return { from: link.from + 2, options, filter: false }
    }
    const tag = ctx.matchBefore(/(?:^|\s)#[\p{L}\p{N}_/-]*$/u)
    if (tag && tagList.length) {
      const hash = tag.text.lastIndexOf('#')
      const q = tag.text.slice(hash + 1).toLowerCase()
      const options = tagList.filter((x) => x.toLowerCase().startsWith(q)).slice(0, 50).map((label) => ({ label, type: 'keyword' }))
      return options.length ? { from: tag.from + hash + 1, options, filter: false } : null
    }
    return null
  }
}

export function Editor({ text, setText, mode, render, onOpenLink, onTag, onUpload, linkTargets, tagList, readOnly, onSaveNow, resolve, fileUrl }) {
  const host = useRef(null)
  const viewRef = useRef(null)
  const pv = useRef(null)
  const [drag, setDrag] = useState(false)
  const html = useMemo(() => (mode === 'edit' || mode === 'live' ? '' : render(text)), [text, mode, render])
  const props = useMemo(() => splitFrontmatter(text).props, [text])
  const showSource = mode !== 'preview'

  // Everything the CM extensions read lives in a ref so the editor is built once.
  const live = useRef({})
  live.current = {
    live: mode === 'live',
    resolve: resolve || (() => null),
    fileUrl: fileUrl || ((p) => p),
    linkTargets, tagList, setText, onOpenLink, onTag, onSaveNow,
  }
  const modeComp = useRef(new Compartment())
  const roComp = useRef(new Compartment())

  const fmt = useCallback((kind) => {
    const view = viewRef.current
    if (!view) return
    const doc = view.state.doc.toString()
    const sel = view.state.selection.main
    const r = applyFormat(doc, sel.from, sel.to, kind)
    view.dispatch({ changes: minimalChange(doc, r.text), selection: { anchor: r.start, head: r.end }, scrollIntoView: true })
    view.focus()
  }, [])

  const insert = useCallback((snippet) => {
    const view = viewRef.current
    if (!view) { setText(insertAt(text, text.length, snippet).text); return }
    const doc = view.state.doc.toString()
    const r = insertAt(doc, view.state.selection.main.head, snippet)
    view.dispatch({ changes: minimalChange(doc, r.text), selection: { anchor: r.pos }, scrollIntoView: true })
    view.focus()
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
  const uploadRef = useRef(uploadFiles)
  uploadRef.current = uploadFiles

  // Build the editor once per mount of the source pane.
  useEffect(() => {
    if (!showSource || !host.current) return undefined
    const L = () => live.current
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        // Start below the frontmatter so live preview shows it as a property strip.
        selection: { anchor: Math.min(text.length, (/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(text) || [''])[0].length) },
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          indentUnit.of('  '),
          markdown({ base: markdownLanguage, addKeymap: false, completeHTMLTags: false }),
          syntaxHighlighting(highlight),
          autocompletion({ override: [completions(() => L())], icons: false }),
          keymap.of([
            { key: 'Mod-b', run: () => { fmt('bold'); return true } },
            { key: 'Mod-i', run: () => { fmt('italic'); return true } },
            { key: 'Mod-k', run: () => { fmt('link'); return true } },
            { key: 'Mod-s', run: () => { L().onSaveNow && L().onSaveNow(); return true } },
            ...markdownKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap,
          ]),
          cmPlaceholder('Start writing… [[ links a note, # adds a tag'),
          modeComp.current.of(EditorView.editorAttributes.of({ class: mode === 'live' ? 'nk-cm-live' : 'nk-cm-source' })),
          roComp.current.of([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]),
          livePreview(() => L()),
          clickHandlers(() => L(), {
            onOpenLink: (x) => L().onOpenLink && L().onOpenLink(x),
            onTag: (x) => L().onTag && L().onTag(x),
            onHref: (href) => { if (/^https?:|^mailto:/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer') },
          }),
          EditorView.domEventHandlers({
            paste(e) { if (e.clipboardData && e.clipboardData.files.length) { e.preventDefault(); uploadRef.current(e.clipboardData.files); return true } return false },
          }),
          EditorView.updateListener.of((u) => { if (u.docChanged) L().setText(u.state.doc.toString()) }),
          EditorView.contentAttributes.of({ 'aria-label': 'Note editor', spellcheck: 'true' }),
        ],
      }),
    })
    view.dom.nkView = view // test/debug handle
    viewRef.current = view
    if (!readOnly) view.focus()
    return () => { view.destroy(); viewRef.current = null }
  }, [showSource])

  // External text changes (task toggles in preview, AI Enhance, conflict reloads).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const cur = view.state.doc.toString()
    if (cur !== text) view.dispatch({ changes: minimalChange(cur, text) })
  }, [text])

  // Mode / read-only switches reconfigure without rebuilding the editor.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: [
      modeComp.current.reconfigure(EditorView.editorAttributes.of({ class: mode === 'live' ? 'nk-cm-live' : 'nk-cm-source' })),
      roComp.current.reconfigure([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]),
    ] })
  }, [mode, readOnly])

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

  return (
    <>
      {showSource && !readOnly ? (
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
          <IBtn icon="link" title="Link to note [[ ]] (Ctrl+K)" onClick={() => fmt('link')} />
          <span className="nk-sep" />
          <label className="nk-ibtn" title="Attach files" aria-label="Attach files" style={{ cursor: 'pointer' }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M11 5l-5.5 5.5a1.5 1.5 0 0 0 2 2L13 7a3 3 0 0 0-4-4L3.5 8.5a4.5 4.5 0 0 0 6 6L14 10" /></svg>
            <input type="file" multiple hidden onChange={(e) => { uploadFiles(e.target.files); e.target.value = '' }} />
          </label>
          <span className="nk-toolbar-hint">{mode === 'live' ? 'Live preview: click a link or tag to open it' : 'Source: Ctrl/Cmd+click opens links'}</span>
        </div>
      ) : null}
      <div className={'nk-editwrap' + (mode === 'split' ? ' nk-split' : '') + (drag ? ' nk-dropzone' : '')}
        onDragOver={(e) => { if (!readOnly && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true) } }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { if (readOnly || !e.dataTransfer.files.length) return; e.preventDefault(); setDrag(false); uploadFiles(e.dataTransfer.files) }}>
        {showSource ? <div className="nk-cm" ref={host} /> : null}
        {mode === 'split' || mode === 'preview' ? (
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
