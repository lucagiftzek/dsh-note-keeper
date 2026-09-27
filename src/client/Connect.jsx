/**
 * "Connect" dialog: every way to get notes in and out of this vault from
 * other apps and devices, in one place.
 *   Obsidian  - pairing code for the Note Keeper Sync plugin (desktop + mobile)
 *   WebDAV    - app passwords for Remotely Save, Cyberduck, Files apps, rclone
 *   Cloud     - two-way mirror with Google Drive / OneDrive / Dropbox /
 *               iCloud Drive / S3 through rclone on the server
 *   Other     - Obsidian on this machine, Syncthing, iCloud/Drive desktop apps
 *   Devices   - everything paired, with revoke
 */
import * as React from 'react'
import { api } from './api.js'
import { Modal } from './ui.jsx'

const { useState, useEffect, useCallback } = React
const REPO = 'lucagiftzek/dsh-note-keeper'
const ago = (ms) => {
  if (!ms) return 'never'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return Math.round(s / 60) + ' min ago'
  if (s < 129600) return Math.round(s / 3600) + ' h ago'
  return new Date(ms).toLocaleDateString()
}

function Copy({ text, label }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="nk-btn nk-sm" onClick={() => { navigator.clipboard && navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
      {done ? 'Copied' : label || 'Copy'}
    </button>
  )
}

export function ConnectDialog({ onClose, vaultPath, initialTab = 'obsidian' }) {
  const [tab, setTab] = useState(initialTab)
  const [st, setSt] = useState(null)
  const [err, setErr] = useState('')
  const refresh = useCallback(() => api.syncStatus().then(setSt).catch((e) => setErr(e.message)), [])
  useEffect(() => { refresh() }, [refresh])
  const tabs = [['obsidian', 'Obsidian'], ['webdav', 'WebDAV apps'], ['cloud', 'Cloud drives'], ['other', 'Other ways'], ['devices', 'Devices']]
  return (
    <Modal title="Connect apps and devices" onClose={onClose} wide>
      <div className="nk-seg" role="tablist">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'nk-on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {err ? <div className="nk-banner nk-warnb">{err}</div> : null}
      {st && !st.enabled && tab !== 'other' ? <div className="nk-banner nk-warnb">Remote sync is switched off on this server (config key <code>syncAddr</code>).</div> : null}
      {tab === 'obsidian' ? <ObsidianTab st={st} onChange={refresh} /> : null}
      {tab === 'webdav' ? <WebDAVTab st={st} onChange={refresh} /> : null}
      {tab === 'cloud' ? <CloudTab onChange={refresh} /> : null}
      {tab === 'other' ? <OtherTab vaultPath={vaultPath} /> : null}
      {tab === 'devices' ? <DevicesTab st={st} onChange={refresh} /> : null}
    </Modal>
  )
}

function ObsidianTab({ st, onChange }) {
  const [pair, setPair] = useState(null)
  const [err, setErr] = useState('')
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (!pair) return undefined
    const t = setInterval(() => setLeft(Math.max(0, Math.round((pair.expires - Date.now()) / 1000))), 1000)
    return () => clearInterval(t)
  }, [pair])
  const make = async () => {
    setErr('')
    try { const p = await api.syncPair(); setPair(p); setLeft(Math.round((p.expires - Date.now()) / 1000)) } catch (e) { setErr(e.message) }
  }
  const url = (pair && pair.url) || (st && st.url) || ''
  return (
    <div className="nk-connect">
      <p>Two-way, real-time sync between this vault and Obsidian on any desktop, iPhone, iPad or Android phone, through the <b>Note Keeper Sync</b> Obsidian plugin. Edits on either side appear on the other within seconds; conflicts keep both versions; deletes go to the trash; encrypted notes stay encrypted.</p>
      <ol className="nk-steps">
        <li><b>Install the plugin in Obsidian.</b> Install <i>BRAT</i> from Community plugins, then <i>BRAT → Add beta plugin</i> → <code>{REPO}</code> <Copy text={REPO} />. (Manual install: copy <code>main.js</code>, <code>manifest.json</code>, <code>styles.css</code> from the <a href={'https://github.com/' + REPO + '/tree/main/obsidian-plugin'} target="_blank" rel="noreferrer">obsidian-plugin</a> folder into <code>.obsidian/plugins/note-keeper-sync/</code>.)</li>
        <li><b>Server URL</b> in the plugin settings: <code>{url}</code> <Copy text={url} /></li>
        <li><b>Pairing code</b> (single use, 10 minutes):
          {pair && left > 0 ? (
            <div className="nk-code"><span>{pair.code}</span><Copy text={pair.code} /><small>expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</small></div>
          ) : (
            <div><button type="button" className="nk-btn nk-primary" disabled={st && !st.enabled} onClick={make}>{pair ? 'New pairing code' : 'Create pairing code'}</button></div>
          )}
        </li>
        <li>Press <b>Connect</b> in the plugin, then <b>Sync now</b>. The first sync merges both sides (nothing is deleted).</li>
      </ol>
      <p className="nk-path" style={{ whiteSpace: 'normal' }}>Security: the code is exchanged once for a device key; every request after that is signed (HMAC-SHA-256, timestamp and nonce) and travels over HTTPS. Revoke a device any time under <i>Devices</i>.</p>
      {err ? <div style={{ color: 'var(--nk-err)' }}>{err}</div> : null}
      <DeviceList devices={((st && st.devices) || []).filter((d) => d.kind === 'sync')} onChange={onChange} empty="No Obsidian device paired yet." />
    </div>
  )
}

