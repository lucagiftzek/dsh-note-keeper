/**
 * dsh-note-keeper — host half.
 *
 * Wires three things into dsh-web:
 *   1. the Go daemon (notekeeperd) that owns the vault, supervised as a child;
 *   2. the browser route /note-keeper/api/* (gated, streamed to the daemon);
 *   3. the model-facing notes_* tools (ctx.get('tools'), resolved defensively
 *      exactly like dsh-orchestrator so a missing registry degrades politely).
 *
 * The browser half (lib/client.js) adds the "Notes" entry to the left sidebar
 * panel list and the full-page Note Keeper panel in the main column.
 *
 * Kill switch: DSH_NOTE_KEEPER_DISABLE=1 in the dsh-web environment, or
 *   - id: dsh-note-keeper
 *     disabled: true
 * in ~/.dsh/profiles/web/cordis.patch.yml.
 * @module dsh-note-keeper
 */

'use strict'

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Daemon } from './daemon.js'
import { API_PREFIX, makeHandler } from './proxy.js'
import { agentTools } from './tools.js'

export const name = 'dsh-note-keeper'
export const inject = ['webServer']

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DISABLE_ENV = 'DSH_NOTE_KEEPER_DISABLE'

/** Defaults; every key can be overridden in the cordis row's config. */
export const DEFAULTS = Object.freeze({
  vault: '~/NoteKeeper',
  trustedHosts: ['llm.tzekos.eu'],
  requireCookie: true,
  binary: '',
  tesseract: 'tesseract',
  dailyFolder: 'Daily',
  inboxNote: 'Inbox.md',
  attachmentsFolder: 'attachments',
  templatesFolder: 'Templates',
  aiWrite: true,
  aiDelete: true,
})

export function expandHome(p) {
  const s = String(p || '')
  return s === '~' || s.startsWith('~/') ? join(homedir(), s.slice(1)) : s
}

/** Merge user config over defaults, type-checking every field. */
export function effectiveConfig(config = {}) {
  const c = { ...DEFAULTS }
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = config[k]
    if (v === undefined || v === null) continue
    if (Array.isArray(def) ? Array.isArray(v) : typeof v === typeof def) c[k] = v
  }
  if (process.env.NK_VAULT) c.vault = process.env.NK_VAULT
  c.vault = expandHome(c.vault)
  c.binary = c.binary ? expandHome(c.binary) : join(PKG_DIR, 'bin', 'notekeeperd')
  return c
}

export function resolveDefineTool(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  const bases = [import.meta.url, join(home, 'profiles', env.DSH_PROFILE || 'web', 'probe.js'), join(home, 'profiles', 'web', 'probe.js')]
  if (process.argv && process.argv[1]) bases.push(process.argv[1])
  for (const base of bases) {
    try {
      const mod = createRequire(base)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch { /* next seed */ }
  }
  return null
}

export function apply(ctx, config = {}) {
  const log = (m) => console.log('dsh-note-keeper: ' + m)
  const warn = (m) => console.error('dsh-note-keeper: ' + m)
  if (process.env[DISABLE_ENV] === '1') { log(DISABLE_ENV + '=1 - nothing registered'); return }

  const cfg = effectiveConfig(config)
  const daemon = new Daemon({
    binary: cfg.binary,
    env: {
      NK_VAULT: cfg.vault,
      NK_TESSERACT: cfg.tesseract,
      NK_DAILY_FOLDER: cfg.dailyFolder,
      NK_INBOX: cfg.inboxNote,
      NK_ATTACH_FOLDER: cfg.attachmentsFolder,
      NK_TEMPLATES: cfg.templatesFolder,
    },
    log, warn,
  })
  daemon.start()
  ctx.effect(() => () => daemon.stop(), 'dsh-note-keeper: daemon')

  const statusInfo = () => ({
    ok: true,
    vault: cfg.vault,
    daemon: daemon.status(),
    folders: { daily: cfg.dailyFolder, inbox: cfg.inboxNote, attachments: cfg.attachmentsFolder, templates: cfg.templatesFolder },
    ai: { write: cfg.aiWrite, delete: cfg.aiDelete },
  })
  const handler = makeHandler({ daemon, config: () => cfg, statusInfo, warn })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'dsh-note-keeper: api route')

  const toolsService = (() => { try { return ctx.get('tools') || null } catch { return null } })()
  const defineTool = resolveDefineTool()
  if (typeof defineTool !== 'function' || !toolsService || typeof toolsService.register !== 'function') {
    warn('tool registry or defineTool unavailable: notes_* tools NOT registered (the sidebar still works)')
  } else {
    let n = 0
    for (const def of agentTools(defineTool, { daemon, config: () => cfg })) {
      ctx.effect(() => {
        const dispose = toolsService.register(def)
        return () => { try { if (typeof dispose === 'function') dispose() } catch { /* gone */ } }
      }, 'dsh-note-keeper: tool ' + def.name)
      n += 1
    }
    log('armed - ' + n + ' tools, route ' + API_PREFIX + ', vault ' + cfg.vault)
  }
}
