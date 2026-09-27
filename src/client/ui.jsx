/**
 * Small UI primitives shared by every Note Keeper view: pixel icons, modal,
 * context menu, prompt/confirm dialogs, and the encryption dialogs that carry
 * the mandatory data-loss warning.
 */
import * as React from 'react'

const { useState, useEffect, useRef } = React

/** 16px pixel-style icons (stroke = currentColor, crisp edges). */
const P = {
  note: 'M3 1.5h7l3 3v10H3z M10 1.5v3h3 M5 8h6 M5 10.5h6 M5 13h4',
  folder: 'M1.5 3.5h5l1.5 1.5h6.5v8.5h-13z',
  folderOpen: 'M1.5 3.5h5l1.5 1.5h5v2 M1.5 13.5l2-6.5h11l-2 6.5z M1.5 3.5v10',
  audio: 'M6 11.5V3l7-1.5v8.5 M6 11.5a2 2 0 1 1-4 0a2 2 0 1 1 4 0z M13 10a2 2 0 1 1-4 0a2 2 0 1 1 4 0z',
  draw: 'M2 14l1-4 8-8 3 3-8 8z M9.5 3.5l3 3',
  file: 'M3 1.5h7l3 3v10H3z M10 1.5v3h3',
  image: 'M1.5 2.5h13v11h-13z M1.5 11l4-4 3 3 2-2 4 4 M10.5 5.5h1',
  lock: 'M4 7.5h8v7H4z M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5 M8 10v2',
  unlock: 'M4 7.5h8v7H4z M5.5 7.5V5a2.5 2.5 0 0 1 5 0 M8 10v2',
  search: 'M7 2.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9z M10.2 10.2l4 4',
  tag: 'M1.5 1.5h6l7 7-6 6-7-7z M4.5 4.5h1',
  graph: 'M3 3h2v2H3z M11 2h2v2h-2z M7 11h2v2H7z M4 5l3.5 6 M12 4l-3.5 7 M5 4h6',
  plus: 'M8 2.5v11 M2.5 8h11',
  mic: 'M6 1.5h4v8H6z M3.5 7.5a4.5 4.5 0 0 0 9 0 M8 12v2.5 M5.5 14.5h5',
  inbox: 'M1.5 9.5l2-7h9l2 7v4h-13z M1.5 9.5h4l1 2h3l1-2h4',
  day: 'M2 3.5h12v11H2z M2 6.5h12 M5 1.5v3 M11 1.5v3 M5 9h2v2H5z',
  clip: 'M11 5l-5.5 5.5a1.5 1.5 0 0 0 2 2L13 7a3 3 0 0 0-4-4L3.5 8.5a4.5 4.5 0 0 0 6 6L14 10',
  trash: 'M2.5 4h11 M6 4V2h4v2 M3.5 4l1 10.5h7l1-10.5 M6.5 6.5v6 M9.5 6.5v6',
  more: 'M3 8h1 M8 8h1 M13 8h1',
  close: 'M3 3l10 10 M13 3L3 13',
  eye: 'M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z M8 6a2 2 0 1 1 0 4a2 2 0 1 1 0-4z',
  split: 'M1.5 2.5h13v11h-13z M8 2.5v11',
  edit: 'M2 14l1-4 8-8 3 3-8 8z',
  menu: 'M2 4h12 M2 8h12 M2 12h12',
  bold: 'M4 2.5h5a2.8 2.8 0 0 1 0 5.5H4z M4 8h5.5a3 3 0 0 1 0 6H4z',
  italic: 'M6.5 2.5h6 M3.5 13.5h6 M9.5 2.5l-3 11',
  h: 'M3 2.5v11 M11 2.5v11 M3 8h8',
  list: 'M5.5 4h9 M5.5 8h9 M5.5 12h9 M2 4h1 M2 8h1 M2 12h1',
  task: 'M1.5 2.5h5v5h-5z M2.5 5l1.5 1.5 3-3 M9 5h5.5 M1.5 9.5h5v5h-5z M9 12h5.5',
  link: 'M6.5 9.5l3-3 M7 4.5l1.5-1.5a2.8 2.8 0 0 1 4 4L11 8.5 M9 11.5l-1.5 1.5a2.8 2.8 0 0 1-4-4L5 7.5',
  code: 'M5 4L1.5 8 5 12 M11 4l3.5 4-3.5 4',
  table: 'M1.5 2.5h13v11h-13z M1.5 6h13 M1.5 9.5h13 M6 2.5v11',
  quote: 'M2.5 4h4v4h-4z M2.5 8c0 2-1 3-1 4 M9.5 4h4v4h-4z M9.5 8c0 2-1 3-1 4',
  ocr: 'M1.5 5V1.5H5 M11 1.5h3.5V5 M14.5 11v3.5H11 M5 14.5H1.5V11 M4.5 5.5h7 M8 5.5v5',
  refresh: 'M13 3v3.5H9.5 M13 6.5A5.5 5.5 0 1 0 13.5 10',
  import: 'M8 1.5v8 M4.5 6.5L8 10l3.5-3.5 M2 10.5v4h12v-4',
  connect: 'M1.5 5.5h4v5h-4z M10.5 5.5h4v5h-4z M5.5 8h5 M8 3v2 M8 11v2',
  template: 'M2 2h12v3H2z M2 7h5v7H2z M9 7h5v3H9z M9 12h5v2H9z',
}

