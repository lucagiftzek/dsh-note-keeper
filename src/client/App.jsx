/**
 * Note Keeper main page. Owns the vault model (tree, open note, key ring),
 * wires live sync events, and routes between the views: note editor,
 * attachment viewer, search, graph, audio recorder and paint canvas.
 */
import * as React from 'react'
import { api, subscribe, transcribe, polish, fileUrl, ApiError } from './api.js'
import { KeyRing, parseEnvelope, sealNote, openNote, deriveKey, randomBytes, unb64, makeFolderMarker, unlockFolderKey, sealBlob, openBlob, ITERATIONS } from './crypto.js'
import { createRenderer, outline, counts, splitFrontmatter } from './markdown.js'
import { buildTree, visibleRows, makeResolver, fileKind, lockedScopeOf, stem, dirOf, baseOf, fmtBytes, fmtAgo } from './tree.js'
import { Icon, IBtn, Modal, PromptDialog, ConfirmDialog, Menu, EncryptDialog, UnlockDialog } from './ui.jsx'
import { Editor } from './Editor.jsx'
import { Recorder } from './Recorder.jsx'
import { PaintEditor } from './Paint.jsx'
import { GraphView } from './Graph.jsx'
import { AiEnhanceButton } from './AiEnhance.jsx'
import { ConnectDialog } from './Connect.jsx'
import { ImportDialog } from './Import.jsx'

const { useState, useEffect, useRef, useMemo, useCallback } = React

const EXPANDED_KEY = 'dsh.note-keeper.expanded'
const MODE_KEY = 'dsh.note-keeper.mode'
const LAST_KEY = 'dsh.note-keeper.last'

/** Same rules as the daemon's SafeTitle: an Obsidian-safe file stem. */
export function safeTitle(t) {
  let s = String(t || '').replace(/[\\/:*?"<>|#^[\]\x00-\x1f]+/g, ' ').split(/\s+/).filter(Boolean).join(' ').replace(/^\.+/, '')
  if ([...s].length > 120) s = [...s].slice(0, 120).join('')
  return s || 'Untitled'
}

const stamp = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0')
const load = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v) } catch { return d } }
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* storage blocked */ } }
const errText = (e) => (e instanceof ApiError ? e.message : String((e && e.message) || e))
const yamlStr = (s) => JSON.stringify(String(s))

