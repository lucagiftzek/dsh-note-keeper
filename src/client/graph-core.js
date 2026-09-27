/**
 * graph-core.js — pure force-directed graph layout logic. No DOM, no React.
 * Exports: createSim, step, neighbors, filterLocal.
 */

/**
 * Create a simulation state from nodes and edges.
 * Each node gets a random initial position, zero velocity.
 * @param {{id:string, kind?:string, degree?:number}[]} nodes
 * @param {{source:string, target:string}[]} edges
 * @param {{width?:number, height?:number, seed?:number}} [opts]
 * @returns {object} sim state
 */
export function createSim(nodes, edges, opts = {}) {
  const width = opts.width || 800;
  const height = opts.height || 600;

  // Simple deterministic pseudo-random generator so layouts are reproducible
  // in tests (avoids Math.random flakiness).
  let seed = opts.seed || 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 10000) / 10000;
  };

  const simNodes = nodes.map((n) => ({
    id: n.id,
    kind: n.kind || 'note',
    degree: n.degree || 0,
    x: (rand() - 0.5) * width,
    y: (rand() - 0.5) * height,
    vx: 0,
    vy: 0,
    fixed: false,
  }));

  const nodeById = new Map(simNodes.map((n) => [n.id, n]));
  const simEdges = edges
    .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  // Adjacency map for neighbors() lookups.
  const adjacency = new Map();
  for (const n of simNodes) adjacency.set(n.id, new Set());
  for (const e of simEdges) {
    adjacency.get(e.source).add(e.target);
    adjacency.get(e.target).add(e.source);
  }

  return {
    nodes: simNodes,
    edges: simEdges,
    nodeById,
    adjacency,
    width,
    height,
  };
}

/**
 * Advance the simulation by one tick: repulsion between all node pairs
 * (capped at 400 nodes worth of O(n^2) work to bound cost), spring forces
 * along edges, and light centering toward the origin.
 * @param {object} sim state from createSim
 * @param {number} [alpha=0.3] cooling factor (0..1), scales all forces
 */
export function step(sim, alpha = 0.3) {
  const { nodes, edges } = sim;
  const n = nodes.length;
  const cap = Math.min(n, 400);

  const REPULSION = 2400;
  const SPRING_LENGTH = 80;
  const SPRING_STRENGTH = 0.06;
  const CENTER_STRENGTH = 0.01;
  const DAMPING = 0.85;

  // Repulsion: every pair of (capped) nodes pushes apart. If there are more
  // nodes than the cap, only the first cap participate in repulsion — the
  // rest still get springs/centering, bounding worst-case cost.
  for (let i = 0; i < cap; i++) {
    for (let j = i + 1; j < cap; j++) {
      const a = nodes[i];
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 0.01) {
        dx = (Math.random() - 0.5) * 0.1;
        dy = (Math.random() - 0.5) * 0.1;
        distSq = 0.01;
      }
      const dist = Math.sqrt(distSq);
      const force = (REPULSION / distSq) * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!a.fixed) { a.vx += fx; a.vy += fy; }
      if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
    }
  }

  // Springs: edges pull connected nodes toward SPRING_LENGTH apart.
  for (const e of edges) {
    const a = sim.nodeById.get(e.source);
    const b = sim.nodeById.get(e.target);
    if (!a || !b) continue;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let dist = Math.hypot(dx, dy) || 0.01;
    const diff = dist - SPRING_LENGTH;
    const force = diff * SPRING_STRENGTH * alpha;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    if (!a.fixed) { a.vx += fx; a.vy += fy; }
    if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
  }

  // Centering: gentle pull toward the origin so the graph doesn't drift away.
  for (const node of nodes) {
    if (node.fixed) continue;
    node.vx += -node.x * CENTER_STRENGTH * alpha;
    node.vy += -node.y * CENTER_STRENGTH * alpha;
  }

  // Integrate velocity into position, with damping.
  for (const node of nodes) {
    if (node.fixed) { node.vx = 0; node.vy = 0; continue; }
    node.vx *= DAMPING;
    node.vy *= DAMPING;
    node.x += node.vx;
    node.y += node.vy;
  }
}

/**
 * Breadth-first neighbor set of a node up to a given depth (inclusive of
 * the focus node itself).
 * @param {object} sim
 * @param {string} id
 * @param {number} [depth=1]
 * @returns {Set<string>}
 */
export function neighbors(sim, id, depth = 1) {
  const visited = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const nodeId of frontier) {
      const adj = sim.adjacency.get(nodeId);
      if (!adj) continue;
      for (const other of adj) {
        if (!visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return visited;
}

/**
 * Filter a raw node/edge list down to the local neighborhood around a focus
 * node (BFS up to depth hops). Pure function — does not require a sim.
 * @param {{id:string}[]} nodes
 * @param {{source:string, target:string}[]} edges
 * @param {string} focusId
 * @param {number} [depth=1]
 * @returns {{nodes: object[], edges: object[]}}
 */
export function filterLocal(nodes, edges, focusId, depth = 1) {
  const adjacency = new Map();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const e of edges) {
    if (!adjacency.has(e.source) || !adjacency.has(e.target)) continue;
    adjacency.get(e.source).add(e.target);
    adjacency.get(e.target).add(e.source);
  }

  if (!adjacency.has(focusId)) return { nodes: [], edges: [] };

  const visited = new Set([focusId]);
  let frontier = [focusId];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const nodeId of frontier) {
      for (const other of adjacency.get(nodeId) || []) {
        if (!visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const keptNodes = nodes.filter((n) => visited.has(n.id));
  const keptEdges = edges.filter((e) => visited.has(e.source) && visited.has(e.target));
  return { nodes: keptNodes, edges: keptEdges };
}
