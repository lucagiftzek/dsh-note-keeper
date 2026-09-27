/**
 * Audio note recorder: MediaRecorder capture with a live level meter, pause,
 * playback check, or an uploaded audio file. The caller (App) uploads the
 * audio, runs speech-to-text and writes the transcript note.
 *
 * Language choice is explicit because it matters: Greek goes to
 * whisper-large-v3 (word-exact Greek in the estate's measurements) with the
 * language pinned, English/Italian likewise; "auto" lets the engine detect.
 */
import * as React from 'react'
import { Icon } from './ui.jsx'

const { useState, useEffect, useRef } = React

export const LANGS = [
  ['el', 'Ελληνικά (Greek)'],
  ['en', 'English'],
  ['auto', 'Auto-detect'],
  ['it', 'Italiano (Italian)'],
  ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['nl', 'Dutch'],
]

/** Pick the best container the browser can record. */
export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

const fmt = (s) => {
  s = Math.floor(s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + ss
}

export function Recorder({ onSave, onCancel, busy, defaultLang }) {
  const [lang, setLang] = useState(defaultLang || 'el')
  const [state, setState] = useState('idle') // idle | recording | paused | done
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [blob, setBlob] = useState(null)
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  const [title, setTitle] = useState('')
  const [doPolish, setDoPolish] = useState(false)
  const rec = useRef(null)
  const chunks = useRef([])
  const stream = useRef(null)
  const audioCtx = useRef(null)
  const raf = useRef(0)
  const clock = useRef({ start: 0, acc: 0 })
  const tick = useRef(0)

  const cleanup = () => {
    cancelAnimationFrame(raf.current)
    clearInterval(tick.current)
    if (stream.current) stream.current.getTracks().forEach((t) => t.stop())
    stream.current = null
    if (audioCtx.current) { try { audioCtx.current.close() } catch { /* closed */ } audioCtx.current = null }
  }
  useEffect(() => () => { cleanup(); if (url) URL.revokeObjectURL(url) }, [])

  const start = async () => {
    setErr('')
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot record audio (needs HTTPS or localhost).')
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
      stream.current = s
      const mime = pickMime()
      // 48 kbit/s Opus: speech stays crisp and 1 hour is ~21 MB, under the
      // 25 MB upload cap of the hosted Whisper engines.
      const r = new MediaRecorder(s, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined)
      chunks.current = []
      r.ondataavailable = (e) => { if (e.data && e.data.size) chunks.current.push(e.data) }
      r.onstop = () => {
        const b = new Blob(chunks.current, { type: r.mimeType || mime || 'audio/webm' })
        setBlob(b)
        setUrl(URL.createObjectURL(b))
        setState('done')
        cleanup()
      }
      r.start(1000)
      rec.current = r
      // Level meter from an analyser node.
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (Ctx) {
        const ctx = new Ctx()
        audioCtx.current = ctx
        const an = ctx.createAnalyser()
        an.fftSize = 512
        ctx.createMediaStreamSource(s).connect(an)
        const buf = new Uint8Array(an.fftSize)
        const loop = () => {
          an.getByteTimeDomainData(buf)
          let peak = 0
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
          setLevel(Math.min(100, (peak / 128) * 160))
          raf.current = requestAnimationFrame(loop)
        }
        loop()
      }
      clock.current = { start: Date.now(), acc: 0 }
      tick.current = setInterval(() => setElapsed((clock.current.acc + (clock.current.start ? Date.now() - clock.current.start : 0)) / 1000), 250)
      setState('recording')
    } catch (e) {
      cleanup()
      setErr(e && e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : String(e && e.message || e))
    }
  }
  const pause = () => {
    const r = rec.current
    if (!r) return
    if (state === 'recording') { r.pause(); clock.current.acc += Date.now() - clock.current.start; clock.current.start = 0; setState('paused') }
    else { r.resume(); clock.current.start = Date.now(); setState('recording') }
  }
  const stop = () => { const r = rec.current; if (r && r.state !== 'inactive') r.stop() }
  const reset = () => { if (url) URL.revokeObjectURL(url); setBlob(null); setUrl(''); setElapsed(0); setState('idle') }
  const pickFile = (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    if (url) URL.revokeObjectURL(url)
    setBlob(f)
    setUrl(URL.createObjectURL(f))
    setTitle(f.name.replace(/\.[^.]+$/, ''))
    setState('done')
    const a = new Audio()
    a.preload = 'metadata'
    a.onloadedmetadata = () => { if (Number.isFinite(a.duration)) setElapsed(a.duration) }
    a.src = URL.createObjectURL(f)
  }
  const save = (transcribe) => onSave({ blob, lang, duration: Math.round(elapsed), transcribe, polish: doPolish, title: title.trim() })

  return (
    <div className="nk-rec">
      <div className="nk-h">Audio note</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="nk-field" style={{ minWidth: 200 }}>Spoken language
          <select className="nk-input" value={lang} onChange={(e) => setLang(e.target.value)} disabled={state === 'recording'}>
            {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="nk-field" style={{ flex: 1, minWidth: 200 }}>Title (optional)
          <input className="nk-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Recording YYYY-MM-DD HH:MM" />
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {state === 'recording' ? <span className="nk-rec-dot" aria-label="recording" /> : null}
        <span className="nk-rec-time" aria-live="polite">{fmt(elapsed)}</span>
        <div className="nk-meter" style={{ flex: 1 }}><i style={{ width: (state === 'recording' ? level : 0) + '%' }} /></div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {state === 'idle' ? <>
          <button type="button" className="nk-btn nk-primary" onClick={start}><Icon name="mic" /> Record</button>
          <label className="nk-btn"><Icon name="clip" /> Transcribe a file…<input type="file" accept="audio/*,video/webm,video/mp4" hidden onChange={pickFile} /></label>
        </> : null}
        {state === 'recording' || state === 'paused' ? <>
          <button type="button" className="nk-btn" onClick={pause}>{state === 'paused' ? 'Resume' : 'Pause'}</button>
          <button type="button" className="nk-btn nk-primary" onClick={stop}>Stop</button>
        </> : null}
        {state === 'done' ? <>
          <button type="button" className="nk-btn nk-primary" disabled={busy} onClick={() => save(true)}>{busy ? 'Working…' : 'Transcribe & save'}</button>
          <button type="button" className="nk-btn" disabled={busy} onClick={() => save(false)}>Save audio only</button>
          <button type="button" className="nk-btn" disabled={busy} onClick={reset}>Discard</button>
        </> : null}
        <span className="nk-spacer" />
        <button type="button" className="nk-btn" onClick={() => { stop(); cleanup(); onCancel() }} disabled={busy}>Close</button>
      </div>
      {state === 'done' && url ? <audio controls src={url} style={{ width: '100%' }} /> : null}
      {state === 'done' ? <label className="nk-check"><input type="checkbox" checked={doPolish} onChange={(e) => setDoPolish(e.target.checked)} /><span>Clean up punctuation and casing after transcription (keeps the raw transcript too)</span></label> : null}
      {err ? <div style={{ color: 'var(--nk-err)' }}>{err}</div> : null}
      <div style={{ fontSize: 12, color: 'var(--nk-fg3)' }}>
        Transcription runs through the estate's speech service (dsh-voice): Greek and English are pinned to their language for accuracy.
        The note is saved as Markdown with metadata (language, engine, duration) and embeds the recording, so Obsidian plays it too.
      </div>
    </div>
  )
}
