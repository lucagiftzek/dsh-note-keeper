/**
 * paint-core.js — pure logic for the retro Paint editor. No DOM, no React.
 * Exports: floodFill, RETRO_PALETTE, hexToRgba, vector doc helpers, UndoStack.
 * Every function here must be unit-testable under plain node:test.
 */

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

/** The 28 classic MS Paint palette colours (hex strings, uppercase). */
export const RETRO_PALETTE = [
  '#000000', '#7F7F7F', '#880015', '#ED1C24', '#FF7F27', '#FFF200', '#22B14C', '#00A2E8',
  '#3F48CC', '#A349A4', '#FFFFFF', '#C3C3C3', '#B97A57', '#FFAEC9', '#FFC90E', '#EFE4B0',
  '#B5E61D', '#99D9EA', '#7092BE', '#C8BFE7', '#000000', '#7F7F7F', '#880015', '#ED1C24',
  '#FF7F27', '#FFF200', '#22B14C', '#00A2E8',
];

/**
 * Convert a hex colour string ("#rrggbb" or "#rgb") to an [r,g,b,a] array.
 * @param {string} hex
 * @param {number} [alpha=255] 0-255 alpha channel to attach
 * @returns {[number, number, number, number]}
 */
export function hexToRgba(hex, alpha = 255) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`hexToRgba: invalid hex colour "${hex}"`);
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [r, g, b, alpha];
}

// ---------------------------------------------------------------------------
// Flood fill (scanline algorithm, iterative — no recursion, no stack overflow)
// ---------------------------------------------------------------------------

/**
 * Flood-fill an ImageData-like buffer starting at (x, y) with the given
 * colour, using a horizontal scanline algorithm (iterative, stack-based —
 * never recursive, so it is safe on large canvases).
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image
 * @param {number} x start x (integer pixel coordinate)
 * @param {number} y start y (integer pixel coordinate)
 * @param {[number, number, number, number]} color target [r,g,b,a] to paint
 * @param {number} [tolerance=0] per-channel colour distance allowed to still
 *   be considered "the same" as the seed pixel (0 = exact match only)
 * @returns {number} number of pixels actually changed
 */
export function floodFill(image, x, y, color, tolerance = 0) {
  const { data, width, height } = image;
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;

  const idxOf = (px, py) => (py * width + px) * 4;

  const seedIdx = idxOf(x, y);
  const seedR = data[seedIdx];
  const seedG = data[seedIdx + 1];
  const seedB = data[seedIdx + 2];
  const seedA = data[seedIdx + 3];

  const [fr, fg, fb, fa] = color;

  // No-op if the target colour already matches the seed colour exactly.
  if (seedR === fr && seedG === fg && seedB === fb && seedA === fa) return 0;

  const matches = (px, py) => {
    const i = idxOf(px, py);
    const dr = Math.abs(data[i] - seedR);
    const dg = Math.abs(data[i + 1] - seedG);
    const db = Math.abs(data[i + 2] - seedB);
    const da = Math.abs(data[i + 3] - seedA);
    return dr <= tolerance && dg <= tolerance && db <= tolerance && da <= tolerance;
  };

  const paint = (px, py) => {
    const i = idxOf(px, py);
    data[i] = fr;
    data[i + 1] = fg;
    data[i + 2] = fb;
    data[i + 3] = fa;
  };

  let filled = 0;
  // Stack of scanline seeds: [x, y]
  const stack = [[x, y]];
  const visited = new Uint8Array(width * height);

  while (stack.length > 0) {
    let [sx, sy] = stack.pop();
    if (visited[sy * width + sx]) continue;
    if (!matches(sx, sy)) continue;

    // Walk left to find the start of this scanline run.
    let left = sx;
    while (left > 0 && !visited[sy * width + (left - 1)] && matches(left - 1, sy)) left--;
    // Walk right to find the end of this scanline run.
    let right = sx;
    while (right < width - 1 && !visited[sy * width + (right + 1)] && matches(right + 1, sy)) right++;

    let spanAbove = false;
    let spanBelow = false;
    for (let px = left; px <= right; px++) {
      const vIdx = sy * width + px;
      if (!visited[vIdx]) {
        paint(px, sy);
        visited[vIdx] = 1;
        filled++;
      }
      if (sy > 0) {
        const above = matches(px, sy - 1) && !visited[(sy - 1) * width + px];
        if (above && !spanAbove) {
          stack.push([px, sy - 1]);
          spanAbove = true;
        } else if (!above) {
          spanAbove = false;
        }
      }
      if (sy < height - 1) {
        const below = matches(px, sy + 1) && !visited[(sy + 1) * width + px];
        if (below && !spanBelow) {
          stack.push([px, sy + 1]);
          spanBelow = true;
        } else if (!below) {
          spanBelow = false;
        }
      }
    }
  }

  return filled;
}

