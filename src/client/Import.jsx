/**
 * Import dialog: bring existing notes into the vault. Files are uploaded one
 * by one to POST /import, where the Go importer converts them:
 *   Markdown / text, HTML, Evernote .enex, Google Keep Takeout (.json/.zip),
 *   Notion export (.zip: IDs stripped, links rewritten to [[wikilinks]]),
 *   Obsidian / Bear / Logseq / Joplin Markdown folders or zips,
 *   plus any attachment type.
 * A picked folder keeps its structure under the destination folder.
 */
import * as React from 'react'
import { api } from './api.js'
import { Modal } from './ui.jsx'

const { useState } = React

const SOURCES = [
  ['Obsidian vault', 'Pick the vault folder (or a .zip of it). .obsidian settings are skipped.'],
  ['Notion', 'Settings → Export → Markdown & CSV, include subpages. Import the .zip as is.'],
  ['Evernote', 'Export notebooks as .enex files (images and attachments included).'],
  ['Apple Notes', 'Export with the free "Exporter" app (Markdown) or print to HTML, then import the folder.'],
  ['Google Keep', 'Google Takeout → Keep → import the .zip (labels become tags, checklists become tasks).'],
  ['Bear / Logseq / Joplin / others', 'Export as Markdown (or HTML) and import the folder or .zip.'],
]

export function ImportDialog({ onClose, defaultDir = 'Imported', onDone }) {
  const [dir, setDir] = useState(defaultDir)
  const [files, setFiles] = useState([]) // { file, rel }
  const [prog, setProg] = useState(null) // { done, total, notes, attachments, skipped: [], errors: [] }
  const busy = prog && prog.done < prog.total

  const pick = (list, fromFolder) => {
    const arr = Array.from(list || []).filter((f) => !/(^|\/)\.(DS_Store|obsidian|trash|git)(\/|$)/.test(f.webkitRelativePath || f.name))
    setFiles(arr.map((f) => ({ file: f, rel: fromFolder && f.webkitRelativePath ? f.webkitRelativePath : f.name })))
    setProg(null)
  }

  const run = async () => {
    const base = dir.trim().replace(/^\/+|\/+$/g, '')
    const state = { done: 0, total: files.length, notes: 0, attachments: 0, skipped: [], errors: [], created: [] }
    setProg({ ...state })
    for (const { file, rel } of files) {
      const parts = rel.split('/')
      const name = parts.pop()
      const sub = [base, ...parts].filter(Boolean).join('/')
      try {
        const r = await api.importFile(file, name, sub)
        state.notes += r.Notes || r.notes || 0
        state.attachments += r.Attachments || r.attachments || 0
        for (const s of r.Skipped || r.skipped || []) state.skipped.push((s.Path || s.path) + ': ' + (s.Reason || s.reason))
        for (const c of r.Created || r.created || []) if (state.created.length < 5) state.created.push(c)
      } catch (e) { state.errors.push(rel + ': ' + (e.message || e)) }
      state.done++
      setProg({ ...state })
    }
    onDone && onDone(state)
  }

  return (
    <Modal title="Import notes" onClose={busy ? undefined : onClose} wide footer={<>
      <button type="button" className="nk-btn" disabled={busy} onClick={onClose}>{prog && !busy ? 'Close' : 'Cancel'}</button>
      <button type="button" className="nk-btn nk-primary" disabled={!files.length || busy} onClick={run}>{busy ? 'Importing…' : 'Import ' + (files.length || '')}</button>
    </>}>
      <div className="nk-row2">
        <label className="nk-btn">Choose files…<input type="file" multiple hidden onChange={(e) => pick(e.target.files, false)} /></label>
        <label className="nk-btn">Choose a folder…<input type="file" multiple hidden webkitdirectory="" directory="" onChange={(e) => pick(e.target.files, true)} /></label>
        <label className="nk-field" style={{ flex: 1 }}>Into folder
          <input className="nk-input" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="(vault root)" />
        </label>
      </div>
      <p className="nk-path">{files.length ? files.length + ' file(s) selected: ' + files.slice(0, 4).map((f) => f.rel).join(', ') + (files.length > 4 ? '…' : '') : 'Supported: .md .txt .html .enex .json (Keep) .csv .zip (Notion, Obsidian, Keep Takeout) and any attachment.'}</p>
      {prog ? (
        <div className="nk-importprog" role="status">
          <progress max={prog.total} value={prog.done} />
          <span>{prog.done}/{prog.total} files · {prog.notes} notes · {prog.attachments} attachments{prog.skipped.length ? ' · ' + prog.skipped.length + ' skipped' : ''}</span>
          {prog.errors.length ? <details open><summary>{prog.errors.length} error(s)</summary><pre className="nk-diff">{prog.errors.join('\n')}</pre></details> : null}
          {prog.skipped.length ? <details><summary>Skipped</summary><pre className="nk-diff">{prog.skipped.slice(0, 200).join('\n')}</pre></details> : null}
        </div>
      ) : (
        <table className="nk-devices"><tbody>{SOURCES.map(([k, v]) => <tr key={k}><td><b>{k}</b></td><td>{v}</td></tr>)}</tbody></table>
      )}
      <p className="nk-path" style={{ whiteSpace: 'normal' }}>Existing notes are never overwritten: name clashes get a number. Imports into encrypted folders are refused (encrypt after importing).</p>
    </Modal>
  )
}
