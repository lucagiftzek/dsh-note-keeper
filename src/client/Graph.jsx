/**
 * Graph.jsx — interactive force-directed graph view for Note Keeper.
 *
 * Exports:
 *   - GraphView({ nodes, edges, onOpen, focus, showTags, onToggleTags })
 *   - GRAPH_CSS: a CSS string (classes prefixed "nk-graph-").
 *
 * Rendering is plain <canvas> (devicePixelRatio aware). Layout uses
 * graph-core.js (pure, dependency-free force simulation). Only 'react' and
 * graph-core.js are imported.
 */

import * as React from 'react';
import { createSim, step, filterLocal } from './graph-core.js';

const { useRef, useState, useEffect, useCallback, useMemo } = React;

const NODE_RADIUS = 6;
const TAG_RADIUS = 5;
const GHOST_RADIUS = 6;
const ATTACHMENT_SIZE = 8;
const LABEL_ZOOM_THRESHOLD = 0.9;
const COOL_ALPHA_START = 0.9;
const COOL_DECAY = 0.985;
const COOL_STOP = 0.02;

/**
 * @param {object} props
 * @param {{id:string, title:string, kind:'note'|'attachment'|'ghost'|'tag', degree?:number}[]} props.nodes
 * @param {{source:string, target:string}[]} props.edges
 * @param {(id:string) => void} props.onOpen called when a note/attachment node is clicked
 * @param {string} [props.focus] id of the currently focused note, if any
 * @param {boolean} [props.showTags] whether tag nodes are shown
 * @param {() => void} [props.onToggleTags] toggles tag visibility
 */
