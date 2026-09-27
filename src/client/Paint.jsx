/**
 * Paint.jsx — retro MS-Paint-style drawing editor for Note Keeper.
 *
 * Exports:
 *   - PaintEditor({ title, initialPngUrl, initialVector, onSave, onOcr, onClose })
 *   - PAINT_CSS: a CSS string (classes prefixed "nk-paint-") the host page
 *     should inject once (e.g. via a <style> tag).
 *
 * Design constraints (see task spec): square corners, 1px borders, hard
 * offset shadows via var(--tz-shadow-pop), tzekos.eu accent/secondary
 * colours, Silkscreen display font for labels, DSH theme background/label
 * variables so the editor works in both dark and light mode.
 *
 * Only 'react' and our own paint-core.js are imported — no other packages.
 */

import * as React from 'react';
import {
  floodFill,
  RETRO_PALETTE,
  hexToRgba,
  createDoc,
  addShape,
  hitTest,
  moveShape,
  deleteShape,
  serializeDoc,
  parseDoc,
  docToSVG,
  UndoStack,
} from './paint-core.js';

const { useState, useRef, useEffect, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BRUSH_SIZES = [1, 3, 6, 12];
const CANVAS_PRESETS = [
  { label: '800x600', width: 800, height: 600 },
  { label: '1280x800', width: 1280, height: 800 },
  { label: '1920x1080', width: 1920, height: 1080 },
];

const TOOLS = [
  { id: 'pencil', label: 'Pencil', icon: 'PN' },
  { id: 'brush', label: 'Brush', icon: 'BR' },
  { id: 'eraser', label: 'Eraser', icon: 'ER' },
  { id: 'spray', label: 'Spray', icon: 'SP' },
  { id: 'bucket', label: 'Fill', icon: 'FL' },
  { id: 'eyedropper', label: 'Pick', icon: 'EY' },
  { id: 'line', label: 'Line', icon: 'LN' },
  { id: 'rect', label: 'Rect', icon: 'RC' },
  { id: 'ellipse', label: 'Ellipse', icon: 'EL' },
  { id: 'text', label: 'Text', icon: 'TX' },
  { id: 'select', label: 'Select', icon: 'SE' },
];

const VECTOR_TOOLS = new Set(['line', 'rect', 'ellipse', 'text', 'select']);
const MAX_UNDO = 30;

/** Deep-clone a vector doc (cheap plain-object structure, JSON is fine). */
function cloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}

// ---------------------------------------------------------------------------
// PaintEditor component
// ---------------------------------------------------------------------------

/**
 * @param {object} props
 * @param {string} [props.title] editor title shown in the header
 * @param {string} [props.initialPngUrl] same-origin URL of a PNG to preload
 *   onto the raster layer
 * @param {string} [props.initialVector] a previously-saved serializeDoc()
 *   JSON string to restore vector shapes from
 * @param {(payload: {png: Blob, vector: string, svg: string, ocrText?: string}) => void} props.onSave
 * @param {(png: Blob) => Promise<string>} [props.onOcr] OCR callback; receives
 *   the flattened PNG and resolves to extracted text
 * @param {() => void} props.onClose called when the editor should close
 */
