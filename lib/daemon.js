/**
 * dsh-note-keeper — supervisor for the Go daemon (notekeeperd).
 *
 * The daemon is spawned as a child of dsh-web (this box has no user systemd
 * bus, and tying the lifetimes together means the vault is served exactly
 * while the GUI is up). Protocol:
 *
 *   - a fresh 32-byte secret per spawn travels in the child's environment
 *     (NK_SECRET), which the daemon removes from its own env immediately;
 *   - -addr 127.0.0.1:0 lets the kernel choose a free port; the daemon prints
 *     "NK_LISTEN host:port" once it is serving;
 *   - -parent-stdin makes it exit when our end of its stdin closes, so it can
 *     never outlive dsh-web (even on SIGKILL of the parent);
 *   - crashes are restarted with capped exponential backoff.
 *
 * request() is the one client every caller uses (the browser proxy and the
 * AI tools alike), so both paths hit the same validation in the daemon.
 * @module dsh-note-keeper/daemon
 */

'use strict'

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import http from 'node:http'

export class Daemon {
  /**
   * @param {object} opts
   * @param {string} opts.binary   path to notekeeperd
   * @param {object} opts.env      NK_* settings (vault, folders, tesseract)
   * @param {(m:string)=>void} [opts.log]
   * @param {(m:string)=>void} [opts.warn]
   */
  constructor({ binary, env = {}, log = () => {}, warn = () => {} }) {
    this.binary = binary
    this.env = env
    this.log = log
    this.warn = warn
    this.child = null
    this.addr = null
    this.secret = null
    this.stopped = false
    this.failures = 0
    this.waiters = []
    this.lastError = null
    this.restartTimer = null
  }

  /** Resolve once the daemon is listening (or reject after timeoutMs). */
  ready(timeoutMs = 15000) {
    if (this.addr) return Promise.resolve(this.addr)
    if (this.stopped) return Promise.reject(new Error('note-keeper daemon is stopped'))
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve)
        reject(new Error('note-keeper daemon not ready: ' + (this.lastError || 'timeout')))
      }, timeoutMs)
      this.waiters.push({ resolve: (a) => { clearTimeout(t); resolve(a) }, reject })
    })
  }

  start() {
    if (this.stopped || this.child) return
    if (!existsSync(this.binary)) {
      this.lastError = 'daemon binary missing at ' + this.binary + ' (run: npm run build:server)'
      this.warn(this.lastError)
      return
    }
    this.secret = randomBytes(32).toString('hex')
    const env = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME || '',
      LANG: 'C.UTF-8',
      ...this.env,
      NK_SECRET: this.secret,
    }
    const child = spawn(this.binary, ['-addr', '127.0.0.1:0', '-parent-stdin'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        const m = /^NK_LISTEN\s+(\S+)$/.exec(line)
        if (m) {
          this.addr = m[1]
          this.failures = 0
          this.lastError = null
          this.log('daemon listening on ' + this.addr + ' (pid ' + child.pid + ')')
          for (const w of this.waiters.splice(0)) w.resolve(this.addr)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim()) this.log(line.trim())
    })
    child.on('error', (e) => { this.lastError = String(e && e.message || e); this.warn('daemon spawn error: ' + this.lastError) })
    child.on('exit', (code, signal) => {
      this.child = null
      this.addr = null
      if (this.stopped) return
      this.failures += 1
      this.lastError = 'daemon exited (code ' + code + ', signal ' + signal + ')'
      const delay = Math.min(30000, 500 * 2 ** Math.min(this.failures, 6))
      this.warn(this.lastError + '; restarting in ' + delay + 'ms')
      this.restartTimer = setTimeout(() => this.start(), delay)
      if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref()
    })
  }

  stop() {
    this.stopped = true
    clearTimeout(this.restartTimer)
    for (const w of this.waiters.splice(0)) w.reject(new Error('stopped'))
    const c = this.child
    this.child = null
    this.addr = null
    if (c) {
      try { c.stdin.end() } catch { /* gone */ }
      try { c.kill('SIGTERM') } catch { /* gone */ }
      const k = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } }, 4000)
      if (typeof k.unref === 'function') k.unref()
    }
  }

  status() {
    return { running: Boolean(this.addr), addr: this.addr, pid: this.child ? this.child.pid : null, failures: this.failures, lastError: this.lastError }
  }

  /**
   * Open a raw request to the daemon (streaming). Caller pipes the body.
   * @returns {Promise<http.ClientRequest>}
   */
  async open(method, path, headers = {}, onResponse) {
    const addr = await this.ready()
    const [host, port] = splitAddr(addr)
    return http.request({ host, port, method, path, headers: { ...headers, 'x-nk-secret': this.secret } }, onResponse)
  }

  /**
   * JSON convenience client used by the AI tools.
   * @returns {Promise<{status:number, body:any}>}
   */
  async request(method, path, { json, raw, timeoutMs = 60000 } = {}) {
    const addr = await this.ready()
    const [host, port] = splitAddr(addr)
    const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : raw
    return new Promise((resolve, reject) => {
      const req = http.request({
        host, port, method, path,
        headers: {
          'x-nk-secret': this.secret,
          ...(payload ? { 'content-type': json !== undefined ? 'application/json' : 'application/octet-stream', 'content-length': payload.length } : {}),
        },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body = text
          try { body = JSON.parse(text) } catch { /* non-JSON */ }
          resolve({ status: res.statusCode || 0, body })
        })
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('note-keeper daemon request timed out')))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }
}

function splitAddr(addr) {
  const i = addr.lastIndexOf(':')
  return [addr.slice(0, i).replace(/^\[|\]$/g, ''), Number(addr.slice(i + 1))]
}
