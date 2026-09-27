/**
 * "AI Enhance" toolbar control: a small button that proofreads, formats and
 * interlinks the open note with a DSH model, plus a gear that opens the AI
 * settings (model choice, what to do). The result is always previewed as a
 * diff; nothing changes until the user applies it (and Ctrl+Z undoes it).
 */
import * as React from 'react'
import { api } from './api.js'
import { Modal } from './ui.jsx'
import { diffLines, diffStats } from './diff.js'

const { useState, useEffect, useMemo } = React

const Sparkle = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" shapeRendering="crispEdges">
    <path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4" /><path d="M12.5 1.5v2M11.5 2.5h2M3.5 12.5v2M2.5 13.5h2" />
  </svg>
)
const Gear = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <circle cx="8" cy="8" r="2.4" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </svg>
)

const routeLabel = (s) => {
  if (!s) return ''
  if (s.provider && s.model) return s.provider + ' / ' + s.model
  return s.default ? 'DSH default (' + s.default.provider + ' / ' + s.default.model + ')' : 'DSH default'
}

export function AiEnhanceButton({ getText, title, disabled, disabledReason, onApply, say }) {
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null) // { before, after, added, model }
  const [settingsOpen, setSettingsOpen] = useState(false)

  const run = async () => {
    const before = getText()
    setBusy(true)
    try {
      const r = await api.aiEnhance(before, title)
      if (r.text === before) say('AI Enhance: the note already looks good, nothing to change.')
      else setPreview({ before, after: r.text, added: r.added || [], model: r.model })
    } catch (e) {
      say('AI Enhance failed: ' + (e.message || e), true)
    } finally { setBusy(false) }
  }

  return (
    <>
      <span className={'nk-ai' + (busy ? ' nk-busy' : '')}>
        <button type="button" className="nk-ai-main" disabled={disabled || busy} onClick={run}
          title={disabled ? disabledReason : 'AI Enhance: fix spelling, format Markdown and link related notes (preview first)'}>
          <Sparkle /><span>{busy ? 'Enhancing…' : 'AI Enhance'}</span>
        </button>
        <button type="button" className="nk-ai-gear" title="AI settings" aria-label="AI settings" onClick={() => setSettingsOpen(true)}><Gear /></button>
      </span>
      {settingsOpen ? <AiSettingsDialog onClose={() => setSettingsOpen(false)} say={say} /> : null}
      {preview ? (
        <AiPreviewDialog {...preview} onClose={() => setPreview(null)}
          onApply={() => {
            // Apply only if the note did not change while the model was working.
            if (getText() !== preview.before) { say('The note changed while AI Enhance was running: run it again.', true); setPreview(null); return }
            onApply(preview.after)
            setPreview(null)
            say('AI Enhance applied' + (preview.added.length ? ' (' + preview.added.length + ' new link' + (preview.added.length > 1 ? 's' : '') + ')' : '') + '. Ctrl+Z undoes it.')
          }} />
      ) : null}
    </>
  )
}

function AiPreviewDialog({ before, after, added, model, onClose, onApply }) {
  const d = useMemo(() => diffLines(before, after), [before, after])
  const st = diffStats(d)
  const [view, setView] = useState('diff')
  return (
    <Modal title="AI Enhance: review changes" onClose={onClose} wide footer={<>
      <span className="nk-path" style={{ marginRight: 'auto' }}>{model ? model.provider + ' / ' + model.model : ''} · +{st.add} −{st.del}{added.length ? ' · links: ' + added.join(', ') : ''}</span>
      <button type="button" className="nk-btn" onClick={onClose}>Discard</button>
      <button type="button" className="nk-btn nk-primary" onClick={onApply}>Apply</button>
    </>}>
      <div className="nk-seg">
        <button type="button" className={view === 'diff' ? 'nk-on' : ''} onClick={() => setView('diff')}>Changes</button>
        <button type="button" className={view === 'after' ? 'nk-on' : ''} onClick={() => setView('after')}>Result</button>
      </div>
      {view === 'diff' ? (
        <pre className="nk-diff">{d.map((r, i) => <div key={i} className={'nk-diff-' + r.type}>{r.type === 'add' ? '+ ' : r.type === 'del' ? '− ' : '  '}{r.text || ' '}</div>)}</pre>
      ) : (
        <pre className="nk-diff">{after}</pre>
      )}
    </Modal>
  )
}

export function AiSettingsDialog({ onClose, say }) {
  const [s, setS] = useState(null)
  const [models, setModels] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    api.aiSettings().then(setS).catch((e) => setErr(e.message))
    api.aiModels().then(setModels).catch(() => setModels({ models: [] }))
  }, [])
  if (!s) return <Modal title="AI settings" onClose={onClose}>{err || 'Loading…'}</Modal>
  const route = s.provider && s.model ? s.provider + '\u0000' + s.model : ''
  const save = async () => {
    try { await api.aiSaveSettings(s); say('AI settings saved.'); onClose() } catch (e) { setErr(e.message) }
  }
  const byProvider = {}
  for (const m of (models && models.models) || []) (byProvider[m.providerName] = byProvider[m.providerName] || []).push(m)
  return (
    <Modal title="AI settings" onClose={onClose} footer={<>
      <button type="button" className="nk-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="nk-btn nk-primary" onClick={save}>Save</button>
    </>}>
      <label className="nk-field">Model
        <select className="nk-input" value={route} onChange={(e) => {
          const v = e.target.value
          if (!v) setS({ ...s, provider: '', model: '' })
          else { const [provider, model] = v.split('\u0000'); setS({ ...s, provider, model }) }
        }}>
          <option value="">{'DSH default for new chats' + (s.default ? ' (' + s.default.provider + ' / ' + s.default.model + ')' : '')}</option>
          {Object.entries(byProvider).map(([p, list]) => (
            <optgroup key={p} label={p}>{list.map((m) => <option key={m.provider + m.id} value={m.provider + '\u0000' + m.id}>{m.name}</option>)}</optgroup>
          ))}
          {route && !((models && models.models) || []).some((m) => m.provider + '\u0000' + m.id === route) ? <option value={route}>{s.provider} / {s.model}</option> : null}
        </select>
      </label>
      {models === null ? <small className="nk-path">Loading models…</small> : null}
      <label className="nk-check"><input type="checkbox" checked={s.fixSpelling} onChange={(e) => setS({ ...s, fixSpelling: e.target.checked })} /> Fix spelling, grammar and punctuation</label>
      <label className="nk-check"><input type="checkbox" checked={s.format} onChange={(e) => setS({ ...s, format: e.target.checked })} /> Format Markdown (headings, lists, tables)</label>
      <label className="nk-check"><input type="checkbox" checked={s.addLinks} onChange={(e) => setS({ ...s, addLinks: e.target.checked })} /> Link related notes with [[wikilinks]]</label>
      <label className="nk-field">Extra instruction (optional)
        <textarea className="nk-input" style={{ minHeight: 70 }} value={s.custom} maxLength={1000} placeholder="e.g. Use British English. Keep it short."
          onChange={(e) => setS({ ...s, custom: e.target.value })} />
      </label>
      <p className="nk-path" style={{ whiteSpace: 'normal' }}>The note (without frontmatter) and the titles of your notes are sent to the selected model. Encrypted notes are never sent. Current: {routeLabel(s)}.</p>
      {err ? <div style={{ color: 'var(--nk-err)' }}>{err}</div> : null}
    </Modal>
  )
}