// ---------------------------------------------------------------------------
// Vector document model
// ---------------------------------------------------------------------------

const DOC_VERSION = 'nk-drawing/1';
const VALID_SHAPE_TYPES = new Set(['line', 'rect', 'ellipse', 'path', 'text']);

let shapeIdCounter = 0;
/** Generate a locally-unique shape id (not cryptographic, just unique per session). */
function nextShapeId() {
  shapeIdCounter += 1;
  return `shape-${Date.now().toString(36)}-${shapeIdCounter}`;
}

/**
 * Create a fresh, empty vector document.
 * @param {number} width
 * @param {number} height
 * @returns {{version: string, width: number, height: number, shapes: object[]}}
 */
export function createDoc(width, height) {
  return {
    version: DOC_VERSION,
    width: Math.max(1, Math.round(width) || 1),
    height: Math.max(1, Math.round(height) || 1),
    shapes: [],
  };
}

/**
 * Append a shape to a document, assigning an id if it does not have one.
 * Mutates and returns the document for convenience.
 * @param {object} doc
 * @param {object} shape partial shape; type is required
 * @returns {object} the shape actually stored (with its id set)
 */
export function addShape(doc, shape) {
  if (!shape || !VALID_SHAPE_TYPES.has(shape.type)) {
    throw new Error(`addShape: unknown shape type "${shape && shape.type}"`);
  }
  const stored = { id: shape.id || nextShapeId(), ...shape };
  stored.id = shape.id || stored.id;
  doc.shapes.push(stored);
  return stored;
}

/** Compute the bounding box of a shape (used by hitTest and rendering). */
function shapeBounds(shape) {
  if (shape.type === 'path' && Array.isArray(shape.points)) {
    const xs = shape.points.map((p) => p.x);
    const ys = shape.points.map((p) => p.y);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }
  const x1 = shape.x1 ?? 0;
  const y1 = shape.y1 ?? 0;
  const x2 = shape.x2 ?? x1;
  const y2 = shape.y2 ?? y1;
  return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
}

/** Distance from a point to a line segment. */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Find the topmost shape under a point, tolerance-aware (so thin strokes and
 * unfilled outlines are still easy to click).
 * @param {object} doc
 * @param {number} x
 * @param {number} y
 * @param {number} [tolerance=6] pixel tolerance around thin strokes
 * @returns {string|null} shape id, or null if nothing hit
 */