export function GraphView({ nodes, edges, onOpen, focus, showTags, onToggleTags }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const simRef = useRef(null);
  const alphaRef = useRef(COOL_ALPHA_START);
  const rafRef = useRef(null);
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef(null); // { kind: 'pan'|'node', ... }
  const colorsRef = useRef(null);

  const [filterText, setFilterText] = useState('');
  const [localMode, setLocalMode] = useState(false);
  const [localDepth, setLocalDepth] = useState(1);
  const [hoverId, setHoverId] = useState(null);
  const [, forceRerender] = useState(0);

  // -----------------------------------------------------------------------
  // Derive the node/edge set actually shown (text filter + local mode + tags)
  // -----------------------------------------------------------------------

  const visibleGraph = useMemo(() => {
    let n = nodes;
    let e = edges;

    if (!showTags) {
      const keepIds = new Set(n.filter((node) => node.kind !== 'tag').map((node) => node.id));
      n = n.filter((node) => node.kind !== 'tag');
      e = e.filter((edge) => keepIds.has(edge.source) && keepIds.has(edge.target));
    }

    if (localMode && focus) {
      const local = filterLocal(n, e, focus, localDepth);
      n = local.nodes;
      e = local.edges;
    }

    if (filterText.trim()) {
      const needle = filterText.trim().toLowerCase();
      const matchIds = new Set(
        n.filter((node) => (node.title || node.id).toLowerCase().includes(needle)).map((node) => node.id)
      );
      // Keep matched nodes plus their direct neighbours so context survives filtering.
      const keep = new Set(matchIds);
      for (const edge of e) {
        if (matchIds.has(edge.source)) keep.add(edge.target);
        if (matchIds.has(edge.target)) keep.add(edge.source);
      }
      n = n.filter((node) => keep.has(node.id));
      e = e.filter((edge) => keep.has(edge.source) && keep.has(edge.target));
    }

    return { nodes: n, edges: e };
  }, [nodes, edges, showTags, localMode, focus, localDepth, filterText]);

  // -----------------------------------------------------------------------
  // (Re)build the simulation whenever the visible graph changes
  // -----------------------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    const width = container ? container.clientWidth || 800 : 800;
    const height = container ? container.clientHeight || 600 : 600;
    simRef.current = createSim(visibleGraph.nodes, visibleGraph.edges, { width, height });
    alphaRef.current = COOL_ALPHA_START;
  }, [visibleGraph]);

  // -----------------------------------------------------------------------
  // Resolve theme colours from CSS variables once, and on theme changes
  // -----------------------------------------------------------------------

  const resolveColors = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;
    const style = getComputedStyle(container);
    const read = (name, fallback) => {
      const v = style.getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    };
    return {
      note: read('--dsw-alias-label-secondary', '#c0b7b2'),
      focus: read('--tz-accent', '#c1553a'),
      tag: read('--tz-accent-2', '#5e9bd6'),
      ghost: read('--dsw-alias-label-secondary', '#c0b7b2'),
      attachment: read('--dsw-alias-label-primary', '#f4f0ed'),
      // Edges use the secondary label tone: the border tone is invisible on the dark background.
      edge: read('--dsw-alias-label-tertiary', '#9a928e'),
      bg: read('--dsw-alias-bg-primary', '#131110'),
      label: read('--dsw-alias-label-primary', '#f4f0ed'),
    };
  }, []);

  useEffect(() => {
    colorsRef.current = resolveColors();
  }, [resolveColors]);

  // -----------------------------------------------------------------------
  // Canvas sizing (devicePixelRatio aware)
  // -----------------------------------------------------------------------

  const resizeCanvas = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
  }, []);

  useEffect(() => {
    resizeCanvas();
    const onResize = () => resizeCanvas();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [resizeCanvas]);

  // -----------------------------------------------------------------------
  // Coordinate transforms: world <-> screen
  // -----------------------------------------------------------------------

  const worldToScreen = useCallback((x, y) => {
    const t = transformRef.current;
    return { x: x * t.scale + t.x, y: y * t.scale + t.y };
  }, []);

  const screenToWorld = useCallback((x, y) => {
    const t = transformRef.current;
    return { x: (x - t.x) / t.scale, y: (y - t.y) / t.scale };
  }, []);

  // -----------------------------------------------------------------------
  // Drawing
  // -----------------------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    const colors = colorsRef.current;
    if (!canvas || !sim || !colors) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    const t = transformRef.current;
    const container = containerRef.current;
    const width = container ? container.clientWidth : canvas.width / dpr;
    const height = container ? container.clientHeight : canvas.height / dpr;
    const originX = width / 2;
    const originY = height / 2;

    const nodeById = sim.nodeById;
    const neighborSet = hoverId ? sim.adjacency.get(hoverId) : null;
    const showLabels = t.scale >= LABEL_ZOOM_THRESHOLD;

    // Edges first (under nodes).
    ctx.strokeStyle = colors.edge;
    ctx.lineWidth = 1;
    for (const e of sim.edges) {
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (!a || !b) continue;
      const pa = worldToScreen(a.x, a.y);
      const pb = worldToScreen(b.x, b.y);
      const highlighted = hoverId && (e.source === hoverId || e.target === hoverId);
      ctx.globalAlpha = hoverId ? (highlighted ? 1 : 0.15) : 0.6;
      ctx.beginPath();
      ctx.moveTo(originX + pa.x, originY + pa.y);
      ctx.lineTo(originX + pb.x, originY + pb.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Nodes.
    for (const node of sim.nodes) {
      const p = worldToScreen(node.x, node.y);
      const sx = originX + p.x;
      const sy = originY + p.y;
      const isFocus = node.id === focus;
      const isHover = node.id === hoverId;
      const dimmed = hoverId && !isHover && !(neighborSet && neighborSet.has(node.id));
      ctx.globalAlpha = dimmed ? 0.25 : 1;

      let color = colors.note;
      if (node.kind === 'tag') color = colors.tag;
      else if (node.kind === 'ghost') color = colors.ghost;
      else if (node.kind === 'attachment') color = colors.attachment;
      if (isFocus) color = colors.focus;

      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;

      if (node.kind === 'ghost') {
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.arc(sx, sy, GHOST_RADIUS, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (node.kind === 'attachment') {
        const s = ATTACHMENT_SIZE;
        ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
      } else if (node.kind === 'tag') {
        ctx.beginPath();
        ctx.arc(sx, sy, TAG_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(sx, sy, isFocus ? NODE_RADIUS + 2 : NODE_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }

      if (showLabels || isHover) {
        ctx.globalAlpha = dimmed ? 0.4 : 1;
        ctx.fillStyle = colors.label;
        ctx.font = '11px var(--tz-font-mono, monospace)';
        ctx.fillText(node.title || node.id, sx + 8, sy + 4);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }, [worldToScreen, hoverId, focus]);

  // -----------------------------------------------------------------------
  // Simulation loop (rAF), cools down and stops
  // -----------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const sim = simRef.current;
      if (sim && alphaRef.current > COOL_STOP) {
        // Skip stepping any node currently being dragged so the user stays in control.
        step(sim, alphaRef.current);
        alphaRef.current *= COOL_DECAY;
        draw();
      } else if (sim) {
        draw();
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [draw]);

  // -----------------------------------------------------------------------
  // Pointer interaction: pan background, drag nodes, hover, click
  // -----------------------------------------------------------------------

  const hitTestScreen = useCallback((sx, sy) => {
    const sim = simRef.current;
    if (!sim) return null;
    const container = containerRef.current;
    const width = container ? container.clientWidth : 0;
    const height = container ? container.clientHeight : 0;
    const originX = width / 2;
    const originY = height / 2;
    let best = null;
    let bestDist = Infinity;
    for (const node of sim.nodes) {
      const p = worldToScreen(node.x, node.y);
      const nx = originX + p.x;
      const ny = originY + p.y;
      const d = Math.hypot(sx - nx, sy - ny);
      const r = (NODE_RADIUS + 4) * transformRef.current.scale;
      if (d <= Math.max(r, 10) && d < bestDist) {
        best = node.id;
        bestDist = d;
      }
    }
    return best;
  }, [worldToScreen]);

  const onPointerDown = useCallback((e) => {
    const canvas = canvasRef.current;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hitId = hitTestScreen(sx, sy);
    if (hitId) {
      const sim = simRef.current;
      const node = sim.nodeById.get(hitId);
      node.fixed = true;
      dragRef.current = { kind: 'node', id: hitId, startSx: sx, startSy: sy, moved: false };
    } else {
      dragRef.current = { kind: 'pan', startSx: sx, startSy: sy, startTx: transformRef.current.x, startTy: transformRef.current.y };
    }
  }, [hitTestScreen]);

  const onPointerMove = useCallback((e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const drag = dragRef.current;

    if (!drag) {
      const hitId = hitTestScreen(sx, sy);
      setHoverId(hitId);
      return;
    }

    if (drag.kind === 'pan') {
      const dx = sx - drag.startSx;
      const dy = sy - drag.startSy;
      transformRef.current = { ...transformRef.current, x: drag.startTx + dx, y: drag.startTy + dy };
      draw();
      return;
    }

    if (drag.kind === 'node') {
      const sim = simRef.current;
      const node = sim.nodeById.get(drag.id);
      if (node) {
        const container = containerRef.current;
        const width = container ? container.clientWidth : 0;
        const height = container ? container.clientHeight : 0;
        const world = screenToWorld(sx - width / 2, sy - height / 2);
        node.x = world.x;
        node.y = world.y;
        node.fixed = true;
        drag.moved = true;
        alphaRef.current = Math.max(alphaRef.current, 0.3); // wake the sim while dragging
        draw();
      }
    }
  }, [hitTestScreen, screenToWorld, draw]);

  const onPointerUp = useCallback((e) => {
    const canvas = canvasRef.current;
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;

    if (drag.kind === 'node') {
      const sim = simRef.current;
      const node = sim.nodeById.get(drag.id);
      if (node) node.fixed = false;
      if (!drag.moved && onOpen) {
        const n = sim.nodeById.get(drag.id);
        if (n && (n.kind === 'note' || n.kind === 'attachment')) onOpen(drag.id);
      }
    }
  }, [onOpen]);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const t = transformRef.current;
    const zoomFactor = Math.exp(-e.deltaY * 0.001);
    const newScale = Math.min(6, Math.max(0.1, t.scale * zoomFactor));
    // Zoom around the pointer position.
    const worldX = (sx - t.x) / t.scale;
    const worldY = (sy - t.y) / t.scale;
    const newX = sx - worldX * newScale;
    const newY = sy - worldY * newScale;
    transformRef.current = { x: newX, y: newY, scale: newScale };
    draw();
  }, [draw]);

  // Basic pinch-to-zoom via two-pointer tracking.
  const pinchRef = useRef(null);
  const onTouchPointerDown = useCallback((e) => {
    if (e.pointerType !== 'touch') return;
    const active = pinchRef.current || {};
    active[e.pointerId] = { x: e.clientX, y: e.clientY };
    pinchRef.current = active;
  }, []);
  const onTouchPointerMoveForPinch = useCallback((e) => {
    if (e.pointerType !== 'touch' || !pinchRef.current) return;
    const active = pinchRef.current;
    if (!active[e.pointerId]) return;
    active[e.pointerId] = { x: e.clientX, y: e.clientY };
    const ids = Object.keys(active);
    if (ids.length === 2) {
      const [p1, p2] = ids.map((id) => active[id]);
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (pinchRef.current._lastDist) {
        const ratio = dist / pinchRef.current._lastDist;
        const t = transformRef.current;
        const newScale = Math.min(6, Math.max(0.1, t.scale * ratio));
        transformRef.current = { ...t, scale: newScale };
        draw();
      }
      pinchRef.current._lastDist = dist;
    }
  }, [draw]);
  const onTouchPointerUp = useCallback((e) => {
    if (pinchRef.current) {
      delete pinchRef.current[e.pointerId];
      if (Object.keys(pinchRef.current).filter((k) => k !== '_lastDist').length < 2) {
        pinchRef.current._lastDist = null;
      }
    }
  }, []);

  // -----------------------------------------------------------------------
  // Toolbar actions
  // -----------------------------------------------------------------------

  const fitToView = useCallback(() => {
    const sim = simRef.current;
    const container = containerRef.current;
    if (!sim || !container || sim.nodes.length === 0) return;
    const xs = sim.nodes.map((n) => n.x);
    const ys = sim.nodes.map((n) => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const width = container.clientWidth;
    const height = container.clientHeight;
    const scale = Math.min(3, Math.max(0.15, Math.min((width - 60) / spanX, (height - 60) / spanY)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    transformRef.current = { x: -cx * scale, y: -cy * scale, scale };
    draw();
  }, [draw]);

  return (
    <div className="nk-graph-root" ref={containerRef}>
      <div className="nk-graph-toolbar">
        <input
          className="nk-graph-filter"
          type="text"
          placeholder="Filter notes…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        {focus && (
          <button
            className={'nk-graph-btn' + (localMode ? ' nk-graph-btn-active' : '')}
            onClick={() => setLocalMode((v) => !v)}
          >
            Local graph
          </button>
        )}
        {focus && localMode && (
          <select className="nk-graph-select" value={localDepth} onChange={(e) => setLocalDepth(Number(e.target.value))}>
            <option value={1}>Depth 1</option>
            <option value={2}>Depth 2</option>
          </select>
        )}
        <button
          className={'nk-graph-btn' + (showTags ? ' nk-graph-btn-active' : '')}
          onClick={onToggleTags}
        >
          Tags
        </button>
        <button className="nk-graph-btn" onClick={fitToView}>Fit</button>
      </div>
      <canvas
        ref={canvasRef}
        className="nk-graph-canvas"
        onPointerDown={(e) => { onPointerDown(e); onTouchPointerDown(e); }}
        onPointerMove={(e) => { onPointerMove(e); onTouchPointerMoveForPinch(e); }}
        onPointerUp={(e) => { onPointerUp(e); onTouchPointerUp(e); }}
        onPointerCancel={(e) => { onPointerUp(e); onTouchPointerUp(e); }}
        onWheel={onWheel}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

export const GRAPH_CSS = [
  '.nk-graph-root {',
  '  position: relative; display: flex; flex-direction: column;',
  '  width: 100%; height: 100%; min-height: 240px;',
  '  background: var(--dsw-alias-bg-primary, #131110);',
  '  border: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  box-shadow: var(--tz-shadow-pop, 6px 6px 0 rgba(0,0,0,.45));',
  '}',
  '.nk-graph-toolbar {',
  '  display: flex; align-items: center; gap: 6px; padding: 6px 8px;',
  '  border-bottom: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  background: var(--dsw-alias-bg-secondary, #1b1817);',
  '  flex-wrap: wrap;',
  '}',
  '.nk-graph-filter {',
  '  flex: 1; min-width: 100px;',
  '  background: var(--dsw-alias-bg-primary, #131110); color: var(--dsw-alias-label-primary, #f4f0ed);',
  '  border: 1px solid var(--dsw-alias-border-primary, #3a332f); border-radius: 0;',
  '  font-family: var(--tz-font-mono, ui-monospace, monospace); font-size: 12px; padding: 4px 6px;',
  '}',
  '.nk-graph-btn {',
  '  border: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  background: var(--dsw-alias-bg-primary, #131110); color: var(--dsw-alias-label-primary, #f4f0ed);',
  '  border-radius: 0; padding: 4px 10px; cursor: pointer;',
  '  font-family: var(--tz-font-display, "Silkscreen", monospace); font-size: 11px;',
  '  box-shadow: 2px 2px 0 rgba(0,0,0,.3);',
  '}',
  '.nk-graph-btn:hover { border-color: var(--tz-accent, #c1553a); }',
  '.nk-graph-btn:active { box-shadow: none; transform: translate(2px, 2px); }',
  '.nk-graph-btn-active { border-color: var(--tz-accent, #c1553a); color: var(--tz-accent, #c1553a); }',
  '.nk-graph-select {',
  '  background: var(--dsw-alias-bg-primary, #131110); color: var(--dsw-alias-label-primary, #f4f0ed);',
  '  border: 1px solid var(--dsw-alias-border-primary, #3a332f); border-radius: 0; font-size: 11px;',
  '}',
  '.nk-graph-canvas { flex: 1; width: 100%; height: 100%; cursor: grab; touch-action: none; display: block; }',
].join('\n');
