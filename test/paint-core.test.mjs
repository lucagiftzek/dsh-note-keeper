// Unit tests for paint-core.js — flood fill, vector doc model, undo stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
} from '../src/client/paint-core.js';

/** Build a blank W x H RGBA image, optionally pre-filled with a colour. */
function makeImage(width, height, fillColor = [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fillColor[0];
    data[i + 1] = fillColor[1];
    data[i + 2] = fillColor[2];
    data[i + 3] = fillColor[3];
  }
  return { data, width, height };
}

function pixelAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

// --- floodFill ---------------------------------------------------------

test('floodFill fills a bounded region and stops at the boundary', () => {
  const img = makeImage(10, 10);
  // Draw a black vertical wall at x=5 splitting the image in two regions.
  for (let y = 0; y < 10; y++) {
    const i = (y * 10 + 5) * 4;
    img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = 255;
  }
  const filled = floodFill(img, 1, 1, [255, 0, 0, 255], 0);
  // Left region (x=0..4, 10 rows) = 50 pixels should be filled red.
  assert.equal(filled, 50);
  assert.deepEqual(pixelAt(img, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(img, 4, 9), [255, 0, 0, 255]);
  // Right region and the wall itself must remain untouched.
  assert.deepEqual(pixelAt(img, 5, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixelAt(img, 6, 0), [255, 255, 255, 255]);
});

test('floodFill respects tolerance to bridge near-matching colours', () => {
  const img = makeImage(4, 1, [200, 200, 200, 255]);
  // Slightly different shade at x=2 — should still be included with enough tolerance.
  const i = (0 * 4 + 2) * 4;
  img.data[i] = 210; img.data[i + 1] = 210; img.data[i + 2] = 210; img.data[i + 3] = 255;

  const filledLowTol = floodFill(makeImageCopy(img), 0, 0, [0, 255, 0, 255], 0);
  assert.equal(filledLowTol, 2, 'zero tolerance should stop before the shade change');

  const filledHighTol = floodFill(makeImageCopy(img), 0, 0, [0, 255, 0, 255], 20);
  assert.equal(filledHighTol, 4, 'sufficient tolerance should bridge the shade change');
});

function makeImageCopy(img) {
  return { data: Uint8ClampedArray.from(img.data), width: img.width, height: img.height };
}

test('floodFill on an already-filled colour is a no-op', () => {
  const img = makeImage(5, 5, [10, 20, 30, 255]);
  const filled = floodFill(img, 2, 2, [10, 20, 30, 255], 0);
  assert.equal(filled, 0);
});

test('RETRO_PALETTE has 28 valid hex colours', () => {
  assert.equal(RETRO_PALETTE.length, 28);
  for (const hex of RETRO_PALETTE) {
    assert.match(hex, /^#[0-9A-Fa-f]{6}$/);
  }
});

test('hexToRgba converts 3- and 6-digit hex', () => {
  assert.deepEqual(hexToRgba('#ff0000'), [255, 0, 0, 255]);
  assert.deepEqual(hexToRgba('#f00'), [255, 0, 0, 255]);
  assert.deepEqual(hexToRgba('#000000', 128), [0, 0, 0, 128]);
  assert.throws(() => hexToRgba('not-a-color'));
});

// --- vector doc model ----------------------------------------------------

test('addShape + hitTest finds the topmost shape at a point', () => {
  const doc = createDoc(100, 100);
  addShape(doc, { type: 'rect', x1: 10, y1: 10, x2: 40, y2: 40, stroke: '#000000', fill: '#ff0000', width: 1 });
  const top = addShape(doc, { type: 'rect', x1: 20, y1: 20, x2: 60, y2: 60, stroke: '#000000', fill: '#00ff00', width: 1 });
  const hitId = hitTest(doc, 30, 30);
  assert.equal(hitId, top.id, 'the later (topmost) overlapping shape should win');
  assert.equal(hitTest(doc, 90, 90), null, 'a point outside all shapes should miss');
});

test('hitTest finds outline-only shapes near their edge, not their empty interior', () => {
  const doc = createDoc(100, 100);
  const rect = addShape(doc, { type: 'rect', x1: 10, y1: 10, x2: 50, y2: 50, stroke: '#000000', fill: null, width: 2 });
  assert.equal(hitTest(doc, 10, 30), rect.id, 'near the left edge should hit');
  assert.equal(hitTest(doc, 30, 30), null, 'the hollow interior should miss');
});

test('moveShape and deleteShape mutate the document', () => {
  const doc = createDoc(50, 50);
  const line = addShape(doc, { type: 'line', x1: 0, y1: 0, x2: 10, y2: 10, stroke: '#000', width: 1 });
  assert.equal(moveShape(doc, line.id, 5, 5), true);
  assert.equal(line.x1, 5);
  assert.equal(line.y2, 15);
  assert.equal(moveShape(doc, 'missing-id', 1, 1), false);

  assert.equal(deleteShape(doc, line.id), true);
  assert.equal(doc.shapes.length, 0);
  assert.equal(deleteShape(doc, line.id), false, 'deleting again should report no-op');
});

test('serializeDoc / parseDoc round-trips and rejects bad input', () => {
  const doc = createDoc(200, 150);
  addShape(doc, { type: 'text', x1: 5, y1: 5, text: 'hello', stroke: '#000', font: { size: 12, family: 'monospace' } });
  const json = serializeDoc(doc);
  const restored = parseDoc(json);
  assert.deepEqual(restored, doc);

  assert.throws(() => parseDoc('not json'), /invalid JSON/);
  assert.throws(() => parseDoc(JSON.stringify({ version: 'wrong', width: 1, height: 1, shapes: [] })), /unsupported version/);
  assert.throws(() => parseDoc(JSON.stringify({ version: 'nk-drawing/1', width: 1, height: 1, shapes: [{ type: 'unknown' }] })), /invalid shape/);
  assert.throws(() => serializeDoc({ version: 'bad' }));
});

test('docToSVG escapes text content (no script injection)', () => {
  const doc = createDoc(100, 100);
  addShape(doc, { type: 'text', x1: 0, y1: 10, text: '<script>alert(1)</script>', stroke: '#000', font: { size: 10 } });
  const svg = docToSVG(doc);
  assert.ok(!svg.includes('<script>'), 'raw script tag must not appear in the SVG output');
  assert.ok(svg.includes('&lt;script&gt;'), 'text must be escaped');
  assert.ok(svg.startsWith('<svg'));
});

test('docToSVG renders basic shape kinds', () => {
  const doc = createDoc(100, 100);
  addShape(doc, { type: 'line', x1: 0, y1: 0, x2: 10, y2: 10, stroke: '#000', width: 2 });
  addShape(doc, { type: 'rect', x1: 0, y1: 0, x2: 10, y2: 10, stroke: '#000', fill: '#fff', width: 1 });
  addShape(doc, { type: 'ellipse', x1: 0, y1: 0, x2: 10, y2: 10, stroke: '#000', width: 1 });
  const svg = docToSVG(doc);
  assert.match(svg, /<line/);
  assert.match(svg, /<rect/);
  assert.match(svg, /<ellipse/);
});

// --- UndoStack -------------------------------------------------------------

test('UndoStack push/undo/redo/canUndo/canRedo', () => {
  const stack = new UndoStack(3);
  assert.equal(stack.canUndo(), false);
  stack.push('a');
  assert.equal(stack.canUndo(), false, 'a single snapshot has nothing to undo to');
  stack.push('b');
  stack.push('c');
  assert.equal(stack.canUndo(), true);
  assert.equal(stack.undo(), 'b');
  assert.equal(stack.canRedo(), true);
  assert.equal(stack.redo(), 'c');
  assert.equal(stack.canRedo(), false);
});

test('UndoStack caps at maxSize and drops oldest snapshots', () => {
  const stack = new UndoStack(2);
  stack.push('a');
  stack.push('b');
  stack.push('c'); // should evict 'a'
  assert.equal(stack.undo(), 'b');
  assert.equal(stack.canUndo(), false, 'a should have been evicted, so no further undo');
});

test('UndoStack push after undo clears the redo branch', () => {
  const stack = new UndoStack(5);
  stack.push('a');
  stack.push('b');
  stack.undo();
  stack.push('c');
  assert.equal(stack.canRedo(), false);
  assert.equal(stack.current(), 'c');
});
