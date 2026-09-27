/**
 * dsh-note-keeper — browser half.
 *
 * Registers:
 *   - a "Notes" row in the left sidebar's global panel list
 *     (slot sidebar.panellist, id 'note-keeper'), and
 *   - the full-page Note Keeper panel in the layout's root-scoped keyed
 *     'main' slot under the same key, which the sidebar row selects through
 *     ctx.layout.selectPanel.
 * Styles are injected once into <head> and removed on dispose.
 * @module dsh-note-keeper/client
 */
import * as React from 'react'
import { App } from './App.jsx'
import { NK_CSS } from './styles.js'
import { PAINT_CSS } from './Paint.jsx'
import { GRAPH_CSS } from './Graph.jsx'

export const name = 'dsh-note-keeper'
export const inject = ['slots']

export const PANEL_ID = 'note-keeper'
const STYLE_ID = '__dsh-note-keeper-styles__'

/** Sidebar row glyph: a notebook with a clay spine (square, pixel-crisp). */
function NotesIcon({ size = 16, active }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" shapeRendering="crispEdges">
      <rect x="3.5" y="1.5" width="10" height="13" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="3" width="3" height="10" fill={active ? 'var(--tz-accent, #c1553a)' : 'currentColor'} opacity={active ? 1 : 0.55} />
      <path d="M6.5 5.5h5M6.5 8h5M6.5 10.5h3" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function Page() {
  return (
    <div style={{ height: '100%', width: '100%', minHeight: 0, display: 'flex' }}>
      <App />
    </div>
  )
}

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return () => {}
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = NK_CSS + '\n' + PAINT_CSS + '\n' + GRAPH_CSS
  document.head.appendChild(el)
  return () => el.remove()
}

export function apply(ctx) {
  const slots = ctx.slots
  const disposers = []
  disposers.push(injectStyles())
  const safe = (label, fn) => {
    try { const d = fn(); if (typeof d === 'function') disposers.push(d) } catch (e) { console.error('[dsh-note-keeper] ' + label + ' registration failed:', e) }
  }
  // The main panel must exist before the sidebar row can select it.
  safe('main panel', () => slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, Page)))
  safe('sidebar entry', () => slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: 'Notes', inject: () => ({}),
  }, NotesIcon)))
  const dispose = () => { for (const d of disposers.splice(0).reverse()) { try { d() } catch { /* gone */ } } }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-note-keeper: client')
  return dispose
}