export function PaintEditor({ title, initialPngUrl, initialVector, onSave, onOcr, onClose }) {
  // --- canvas refs -----------------------------------------------------
  const rasterRef = useRef(null); // raster (bitmap) layer
  const overlayRef = useRef(null); // vector overlay layer (also used for live drawing preview)
  const containerRef = useRef(null);
  const rasterCtxRef = useRef(null);

  // --- canvas sizing -----------------------------------------------------
  const [canvasSize, setCanvasSize] = useState(null); // {width, height} once known
  const [needsSizePrompt, setNeedsSizePrompt] = useState(!initialPngUrl && !initialVector);

  // --- tool state --------------------------------------------------------
  const [tool, setTool] = useState('pencil');
  const [brushSize, setBrushSize] = useState(3);
  const [shapeMode, setShapeMode] = useState('outline'); // outline | filled | both
  const [primaryColor, setPrimaryColor] = useState('#000000');
  const [secondaryColor, setSecondaryColor] = useState('#FFFFFF');
  const [tolerance, setTolerance] = useState(24);

  // --- document state ------------------------------------------------------
  const vectorDocRef = useRef(null); // authoritative vector doc (mutated in place, then re-rendered)
  const [vectorVersion, setVectorVersion] = useState(0); // bump to force overlay repaint
  const [selectedShapeId, setSelectedShapeId] = useState(null);
  const [dirty, setDirty] = useState(false);

  // --- undo/redo (separate stacks for raster snapshots and vector docs) ---
  const rasterUndoRef = useRef(new UndoStack(MAX_UNDO));
  const vectorUndoRef = useRef(new UndoStack(MAX_UNDO));

  // --- pointer/drag state --------------------------------------------------
  const drawingRef = useRef(null); // in-progress stroke/shape info
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });

  // --- OCR panel state -----------------------------------------------------
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState(null);
  const [ocrText, setOcrText] = useState(null);

  // --- responsive layout -----------------------------------------------------
  const [narrow, setNarrow] = useState(typeof window !== 'undefined' ? window.innerWidth < 700 : false);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 700);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // -----------------------------------------------------------------------
  // Initialisation: size, raster image, vector doc
  // -----------------------------------------------------------------------

  const initRasterContext = useCallback((width, height) => {
    const raster = rasterRef.current;
    if (!raster) return;
    raster.width = width;
    raster.height = height;
    const ctx = raster.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    rasterCtxRef.current = ctx;
  }, []);

  const pushRasterSnapshot = useCallback(() => {
    const ctx = rasterCtxRef.current;
    const raster = rasterRef.current;
    if (!ctx || !raster) return;
    const snap = ctx.getImageData(0, 0, raster.width, raster.height);
    rasterUndoRef.current.push(snap);
  }, []);

  const startWithSize = useCallback((width, height) => {
    setNeedsSizePrompt(false);
    setCanvasSize({ width, height });
    vectorDocRef.current = createDoc(width, height);
    // Deferred: actual canvas element sizing happens in the effect below
    // once the <canvas> is mounted with these dimensions.
  }, []);

  // Apply canvasSize to the raster element once it changes.
  useEffect(() => {
    if (!canvasSize) return;
    initRasterContext(canvasSize.width, canvasSize.height);
    pushRasterSnapshot();
    vectorUndoRef.current.push(cloneDoc(vectorDocRef.current));
    setVectorVersion((v) => v + 1);
  }, [canvasSize, initRasterContext, pushRasterSnapshot]);

  // Load initial PNG (if provided) once the raster context exists.
  useEffect(() => {
    if (!initialPngUrl) return;
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || 800;
      const height = img.naturalHeight || 600;
      setNeedsSizePrompt(false);
      setCanvasSize({ width, height });
      // Defer drawing the image until the canvas has been resized by the
      // canvasSize effect above (next tick via microtask/paint order).
      requestAnimationFrame(() => {
        const ctx = rasterCtxRef.current;
        if (!ctx) return;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        pushRasterSnapshot();
      });
    };
    img.onerror = () => {
      // Fall back to prompting for a canvas size if the image failed to load.
      setNeedsSizePrompt(true);
    };
    img.src = initialPngUrl;
  }, [initialPngUrl, pushRasterSnapshot]);

  // Restore vector shapes from a previous save.
  useEffect(() => {
    if (!initialVector) return;
    try {
      const doc = parseDoc(initialVector);
      vectorDocRef.current = doc;
      if (!canvasSize) setCanvasSize({ width: doc.width, height: doc.height });
      setVectorVersion((v) => v + 1);
      vectorUndoRef.current.push(cloneDoc(doc));
    } catch (err) {
      // Malformed vector data: start fresh rather than crash the editor.
      console.warn('PaintEditor: failed to restore vector doc', err);
    }
  }, [initialVector]); // eslint-disable-line react-hooks/exhaustive-deps

  // -----------------------------------------------------------------------
  // Overlay (vector) rendering
  // -----------------------------------------------------------------------

  const renderOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    const doc = vectorDocRef.current;
    if (!overlay || !doc) return;
    if (overlay.width !== doc.width) overlay.width = doc.width;
    if (overlay.height !== doc.height) overlay.height = doc.height;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    for (const shape of doc.shapes) {
      drawShape(ctx, shape);
      if (shape.id === selectedShapeId) drawSelectionHandles(ctx, shape);
    }

    // In-progress shape preview (rubber-banding).
    const drag = drawingRef.current;
    if (drag && drag.previewShape) {
      drawShape(ctx, drag.previewShape);
    }
  }, [selectedShapeId]);

  useEffect(() => {
    renderOverlay();
  }, [vectorVersion, renderOverlay]);

  // -----------------------------------------------------------------------
  // Flattening: compose raster + vector onto an offscreen canvas
  // -----------------------------------------------------------------------

  const flatten = useCallback(() => {
    const raster = rasterRef.current;
    if (!raster) return null;
    const off = document.createElement('canvas');
    off.width = raster.width;
    off.height = raster.height;
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, off.width, off.height);
    ctx.drawImage(raster, 0, 0);
    const doc = vectorDocRef.current;
    if (doc) {
      for (const shape of doc.shapes) drawShape(ctx, shape);
    }
    return off;
  }, []);

  const flattenToBlob = useCallback(() => {
    return new Promise((resolve) => {
      const off = flatten();
      if (!off) { resolve(null); return; }
      off.toBlob((blob) => resolve(blob), 'image/png');
    });
  }, [flatten]);

  /** Rasterize all vector shapes onto the raster layer and clear the vector doc. */
  const flattenVectorsToRaster = useCallback(() => {
    const ctx = rasterCtxRef.current;
    const doc = vectorDocRef.current;
    if (!ctx || !doc || doc.shapes.length === 0) return;
    for (const shape of doc.shapes) drawShape(ctx, shape);
    pushRasterSnapshot();
    doc.shapes = [];
    vectorUndoRef.current.push(cloneDoc(doc));
    setSelectedShapeId(null);
    setVectorVersion((v) => v + 1);
    setDirty(true);
  }, [pushRasterSnapshot]);

  // -----------------------------------------------------------------------
  // Undo / redo
  // -----------------------------------------------------------------------

  const applyRasterSnapshot = useCallback((snapshot) => {
    const ctx = rasterCtxRef.current;
    if (!ctx || !snapshot) return;
    ctx.putImageData(snapshot, 0, 0);
  }, []);

  const applyVectorSnapshot = useCallback((snapshot) => {
    if (!snapshot) return;
    vectorDocRef.current = cloneDoc(snapshot);
    setVectorVersion((v) => v + 1);
  }, []);

  const undo = useCallback(() => {
    // Undo affects whichever stack was touched most recently isn't tracked
    // separately, so we attempt both: vector undo takes priority when the
    // current tool is a vector tool, otherwise raster.
    if (VECTOR_TOOLS.has(tool) && vectorUndoRef.current.canUndo()) {
      applyVectorSnapshot(vectorUndoRef.current.undo());
      setDirty(true);
      return;
    }
    if (rasterUndoRef.current.canUndo()) {
      applyRasterSnapshot(rasterUndoRef.current.undo());
      setDirty(true);
      return;
    }
    if (vectorUndoRef.current.canUndo()) {
      applyVectorSnapshot(vectorUndoRef.current.undo());
      setDirty(true);
    }
  }, [tool, applyRasterSnapshot, applyVectorSnapshot]);

  const redo = useCallback(() => {
    if (VECTOR_TOOLS.has(tool) && vectorUndoRef.current.canRedo()) {
      applyVectorSnapshot(vectorUndoRef.current.redo());
      setDirty(true);
      return;
    }
    if (rasterUndoRef.current.canRedo()) {
      applyRasterSnapshot(rasterUndoRef.current.redo());
      setDirty(true);
      return;
    }
    if (vectorUndoRef.current.canRedo()) {
      applyVectorSnapshot(vectorUndoRef.current.redo());
      setDirty(true);
    }
  }, [tool, applyRasterSnapshot, applyVectorSnapshot]);

  const clearCanvas = useCallback(() => {
    const ctx = rasterCtxRef.current;
    const raster = rasterRef.current;
    if (!ctx || !raster) return;
    if (!window.confirm('Clear the entire canvas? This removes both drawing and shapes.')) return;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, raster.width, raster.height);
    pushRasterSnapshot();
    vectorDocRef.current.shapes = [];
    vectorUndoRef.current.push(cloneDoc(vectorDocRef.current));
    setVectorVersion((v) => v + 1);
    setSelectedShapeId(null);
    setDirty(true);
  }, [pushRasterSnapshot]);

  // -----------------------------------------------------------------------
  // Raster drawing primitives
  // -----------------------------------------------------------------------

  const strokeSegment = useCallback((ctx, from, to, size, color, mode) => {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = size;
    if (mode === 'eraser') {
      ctx.strokeStyle = '#FFFFFF';
    } else {
      ctx.strokeStyle = color;
    }
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }, []);

  const sprayAt = useCallback((ctx, pos, size, color) => {
    const density = Math.max(6, size * 4);
    ctx.fillStyle = color;
    for (let i = 0; i < density; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * size * 2;
      const px = pos.x + Math.cos(angle) * radius;
      const py = pos.y + Math.sin(angle) * radius;
      ctx.fillRect(px, py, 1, 1);
    }
  }, []);

  // -----------------------------------------------------------------------
  // Pointer coordinate helpers
  // -----------------------------------------------------------------------

  const eventToCanvasPoint = useCallback((e) => {
    const overlay = overlayRef.current;
    if (!overlay) return { x: 0, y: 0 };
    const rect = overlay.getBoundingClientRect();
    const scaleX = overlay.width / rect.width;
    const scaleY = overlay.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  // -----------------------------------------------------------------------
  // Pointer handlers
  // -----------------------------------------------------------------------

  const handlePointerDown = useCallback((e) => {
    e.preventDefault();
    const overlay = overlayRef.current;
    overlay.setPointerCapture(e.pointerId);
    const pos = eventToCanvasPoint(e);
    const isRightButton = e.button === 2;
    const color = isRightButton ? secondaryColor : primaryColor;
    const pressureSize = e.pointerType === 'pen' && e.pressure > 0
      ? Math.max(1, Math.round(brushSize * (0.4 + e.pressure * 1.2)))
      : brushSize;

    if (tool === 'pencil' || tool === 'brush' || tool === 'eraser') {
      const ctx = rasterCtxRef.current;
      const size = tool === 'pencil' ? 1 : pressureSize;
      drawingRef.current = { kind: 'stroke', last: pos, tool, size, color };
      strokeSegment(ctx, pos, pos, size, color, tool);
      return;
    }

    if (tool === 'spray') {
      const ctx = rasterCtxRef.current;
      drawingRef.current = { kind: 'spray', size: pressureSize, color };
      sprayAt(ctx, pos, pressureSize, color);
      return;
    }

    if (tool === 'bucket') {
      const ctx = rasterCtxRef.current;
      const raster = rasterRef.current;
      const imageData = ctx.getImageData(0, 0, raster.width, raster.height);
      const rgba = hexToRgba(color);
      floodFill(imageData, Math.round(pos.x), Math.round(pos.y), rgba, tolerance);
      ctx.putImageData(imageData, 0, 0);
      pushRasterSnapshot();
      setDirty(true);
      return;
    }

    if (tool === 'eyedropper') {
      const ctx = rasterCtxRef.current;
      const pixel = ctx.getImageData(Math.round(pos.x), Math.round(pos.y), 1, 1).data;
      const hex = '#' + [pixel[0], pixel[1], pixel[2]].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();
      if (isRightButton) setSecondaryColor(hex); else setPrimaryColor(hex);
      return;
    }

    if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
      drawingRef.current = {
        kind: 'vector-draw',
        type: tool,
        start: pos,
        color,
        previewShape: null,
      };
      return;
    }

    if (tool === 'text') {
      const text = window.prompt('Text:', '');
      if (text) {
        const shape = addShape(vectorDocRef.current, {
          type: 'text',
          x1: pos.x,
          y1: pos.y,
          text,
          stroke: color,
          font: { size: 16, family: 'monospace' },
        });
        vectorUndoRef.current.push(cloneDoc(vectorDocRef.current));
        setVectorVersion((v) => v + 1);
        setSelectedShapeId(shape.id);
        setDirty(true);
      }
      return;
    }

    if (tool === 'select') {
      const hitId = hitTest(vectorDocRef.current, pos.x, pos.y);
      setSelectedShapeId(hitId);
      if (hitId) {
        drawingRef.current = { kind: 'select-drag', last: pos, id: hitId };
      }
      return;
    }
  }, [tool, brushSize, primaryColor, secondaryColor, tolerance, strokeSegment, sprayAt, eventToCanvasPoint, pushRasterSnapshot]);

  const handlePointerMove = useCallback((e) => {
    const pos = eventToCanvasPoint(e);
    setCursorPos({ x: Math.round(pos.x), y: Math.round(pos.y) });
    const drag = drawingRef.current;
    if (!drag) return;

    if (drag.kind === 'stroke') {
      const ctx = rasterCtxRef.current;
      const size = e.pointerType === 'pen' && e.pressure > 0
        ? Math.max(1, Math.round(drag.size * (0.4 + e.pressure * 1.2)))
        : drag.size;
      strokeSegment(ctx, drag.last, pos, size, drag.color, drag.tool);
      drag.last = pos;
      return;
    }

    if (drag.kind === 'spray') {
      const ctx = rasterCtxRef.current;
      sprayAt(ctx, pos, drag.size, drag.color);
      return;
    }

    if (drag.kind === 'vector-draw') {
      const filled = shapeMode === 'filled' || shapeMode === 'both';
      drag.previewShape = {
        type: drag.type,
        x1: drag.start.x,
        y1: drag.start.y,
        x2: pos.x,
        y2: pos.y,
        stroke: drag.color,
        width: brushSize,
        fill: filled ? drag.color : null,
      };
      renderOverlay();
      return;
    }

    if (drag.kind === 'select-drag') {
      const dx = pos.x - drag.last.x;
      const dy = pos.y - drag.last.y;
      moveShape(vectorDocRef.current, drag.id, dx, dy);
      drag.last = pos;
      setVectorVersion((v) => v + 1);
      return;
    }
  }, [eventToCanvasPoint, strokeSegment, sprayAt, shapeMode, brushSize, renderOverlay]);

  const handlePointerUp = useCallback((e) => {
    const overlay = overlayRef.current;
    if (overlay && overlay.hasPointerCapture && overlay.hasPointerCapture(e.pointerId)) {
      overlay.releasePointerCapture(e.pointerId);
    }
    const drag = drawingRef.current;
    drawingRef.current = null;
    if (!drag) return;

    if (drag.kind === 'stroke' || drag.kind === 'spray') {
      pushRasterSnapshot();
      setDirty(true);
      return;
    }

    if (drag.kind === 'vector-draw' && drag.previewShape) {
      const shape = addShape(vectorDocRef.current, drag.previewShape);
      vectorUndoRef.current.push(cloneDoc(vectorDocRef.current));
      setSelectedShapeId(shape.id);
      setVectorVersion((v) => v + 1);
      setDirty(true);
      return;
    }

    if (drag.kind === 'select-drag') {
      vectorUndoRef.current.push(cloneDoc(vectorDocRef.current));
      setDirty(true);
      return;
    }
  }, [pushRasterSnapshot]);

  // Delete key removes the selected vector shape.
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        doSave();
        return;
      }
      if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && tool === 'select' && selectedShapeId) {
        e.preventDefault();
        deleteShape(vectorDocRef.current, selectedShapeId);
        vectorUndoRef.current.push(cloneDoc(vectorDocRef.current));
        setSelectedShapeId(null);
        setVectorVersion((v) => v + 1);
        setDirty(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // doSave defined below via useCallback; declared with function hoisting workaround below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo, tool, selectedShapeId]);

  // -----------------------------------------------------------------------
  // Save / OCR / Close
  // -----------------------------------------------------------------------

  const doSave = useCallback(async (extra) => {
    const blob = await flattenToBlob();
    if (!blob) return;
    const vector = serializeDoc(vectorDocRef.current);
    const svg = docToSVG(vectorDocRef.current);
    setDirty(false);
    onSave({ png: blob, vector, svg, ...(extra || {}) });
  }, [flattenToBlob, onSave]);

  const doOcr = useCallback(async () => {
    if (!onOcr) return;
    setOcrError(null);
    setOcrBusy(true);
    try {
      const blob = await flattenToBlob();
      const text = await onOcr(blob);
      setOcrText(text || '');
    } catch (err) {
      setOcrError(err && err.message ? err.message : String(err));
    } finally {
      setOcrBusy(false);
    }
  }, [flattenToBlob, onOcr]);

  const insertOcrIntoNote = useCallback(() => {
    doSave({ ocrText: ocrText || '' });
  }, [doSave, ocrText]);

  const doClose = useCallback(() => {
    if (dirty) {
      const ok = window.confirm('You have unsaved changes. Close without saving?');
      if (!ok) return;
    }
    onClose();
  }, [dirty, onClose]);

  // -----------------------------------------------------------------------
  // Palette swatch click handler (left = primary, right = secondary)
  // -----------------------------------------------------------------------

  const onSwatchClick = useCallback((hex) => (e) => {
    e.preventDefault();
    if (e.button === 2) setSecondaryColor(hex); else setPrimaryColor(hex);
  }, []);

  const onSwatchContextMenu = useCallback((hex) => (e) => {
    e.preventDefault();
    setSecondaryColor(hex);
  }, []);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (needsSizePrompt) {
    return (
      <div className="nk-paint-root nk-paint-size-prompt" ref={containerRef}>
        <div className="nk-paint-header">
          <span className="nk-paint-title">{title || 'New drawing'}</span>
          <button className="nk-paint-btn nk-paint-btn-close" onClick={onClose}>X</button>
        </div>
        <div className="nk-paint-size-panel">
          <div className="nk-paint-label">Choose a canvas size:</div>
          <div className="nk-paint-size-options">
            {CANVAS_PRESETS.map((p) => (
              <button key={p.label} className="nk-paint-btn" onClick={() => startWithSize(p.width, p.height)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={'nk-paint-root' + (narrow ? ' nk-paint-narrow' : '')} ref={containerRef}>
      <div className="nk-paint-header">
        <span className="nk-paint-title">{title || 'Drawing'}{dirty ? ' *' : ''}</span>
        <div className="nk-paint-header-actions">
          <button className="nk-paint-btn nk-paint-btn-accent" onClick={() => doSave()}>Save</button>
          {onOcr && (
            <button className="nk-paint-btn" onClick={doOcr} disabled={ocrBusy}>
              {ocrBusy ? 'Reading…' : 'Extract text (OCR)'}
            </button>
          )}
          <button className="nk-paint-btn nk-paint-btn-close" onClick={doClose}>Close</button>
        </div>
      </div>

      <div className="nk-paint-body">
        <div className="nk-paint-toolbox">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={'nk-paint-tool-btn' + (tool === t.id ? ' nk-paint-tool-active' : '')}
              title={t.label}
              onClick={() => { setTool(t.id); setSelectedShapeId(null); }}
            >
              <span className="nk-paint-tool-icon">{t.icon}</span>
              <span className="nk-paint-tool-label">{t.label}</span>
            </button>
          ))}

          <div className="nk-paint-tool-section">
            <div className="nk-paint-label">Size</div>
            <div className="nk-paint-size-row">
              {BRUSH_SIZES.map((s) => (
                <button
                  key={s}
                  className={'nk-paint-size-btn' + (brushSize === s ? ' nk-paint-tool-active' : '')}
                  onClick={() => setBrushSize(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {(tool === 'rect' || tool === 'ellipse') && (
            <div className="nk-paint-tool-section">
              <div className="nk-paint-label">Shape mode</div>
              <select className="nk-paint-select" value={shapeMode} onChange={(e) => setShapeMode(e.target.value)}>
                <option value="outline">Outline</option>
                <option value="filled">Filled</option>
                <option value="both">Both</option>
              </select>
            </div>
          )}

          {tool === 'bucket' && (
            <div className="nk-paint-tool-section">
              <div className="nk-paint-label">Tolerance</div>
              <input
                className="nk-paint-range"
                type="range"
                min="0"
                max="128"
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))}
              />
            </div>
          )}

          <div className="nk-paint-tool-section">
            <button className="nk-paint-btn" onClick={undo}>Undo</button>
            <button className="nk-paint-btn" onClick={redo}>Redo</button>
            <button className="nk-paint-btn" onClick={clearCanvas}>Clear</button>
            <button className="nk-paint-btn" onClick={flattenVectorsToRaster}>Flatten</button>
          </div>
        </div>

        <div className="nk-paint-canvas-scroller">
          <div
            className="nk-paint-canvas-stack"
            style={canvasSize ? { width: canvasSize.width, height: canvasSize.height } : undefined}
          >
            <canvas ref={rasterRef} className="nk-paint-layer nk-paint-layer-raster" />
            <canvas
              ref={overlayRef}
              className="nk-paint-layer nk-paint-layer-overlay"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onContextMenu={(e) => e.preventDefault()}
            />
          </div>
        </div>
      </div>

      <div className="nk-paint-palette-bar">
        <div className="nk-paint-swatch-preview">
          <span className="nk-paint-swatch-secondary" style={{ background: secondaryColor }} />
          <span className="nk-paint-swatch-primary" style={{ background: primaryColor }} />
        </div>
        <div className="nk-paint-palette">
          {RETRO_PALETTE.map((hex, i) => (
            <button
              key={hex + '-' + i}
              className="nk-paint-swatch"
              style={{ background: hex }}
              onClick={onSwatchClick(hex)}
              onContextMenu={onSwatchContextMenu(hex)}
              title={hex}
            />
          ))}
        </div>
      </div>

      <div className="nk-paint-statusbar">
        <span>X: {cursorPos.x} Y: {cursorPos.y}</span>
        <span>{canvasSize ? canvasSize.width + ' x ' + canvasSize.height : ''}</span>
        <span>{tool}</span>
      </div>

      {(ocrText !== null || ocrError) && (
        <div className="nk-paint-ocr-panel">
          <div className="nk-paint-label">OCR result</div>
          {ocrError && <div className="nk-paint-ocr-error">{ocrError}</div>}
          {ocrText !== null && !ocrError && (
            <React.Fragment>
              <textarea className="nk-paint-ocr-text" readOnly value={ocrText} />
              <div className="nk-paint-ocr-actions">
                <button
                  className="nk-paint-btn"
                  onClick={() => { navigator.clipboard && navigator.clipboard.writeText(ocrText); }}
                >
                  Copy
                </button>
                <button className="nk-paint-btn nk-paint-btn-accent" onClick={insertOcrIntoNote}>
                  Insert into note
                </button>
              </div>
            </React.Fragment>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shape rendering helpers (shared by overlay draw and flatten)
// ---------------------------------------------------------------------------

function drawShape(ctx, shape) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = shape.width || 1;
  ctx.strokeStyle = shape.stroke || '#000000';
  ctx.fillStyle = shape.fill || shape.stroke || '#000000';

  if (shape.type === 'line') {
    ctx.beginPath();
    ctx.moveTo(shape.x1, shape.y1);
    ctx.lineTo(shape.x2, shape.y2);
    ctx.stroke();
  } else if (shape.type === 'rect') {
    const x = Math.min(shape.x1, shape.x2);
    const y = Math.min(shape.y1, shape.y2);
    const w = Math.abs(shape.x2 - shape.x1);
    const h = Math.abs(shape.y2 - shape.y1);
    if (shape.fill) ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  } else if (shape.type === 'ellipse') {
    const cx = (shape.x1 + shape.x2) / 2;
    const cy = (shape.y1 + shape.y2) / 2;
    const rx = Math.abs(shape.x2 - shape.x1) / 2;
    const ry = Math.abs(shape.y2 - shape.y1) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (shape.fill) ctx.fill();
    ctx.stroke();
  } else if (shape.type === 'path' && Array.isArray(shape.points)) {
    ctx.beginPath();
    shape.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  } else if (shape.type === 'text') {
    const fontSize = (shape.font && shape.font.size) || 16;
    const fontFamily = (shape.font && shape.font.family) || 'monospace';
    ctx.font = fontSize + 'px ' + fontFamily;
    ctx.fillStyle = shape.stroke || '#000000';
    ctx.fillText(shape.text || '', shape.x1, shape.y1);
  }
  ctx.restore();
}

function drawSelectionHandles(ctx, shape) {
  ctx.save();
  ctx.strokeStyle = '#00A2E8';
  ctx.setLineDash([4, 2]);
  ctx.lineWidth = 1;
  let x1, y1, x2, y2;
  if (shape.type === 'path' && Array.isArray(shape.points)) {
    const xs = shape.points.map((p) => p.x);
    const ys = shape.points.map((p) => p.y);
    x1 = Math.min(...xs); y1 = Math.min(...ys); x2 = Math.max(...xs); y2 = Math.max(...ys);
  } else {
    x1 = shape.x1; y1 = shape.y1; x2 = shape.x2 ?? shape.x1; y2 = shape.y2 ?? shape.y1;
  }
  const x = Math.min(x1, x2) - 4;
  const y = Math.min(y1, y2) - 4;
  const w = Math.abs(x2 - x1) + 8;
  const h = Math.abs(y2 - y1) + 8;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// CSS (retro Win95-adjacent bevels, tzekos.eu square-corner/hard-shadow system)
// ---------------------------------------------------------------------------

export const PAINT_CSS = [
  '.nk-paint-root {',
  '  display: flex; flex-direction: column;',
  '  background: var(--dsw-alias-bg-primary, #131110);',
  '  color: var(--dsw-alias-label-primary, #f4f0ed);',
  '  border: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  box-shadow: var(--tz-shadow-pop, 6px 6px 0 rgba(0,0,0,.45));',
  '  font-family: var(--tz-font-mono, ui-monospace, monospace);',
  '  max-width: 100%;',
  '}',
  '.nk-paint-header {',
  '  display: flex; align-items: center; justify-content: space-between;',
  '  padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  background: var(--dsw-alias-bg-secondary, #1b1817);',
  '}',
  '.nk-paint-title {',
  '  font-family: var(--tz-font-display, "Silkscreen", monospace);',
  '  font-size: 13px; letter-spacing: .5px;',
  '  color: var(--dsw-alias-label-primary, #f4f0ed);',
  '}',
  '.nk-paint-header-actions { display: flex; gap: 6px; }',
  '.nk-paint-btn {',
  '  border: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  background: var(--dsw-alias-bg-primary, #131110);',
  '  color: var(--dsw-alias-label-primary, #f4f0ed);',
  '  border-radius: 0; padding: 4px 10px; cursor: pointer;',
  '  font-family: var(--tz-font-mono, ui-monospace, monospace); font-size: 12px;',
  '  box-shadow: 2px 2px 0 rgba(0,0,0,.35);',
  '}',
  '.nk-paint-btn:hover { border-color: var(--tz-accent, #c1553a); }',
  '.nk-paint-btn:active { box-shadow: none; transform: translate(2px, 2px); }',
  '.nk-paint-btn:disabled { opacity: .5; cursor: default; }',
  '.nk-paint-btn-accent { border-color: var(--tz-accent, #c1553a); color: var(--tz-accent, #c1553a); }',
  '.nk-paint-btn-close { border-color: var(--tz-accent-2, #5e9bd6); }',
  '.nk-paint-body { display: flex; flex: 1; min-height: 0; }',
  '.nk-paint-toolbox {',
  '  display: flex; flex-direction: column; gap: 4px; padding: 8px;',
  '  width: 110px; flex: 0 0 auto;',
  '  border-right: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  background: var(--dsw-alias-bg-secondary, #1b1817);',
  '  overflow-y: auto;',
  '}',
  '.nk-paint-narrow .nk-paint-body { flex-direction: column; }',
  '.nk-paint-narrow .nk-paint-toolbox {',
  '  width: auto; flex-direction: row; flex-wrap: wrap;',
  '  border-right: none; border-bottom: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '}',
  '.nk-paint-tool-btn {',
  '  display: flex; align-items: center; gap: 6px;',
  '  border: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  background: var(--dsw-alias-bg-primary, #131110);',
  '  color: var(--dsw-alias-label-secondary, #c0b7b2);',
  '  border-radius: 0; padding: 4px 6px; cursor: pointer; font-size: 11px;',
  '  box-shadow: 2px 2px 0 rgba(0,0,0,.3);',
  '}',
  '.nk-paint-tool-btn:hover { color: var(--dsw-alias-label-primary, #f4f0ed); }',
  '.nk-paint-tool-active {',
  '  border-color: var(--tz-accent, #c1553a); color: var(--tz-accent, #c1553a);',
  '  box-shadow: none; transform: translate(2px, 2px);',
  '}',
  '.nk-paint-tool-icon {',
  '  font-family: var(--tz-font-display, "Silkscreen", monospace);',
  '  font-size: 10px; width: 20px; text-align: center;',
  '  border: 1px solid currentColor; padding: 1px 0;',
  '}',
  '.nk-paint-tool-label { font-size: 10px; }',
  '.nk-paint-narrow .nk-paint-tool-label { display: none; }',
  '.nk-paint-tool-section {',
  '  margin-top: 6px; padding-top: 6px;',
  '  border-top: 1px dashed var(--dsw-alias-border-primary, #3a332f);',
  '  display: flex; flex-direction: column; gap: 4px;',
  '}',
  '.nk-paint-label {',
  '  font-family: var(--tz-font-display, "Silkscreen", monospace);',
  '  font-size: 10px; color: var(--dsw-alias-label-secondary, #c0b7b2);',
  '  text-transform: uppercase; letter-spacing: .5px;',
  '}',
  '.nk-paint-size-row, .nk-paint-size-options { display: flex; gap: 4px; flex-wrap: wrap; }',
  '.nk-paint-size-btn {',
  '  width: 24px; height: 24px; border: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  background: var(--dsw-alias-bg-primary, #131110); color: var(--dsw-alias-label-primary, #f4f0ed);',
  '  border-radius: 0; cursor: pointer; font-size: 11px;',
  '}',
  '.nk-paint-select, .nk-paint-range {',
  '  background: var(--dsw-alias-bg-primary, #131110); color: var(--dsw-alias-label-primary, #f4f0ed);',
  '  border: 1px solid var(--dsw-alias-border-primary, #3a332f); border-radius: 0; font-size: 11px;',
  '}',
  '.nk-paint-canvas-scroller {',
  '  flex: 1; overflow: auto; background: var(--dsw-alias-bg-secondary, #1b1817);',
  '  display: flex; align-items: flex-start; justify-content: flex-start; padding: 12px;',
  '}',
  '.nk-paint-canvas-stack { position: relative; box-shadow: var(--tz-shadow-pop, 6px 6px 0 rgba(0,0,0,.45)); flex: 0 0 auto; }',
  '.nk-paint-layer { position: absolute; top: 0; left: 0; touch-action: none; }',
  '.nk-paint-layer-raster { background: #FFFFFF; }',
  '.nk-paint-layer-overlay { cursor: crosshair; }',
  '.nk-paint-palette-bar {',
  '  display: flex; align-items: center; gap: 8px; padding: 6px 10px;',
  '  border-top: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  background: var(--dsw-alias-bg-secondary, #1b1817);',
  '  flex-wrap: wrap;',
  '}',
  '.nk-paint-swatch-preview { position: relative; width: 34px; height: 24px; flex: 0 0 auto; }',
  '.nk-paint-swatch-primary, .nk-paint-swatch-secondary {',
  '  position: absolute; width: 20px; height: 20px; border: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '}',
  '.nk-paint-swatch-primary { left: 0; top: 4px; z-index: 1; }',
  '.nk-paint-swatch-secondary { left: 10px; top: 0; }',
  '.nk-paint-palette { display: flex; flex-wrap: wrap; gap: 2px; max-width: 420px; }',
  '.nk-paint-swatch {',
  '  width: 16px; height: 16px; border: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  border-radius: 0; cursor: pointer; padding: 0;',
  '}',
  '.nk-paint-swatch:hover { outline: 1px solid var(--tz-accent, #c1553a); }',
  '.nk-paint-statusbar {',
  '  display: flex; gap: 16px; padding: 3px 10px; font-size: 11px;',
  '  border-top: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  color: var(--dsw-alias-label-secondary, #c0b7b2);',
  '}',
  '.nk-paint-size-prompt .nk-paint-size-panel { padding: 24px; display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }',
  '.nk-paint-ocr-panel {',
  '  padding: 10px; border-top: 1px solid var(--dsw-alias-border-primary, #3a332f);',
  '  background: var(--dsw-alias-bg-secondary, #1b1817);',
  '  display: flex; flex-direction: column; gap: 6px;',
  '}',
  '.nk-paint-ocr-text {',
  '  width: 100%; min-height: 80px; resize: vertical;',
  '  background: var(--dsw-alias-bg-primary, #131110); color: var(--dsw-alias-label-primary, #f4f0ed);',
  '  border: 1px solid var(--dsw-alias-border-primary, #3a332f); border-radius: 0;',
  '  font-family: var(--tz-font-mono, ui-monospace, monospace); font-size: 12px; padding: 6px;',
  '}',
  '.nk-paint-ocr-actions { display: flex; gap: 6px; }',
  '.nk-paint-ocr-error { color: var(--tz-accent, #c1553a); font-size: 12px; }',
].join('\n');
