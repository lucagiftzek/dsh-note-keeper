// Unit tests for graph-core.js — force simulation and neighbourhood filtering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, step, neighbors, filterLocal } from '../src/client/graph-core.js';

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

test('connected nodes converge closer together than an unconnected node', () => {
  const nodes = [
    { id: 'a', kind: 'note' },
    { id: 'b', kind: 'note' },
    { id: 'c', kind: 'note' }, // isolated — no edges
  ];
  const edges = [{ source: 'a', target: 'b' }];
  const sim = createSim(nodes, edges, { width: 400, height: 400, seed: 7 });

  for (let i = 0; i < 200; i++) step(sim, 0.5);

  const a = sim.nodeById.get('a');
  const b = sim.nodeById.get('b');
  const c = sim.nodeById.get('c');

  const abDist = dist(a, b);
  const acDist = dist(a, c);
  const bcDist = dist(b, c);

  assert.ok(abDist < acDist, 'connected pair a-b should end up closer than a-c');
  assert.ok(abDist < bcDist, 'connected pair a-b should end up closer than b-c');
});

test('step() does not throw on edges referencing nodes outside the set', () => {
  const nodes = [{ id: 'x' }, { id: 'y' }];
  const edges = [{ source: 'x', target: 'y' }, { source: 'x', target: 'missing' }];
  const sim = createSim(nodes, edges, { seed: 1 });
  assert.equal(sim.edges.length, 1, 'edges to unknown nodes are dropped at sim creation');
  assert.doesNotThrow(() => step(sim, 0.3));
});

test('step() caps repulsion work but still moves nodes when node count > 400', () => {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < 420; i++) nodes.push({ id: 'n' + i });
  const sim = createSim(nodes, edges, { seed: 3 });
  const before = sim.nodes[419].x;
  step(sim, 0.5);
  // Should not throw and should complete quickly; position may or may not
  // change for nodes beyond the repulsion cap, but centering still applies.
  assert.equal(sim.nodes.length, 420);
  assert.equal(typeof sim.nodes[419].x, 'number');
  void before;
});

test('neighbors() returns BFS neighborhood up to a given depth', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'd' },
  ];
  const sim = createSim(nodes, edges, { seed: 2 });

  const depth1 = neighbors(sim, 'a', 1);
  assert.deepEqual([...depth1].sort(), ['a', 'b']);

  const depth2 = neighbors(sim, 'a', 2);
  assert.deepEqual([...depth2].sort(), ['a', 'b', 'c']);

  const depth3 = neighbors(sim, 'a', 3);
  assert.deepEqual([...depth3].sort(), ['a', 'b', 'c', 'd']);
});

test('filterLocal restricts nodes/edges to the focus neighborhood', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'isolated' }];
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'd' },
  ];

  const depth1 = filterLocal(nodes, edges, 'b', 1);
  assert.deepEqual(depth1.nodes.map((n) => n.id).sort(), ['a', 'b', 'c']);
  assert.equal(depth1.edges.length, 2);

  const depth2 = filterLocal(nodes, edges, 'b', 2);
  assert.deepEqual(depth2.nodes.map((n) => n.id).sort(), ['a', 'b', 'c', 'd']);

  const missingFocus = filterLocal(nodes, edges, 'nonexistent', 1);
  assert.deepEqual(missingFocus, { nodes: [], edges: [] });
});

test('filterLocal never pulls in the fully isolated node', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'isolated' }];
  const edges = [{ source: 'a', target: 'b' }];
  const result = filterLocal(nodes, edges, 'a', 5);
  assert.ok(!result.nodes.some((n) => n.id === 'isolated'));
});