export function hitTest(doc, x, y, tolerance = 6) {
  for (let i = doc.shapes.length - 1; i >= 0; i--) {
    const s = doc.shapes[i];
    const strokeW = Math.max(1, s.width || 1);
    const tol = tolerance + strokeW / 2;

    if (s.type === 'line') {
      if (distToSegment(x, y, s.x1, s.y1, s.x2, s.y2) <= tol) return s.id;
      continue;
    }

    if (s.type === 'rect') {
      const b = shapeBounds(s);
      const inside = x >= b.minX - tol && x <= b.maxX + tol && y >= b.minY - tol && y <= b.maxY + tol;
      if (!inside) continue;
      if (s.fill) return s.id;
      // Outline only: must be near one of the four edges.
      const nearLeft = Math.abs(x - b.minX) <= tol && y >= b.minY - tol && y <= b.maxY + tol;
      const nearRight = Math.abs(x - b.maxX) <= tol && y >= b.minY - tol && y <= b.maxY + tol;
      const nearTop = Math.abs(y - b.minY) <= tol && x >= b.minX - tol && x <= b.maxX + tol;
      const nearBottom = Math.abs(y - b.maxY) <= tol && x >= b.minX - tol && x <= b.maxX + tol;
      if (nearLeft || nearRight || nearTop || nearBottom) return s.id;
      continue;
    }

    if (s.type === 'ellipse') {
      const b = shapeBounds(s);
      const rx = (b.maxX - b.minX) / 2 || 1;
      const ry = (b.maxY - b.minY) / 2 || 1;
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      const nx = (x - cx) / (rx + tol);
      const ny = (y - cy) / (ry + tol);
      const outerHit = nx * nx + ny * ny <= 1;
      if (!outerHit) continue;
      if (s.fill) return s.id;
      const nx2 = (x - cx) / Math.max(1, rx - tol);
      const ny2 = (y - cy) / Math.max(1, ry - tol);
      const innerHit = nx2 * nx2 + ny2 * ny2 <= 1;
      if (!innerHit) return s.id; // inside outer ring, outside inner ring
      continue;
    }

    if (s.type === 'path' && Array.isArray(s.points)) {
      for (let p = 0; p < s.points.length - 1; p++) {
        const a = s.points[p];
        const b2 = s.points[p + 1];
        if (distToSegment(x, y, a.x, a.y, b2.x, b2.y) <= tol) return s.id;
      }
      continue;
    }

    if (s.type === 'text') {
      const fontSize = s.font && s.font.size ? s.font.size : 16;
      const approxWidth = (s.text || '').length * fontSize * 0.6;
      const minX = s.x1;
      const minY = s.y1 - fontSize;
      const maxX = s.x1 + approxWidth;
      const maxY = s.y1;
      if (x >= minX - tol && x <= maxX + tol && y >= minY - tol && y <= maxY + tol) return s.id;
      continue;
    }
  }
  return null;
}

/**
 * Move a shape by (dx, dy). Mutates the matching shape in place.
 * @param {object} doc
 * @param {string} id
 * @param {number} dx
 * @param {number} dy
 * @returns {boolean} whether a shape was found and moved
 */
export function moveShape(doc, id, dx, dy) {
  const s = doc.shapes.find((sh) => sh.id === id);
  if (!s) return false;
  if (s.type === 'path' && Array.isArray(s.points)) {
    s.points = s.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  } else {
    if (s.x1 != null) s.x1 += dx;
    if (s.y1 != null) s.y1 += dy;
    if (s.x2 != null) s.x2 += dx;
    if (s.y2 != null) s.y2 += dy;
  }
  return true;
}

/**
 * Remove a shape by id.
 * @param {object} doc
 * @param {string} id
 * @returns {boolean} whether a shape was removed
 */
export function deleteShape(doc, id) {
  const before = doc.shapes.length;
  doc.shapes = doc.shapes.filter((s) => s.id !== id);
  return doc.shapes.length !== before;
}

/**
 * Serialize a document to a JSON string.
 * @param {object} doc
 * @returns {string}
 */
export function serializeDoc(doc) {
  if (!doc || doc.version !== DOC_VERSION) {
    throw new Error('serializeDoc: document missing correct version field');
  }
  return JSON.stringify(doc);
}

/**
 * Parse and validate a serialized document. Throws on malformed input so
 * callers can decide how to recover (e.g. start a fresh doc).
 * @param {string} json
 * @returns {object} validated document
 */
export function parseDoc(json) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('parseDoc: invalid JSON');
  }
  if (!raw || typeof raw !== 'object') throw new Error('parseDoc: not an object');
  if (raw.version !== DOC_VERSION) throw new Error(`parseDoc: unsupported version "${raw.version}"`);
  if (typeof raw.width !== 'number' || typeof raw.height !== 'number') {
    throw new Error('parseDoc: width/height must be numbers');
  }
  if (!Array.isArray(raw.shapes)) throw new Error('parseDoc: shapes must be an array');
  for (const s of raw.shapes) {
    if (!s || typeof s !== 'object' || !VALID_SHAPE_TYPES.has(s.type)) {
      throw new Error(`parseDoc: invalid shape entry (type "${s && s.type}")`);
    }
    if (!s.id || typeof s.id !== 'string') throw new Error('parseDoc: shape missing string id');
  }
  return {
    version: raw.version,
    width: raw.width,
    height: raw.height,
    shapes: raw.shapes.map((s) => ({ ...s })),
  };
}