export function Icon({ name, size = 16, title }) {
  const d = P[name] || P.file
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" shapeRendering="crispEdges" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  )
}

export function IBtn({ icon, title, onClick, active, disabled, className }) {
  return (
    <button type="button" className={'nk-ibtn' + (active ? ' nk-on' : '') + (className ? ' ' + className : '')} title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
  )
}

export function Modal({ title, children, footer, onClose, wide }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && onClose) { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="nk-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && onClose) onClose() }}>
      <div className="nk-modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { width: 'min(760px,100%)' } : undefined}>
        <div className="nk-modal-h"><span>{title}</span><span className="nk-spacer" />{onClose ? <IBtn icon="close" title="Close" onClick={onClose} /> : null}</div>
        <div className="nk-modal-b">{children}</div>
        {footer ? <div className="nk-modal-f">{footer}</div> : null}
      </div>
    </div>
  )
}

/** Text prompt dialog. */
export function PromptDialog({ title, label, initial = '', placeholder, okLabel = 'OK', onOk, onCancel }) {
  const [v, setV] = useState(initial)
  const ref = useRef(null)
  useEffect(() => { const el = ref.current; if (el) { el.focus(); el.select() } }, [])
  const ok = () => { if (v.trim()) onOk(v.trim()) }
  return (
    <Modal title={title} onClose={onCancel} footer={<>
      <button type="button" className="nk-btn" onClick={onCancel}>Cancel</button>
      <button type="button" className="nk-btn nk-primary" onClick={ok} disabled={!v.trim()}>{okLabel}</button>
    </>}>
      <label className="nk-field">{label}
        <input ref={ref} className="nk-input" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') ok() }} />
      </label>
    </Modal>
  )
}

export function ConfirmDialog({ title, message, okLabel = 'OK', danger, onOk, onCancel }) {
  return (
    <Modal title={title} onClose={onCancel} footer={<>
      <button type="button" className="nk-btn" onClick={onCancel}>Cancel</button>
      <button type="button" className={'nk-btn ' + (danger ? 'nk-danger' : 'nk-primary')} onClick={onOk} autoFocus>{okLabel}</button>
    </>}>
      <div>{message}</div>
    </Modal>
  )
}

/** Context menu at viewport coordinates. items: [{label, onClick} | '-'] */
export function Menu({ x, y, items, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ x, y })
  useEffect(() => {
    const el = ref.current
    if (el) {
      const r = el.getBoundingClientRect()
      setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) })
    }
    const close = (e) => { if (!el || !el.contains(e.target)) onClose() }
    const key = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', onClose) }
  }, [])
  return (
    <div className="nk-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {items.filter(Boolean).map((it, i) => it === '-' ? <hr key={i} /> : (
        <button key={i} type="button" role="menuitem" onClick={() => { onClose(); it.onClick() }}>{it.label}</button>
      ))}
    </div>
  )
}