function WebDAVTab({ st, onChange }) {
  const [name, setName] = useState('')
  const [creds, setCreds] = useState(null)
  const [err, setErr] = useState('')
  const make = async () => {
    setErr('')
    try { setCreds(await api.syncWebDAV(name || 'WebDAV app')); setName(''); onChange() } catch (e) { setErr(e.message) }
  }
  return (
    <div className="nk-connect">
      <p>Serve the vault over <b>WebDAV</b> for apps that speak it: <i>Remotely Save</i> (Obsidian, desktop and mobile), Cyberduck, rclone, the iOS Files app, Android file managers, and Markdown editors with WebDAV sync. Each app gets its own password; hidden files are not exposed; deletes go to the trash.</p>
      <div className="nk-row2">
        <input className="nk-input" placeholder="App name, e.g. Remotely Save on iPhone" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="nk-btn nk-primary" disabled={st && !st.enabled} onClick={make}>Create app password</button>
      </div>
      {creds ? (
        <div className="nk-creds" role="status">
          <p><b>Shown once.</b> Enter these in the app now:</p>
          <div><span>Server URL</span><code>{creds.url}</code><Copy text={creds.url} /></div>
          <div><span>Username</span><code>{creds.username}</code><Copy text={creds.username} /></div>
          <div><span>Password</span><code>{creds.password}</code><Copy text={creds.password} /></div>
          <p className="nk-path" style={{ whiteSpace: 'normal' }}>Remotely Save: choose <i>WebDAV</i>, paste the three values, Auth type <i>basic</i>, Depth header <i>supports depth="1"</i>, then <i>Check connectivity</i>.</p>
        </div>
      ) : null}
      {err ? <div style={{ color: 'var(--nk-err)' }}>{err}</div> : null}
      <DeviceList devices={((st && st.devices) || []).filter((d) => d.kind === 'webdav')} onChange={onChange} empty="No WebDAV app yet." />
    </div>
  )
}

function CloudTab({ onChange }) {
  const [data, setData] = useState(null)
  const [cfg, setCfg] = useState(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const load = useCallback(() => api.syncRemotes().then((d) => { setData(d); setCfg((c) => c || { enabled: d.cloud.enabled, remote: d.cloud.remote || '', path: d.cloud.path || 'NoteKeeper', intervalMin: d.cloud.intervalMin || 10 }) }).catch((e) => setErr(e.message)), [])
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])
  if (!data || !cfg) return <div className="nk-connect">{err || 'Loading…'}</div>
  const c = data.cloud
  const save = async (enabled) => {
    setErr(''); setMsg('')
    try { await api.syncSetCloud({ ...cfg, enabled }); setCfg({ ...cfg, enabled }); setMsg(enabled ? 'Mirror enabled; first run started.' : 'Mirror paused.'); load(); onChange() } catch (e) { setErr(e.message) }
  }
  return (
    <div className="nk-connect">
      <p>Mirror the whole vault two ways with a cloud drive, from the server, with <b>rclone bisync</b>: Google Drive, OneDrive, Dropbox, iCloud Drive, Box, pCloud, S3, and 40 more. Then open that cloud folder in Obsidian or any app on your other devices, or just keep it as an off-site copy.</p>
      {data.remotes.length ? (
        <>
          <div className="nk-row2">
            <label className="nk-field" style={{ flex: 1 }}>Remote
              <select className="nk-input" value={cfg.remote} onChange={(e) => setCfg({ ...cfg, remote: e.target.value })}>
                <option value="">Choose…</option>
                {data.remotes.map((r) => <option key={r.name} value={r.name}>{r.name} ({r.type})</option>)}
              </select>
            </label>
            <label className="nk-field" style={{ flex: 1 }}>Folder in the remote
              <input className="nk-input" value={cfg.path} onChange={(e) => setCfg({ ...cfg, path: e.target.value })} />
            </label>
            <label className="nk-field" style={{ width: 110 }}>Every (min)
              <input className="nk-input" type="number" min="2" value={cfg.intervalMin} onChange={(e) => setCfg({ ...cfg, intervalMin: Number(e.target.value) || 10 })} />
            </label>
          </div>
          <div className="nk-row2">
            <button type="button" className="nk-btn nk-primary" disabled={!cfg.remote} onClick={() => save(true)}>{c.enabled ? 'Save' : 'Enable mirror'}</button>
            {c.enabled ? <button type="button" className="nk-btn" onClick={() => api.syncRunCloud().then(() => { setMsg('Sync started.'); setTimeout(load, 800) })}>Sync now</button> : null}
            {c.enabled ? <button type="button" className="nk-btn" onClick={() => save(false)}>Pause</button> : null}
          </div>
          <div className="nk-cloudstate">
            <span>Status: <b>{c.running ? 'syncing…' : c.enabled ? (c.lastRun ? (c.lastOk ? 'in sync' : 'last run failed') : 'waiting for first run') : 'off'}</b></span>
            {c.lastRun ? <span>Last run: {ago(c.lastRun)}</span> : null}
            {c.remote ? <span>Target: <code>{c.remote}{c.path}</code></span> : null}
          </div>
          {c.lastError ? <div style={{ color: 'var(--nk-err)' }}>{c.lastError}</div> : null}
          {c.log ? <details><summary>rclone log</summary><pre className="nk-diff">{c.log}</pre></details> : null}
        </>
      ) : (
        <div className="nk-banner nk-warnb">No rclone remote is configured on the server yet.</div>
      )}
      <details>
        <summary>Add a cloud drive (one-time, on the server)</summary>
        <ul className="nk-steps">
          <li>Google Drive / OneDrive / Dropbox / Box / pCloud: run <code>rclone config</code> on the server, choose <i>n</i> (new remote), pick the provider, and complete the browser sign-in (for a headless server use <code>rclone authorize "drive"</code> on a computer with a browser and paste the token).</li>
          <li>iCloud Drive: <code>rclone config create icloud iclouddrive apple_id=you@icloud.com</code>, then enter your password and the 2FA code when asked (Advanced Data Protection must be off for iCloud web access).</li>
          <li>Reopen this tab: the remote appears in the list.</li>
        </ul>
      </details>
      <p className="nk-path" style={{ whiteSpace: 'normal' }}>How it merges: the first run combines both sides (nothing is deleted). Later runs propagate edits and deletions both ways; if a file changed on both sides, the newer one wins and the other is kept as a numbered copy. <code>.obsidian</code> and <code>.trash</code> are not mirrored.</p>
      {msg ? <div style={{ color: 'var(--nk-ok)' }}>{msg}</div> : null}
      {err ? <div style={{ color: 'var(--nk-err)' }}>{err}</div> : null}
    </div>
  )
}