/** Escape text for safe inclusion inside SVG markup (prevents markup/script injection). */
function escapeSvgText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render a document to a standalone SVG string. Text content is escaped.
 * @param {object} doc
 * @returns {string}
 */
export function docToSVG(doc) {
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">`);
  for (const s of doc.shapes) {
    const stroke = s.stroke || 'none';
    const fillAttr = s.fill ? (typeof s.fill === 'string' ? s.fill : stroke) : 'none';
    const strokeWidth = s.width || 1;
    if (s.type === 'line') {
      parts.push(`<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${stroke}" stroke-width="${strokeWidth}" />`);
    } else if (s.type === 'rect') {
      const b = shapeBounds(s);
      parts.push(`<rect x="${b.minX}" y="${b.minY}" width="${b.maxX - b.minX}" height="${b.maxY - b.minY}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fillAttr}" />`);
    } else if (s.type === 'ellipse') {
      const b = shapeBounds(s);
      const rx = (b.maxX - b.minX) / 2;
      const ry = (b.maxY - b.minY) / 2;
      const cx = b.minX + rx;
      const cy = b.minY + ry;
      parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fillAttr}" />`);
    } else if (s.type === 'path' && Array.isArray(s.points)) {
      const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
      parts.push(`<path d="${d}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="none" />`);
    } else if (s.type === 'text') {
      const fontSize = (s.font && s.font.size) || 16;
      const fontFamily = escapeSvgText((s.font && s.font.family) || 'monospace');
      parts.push(`<text x="${s.x1}" y="${s.y1}" font-size="${fontSize}" font-family="${fontFamily}" fill="${stroke === 'none' ? '#000000' : stroke}">${escapeSvgText(s.text)}</text>`);
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Undo/redo stack (generic over any snapshot value)
// ---------------------------------------------------------------------------

/**
 * A bounded undo/redo stack. Generic over the snapshot type: callers push
 * whatever value represents "current state" (an ImageData clone, a vector
 * doc clone, etc.).
 */
export class UndoStack {
  /** @param {number} [maxSize=30] maximum number of snapshots retained */
  constructor(maxSize = 30) {
    this.maxSize = Math.max(1, maxSize);
    /** @type {any[]} */
    this._undo = [];
    /** @type {any[]} */
    this._redo = [];
  }

  /**
   * Push a new snapshot as the current state. Clears the redo stack (new
   * branch of history). Drops the oldest snapshot once maxSize is exceeded.
   * @param {any} snapshot
   */
  push(snapshot) {
    this._undo.push(snapshot);
    if (this._undo.length > this.maxSize) this._undo.shift();
    this._redo = [];
  }

  /** @returns {boolean} whether undo() would return a value */
  canUndo() {
    return this._undo.length > 1;
  }

  /** @returns {boolean} whether redo() would return a value */
  canRedo() {
    return this._redo.length > 0;
  }

  /**
   * Move one step back in history.
   * @returns {any|undefined} the previous snapshot, or undefined if none
   */
  undo() {
    if (!this.canUndo()) return undefined;
    const current = this._undo.pop();
    this._redo.push(current);
    return this._undo[this._undo.length - 1];
  }

  /**
   * Move one step forward in history (after an undo).
   * @returns {any|undefined} the next snapshot, or undefined if none
   */
  redo() {
    if (!this.canRedo()) return undefined;
    const snapshot = this._redo.pop();
    this._undo.push(snapshot);
    if (this._undo.length > this.maxSize) this._undo.shift();
    return snapshot;
  }

  /** @returns {any|undefined} the current top-of-stack snapshot */
  current() {
    return this._undo[this._undo.length - 1];
  }
}