/** Exact wording required by the product specification. */
export const LOSS_WARNING = 'Warning: Loss of the password results in permanent, unrecoverable data loss.'

export function passwordStrength(pw) {
  let s = 0
  if (pw.length >= 8) s++
  if (pw.length >= 12) s++
  if (pw.length >= 16) s++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++
  if (/\d/.test(pw)) s++
  if (/[^\w\s]/.test(pw) || /[^\x00-\x7f]/.test(pw)) s++
  return Math.min(4, Math.floor(s * 4 / 6))
}

/**
 * Set-up dialog for encrypting a note or folder. The loss warning is shown
 * prominently and must be acknowledged; the password must be typed twice.
 */
export function EncryptDialog({ target, kind, onOk, onCancel, busy, progress }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [hint, setHint] = useState('')
  const [ack, setAck] = useState(false)
  const strength = passwordStrength(pw)
  const colors = ['var(--nk-err)', 'var(--nk-err)', 'var(--nk-warn)', 'var(--nk-ok)', 'var(--nk-ok)']
  const valid = pw.length >= 8 && pw === pw2 && ack && !(hint && pw && hint.toLowerCase().includes(pw.toLowerCase()))
  return (
    <Modal title={'Encrypt ' + kind} onClose={busy ? undefined : onCancel} footer={<>
      <button type="button" className="nk-btn" onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="button" className="nk-btn nk-primary" disabled={!valid || busy} onClick={() => onOk({ password: pw, hint })}>{busy ? 'Encrypting…' : 'Encrypt'}</button>
    </>}>
      <div className="nk-danger-box" role="alert"><span className="nk-bang">!</span><span>{LOSS_WARNING}</span></div>
      <div style={{ fontSize: 13, color: 'var(--nk-fg2)' }}>
        <b>{target}</b> will be encrypted in this browser with AES-256-GCM (key from your password via PBKDF2-SHA-256, 600,000 rounds).
        The server, Obsidian, sync services and AI models only ever see ciphertext. There is no reset link and no recovery key.
        {kind === 'folder' ? ' Every note and attachment in the folder is encrypted, and anything added later is encrypted automatically. File and folder names stay visible.' : ' The file name stays visible.'}
      </div>
      <label className="nk-field">Password (min. 8 characters)
        <input className="nk-input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        <div className="nk-strength"><i style={{ width: (pw ? (strength + 1) * 20 : 0) + '%', background: colors[strength] }} /></div>
      </label>
      <label className="nk-field">Repeat password
        <input className="nk-input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        {pw2 && pw !== pw2 ? <span style={{ color: 'var(--nk-err)' }}>Passwords do not match.</span> : null}
      </label>
      <label className="nk-field">Hint (optional, stored in plain text - never the password itself)
        <input className="nk-input" value={hint} maxLength={120} onChange={(e) => setHint(e.target.value)} />
      </label>
      <label className="nk-check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I understand that if I lose this password my data cannot be recovered by anyone.</span></label>
      {progress ? <div className="nk-meter"><i style={{ width: progress + '%' }} /></div> : null}
    </Modal>
  )
}

/** Password prompt used to unlock a note or folder for this browser session. */
export function UnlockDialog({ target, hint, onOk, onCancel, error, busy }) {
  const [pw, setPw] = useState('')
  return (
    <Modal title="Unlock" onClose={onCancel} footer={<>
      <button type="button" className="nk-btn" onClick={onCancel}>Cancel</button>
      <button type="button" className="nk-btn nk-primary" disabled={!pw || busy} onClick={() => onOk(pw)}>{busy ? 'Unlocking…' : 'Unlock'}</button>
    </>}>
      <div style={{ fontSize: 13 }}>Enter the password for <b>{target}</b>. It stays in this tab's memory only and is forgotten after 10 idle minutes or when you press Lock.</div>
      {hint ? <div style={{ fontSize: 12, color: 'var(--nk-fg3)' }}>Hint: {hint}</div> : null}
      <input className="nk-input" type="password" autoComplete="current-password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && pw) onOk(pw) }} />
      {error ? <div style={{ color: 'var(--nk-err)', fontSize: 13 }}>{error}</div> : null}
    </Modal>
  )
}