function OtherTab({ vaultPath }) {
  return (
    <div className="nk-connect">
      <ul className="nk-steps">
        <li><b>Obsidian on this server's desktop.</b> <i>Open folder as vault</i> → <code>{vaultPath}</code> <Copy text={vaultPath || ''} />. Both apps see each other's edits live (Note Keeper watches the folder).</li>
        <li><b>Obsidian Sync (official).</b> Obsidian Sync has no server-side API, so it cannot connect to this server directly. Use the Note Keeper Sync plugin instead; it can run next to Obsidian Sync in the same vault.</li>
        <li><b>Syncthing</b> (desktop and Android): share <code>{vaultPath}</code> from the server with your devices, then open the synced folder as an Obsidian vault.</li>
        <li><b>iCloud Drive / Google Drive desktop apps</b>: use <i>Cloud drives</i> to mirror the vault into the drive, then open that folder in Obsidian on iPhone/iPad (iCloud) or on your computer.</li>
        <li><b>Git</b>: the vault is plain files; <code>git init</code> in it works with Obsidian Git on every platform.</li>
        <li><b>Any Markdown editor</b> (Logseq, Zettlr, iA Writer, Typora, 1Writer): point it at the synced folder or connect it over WebDAV.</li>
      </ul>
    </div>
  )
}

function DevicesTab({ st, onChange }) {
  return <div className="nk-connect"><DeviceList devices={(st && st.devices) || []} onChange={onChange} empty="Nothing is connected yet." /></div>
}

function DeviceList({ devices, onChange, empty }) {
  const [err, setErr] = useState('')
  if (!devices.length) return <p className="nk-path">{empty}</p>
  return (
    <table className="nk-devices">
      <thead><tr><th>Device</th><th>Type</th><th>Paired</th><th>Last seen</th><th /></tr></thead>
      <tbody>
        {devices.map((d) => (
          <tr key={d.id}>
            <td>{d.name}{d.platform ? <small className="nk-path"> · {d.platform}</small> : null}</td>
            <td>{d.kind === 'webdav' ? 'WebDAV' : 'Obsidian sync'}</td>
            <td>{ago(d.created)}</td>
            <td>{ago(d.lastSeen)}</td>
            <td><button type="button" className="nk-btn nk-sm nk-danger" onClick={async () => {
              if (!window.confirm('Revoke ' + d.name + '? It will stop syncing immediately.')) return
              try { await api.syncRevoke(d.id); onChange() } catch (e) { setErr(e.message) }
            }}>Revoke</button></td>
          </tr>
        ))}
      </tbody>
      {err ? <caption style={{ color: 'var(--nk-err)' }}>{err}</caption> : null}
    </table>
  )
}
