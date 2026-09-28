// A navigable graph of the loaded roads, shared by pedestrians and traffic.
//
// Nodes are road vertices; vertices at the same position (a junction where OSM ways share a
// node, or a tile border where the pipeline cut a road) are merged, so agents walk and drive
// across junctions and tile borders. Edges are road segments. No three.js dependency.

const key = (x, z, q) => `${Math.round(x / q)},${Math.round(z / q)}`;

export class RoadNetwork {
  /** @param {{ quantum?: number }} [o] positions closer than ~quantum meters are one node */
  constructor({ quantum = 0.05 } = {}) {
    this.quantum = quantum;
    this.nodes = new Map();
    this.edges = [];
    this._byKey = null;
  }

  _edgeKey(e) {
    const q = this.quantum;
    return `${e.road.id}|${key(e.a.x, e.a.z, q)}|${key(e.b.x, e.b.z, q)}`;
  }

  /**
   * This network's copy of an edge from another (older) network: same road, same end points,
   * same orientation. Lets agents keep walking / driving when the network is rebuilt.
   */
  match(edge) {
    if (!this._byKey) this._byKey = new Map(this.edges.map((e) => [this._edgeKey(e), e]));
    return this._byKey.get(this._edgeKey(edge)) ?? null;
  }

  /** @param {Iterable<object>} roads  roads with flat [x, z, ...] `points` (areas are ignored) */
  static fromRoads(roads, options) {
    const net = new RoadNetwork(options);
    for (const r of roads) if (r.points) net.addRoad(r);
    return net;
  }

  _node(x, z) {
    const k = key(x, z, this.quantum);
    let n = this.nodes.get(k);
    if (!n) this.nodes.set(k, (n = { x, z, edges: [] }));
    return n;
  }

  addRoad(road) {
    const p = road.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const a = this._node(p[i], p[i + 1]), b = this._node(p[i + 2], p[i + 3]);
      if (a === b) continue;
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
      const edge = { id: this.edges.length, a, b, road, len, ux: dx / len, uz: dz / len };
      this.edges.push(edge);
      a.edges.push(edge);
      b.edges.push(edge);
    }
  }

  /** Point `s` meters along an edge in the travel direction, with the travel direction. */
  pointOn(edge, forward, s) {
    const t = Math.min(1, Math.max(0, s / edge.len));
    const [from, ux, uz] = forward ? [edge.a, edge.ux, edge.uz] : [edge.b, -edge.ux, -edge.uz];
    return { x: from.x + ux * t * edge.len, z: from.z + uz * t * edge.len, ux, uz };
  }

  /**
   * The edge to take at the end of `edge` (travelling `forward`). Prefers going roughly
   * straight, allows turns, never picks edges rejected by `filter`; U-turns at dead ends.
   */
  next(edge, forward, rng, filter = null) {
    const node = forward ? edge.b : edge.a;
    const ux = forward ? edge.ux : -edge.ux, uz = forward ? edge.uz : -edge.uz;
    const options = [];
    let total = 0;
    for (const e of node.edges) {
      if (e === edge || (filter && !filter(e))) continue;
      const fwd = e.a === node;
      const ex = fwd ? e.ux : -e.ux, ez = fwd ? e.uz : -e.uz;
      const straight = ux * ex + uz * ez; // 1 straight on, -1 back
      const w = Math.max(0.05, 0.6 + straight);
      options.push({ edge: e, forward: fwd, w });
      total += w;
    }
    if (!options.length) return { edge, forward: !forward }; // dead end: turn around
    let r = rng.next() * total;
    for (const o of options) {
      r -= o.w;
      if (r <= 0) return o;
    }
    return options[options.length - 1];
  }

  /** A random edge passing `filter`, weighted by length, whose midpoint is rMin..rMax from (x, z). */
  randomEdge(rng, { filter = null, x = 0, z = 0, rMin = 0, rMax = Infinity, tries = 60 } = {}) {
    const pool = filter ? this.edges.filter(filter) : this.edges;
    if (!pool.length) return null;
    for (let i = 0; i < tries; i++) {
      const e = pool[Math.floor(rng.next() * pool.length)];
      const mx = (e.a.x + e.b.x) / 2, mz = (e.a.z + e.b.z) / 2;
      const d = Math.hypot(mx - x, mz - z);
      if (d >= rMin && d <= rMax) return e;
    }
    return null;
  }
}