export function App() {
  const ring = useRef(null)
  if (!ring.current) ring.current = new KeyRing()
  const [, bump] = useState(0)
  const [tree, setTree] = useState({ entries: [], locked: [], root: '' })
  const [status, setStatus] = useState(null)
  const [view, setView] = useState({ kind: 'home' })
  const [note, setNote] = useState(null) // { path, mtime, env, keyId, locked, text, saved, conflict, error }
  // v0.2: live preview is the default; users who picked a mode keep it.
  const [mode, setModeState] = useState(() => { const m = load(MODE_KEY, 'live'); return ['live', 'edit', 'split', 'preview'].includes(m) ? m : 'live' })
  const [saveState, setSaveState] = useState('')
  const [expanded, setExpanded] = useState(() => new Set(load(EXPANDED_KEY, [])))
  const [sideTab, setSideTab] = useState('files')
  const [tags, setTags] = useState([])
  const [recent, setRecent] = useState([])
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [hits, setHits] = useState([])
  const [dialog, setDialog] = useState(null)
  const [menu, setMenu] = useState(null)
  const [toast, setToast] = useState(null)
  const [busy, setBusy] = useState(false)
  const [graph, setGraph] = useState(null)
  const [graphTags, setGraphTags] = useState(false)
  const [dropTarget, setDropTarget] = useState(null)
  const [showSide, setShowSide] = useState(false)
  const noteRef = useRef(null)
  noteRef.current = note
  const searchRef = useRef(null)

  const setMode = (m) => { setModeState(m); store(MODE_KEY, m) }
  const say = useCallback((text, err) => { setToast({ text, err }); clearTimeout(say.t); say.t = setTimeout(() => setToast(null), err ? 6000 : 2600) }, [])

  // ---- vault model -----------------------------------------------------------
  const loadTree = useCallback(async () => {
    try { const t = await api.tree(); setTree({ entries: t.entries || [], locked: t.locked || [], root: t.root || '' }) } catch (e) { say('Could not load the vault: ' + errText(e), true) }
  }, [say])
  const loadSide = useCallback(async () => {
    try { const [t, r] = await Promise.all([api.tags(), api.recent(40)]); setTags(t.tags || []); setRecent(r.notes || []) } catch { /* shown by tree */ }
  }, [])
  useEffect(() => {
    loadTree(); loadSide()
    api.status().then(setStatus).catch(() => {})
    const unRing = ring.current.subscribe(() => bump((n) => n + 1))
    const sweep = setInterval(() => ring.current.sweep(), 30000)
    let t = null
    const unsub = subscribe((ev) => {
      clearTimeout(t)
      t = setTimeout(() => { loadTree(); loadSide() }, 250)
      const cur = noteRef.current
      if (cur && ev.paths && ev.paths.includes(cur.path)) refreshOpen(cur.path)
    })
    return () => { unsub(); unRing(); clearInterval(sweep); clearTimeout(t) }
  }, [])

  const paths = useMemo(() => tree.entries.filter((e) => !e.dir).map((e) => e.path), [tree])
  const byPath = useMemo(() => new Map(tree.entries.map((e) => [e.path, e])), [tree])
  const root = useMemo(() => buildTree(tree.entries), [tree])
  const rows = useMemo(() => visibleRows(root, expanded), [root, expanded])
  const resolve = useMemo(() => makeResolver(paths, note ? note.path : ''), [paths, note && note.path])
  const render = useMemo(() => createRenderer(resolve), [resolve])
  const tagList = useMemo(() => tags.map((t) => t.tag), [tags])
  const linkTargets = useMemo(() => paths.filter((p) => p.endsWith('.md')).map((p) => stem(p)).sort(), [paths])
  const lockedOf = (p) => lockedScopeOf(p, tree.locked)

  const toggleDir = (p, open) => {
    setExpanded((s) => {
      const n = new Set(s)
      if (open === true || (open === undefined && !n.has(p))) n.add(p); else n.delete(p)
      store(EXPANDED_KEY, [...n])
      return n
    })
  }
  const reveal = (p) => {
    const parts = dirOf(p).split('/').filter(Boolean)
    setExpanded((s) => { const n = new Set(s); let acc = ''; for (const x of parts) { acc = acc ? acc + '/' + x : x; n.add(acc) } store(EXPANDED_KEY, [...n]); return n })
  }

  // ---- keys ----------------------------------------------------------------
  const keyIdFor = (path, env) => (env && env.scope === 'folder' && lockedOf(path) !== null ? 'folder:' + lockedOf(path) : 'note:' + path)
  /** Ensure the folder key is in the ring (prompting if needed). */
  const needFolderKey = (folder) => new Promise((resolveKey, rejectKey) => {
    const have = ring.current.get('folder:' + folder)
    if (have) return resolveKey(have.key)
    api.lockInfo(folder).then((info) => {
      if (!info.locked) return rejectKey(new Error('folder is not encrypted'))
      const attempt = async (pw) => {
        setDialog((d) => ({ ...d, busy: true, error: '' }))
        try {
          const key = await unlockFolderKey(pw, info.marker)
          ring.current.set('folder:' + info.scope, key, { salt: unb64(info.marker.salt), iter: info.marker.iter, hint: info.marker.hint })
          setDialog(null)
          resolveKey(key)
        } catch (e) { setDialog((d) => ({ ...d, busy: false, error: errText(e) })) }
      }
      setDialog({ type: 'unlock', target: (info.scope || 'vault') + '/ (encrypted folder)', hint: info.marker.hint, onOk: attempt, onCancel: () => { setDialog(null); rejectKey(new Error('cancelled')) } })
    }).catch(rejectKey)
  })

  // ---- open / save -----------------------------------------------------------
  const decryptInto = async (path, res, env) => {
    const kid = keyIdFor(path, env)
    const k = ring.current.get(kid)
    if (!k) return { path, mtime: res.mtime, env, keyId: kid, locked: true, text: '', saved: '' }
    try {
      const text = await openNote(k.key, env)
      return { path, mtime: res.mtime, env, keyId: kid, locked: false, text, saved: text }
    } catch (e) {
      return { path, mtime: res.mtime, env, keyId: kid, locked: true, text: '', saved: '', error: errText(e) }
    }
  }

  const openPath = useCallback(async (path, opts = {}) => {
    const cur = noteRef.current
    if (cur && cur.text !== cur.saved && !cur.locked && cur.path !== path) await saveNow()
    setShowSide(false)
    const e = byPath.get(path)
    if (!path.toLowerCase().endsWith('.md')) { setNote(null); setView({ kind: 'file', path }); reveal(path); store(LAST_KEY, path); return }
    try {
      const res = await api.note(path)
      const env = parseEnvelope(res.content)
      const n = env ? await decryptInto(path, res, env) : { path, mtime: res.mtime, env: null, keyId: null, locked: false, text: res.content, saved: res.content }
      n.backlinks = res.backlinks
      n.doc = res.doc
      setNote(n)
      setView({ kind: 'note', path })
      setSaveState('')
      reveal(path)
      store(LAST_KEY, path)
      if (opts.edit && mode === 'preview') setMode('live')
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && e === undefined) say('Not found: ' + path, true)
      else say(errText(err), true)
    }
  }, [byPath])

  // Re-open the last note once the tree is known.
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !tree.entries.length) return
    restored.current = true
    const last = load(LAST_KEY, '')
    if (last && byPath.has(last)) openPath(last)
  }, [tree])

  const refreshOpen = async (path) => {
    const cur = noteRef.current
    if (!cur || cur.path !== path) return
    try {
      if (saving.current) return // our own save is in flight; its result decides
      const res = await api.note(path)
      const now = noteRef.current // the note may have been saved while we fetched
      if (!now || now.path !== path || saving.current) return
      if (res.mtime === now.mtime) return
      if (!now.env && res.content === now.text) { setNote((n) => n && n.path === path ? { ...n, mtime: res.mtime, saved: res.content } : n); return }
      if (now.text !== now.saved) { setNote((n) => n && n.path === path ? { ...n, conflict: { content: res.content, mtime: res.mtime } } : n); return }
      const env = parseEnvelope(res.content)
      const n = env ? await decryptInto(path, res, env) : { path, mtime: res.mtime, env: null, keyId: null, locked: false, text: res.content, saved: res.content }
      n.backlinks = res.backlinks
      n.doc = res.doc
      setNote(n)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { setNote(null); setView({ kind: 'home' }); say('The open note was deleted or moved elsewhere.') }
    }
  }

  /** Serialize the open note for disk (encrypting when required). */
  const serialize = async (n) => {
    const scope = lockedOf(n.path)
    if (n.env || scope !== null) {
      if (n.env && n.env.scope === 'note' && scope === null) {
        const k = ring.current.get(n.keyId)
        if (!k) throw new Error('note is locked - unlock it first')
        return sealNote(k.key, n.text, { scope: 'note', salt: k.extra.salt, iter: k.extra.iter, hint: k.extra.hint })
      }
      const key = await needFolderKey(scope)
      const k = ring.current.get('folder:' + scope)
      return sealNote(key, n.text, { scope: 'folder', salt: k.extra.salt, iter: k.extra.iter })
    }
    return n.text
  }

  const saving = useRef(false)
  const saveNow = useCallback(async (force) => {
    const n = noteRef.current
    if (!n || n.locked || saving.current) return
    if (n.text === n.saved && !force) return
    saving.current = true
    setSaveState('saving')
    try {
      const content = await serialize(n)
      const r = await api.save(n.path, content, force ? 0 : n.mtime)
      setNote((cur) => cur && cur.path === n.path ? { ...cur, mtime: r.mtime, saved: n.text, conflict: null, env: parseEnvelope(content) } : cur)
      setSaveState('saved')
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') {
        setNote((cur) => cur && cur.path === n.path ? { ...cur, conflict: { content: e.body.content, mtime: e.body.mtime } } : cur)
        setSaveState('conflict')
      } else { setSaveState('error'); say('Save failed: ' + errText(e), true) }
    } finally { saving.current = false }
  }, [tree.locked])

  // Autosave 1.2 s after the last keystroke; flush when the page hides.
  useEffect(() => {
    if (!note || note.locked || note.text === note.saved || note.conflict) return
    setSaveState('dirty')
    const t = setTimeout(() => saveNow(), 1200)
    return () => clearTimeout(t)
  }, [note && note.text])
  useEffect(() => {
    const flush = () => { if (document.visibilityState === 'hidden') saveNow() }
    document.addEventListener('visibilitychange', flush)
    const warn = (e) => { const n = noteRef.current; if (n && n.text !== n.saved) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => { document.removeEventListener('visibilitychange', flush); window.removeEventListener('beforeunload', warn) }
  }, [saveNow])

  const setText = useCallback((t) => setNote((n) => (n ? { ...n, text: typeof t === 'function' ? t(n.text) : t } : n)), [])

  const resolveConflict = async (choice) => {
    const n = noteRef.current
    if (!n || !n.conflict) return
    if (choice === 'mine') { setNote({ ...n, mtime: n.conflict.mtime, conflict: null }); setTimeout(() => saveNow(true), 0); return }
    const env = parseEnvelope(n.conflict.content)
    let disk = n.conflict.content
    if (env) { const k = ring.current.get(n.keyId); if (k) disk = await openNote(k.key, env) }
    if (choice === 'theirs') setNote({ ...n, text: disk, saved: disk, mtime: n.conflict.mtime, conflict: null })
    else setNote({ ...n, text: n.text + '\n\n> [!warning] Merge: version from disk\n\n' + disk, saved: disk, mtime: n.conflict.mtime, conflict: null })
  }

  // ---- creation --------------------------------------------------------------
  const currentFolder = () => {
    const p = (view.kind === 'note' || view.kind === 'file') ? view.path : ''
    return p ? dirOf(p) : ''
  }
  /** Create a note, encrypting its first content when the folder is locked. */
  const createNote = async (folder, title, content) => {
    const scope = lockedScopeOf(folder ? folder + '/x.md' : 'x.md', tree.locked)
    let body = content || ''
    if (scope !== null) {
      const key = await needFolderKey(scope)
      const k = ring.current.get('folder:' + scope)
      body = await sealNote(key, body, { scope: 'folder', salt: k.extra.salt, iter: k.extra.iter })
    }
    const r = await api.create(folder, title, body)
    await loadTree()
    return r.path
  }
  const newNote = (folder = currentFolder()) => setDialog({
    type: 'prompt', title: 'New note', label: 'Title' + (folder ? ' (in ' + folder + '/)' : ''), okLabel: 'Create',
    onOk: async (title) => {
      setDialog(null)
      try { const p = await createNote(folder, title, '# ' + title + '\n\n'); await openPath(p, { edit: true }) } catch (e) { if (e.message !== 'cancelled') say(errText(e), true) }
    },
  })
  const newFolder = (parent = currentFolder()) => setDialog({
    type: 'prompt', title: 'New folder', label: 'Folder name' + (parent ? ' (in ' + parent + '/)' : ''), okLabel: 'Create',
    onOk: async (name) => {
      setDialog(null)
      const p = (parent ? parent + '/' : '') + safeTitle(name)
      try { await api.mkdir(p); toggleDir(p, true); if (parent) toggleDir(parent, true); await loadTree() } catch (e) { say(errText(e), true) }
    },
  })
  const openDaily = async () => { try { const r = await api.daily(); await loadTree(); await openPath(r.path) } catch (e) { say(errText(e), true) } }
  const fromTemplate = async () => {
    try {
      const t = await api.templates()
      if (!t.templates.length) { say('No templates yet: create notes in the "' + t.folder + '" folder.'); return }
      setDialog({ type: 'template', templates: t.templates })
    } catch (e) { say(errText(e), true) }
  }
  const useTemplate = async (tpl) => {
    setDialog({
      type: 'prompt', title: 'New note from "' + tpl.title + '"', label: 'Title', okLabel: 'Create',
      onOk: async (title) => {
        setDialog(null)
        try {
          const src = (await api.note(tpl.path)).content
          const d = new Date()
          const body = src.replaceAll('{{title}}', title).replaceAll('{{date}}', stamp(d).slice(0, 10)).replaceAll('{{time}}', stamp(d).slice(11, 13) + ':' + stamp(d).slice(13))
          const p = await createNote(currentFolder(), title, body)
          await openPath(p, { edit: true })
        } catch (e) { if (e.message !== 'cancelled') say(errText(e), true) }
      },
    })
  }

  // ---- attachments -----------------------------------------------------------
  /** Upload into the right place (sealed inside locked folders); returns the vault path. */
  const uploadBlob = async (blob, name, nearPath) => {
    const folder = nearPath !== undefined ? dirOf(nearPath) : currentFolder()
    const scope = lockedScopeOf(folder ? folder + '/x' : 'x', tree.locked)
    if (scope !== null) {
      const key = await needFolderKey(scope)
      const sealed = await sealBlob(key, new Uint8Array(await blob.arrayBuffer()))
      const r = await api.upload(new Blob([sealed]), name + '.nkenc', (scope ? scope + '/' : '') + 'attachments', true)
      return r.path
    }
    const dir = (status && status.folders && status.folders.attachments) || 'attachments'
    const r = await api.upload(blob, name, dir)
    return r.path
  }
  const onUpload = async (file) => {
    try {
      const p = await uploadBlob(file, file.name || ('pasted ' + stamp() + '.png'), note ? note.path : undefined)
      await loadTree()
      return '![[' + baseOf(p).replace(/\.nkenc$/, '') + ']]'
    } catch (e) { if (e.message !== 'cancelled') say('Upload failed: ' + errText(e), true); return null }
  }

  // ---- audio notes -----------------------------------------------------------
  const saveRecording = async ({ blob, lang, duration, transcribe: doStt, polish: doPolish, title }) => {
    const folder = view.folder !== undefined ? view.folder : currentFolder()
    const scope = lockedScopeOf(folder ? folder + '/x.md' : 'x.md', tree.locked)
    if (doStt && scope !== null && !window.confirm('This folder is encrypted. Transcription sends the audio to the speech service (it is not stored there). Continue?')) return
    setBusy(true)
    try {
      const ext = /ogg/.test(blob.type) ? 'ogg' : /mp4|m4a/.test(blob.type) ? 'm4a' : /mpeg/.test(blob.type) ? 'mp3' : /wav/.test(blob.type) ? 'wav' : 'webm'
      const name = safeTitle(title || 'Recording ' + stamp())
      const audioPath = await uploadBlob(blob, name + '.' + ext, folder ? folder + '/x.md' : 'x.md')
      let text = ''
      let meta = { engine: '', language: lang }
      let raw = ''
      if (doStt) {
        try {
          const r = await transcribe(blob, lang)
          raw = text = (r.text || '').trim()
          meta = { engine: r.engine || '', language: r.language || lang }
          if (doPolish && text) { const p = await polish(text); if (p && p.polished) text = p.text }
        } catch (e) { say('Transcription failed (the audio is saved): ' + errText(e), true) }
      }
      const embed = baseOf(audioPath).replace(/\.nkenc$/, '')
      const body = ['---', 'nk-type: audio', 'audio: ' + yamlStr('[[' + embed + ']]'), 'language: ' + (meta.language || lang), meta.engine ? 'engine: ' + meta.engine : null,
        'duration: ' + duration, 'recorded: ' + new Date().toISOString(), 'transcribed: ' + Boolean(text), 'tags: [audio, transcript]', '---',
        '# ' + name, '', '![[' + embed + ']]', '', '## Transcript', '', text || '_No transcript yet. Use "Transcribe" in the note header to create one._',
        raw && raw !== text ? '\n## Raw transcript\n\n' + raw : null, ''].filter((x) => x !== null).join('\n')
      const p = await createNote(folder, name, body)
      await openPath(p)
      say(text ? 'Transcribed and saved.' : 'Recording saved.')
    } catch (e) { if (e.message !== 'cancelled') say(errText(e), true) } finally { setBusy(false) }
  }
  /** Transcribe the audio embedded in an existing audio note. */
  const transcribeOpen = async (lang) => {
    const n = noteRef.current
    if (!n) return
    const m = /!\[\[([^\]|]+)\]\]/.exec(n.text)
    const target = m && (resolve(m[1]) || resolve(m[1] + '.nkenc'))
    if (!target) { say('No embedded audio found in this note.', true); return }
    setBusy(true)
    try {
      let bytes = await api.fileBytes(target)
      if (target.endsWith('.nkenc')) bytes = await openBlob(await needFolderKey(lockedOf(target)), bytes)
      const r = await transcribe(new Blob([bytes], { type: 'audio/webm' }), lang || (splitFrontmatter(n.text).props || {}).language || 'el')
      const t = (r.text || '').trim()
      const next = n.text.replace(/## Transcript\n\n[\s\S]*?(?=\n## |$)/, '## Transcript\n\n' + t + '\n').replace(/^transcribed: .*$/m, 'transcribed: true')
      setText(next.includes('## Transcript') ? next : n.text + '\n## Transcript\n\n' + t + '\n')
      say('Transcript added.')
    } catch (e) { say('Transcription failed: ' + errText(e), true) } finally { setBusy(false) }
  }

  // ---- drawings --------------------------------------------------------------
  const saveDrawing = async ({ png, vector, ocrText }) => {
    const d = view.drawing || {}
    const folder = d.notePath ? dirOf(d.notePath) : (view.folder !== undefined ? view.folder : currentFolder())
    const near = (folder ? folder + '/' : '') + 'x.md'
    setBusy(true)
    try {
      const name = safeTitle(d.title || 'Drawing ' + stamp())
      const pngPath = await uploadBlob(png, name + '.png', near)
      const vecPath = await uploadBlob(new Blob([vector], { type: 'application/json' }), name + '.drawing.json', near)
      const pngEmbed = baseOf(pngPath).replace(/\.nkenc$/, '')
      const vecRef = vecPath
      if (d.notePath) {
        // Update the existing drawing note to point at the new files, then purge the old ones.
        const n = noteRef.current && noteRef.current.path === d.notePath ? noteRef.current : null
        let text = n ? n.text : ''
        const props = splitFrontmatter(text).props || {}
        text = text.replace(/!\[\[[^\]]*\]\]/, '![[' + pngEmbed + ']]').replace(/^drawing: .*$/m, 'drawing: ' + yamlStr('[[' + pngEmbed + ']]')).replace(/^vector: .*$/m, 'vector: ' + yamlStr(vecRef))
        if (ocrText) text = text.replace(/## Extracted text\n\n[\s\S]*?(?=\n## |$)/, '## Extracted text\n\n' + ocrText + '\n')
        setNote((cur) => cur ? { ...cur, text } : cur)
        setTimeout(() => saveNow(), 0)
        for (const old of [props.vector, d.pngPath]) if (old && old !== vecRef && old !== pngPath) api.trash(old, true).catch(() => {})
        setView({ kind: 'note', path: d.notePath })
      } else {
        const body = ['---', 'nk-type: drawing', 'drawing: ' + yamlStr('[[' + pngEmbed + ']]'), 'vector: ' + yamlStr(vecRef), 'created: ' + new Date().toISOString(), 'tags: [drawing]', '---',
          '# ' + name, '', '![[' + pngEmbed + ']]', '', '## Extracted text', '', ocrText || '_Use "Extract text" in the canvas to OCR handwriting._', ''].join('\n')
        const p = await createNote(folder, name, body)
        await openPath(p)
      }
      await loadTree()
      say('Drawing saved.')
    } catch (e) { if (e.message !== 'cancelled') say(errText(e), true) } finally { setBusy(false) }
  }
  const editDrawing = async () => {
    const n = noteRef.current
    if (!n) return
    const props = splitFrontmatter(n.text).props || {}
    const target = String(props.drawing || '').replace(/^\[\[|\]\]$/g, '')
    const pngPath = resolve(target) || resolve(target + '.nkenc')
    let initialPngUrl = null
    let initialVector = null
    try {
      const openBytes = async (p) => { let b = await api.fileBytes(p); if (p.endsWith('.nkenc')) b = await openBlob(await needFolderKey(lockedOf(p)), b); return b }
      if (pngPath) initialPngUrl = URL.createObjectURL(new Blob([await openBytes(pngPath)], { type: 'image/png' }))
      const vp = props.vector && (byPath.has(props.vector) ? props.vector : null)
      if (vp) initialVector = new TextDecoder().decode(await openBytes(vp))
    } catch (e) { if (e.message === 'cancelled') return; say('Could not load the drawing: ' + errText(e), true) }
    setView({ kind: 'paint', drawing: { notePath: n.path, title: stem(n.path), pngPath, initialPngUrl, initialVector } })
  }
  const ocr = async (blob) => (await api.ocrBlob(blob, 'eng+ell')).text

  // ---- move / rename / delete ------------------------------------------------
  const doMove = async (from, to) => {
    try {
      const r = await api.move(from, to)
      if (note && note.path === from) setNote((n) => ({ ...n, path: to }))
      if (view.path === from) setView((v) => ({ ...v, path: to }))
      await loadTree()
      if (r.rewritten && r.rewritten.length) say('Moved; updated links in ' + r.rewritten.length + ' note(s).')
    } catch (e) { say(errText(e), true) }
  }
  const rename = (p, dir) => setDialog({
    type: 'prompt', title: 'Rename', label: 'New name', initial: dir ? baseOf(p) : stem(p), okLabel: 'Rename',
    onOk: (name) => { setDialog(null); const ext = dir ? '' : p.slice(p.lastIndexOf('.')); const nn = dir ? safeTitle(name) : safeTitle(name) + ext; doMove(p, (dirOf(p) ? dirOf(p) + '/' : '') + nn) },
  })
  const moveTo = (p) => setDialog({
    type: 'prompt', title: 'Move', label: 'Destination folder (empty = vault root)', initial: dirOf(p) || '/', okLabel: 'Move',
    onOk: (folder) => { setDialog(null); const f = folder.replace(/^\/+|\/+$/g, ''); doMove(p, (f ? f + '/' : '') + baseOf(p)) },
  })
  const remove = (p, dir) => setDialog({
    type: 'confirm', title: 'Delete', danger: true, okLabel: 'Move to trash',
    message: <span>Move <b>{p}</b>{dir ? ' and everything in it' : ''} to the vault trash (<code>.trash</code>)? Obsidian can restore it.</span>,
    onOk: async () => {
      setDialog(null)
      try { await api.trash(p); if (note && (note.path === p || note.path.startsWith(p + '/'))) { setNote(null); setView({ kind: 'home' }) } await loadTree() } catch (e) { say(errText(e), true) }
    },
  })

  // ---- encryption flows --------------------------------------------------------
  const encryptNote = () => {
    const n = noteRef.current
    if (!n) return
    setDialog({
      type: 'encrypt', kind: 'note', target: n.path,
      onOk: async ({ password, hint }) => {
        setDialog((d) => ({ ...d, busy: true }))
        try {
          const salt = randomBytes(16)
          const key = await deriveKey(password, salt)
          const env = await sealNote(key, n.text, { scope: 'note', salt, hint })
          const r = await api.save(n.path, env, n.mtime)
          ring.current.set('note:' + n.path, key, { salt, iter: ITERATIONS, hint })
          setNote({ ...n, env: parseEnvelope(env), keyId: 'note:' + n.path, mtime: r.mtime, saved: n.text })
          setDialog(null)
          say('Note encrypted. Only this password can open it.')
        } catch (e) { setDialog(null); say('Encryption failed: ' + errText(e), true) }
      },
    })
  }
  const decryptNotePermanently = async () => {
    const n = noteRef.current
    if (!n || n.locked || lockedOf(n.path) !== null) return
    try {
      const r = await api.save(n.path, n.text, n.mtime)
      ring.current.forget(n.keyId)
      setNote({ ...n, env: null, keyId: null, mtime: r.mtime, saved: n.text })
      say('Encryption removed from this note.')
    } catch (e) { say(errText(e), true) }
  }
  const unlockOpen = () => {
    const n = noteRef.current
    if (!n || !n.env) return
    const scope = lockedOf(n.path)
    if (n.env.scope === 'folder' && scope !== null) { needFolderKey(scope).then(() => refreshOpenForce()).catch(() => {}); return }
    const attempt = async (pw) => {
      setDialog((d) => ({ ...d, busy: true, error: '' }))
      try {
        const salt = unb64(n.env.salt)
        const key = await deriveKey(pw, salt, n.env.iter)
        const text = await openNote(key, n.env)
        ring.current.set(n.keyId, key, { salt, iter: n.env.iter, hint: n.env.hint })
        setNote({ ...n, locked: false, text, saved: text, error: null })
        setDialog(null)
      } catch (e) { setDialog((d) => ({ ...d, busy: false, error: errText(e) })) }
    }
    setDialog({ type: 'unlock', target: n.path, hint: n.env.hint, onOk: attempt })
  }
  const refreshOpenForce = async () => { const n = noteRef.current; if (n) { setNote({ ...n, mtime: -1 }); const res = await api.note(n.path); const env = parseEnvelope(res.content); const nn = env ? await decryptInto(n.path, res, env) : { path: n.path, mtime: res.mtime, env: null, keyId: null, locked: false, text: res.content, saved: res.content }; nn.backlinks = res.backlinks; nn.doc = res.doc; setNote(nn) } }

  const encryptFolder = (folder) => setDialog({
    type: 'encrypt', kind: 'folder', target: folder + '/',
    onOk: async ({ password, hint }) => {
      setDialog((d) => ({ ...d, busy: true, progress: 1 }))
      try {
        const { key, marker } = await makeFolderMarker(password, hint)
        const salt = unb64(marker.salt)
        const inside = tree.entries.filter((e) => !e.dir && e.path.startsWith(folder + '/'))
        let done = 0
        for (const e of inside) {
          if (e.path.endsWith('.md')) {
            const res = await api.note(e.path)
            if (!parseEnvelope(res.content)) await api.save(e.path, await sealNote(key, res.content, { scope: 'folder', salt }), res.mtime)
          } else if (!e.path.endsWith('.nkenc')) {
            const bytes = await api.fileBytes(e.path)
            await api.upload(new Blob([await sealBlob(key, bytes)]), baseOf(e.path) + '.nkenc', dirOf(e.path), true)
            await api.trash(e.path, true) // purge: plaintext must not linger in .trash
          }
          done++
          setDialog((d) => (d ? { ...d, progress: Math.round((done / Math.max(1, inside.length)) * 95) + 1 } : d))
        }
        await api.lock(folder, marker)
        ring.current.set('folder:' + folder, key, { salt, iter: marker.iter, hint })
        setDialog(null)
        await loadTree()
        if (noteRef.current && noteRef.current.path.startsWith(folder + '/')) refreshOpenForce()
        say('Folder encrypted (' + inside.length + ' files).')
      } catch (e) { setDialog(null); say('Folder encryption stopped: ' + errText(e) + '. Files already encrypted stay encrypted; run it again to finish.', true) }
    },
  })
  const decryptFolder = async (folder) => {
    try {
      const key = await needFolderKey(folder)
      if (!window.confirm('Remove encryption from ' + folder + '/? Every note and attachment in it will be stored as plain text again.')) return
      setBusy(true)
      const inside = tree.entries.filter((e) => !e.dir && e.path.startsWith(folder + '/'))
      const plain = []
      for (const e of inside) {
        if (e.path.endsWith('.md')) {
          const res = await api.note(e.path)
          const env = parseEnvelope(res.content)
          if (env && env.scope === 'folder') plain.push({ path: e.path, text: await openNote(key, env), mtime: res.mtime })
        } else if (e.path.endsWith('.nkenc')) {
          plain.push({ path: e.path, bytes: await openBlob(key, await api.fileBytes(e.path)) })
        }
      }
      await api.unlockFolder(folder).catch(async (err) => { if (err.code === 'still_encrypted') return fetch('/note-keeper/api/lock?folder=' + encodeURIComponent(folder) + '&force=1', { method: 'DELETE', credentials: 'same-origin', headers: { 'x-requested-with': 'dsh-note-keeper' } }); throw err })
      for (const p of plain) {
        if (p.text !== undefined) await api.save(p.path, p.text, p.mtime)
        else { await api.upload(new Blob([p.bytes]), baseOf(p.path).replace(/\.nkenc$/, ''), dirOf(p.path)); await api.trash(p.path, true) }
      }
      ring.current.forget('folder:' + folder)
      await loadTree()
      if (noteRef.current && noteRef.current.path.startsWith(folder + '/')) refreshOpenForce()
      say('Encryption removed from ' + folder + '/.')
    } catch (e) { if (e.message !== 'cancelled') say(errText(e), true) } finally { setBusy(false) }
  }
  const lockAll = () => {
    const n = noteRef.current
    if (n && n.text !== n.saved) saveNow()
    ring.current.clear()
    if (n && n.env) setNote({ ...n, locked: true, text: '', saved: '' })
    say('All encryption keys forgotten in this tab.')
  }

  // ---- search ----------------------------------------------------------------
  useEffect(() => {
    if (view.kind !== 'search') return
    if (!query.trim() && !tagFilter) { setHits([]); return }
    const t = setTimeout(() => api.search(query, { tag: tagFilter, limit: 100 }).then((r) => setHits(r.hits)).catch(() => {}), 140)
    return () => clearTimeout(t)
  }, [query, tagFilter, view.kind, tree])
  const openSearch = (q, tag) => { if (q !== undefined) setQuery(q); if (tag !== undefined) setTagFilter(tag); setView({ kind: 'search' }); setNote(null) }

  // ---- graph -----------------------------------------------------------------
  useEffect(() => {
    if (view.kind !== 'graph') return
    api.graph(graphTags).then(setGraph).catch((e) => say(errText(e), true))
  }, [view.kind, graphTags, tree])

  // ---- keyboard shortcuts (active while this page is mounted) ------------------
  useEffect(() => {
    const onKey = (e) => {
      const inField = /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote() }
      else if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'c') { e.preventDefault(); setDialog({ type: 'capture' }) }
      else if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'd') { e.preventDefault(); openDaily() }
      else if (e.ctrlKey && e.key.toLowerCase() === 'e' && noteRef.current) { e.preventDefault(); setMode(mode === 'preview' ? 'live' : 'preview') }
      else if (!inField && e.key === '/') { e.preventDefault(); searchRef.current && searchRef.current.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- decrypt sealed embeds in the preview -----------------------------------
  const sealedUrls = useRef(new Map())
  useEffect(() => {
    const els = document.querySelectorAll('.nk-root [data-nk-sealed]')
    els.forEach(async (el) => {
      const p = el.getAttribute('data-nk-sealed')
      if (el.src && el.src.startsWith('blob:')) return
      let url = sealedUrls.current.get(p)
      if (!url) {
        const k = ring.current.get('folder:' + lockedOf(p))
        if (!k) return
        try { url = URL.createObjectURL(new Blob([await openBlob(k.key, await api.fileBytes(p))])); sealedUrls.current.set(p, url) } catch { return }
      }
      el.src = url
    })
  })
  useEffect(() => () => { for (const u of sealedUrls.current.values()) URL.revokeObjectURL(u) }, [])

  // ---- rendering -------------------------------------------------------------
  const rowIcon = (node) => {
    if (node.dir) return tree.locked.includes(node.path) ? 'lock' : expanded.has(node.path) ? 'folderOpen' : 'folder'
    const k = fileKind(node.entry)
    if (node.entry.doc && node.entry.doc.encrypted) return 'lock'
    return { note: 'note', audio: 'audio', draw: 'draw', image: 'image', audiofile: 'audio', video: 'file', pdf: 'file', sealed: 'lock', file: 'file' }[k]
  }
  const ctxMenu = (e, node) => {
    e.preventDefault()
    const p = node.path
    const isLocked = node.dir && tree.locked.includes(p)
    const inLocked = lockedOf(p) !== null
    setMenu({
      x: e.clientX, y: e.clientY, items: node.dir ? [
        { label: 'New note here', onClick: () => newNote(p) },
        { label: 'New folder here', onClick: () => newFolder(p) },
        { label: 'New audio note here', onClick: () => setView({ kind: 'record', folder: p }) },
        { label: 'New drawing here', onClick: () => setView({ kind: 'paint', folder: p, drawing: {} }) },
        '-',
        { label: 'Rename…', onClick: () => rename(p, true) },
        { label: 'Move…', onClick: () => moveTo(p) },
        '-',
        isLocked ? { label: ring.current.has('folder:' + p) ? 'Lock now (forget key)' : 'Unlock for this session…', onClick: () => (ring.current.has('folder:' + p) ? (ring.current.forget('folder:' + p), refreshOpenForce()) : needFolderKey(p).then(refreshOpenForce).catch(() => {})) } : null,
        isLocked ? { label: 'Remove folder encryption…', onClick: () => decryptFolder(p) } : null,
        !isLocked && !inLocked ? { label: 'Encrypt folder…', onClick: () => encryptFolder(p) } : null,
        '-',
        { label: 'Delete…', onClick: () => remove(p, true) },
      ] : [
        { label: 'Open', onClick: () => openPath(p) },
        p.endsWith('.md') ? { label: 'Copy link [[…]]', onClick: () => navigator.clipboard && navigator.clipboard.writeText('[[' + stem(p) + ']]') } : { label: 'Download', onClick: () => window.open(fileUrl(p, true), '_blank') },
        '-',
        { label: 'Rename…', onClick: () => rename(p, false) },
        { label: 'Move…', onClick: () => moveTo(p) },
        '-',
        { label: 'Delete…', onClick: () => remove(p, false) },
      ],
    })
  }

  const Sidebar = (
    <aside className="nk-side" aria-label="Vault">
      <div className="nk-tabs" role="tablist">
        {[['files', 'Files'], ['tags', 'Tags'], ['recent', 'Recent']].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={sideTab === k} className={'nk-tab' + (sideTab === k ? ' nk-on' : '')} onClick={() => setSideTab(k)}>{l}</button>
        ))}
      </div>
      <div className="nk-sidebody"
        onDragOver={(e) => { if (sideTab === 'files' && e.dataTransfer.types.includes('text/nk-path')) { e.preventDefault(); setDropTarget('') } }}
        onDrop={(e) => { const from = e.dataTransfer.getData('text/nk-path'); setDropTarget(null); if (from && dirOf(from) !== '' && e.target === e.currentTarget) doMove(from, baseOf(from)) }}>
        {sideTab === 'files' ? rows.map(({ node, depth }) => (
          <div key={node.path} className={'nk-row' + ((view.path === node.path) ? ' nk-sel' : '') + (dropTarget === node.path ? ' nk-drop' : '')} style={{ '--d': depth }}
            title={node.path} draggable
            onDragStart={(e) => { e.dataTransfer.setData('text/nk-path', node.path); e.dataTransfer.effectAllowed = 'move' }}
            onDragOver={(e) => { if (node.dir && e.dataTransfer.types.includes('text/nk-path')) { e.preventDefault(); e.stopPropagation(); setDropTarget(node.path) } }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget(null); const from = e.dataTransfer.getData('text/nk-path'); if (from && node.dir && from !== node.path && dirOf(from) !== node.path) doMove(from, node.path + '/' + baseOf(from)) }}
            onClick={() => (node.dir ? toggleDir(node.path) : openPath(node.path))}
            onContextMenu={(e) => ctxMenu(e, node)}
            role="treeitem" aria-expanded={node.dir ? expanded.has(node.path) : undefined}>
            <span className={'nk-ico' + (rowIcon(node) === 'lock' ? ' nk-lockico' : '')}><Icon name={rowIcon(node)} size={14} /></span>
            <span className="nk-name">{node.dir ? node.name : node.name.replace(/\.md$/i, '')}</span>
            {!node.dir && !node.path.endsWith('.md') ? <span className="nk-badge">{fmtBytes(node.entry.size)}</span> : null}
          </div>
        )) : null}
        {sideTab === 'files' && !rows.length ? <div className="nk-empty" style={{ padding: 16 }}>The vault is empty.</div> : null}
        {sideTab === 'tags' ? (
          <div style={{ padding: '6px 10px' }}>
            {tags.length ? tags.map((t) => (
              <span key={t.tag} className={'nk-chip' + (tagFilter === t.tag ? ' nk-on' : '')} onClick={() => openSearch('', tagFilter === t.tag ? '' : t.tag)}>#{t.tag} <small>{t.count}</small></span>
            )) : <div style={{ color: 'var(--nk-fg3)', fontSize: 13 }}>No tags yet. Add #tags in a note or a tags: list in its frontmatter.</div>}
          </div>
        ) : null}
        {sideTab === 'recent' ? recent.map((d) => (
          <div key={d.path} className={'nk-row' + (view.path === d.path ? ' nk-sel' : '')} onClick={() => openPath(d.path)} title={d.path}>
            <span className="nk-ico"><Icon name={d.encrypted ? 'lock' : d.type === 'audio' ? 'audio' : d.type === 'drawing' ? 'draw' : 'note'} size={14} /></span>
            <span className="nk-name">{d.title}</span><span className="nk-badge">{fmtAgo(d.mtime)}</span>
          </div>
        )) : null}
      </div>
      <div className="nk-sidefoot">
        <IBtn icon="note" title="New note (Ctrl+Alt+N)" onClick={() => newNote()} />
        <IBtn icon="folder" title="New folder" onClick={() => newFolder()} />
        <IBtn icon="mic" title="New audio note" onClick={() => setView({ kind: 'record', folder: currentFolder() })} />
        <IBtn icon="draw" title="New drawing" onClick={() => setView({ kind: 'paint', folder: currentFolder(), drawing: {} })} />
        <IBtn icon="template" title="New from template" onClick={fromTemplate} />
        <label className="nk-ibtn" title="Upload files" aria-label="Upload files" style={{ cursor: 'pointer' }}>
          <Icon name="clip" /><input type="file" multiple hidden onChange={async (e) => { const fs = Array.from(e.target.files || []); e.target.value = ''; for (const f of fs) { try { await uploadBlob(f, f.name) } catch (err) { if (err.message !== 'cancelled') say(errText(err), true) } } await loadTree(); if (fs.length) say(fs.length + ' file(s) uploaded.') }} />
        </label>
        <span className="nk-spacer" />
        <IBtn icon="refresh" title="Reload" onClick={() => { loadTree(); loadSide() }} />
      </div>
    </aside>
  )

  const n = note
  const c = n && !n.locked ? counts(n.text) : null
  const noteType = n && !n.locked ? ((splitFrontmatter(n.text).props || {})['nk-type'] || 'text') : 'text'
  const NoteView = n ? (
    <section className="nk-main" aria-label="Note">
      <div className="nk-notehead">
        <IBtn icon="menu" title="Files" className="nk-only-narrow" onClick={() => setShowSide((s) => !s)} />
        <input className="nk-title" key={n.path} defaultValue={stem(n.path)} aria-label="Note title (renames the file)"
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
          onBlur={(e) => { const t = safeTitle(e.target.value); if (t !== stem(n.path)) doMove(n.path, (dirOf(n.path) ? dirOf(n.path) + '/' : '') + t + '.md') }} />
        {n.env ? <span className="nk-lockico" title="Encrypted"><Icon name="lock" /></span> : null}
        {noteType === 'audio' ? <button type="button" className="nk-btn" disabled={busy || n.locked} onClick={() => transcribeOpen()}>{busy ? 'Transcribing…' : 'Transcribe'}</button> : null}
        {noteType === 'drawing' ? <button type="button" className="nk-btn" disabled={n.locked} onClick={editDrawing}><Icon name="draw" /> Edit drawing</button> : null}
        {!n.locked ? (
          <AiEnhanceButton title={stem(n.path)} getText={() => (noteRef.current ? noteRef.current.text : '')}
            disabled={!!n.env || n.readOnly} disabledReason={n.env ? 'Encrypted notes are never sent to a model' : 'Read-only'}
            onApply={(t) => setText(t)} say={say} />
        ) : null}
        <IBtn icon="edit" title="Live preview: links and tags render while you type" active={mode === 'live'} onClick={() => setMode('live')} />
        <IBtn icon="code" title="Source (Markdown as text)" active={mode === 'edit'} onClick={() => setMode('edit')} />
        <IBtn icon="split" title="Split: source + preview" active={mode === 'split'} onClick={() => setMode('split')} />
        <IBtn icon="eye" title="Reading view (Ctrl+E)" active={mode === 'preview'} onClick={() => setMode('preview')} />
        <IBtn icon="more" title="More" onClick={(e) => setMenu({
          x: e.clientX, y: e.clientY, items: [
            !n.env && lockedOf(n.path) === null ? { label: 'Encrypt note…', onClick: encryptNote } : null,
            n.env && n.env.scope === 'note' && !n.locked && lockedOf(n.path) === null ? { label: 'Remove encryption', onClick: decryptNotePermanently } : null,
            n.env && !n.locked ? { label: 'Lock now', onClick: lockAll } : null,
            { label: 'Copy link [[…]]', onClick: () => navigator.clipboard && navigator.clipboard.writeText('[[' + stem(n.path) + ']]') },
            { label: 'Show in graph', onClick: () => setView({ kind: 'graph', focus: n.path }) },
            '-',
            { label: 'Move…', onClick: () => moveTo(n.path) },
            { label: 'Delete…', onClick: () => remove(n.path, false) },
          ],
        })} />
      </div>
      {n.conflict ? (
        <div className="nk-banner nk-warnb" role="alert">
          This note changed on disk (another device, Obsidian or an AI tool) while you were editing.
          <button type="button" className="nk-btn" onClick={() => resolveConflict('theirs')}>Load disk version</button>
          <button type="button" className="nk-btn" onClick={() => resolveConflict('merge')}>Keep both</button>
          <button type="button" className="nk-btn nk-danger" onClick={() => resolveConflict('mine')}>Overwrite with mine</button>
        </div>
      ) : null}
      {n.locked ? (
        <div className="nk-empty">
          <div className="nk-lockico" style={{ fontSize: 28 }}><Icon name="lock" size={40} /></div>
          <h2>Encrypted note</h2>
          <p>{n.error ? n.error : 'This note is end-to-end encrypted. Its content never leaves this browser unencrypted.'}</p>
          {n.env && n.env.hint ? <p style={{ fontSize: 12 }}>Hint: {n.env.hint}</p> : null}
          <button type="button" className="nk-btn nk-primary" onClick={unlockOpen}>Unlock…</button>
        </div>
      ) : (
        <Editor key={n.path} text={n.text} setText={setText} mode={mode} render={render} linkTargets={linkTargets}
          tagList={tagList} resolve={resolve} fileUrl={(p) => fileUrl(p)}
          onOpenLink={(t) => { const p = resolve(t); if (p) openPath(p); else setDialog({ type: 'confirm', title: 'Create note', message: <span>No note named <b>{t}</b> yet. Create it?</span>, okLabel: 'Create', onOk: async () => { setDialog(null); try { const np = await createNote(dirOf(t) || currentFolder(), baseOf(t), '# ' + baseOf(t) + '\n\n'); openPath(np, { edit: true }) } catch (e) { if (e.message !== 'cancelled') say(errText(e), true) } } }) }}
          onTag={(t) => openSearch('', t)} onUpload={onUpload} onSaveNow={() => saveNow()} />
      )}
      <div className="nk-status">
        <span className="nk-path">{n.path}</span>
        {c ? <span>{c.words} words · {c.minutes} min read</span> : null}
        <span className="nk-spacer" />
        {saveState === 'dirty' ? <span className="nk-dirty">unsaved</span> : saveState === 'saving' ? <span>saving…</span> : saveState === 'saved' ? <span className="nk-saved">saved</span> : saveState === 'error' ? <span className="nk-errtxt">save failed</span> : saveState === 'conflict' ? <span className="nk-errtxt">conflict</span> : null}
        <span>{n.env ? 'encrypted' : 'plain'} · {fmtAgo(n.mtime)}</span>
      </div>
    </section>
  ) : null

  const Info = n && !n.locked ? (() => {
    const props = splitFrontmatter(n.text).props || {}
    const heads = outline(n.text)
    const links = (n.doc && n.doc.links) || []
    return (
      <aside className="nk-info" aria-label="Note info">
        <div className="nk-h">Tags</div>
        <div>{(n.doc && n.doc.tags && n.doc.tags.length) ? n.doc.tags.map((t) => <span key={t} className="nk-chip" onClick={() => openSearch('', t)}>#{t}</span>) : <small style={{ color: 'var(--nk-fg3)' }}>none</small>}</div>
        {heads.length ? <><div className="nk-h">Outline</div>{heads.map((h, i) => <span key={i} className="nk-link" style={{ paddingLeft: (h.level - 1) * 10 }} onClick={() => { setMode(mode === 'edit' ? 'split' : mode); setTimeout(() => { const el = Array.from(document.querySelectorAll('.nk-root .nk-md h1,.nk-root .nk-md h2,.nk-root .nk-md h3,.nk-root .nk-md h4,.nk-root .nk-md h5,.nk-root .nk-md h6'))[i]; el && el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 50) }}>{h.text}</span>)}</> : null}
        <div className="nk-h">Backlinks ({(n.backlinks || []).length})</div>
        {(n.backlinks || []).length ? n.backlinks.map((b) => <span key={b.path} className="nk-link" onClick={() => openPath(b.path)} title={b.path}>{b.title}</span>) : <small style={{ color: 'var(--nk-fg3)' }}>No notes link here yet.</small>}
        <div className="nk-h">Links ({links.length})</div>
        {links.map((l) => { const p = resolve(l); return <span key={l} className="nk-link" style={p ? undefined : { opacity: 0.55 }} onClick={() => (p ? openPath(p) : null)} title={p || 'unresolved'}>{l}</span> })}
        {props.language || props.duration ? <><div className="nk-h">Recording</div><small>{props.language ? 'language: ' + props.language : ''} {props.duration ? '· ' + props.duration + ' s' : ''} {props.engine ? '· ' + props.engine : ''}</small></> : null}
      </aside>
    )
  })() : null

  const FileView = view.kind === 'file' ? (() => {
    const e = byPath.get(view.path)
    if (!e) return <div className="nk-empty">File not found.</div>
    const k = fileKind(e)
    const url = fileUrl(e.path)
    return (
      <section className="nk-main">
        <div className="nk-notehead"><IBtn icon="menu" title="Files" className="nk-only-narrow" onClick={() => setShowSide((s) => !s)} /><b style={{ flex: 1 }}>{baseOf(e.path)}</b><span className="nk-path">{fmtBytes(e.size)}</span>
          <a className="nk-btn" href={fileUrl(e.path, true)}>Download</a>
          <button type="button" className="nk-btn" onClick={() => { navigator.clipboard && navigator.clipboard.writeText('![[' + baseOf(e.path) + ']]'); say('Embed copied.') }}>Copy embed</button>
          {k === 'image' ? <button type="button" className="nk-btn" disabled={busy} onClick={async () => { setBusy(true); try { const r = await api.ocrPath(e.path, 'eng+ell'); setDialog({ type: 'ocr', text: r.text }) } catch (err) { say(errText(err), true) } finally { setBusy(false) } }}><Icon name="ocr" /> Extract text</button> : null}
          <IBtn icon="trash" title="Delete" onClick={() => remove(e.path, false)} />
        </div>
        <div className="nk-attach">
          {k === 'image' ? <img src={url} alt={baseOf(e.path)} /> : null}
          {k === 'audiofile' ? <audio controls src={url} style={{ width: '100%' }} /> : null}
          {k === 'video' ? <video controls src={url} style={{ width: '100%' }} /> : null}
          {k === 'pdf' ? <object data={url} type="application/pdf"><a href={url} target="_blank" rel="noopener">Open PDF</a></object> : null}
          {k === 'sealed' ? <SealedView path={e.path} getKey={() => needFolderKey(lockedOf(e.path))} /> : null}
          {k === 'file' ? <div className="nk-empty">No preview for this file type. Use Download.</div> : null}
          {(() => { const users = tree.entries.filter((x) => x.doc && x.doc.links && x.doc.links.some((l) => resolve(l) === e.path || baseOf(l) === baseOf(e.path))); return users.length ? <div><div className="nk-h">Used in</div>{users.map((u) => <span key={u.path} className="nk-link" onClick={() => openPath(u.path)}>{u.doc.title}</span>)}</div> : null })()}
        </div>
      </section>
    )
  })() : null

  // The lock button does what the open note needs: encrypt a plain note,
  // lock an unlocked encrypted note, otherwise lock every open key.
  const lockAction = (() => {
    const cur = note
    if (view.kind === 'note' && cur && !cur.env && lockedOf(cur.path) === null) return { title: 'Encrypt this note…', run: encryptNote, active: false }
    if (view.kind === 'note' && cur && cur.env && !cur.locked) return { title: 'Lock this note now (and all other unlocked notes)', run: lockAll, active: true }
    return { title: 'Lock all encrypted notes now', run: lockAll, active: false }
  })()

  const Home = (
    <section className="nk-main">
      <div className="nk-empty">
        <h2>NOTE KEEPER</h2>
        <p>{tree.entries.filter((e) => !e.dir && e.path.endsWith('.md')).length} notes in <code>{status ? status.vault : '…'}</code>. Plain Markdown: open the same folder as an Obsidian vault on desktop or mobile and both stay in sync live.</p>
        <div className="nk-cards">
          <div className="nk-card" onClick={() => newNote()}><b>Text note</b><span>Markdown with live preview, [[links]] and #tags</span></div>
          <div className="nk-card" onClick={() => setView({ kind: 'record', folder: currentFolder() })}><b>Audio note</b><span>Record and transcribe (Greek / English)</span></div>
          <div className="nk-card" onClick={() => setView({ kind: 'paint', folder: currentFolder(), drawing: {} })}><b>Drawing</b><span>Retro paint canvas with handwriting OCR</span></div>
          <div className="nk-card" onClick={openDaily}><b>Daily note</b><span>Today's page (Ctrl+Alt+D)</span></div>
          <div className="nk-card" onClick={() => setDialog({ type: 'capture' })}><b>Quick capture</b><span>Drop a thought into the Inbox (Ctrl+Alt+C)</span></div>
          <div className="nk-card" onClick={() => setView({ kind: 'graph' })}><b>Graph</b><span>See how your notes connect</span></div>
          <div className="nk-card" onClick={() => setDialog({ type: 'import' })}><b>Import</b><span>Obsidian, Notion, Evernote, Apple Notes, Google Keep, Markdown</span></div>
          <div className="nk-card" onClick={() => setDialog({ type: 'connect' })}><b>Connect</b><span>Obsidian (desktop + mobile), WebDAV apps, Google Drive, iCloud</span></div>
        </div>
        {recent.length ? <div style={{ textAlign: 'left', marginTop: 22 }}><div className="nk-h">Recently edited</div>{recent.slice(0, 8).map((d) => <span key={d.path} className="nk-link" onClick={() => openPath(d.path)}>{d.title} <small style={{ color: 'var(--nk-fg3)' }}>{fmtAgo(d.mtime)}</small></span>)}</div> : null}
      </div>
    </section>
  )

  const SearchView = (
    <section className="nk-main">
      <div className="nk-notehead">
        <IBtn icon="menu" title="Files" className="nk-only-narrow" onClick={() => setShowSide((s) => !s)} />
        <b style={{ fontFamily: 'var(--nk-display)', fontSize: 12, letterSpacing: '.06em' }}>SEARCH</b>
        {tagFilter ? <span className="nk-chip nk-on" onClick={() => setTagFilter('')}>#{tagFilter} ×</span> : null}
        <span className="nk-spacer" /><small className="nk-path">{hits.length} result(s) · accent-insensitive · "exact phrase"</small>
      </div>
      <div className="nk-hits">
        {hits.map((h) => (
          <div key={h.path} className="nk-hit" onClick={() => openPath(h.path)}>
            <b>{h.encrypted ? '[encrypted] ' : ''}{h.title}</b><small>{h.path}</small>
            {h.snippet ? <p>{h.snippet}</p> : null}
            {h.tags && h.tags.length ? <div style={{ marginTop: 4 }}>{h.tags.map((t) => <span key={t} className="nk-chip">#{t}</span>)}</div> : null}
          </div>
        ))}
        {!hits.length ? <div className="nk-empty">{query || tagFilter ? 'Nothing found.' : 'Type to search every note (Greek and English, accents ignored).'}</div> : null}
      </div>
    </section>
  )

  let main
  if (view.kind === 'note' && n) main = NoteView
  else if (view.kind === 'file') main = FileView
  else if (view.kind === 'search') main = SearchView
  else if (view.kind === 'record') main = <section className="nk-main"><Recorder busy={busy} onCancel={() => setView({ kind: 'home' })} onSave={saveRecording} /></section>
  else if (view.kind === 'paint') main = (
    <section className="nk-main" style={{ minHeight: 0 }}>
      <PaintEditor title={(view.drawing && view.drawing.title) || 'New drawing'} initialPngUrl={view.drawing && view.drawing.initialPngUrl} initialVector={view.drawing && view.drawing.initialVector}
        onSave={saveDrawing} onOcr={ocr} onClose={() => (view.drawing && view.drawing.notePath ? openPath(view.drawing.notePath) : setView({ kind: 'home' }))} />
    </section>
  )
  else if (view.kind === 'graph') main = (
    <section className="nk-main" style={{ minHeight: 0 }}>
      {graph ? <GraphView nodes={graph.nodes} edges={graph.edges} focus={view.focus} showTags={graphTags} onToggleTags={() => setGraphTags((v) => !v)} onOpen={(id) => openPath(id)} /> : <div className="nk-empty">Loading graph…</div>}
    </section>
  )
  else main = Home

  return (
    <div className={'nk-root' + (showSide ? ' nk-show-side' : '')}>
      <header className="nk-head">
        <span className="nk-brand"><i />Note Keeper</span>
        <span className="nk-vault" title={status ? status.vault : ''}>{status && status.daemon && !status.daemon.running ? 'backend offline' : tree.root}</span>
        <span className="nk-spacer" />
        <input ref={searchRef} className="nk-input nk-search" type="search" placeholder="Search notes  ( / )" value={query} aria-label="Search notes"
          onChange={(e) => { setQuery(e.target.value); if (view.kind !== 'search') openSearch() }} onFocus={() => { if (query) openSearch() }} />
        <button type="button" className="nk-btn nk-primary" onClick={() => newNote()} title="New note (Ctrl+Alt+N)"><Icon name="plus" />New</button>
        <IBtn icon="day" title="Daily note (Ctrl+Alt+D)" onClick={openDaily} />
        <IBtn icon="inbox" title="Quick capture (Ctrl+Alt+C)" onClick={() => setDialog({ type: 'capture' })} />
        <IBtn icon="graph" title="Graph view" active={view.kind === 'graph'} onClick={() => setView({ kind: 'graph', focus: n ? n.path : undefined })} />
        <IBtn icon="import" title="Import notes (Obsidian, Notion, Evernote, Apple Notes, Keep, Markdown)" onClick={() => setDialog({ type: 'import' })} />
        <IBtn icon="connect" title="Connect Obsidian, phones, WebDAV apps and cloud drives" onClick={() => setDialog({ type: 'connect' })} />
        <IBtn icon="lock" title={lockAction.title} active={lockAction.active} onClick={lockAction.run} />
      </header>
      <div className={'nk-body' + (Info && view.kind === 'note' ? '' : ' nk-no-info')}>
        {Sidebar}
        {main}
        {view.kind === 'note' ? Info : null}
      </div>
      {dialog && dialog.type === 'prompt' ? <PromptDialog {...dialog} onCancel={() => setDialog(null)} /> : null}
      {dialog && dialog.type === 'confirm' ? <ConfirmDialog {...dialog} onCancel={() => setDialog(null)} /> : null}
      {dialog && dialog.type === 'encrypt' ? <EncryptDialog {...dialog} onCancel={() => setDialog(null)} /> : null}
      {dialog && dialog.type === 'unlock' ? <UnlockDialog {...dialog} onCancel={dialog.onCancel || (() => setDialog(null))} /> : null}
      {dialog && dialog.type === 'capture' ? <CaptureDialog onClose={() => setDialog(null)} onDone={(p) => { setDialog(null); say('Captured to ' + p); loadTree() }} /> : null}
      {dialog && dialog.type === 'template' ? (
        <Modal title="New from template" onClose={() => setDialog(null)}>
          {dialog.templates.map((t) => <span key={t.path} className="nk-link" onClick={() => useTemplate(t)}>{t.title} <small className="nk-path">{t.path}</small></span>)}
        </Modal>
      ) : null}
      {dialog && dialog.type === 'ocr' ? (
        <Modal title="Extracted text" onClose={() => setDialog(null)} footer={<button type="button" className="nk-btn" onClick={() => { navigator.clipboard && navigator.clipboard.writeText(dialog.text); say('Copied.') }}>Copy</button>}>
          <textarea className="nk-input" style={{ minHeight: 200, fontFamily: 'var(--nk-mono)' }} readOnly value={dialog.text || '(no text recognised)'} />
        </Modal>
      ) : null}
      {dialog && dialog.type === 'connect' ? <ConnectDialog vaultPath={(status && status.vault) || tree.root} onClose={() => setDialog(null)} /> : null}
      {dialog && dialog.type === 'import' ? <ImportDialog defaultDir="Imported" onClose={() => setDialog(null)}
        onDone={(st) => { loadTree(); loadSide(); say('Imported ' + st.notes + ' notes and ' + st.attachments + ' attachments' + (st.errors.length ? ' (' + st.errors.length + ' errors)' : '') + '.', st.errors.length > 0) }} /> : null}
      {menu ? <Menu {...menu} onClose={() => setMenu(null)} /> : null}
      {toast ? <div className={'nk-toast' + (toast.err ? ' nk-errt' : '')} role="status">{toast.text}</div> : null}
    </div>
  )
}

/** Decrypts an encrypted attachment for preview/download on demand. */
function SealedView({ path, getKey }) {
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  const name = baseOf(path).replace(/\.nkenc$/, '')
  const kind = fileKind({ path: name })
  const open = async () => {
    try {
      const key = await getKey()
      const bytes = await openBlob(key, await api.fileBytes(path))
      const type = kind === 'image' ? 'image/' + (name.split('.').pop() === 'jpg' ? 'jpeg' : name.split('.').pop()) : kind === 'audiofile' ? 'audio/webm' : kind === 'pdf' ? 'application/pdf' : 'application/octet-stream'
      setUrl(URL.createObjectURL(new Blob([bytes], { type })))
    } catch (e) { if (e.message !== 'cancelled') setErr(errText(e)) }
  }
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  if (!url) return <div><p>Encrypted attachment <b>{name}</b>.</p><button type="button" className="nk-btn nk-primary" onClick={open}>Decrypt and show</button>{err ? <p style={{ color: 'var(--nk-err)' }}>{err}</p> : null}</div>
  return (
    <div style={{ width: '100%' }}>
      {kind === 'image' ? <img src={url} alt={name} /> : kind === 'audiofile' ? <audio controls src={url} style={{ width: '100%' }} /> : null}
      <p><a className="nk-btn" href={url} download={name}>Save decrypted copy</a></p>
    </div>
  )
}

/** Quick capture: one line (or a few) into the Inbox, optionally as a task. */
function CaptureDialog({ onClose, onDone }) {
  const [text, setText] = useState('')
  const [todo, setTodo] = useState(false)
  const [err, setErr] = useState('')
  const send = async () => {
    if (!text.trim()) return
    try { const r = await api.capture(text, todo); onDone(r.path) } catch (e) { setErr(errText(e)) }
  }
  return (
    <Modal title="Quick capture" onClose={onClose} footer={<>
      <label className="nk-check" style={{ marginRight: 'auto' }}><input type="checkbox" checked={todo} onChange={(e) => setTodo(e.target.checked)} /> as task</label>
      <button type="button" className="nk-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nk-btn nk-primary" disabled={!text.trim()} onClick={send}>Capture (Ctrl+Enter)</button>
    </>}>
      <textarea className="nk-input" style={{ minHeight: 110 }} autoFocus value={text} placeholder="A thought, a link, a to-do…"
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send() }} />
      {err ? <div style={{ color: 'var(--nk-err)' }}>{err}</div> : null}
    </Modal>
  )
}
