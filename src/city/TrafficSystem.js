// Street traffic and the Jerusalem Light Rail.
//
// Vehicles (cars, delivery vans) drive on the right-hand lane of the loaded asphalt roads,
// respect one-way streets, keep their distance from the vehicle ahead, slow down at junctions
// and stop for the player. Instanced: one draw call per vehicle type, plus one for all
// headlight cones and one for their pools of light on the road (night only).
//
// The light rail (Rakevet Kala) runs on Jaffa Road: its path is chained from the loaded road
// pieces named Jaffa, rails are laid along it, and an articulated five-module tram cruises
// back and forth with smooth acceleration, slowing through junctions and dwelling at stops.
// The tram is solid: its modules are collision boxes, updated every frame.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRng } from './random.js';

export const DEFAULT_TRAFFIC_OPTIONS = Object.freeze({
  maxVehicles: 40,
  radius: 260, // vehicles exist within this distance of the camera
  density: 1 / 70, // vehicles per meter of drivable lane nearby
  vanShare: 0.25,
  spacing: 7, // m bumper to bumper when stopped
  headway: 1.4, // s
  accel: 2.2,
  brake: 5,
  junctionSpeed: 5, // m/s through junctions
  seed: 'traffic',
});

const SPEED = { motorway: 22, trunk: 18, primary: 14, secondary: 13, tertiary: 11, unclassified: 9, residential: 8, living_street: 4, service: 5, busway: 11, road: 8 };
const LINK = /_link$/;
const DRIVABLE = new Set([...Object.keys(SPEED), 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
export const isDrivable = (edge) => DRIVABLE.has(edge.road.highway) && edge.road.surface === 'asphalt';
const speedLimit = (road) => SPEED[road.highway] ?? (LINK.test(road.highway) ? 9 : 7);
/** Can this edge be driven in this direction (one-way streets)? */
const allowed = (edge, forward) => !edge.road.oneway || (edge.road.oneway > 0) === forward;

const CAR_COLORS = [0xf2f2f0, 0xe8e8e6, 0x1c1c1e, 0x8a8d91, 0xb9bcc0, 0x7a1f1f, 0x2b3f63, 0xc9b27a, 0x3e4a3d, 0xdedad0];
const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class TrafficSystem {
  /**
   * @param {object} p
   * @param {import('./CityCollision.js').CityCollisionWorld} p.collision
   * @param {{uNight:{value:number}}} p.uniforms
   * @param {Partial<typeof DEFAULT_TRAFFIC_OPTIONS>} [p.options]
   */
  /** @param {{ collision, uniforms, environment?: THREE.Texture | null, options? }} p  environment: reflection map for the steel rails */
  constructor({ collision, uniforms, environment = null, options = {} }) {
    this.environment = environment;
    this.o = { ...DEFAULT_TRAFFIC_OPTIONS, ...options };
    this.collision = collision;
    this.uniforms = uniforms;
    this.rng = createRng(this.o.seed);
    this.network = null;
    this.driveEdges = [];
    this.vehicles = [];
    this.rail = null;
    this.group = new THREE.Group();
    this.group.name = 'Traffic';
    this._built = false;
    this._tmp = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(0, 0, 0, 'YXZ'), v: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Color() };
  }

  get count() {
    return this.vehicles.length;
  }

  setNetwork(network) {
    this.network = network;
    this.driveEdges = network ? network.edges.filter(isDrivable) : [];
    // Vehicles carry on along the same road in the new network; ones on unloaded roads go.
    this.vehicles = this.vehicles.filter((v) => {
      const e = network?.match(v.edge);
      if (e) v.edge = e;
      return !!e;
    });
    this._setRail(network);
  }

  // ------------------------------------------------------------------------------------------
  // Vehicles
  // ------------------------------------------------------------------------------------------

  update(dt, center, player = null) {
    const o = this.o;
    this.vehicles = this.vehicles.filter((v) => Math.hypot(v.x - center.x, v.z - center.z) < o.radius * 1.15);
    if (this.network && this.driveEdges.length) {
      const want = Math.min(o.maxVehicles, Math.round(this._lengthNear(center) * o.density));
      for (let t = 0; t < 4 && this.vehicles.length < want; t++) this._spawn(center);
    }
    // Leader lookup: vehicles per (edge, direction), ordered by progress.
    const lanes = new Map();
    for (const v of this.vehicles) {
      const k = `${v.edge.id}:${v.forward}`;
      if (!lanes.has(k)) lanes.set(k, []);
      lanes.get(k).push(v);
    }
    for (const list of lanes.values()) list.sort((a, b) => a.s - b.s);
    for (const v of this.vehicles) this._drive(v, dt, lanes, player);
    this.vehicles = this.vehicles.filter((v) => !v.dead);
    this.rail?.update(dt, this.collision, player);
  }

  _lengthNear(center) {
    if (this._len && Math.hypot(center.x - this._len.x, center.z - this._len.z) < 30) return this._len.len;
    let len = 0;
    const r = this.o.radius;
    for (const e of this.driveEdges) {
      const mx = (e.a.x + e.b.x) / 2, mz = (e.a.z + e.b.z) / 2;
      if (Math.hypot(mx - center.x, mz - center.z) < r) len += e.len * (e.road.oneway ? 1 : 2);
    }
    this._len = { x: center.x, z: center.z, len };
    return len;
  }

  _spawn(center) {
    const rng = this.rng;
    const edge = this.network.randomEdge(rng, { filter: null, x: center.x, z: center.z, rMin: this.vehicles.length ? 60 : 0, rMax: this.o.radius, tries: 30 });
    if (!edge || !isDrivable(edge)) return;
    let forward = rng.chance(0.5);
    if (!allowed(edge, forward)) forward = !forward;
    const s = rng.range(0, edge.len);
    // Keep a gap from anyone already on this lane.
    if (this.vehicles.some((v) => v.edge === edge && v.forward === forward && Math.abs(v.s - s) < 15)) return;
    const van = rng.chance(this.o.vanShare);
    const limit = speedLimit(edge.road);
    const v = {
      type: van ? 'van' : 'car', edge, forward, s,
      speed: limit * 0.7, cruise: limit * rng.range(0.85, 1.05),
      color: van ? rng.pick([0xf2f2f0, 0xe8e2d0, 0x2b3f63, 0xc0c3c6]) : rng.pick(CAR_COLORS),
      length: van ? 5.4 : 4.3, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    };
    this._place(v, 0);
    this.vehicles.push(v);
  }

  /** Right-hand lane position for a vehicle on its edge. */
  _place(v, dt) {
    const p = this.network.pointOn(v.edge, v.forward, v.s);
    const lane = v.edge.road.oneway ? 0 : Math.min(3.2, v.edge.road.width / 4);
    const x = p.x - p.uz * lane, z = p.z + p.ux * lane; // right of the travel direction
    if (dt === 0) { v.x = x; v.z = z; } else { v.x = damp(v.x, x, 10, dt); v.z = damp(v.z, z, 10, dt); }
    const yaw = Math.atan2(-p.ux, -p.uz);
    v.yaw = dt === 0 ? yaw : v.yaw + wrap(yaw - v.yaw) * Math.min(1, dt * 7);
    const h = (xx, zz) => this.collision.terrainHeight(xx, zz);
    const half = v.length / 2;
    const yf = h(v.x - Math.sin(v.yaw) * half, v.z - Math.cos(v.yaw) * half), yb = h(v.x + Math.sin(v.yaw) * half, v.z + Math.cos(v.yaw) * half);
    v.y = (yf + yb) / 2 + 0.06;
    v.pitch = Math.atan2(yf - yb, v.length);
  }

  _drive(v, dt, lanes, player) {
    const o = this.o;
    // Target speed: road limit, less near a junction, less behind a slower vehicle, zero for the player.
    let target = v.cruise;
    const toEnd = v.edge.len - v.s;
    const node = v.forward ? v.edge.b : v.edge.a;
    if (node.edges.length > 2 && toEnd < 25) target = Math.min(target, o.junctionSpeed + (toEnd / 25) * (v.cruise - o.junctionSpeed));
    const list = lanes.get(`${v.edge.id}:${v.forward}`);
    const i = list.indexOf(v);
    const ahead = list[i + 1];
    if (ahead) {
      const gap = ahead.s - v.s - ahead.length;
      target = Math.min(target, Math.max(0, (gap - o.spacing + 2) / o.headway));
    }
    if (player) {
      const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
      const dx = player.x - v.x, dz = player.z - v.z;
      const along = dx * fx + dz * fz, across = Math.abs(dx * fz - dz * fx);
      if (along > 0 && along < 14 && across < 2.2 && Math.abs(player.y - v.y) < 3) target = Math.min(target, Math.max(0, (along - 4) * 0.6));
    }
    v.speed = target > v.speed ? Math.min(target, v.speed + o.accel * dt) : Math.max(target, v.speed - o.brake * dt);
    v.s += v.speed * dt;
    while (v.s > v.edge.len) {
      v.s -= v.edge.len;
      // Only exits that are drivable in the direction we'd leave the junction by.
      const node = v.forward ? v.edge.b : v.edge.a;
      const n = this.network.next(v.edge, v.forward, this.rng, (e) => isDrivable(e) && allowed(e, e.a === node));
      if (!allowed(n.edge, n.forward)) {
        v.dead = true; // dead end of a one-way street: leave the simulation (another car spawns)
        return;
      }
      v.edge = n.edge;
      v.forward = n.forward;
      v.cruise = speedLimit(v.edge.road) * this.rng.range(0.85, 1.05);
    }
    this._place(v, dt);
  }

  // ------------------------------------------------------------------------------------------
  // Light rail
  // ------------------------------------------------------------------------------------------

  _setRail(network) {
    const path = network ? jaffaPath(network) : null;
    const key = path ? `${path.points.length}:${path.length.toFixed(1)}` : null;
    if (key === this._railKey) return;
    this._railKey = key;
    const old = this.rail;
    if (old) {
      old.dispose(this.collision);
      this.group.remove(old.group);
      this.rail = null;
    }
    if (path && path.length > 150) {
      this.rail = new LightRail(path, { terrain: (x, z) => this.collision.terrainHeight(x, z), uniforms: this.uniforms, environment: this.environment });
      if (old) this.rail.continueFrom(old);
      this.group.add(this.rail.group);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------------------------------

  _buildMeshes() {
    this._built = true;
    const max = this.o.maxVehicles;
    const mat = vehicleMaterial(this.uniforms);
    this.meshes = {
      car: new THREE.InstancedMesh(carGeometry(), mat, max),
      van: new THREE.InstancedMesh(vanGeometry(), mat, max),
    };
    for (const [name, m] of Object.entries(this.meshes)) {
      m.name = `Vehicles(${name})`;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color(0xffffff));
      m.count = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.userData.detail = true;
      this.group.add(m);
    }
    const cones = headlightConeGeometry();
    this.cones = new THREE.InstancedMesh(cones, headlightMaterial(this.uniforms), max);
    this.cones.name = 'HeadlightCones';
    this.cones.frustumCulled = false;
    this.cones.count = 0;
    this.group.add(this.cones);
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), null, max);
    this.pools.name = 'HeadlightPools';
    this.pools.frustumCulled = false;
    this.pools.count = 0;
    this.pools.setColorAt(0, new THREE.Color(0xffffff));
    this.group.add(this.pools);
  }

  /** Sets the headlight pool material (shared light-pool shader from the city materials). */
  setPoolMaterial(material) {
    if (!this._built) this._buildMeshes();
    this.pools.material = material;
  }

  render(camera) {
    if (!this._built) this._buildMeshes();
    const t = this._tmp;
    const n = { car: 0, van: 0 };
    let cones = 0;
    const night = this.uniforms.uNight.value;
    for (const v of this.vehicles) {
      const mesh = this.meshes[v.type];
      t.q.setFromEuler(t.e.set(v.pitch, v.yaw, 0));
      t.m.compose(t.v.set(v.x, v.y, v.z), t.q, t.s.set(1, 1, 1));
      mesh.setMatrixAt(n[v.type], t.m);
      mesh.setColorAt(n[v.type], t.c.setHex(v.color));
      n[v.type]++;
      if (night > 0.02 && this.pools.material) {
        this.cones.setMatrixAt(cones, t.m);
        // Light pool on the road ahead, stretched along the travel direction.
        const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
        t.m.compose(t.v.set(v.x + fx * (v.length / 2 + 6), v.y + 0.05, v.z + fz * (v.length / 2 + 6)), t.q.setFromEuler(t.e.set(0, v.yaw, 0)), t.s.set(6, 1, 11));
        this.pools.setMatrixAt(cones, t.m);
        this.pools.setColorAt(cones, t.c.setHex(0xfff2d8));
        cones++;
      }
    }
    for (const [type, mesh] of Object.entries(this.meshes)) {
      mesh.count = n[type];
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
    this.cones.count = cones;
    this.cones.instanceMatrix.needsUpdate = true;
    this.pools.count = cones;
    this.pools.instanceMatrix.needsUpdate = true;
    if (this.pools.instanceColor) this.pools.instanceColor.needsUpdate = true;
    this.rail?.render();
  }

  dispose() {
    this.rail?.dispose(this.collision);
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (o.material !== this.pools?.material) o.material?.dispose?.();
      }
    });
  }
}

// -------------------------------------------------------------------------------------------------
// Light rail
// -------------------------------------------------------------------------------------------------

const JAFFA = /jaffa|yafo|יפו/i;

/**
 * The longest chain of loaded road pieces named Jaffa (Road / Street / יפו), as a polyline
 * with cumulative lengths and the distances of junctions along it.
 */
export function jaffaPath(network) {
  const edges = network.edges.filter((e) => JAFFA.test(`${e.road.name ?? ''} ${e.road.nameLocal ?? ''}`));
  if (!edges.length) return null;
  const inSet = new Set(edges);
  const deg = (node) => node.edges.filter((e) => inSet.has(e)).length;
  const walk = (start) => {
    const seen = new Set();
    const pts = [start];
    let node = start, prevDir = null;
    for (;;) {
      // Continue along the Jaffa edge that goes the most straight on.
      let best = null, bestDot = -Infinity;
      for (const e of node.edges) {
        if (!inSet.has(e) || seen.has(e)) continue;
        const other = e.a === node ? e.b : e.a;
        const dx = other.x - node.x, dz = other.z - node.z, l = Math.hypot(dx, dz) || 1;
        const dot = prevDir ? (dx * prevDir[0] + dz * prevDir[1]) / l : 0;
        if (dot > bestDot) { bestDot = dot; best = { e, other, dir: [dx / l, dz / l] }; }
      }
      if (!best || (prevDir && bestDot < -0.2)) break;
      seen.add(best.e);
      pts.push(best.other);
      prevDir = best.dir;
      node = best.other;
    }
    return pts;
  };
  const ends = [...new Set(edges.flatMap((e) => [e.a, e.b]))].filter((n) => deg(n) === 1);
  let best = null;
  for (const start of ends.length ? ends : [edges[0].a]) {
    const nodes = walk(start);
    const points = [], cum = [0], junctions = [];
    for (let i = 0; i < nodes.length; i++) {
      points.push(nodes[i].x, nodes[i].z);
      if (i) cum.push(cum[i - 1] + Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z));
      if (i && i < nodes.length - 1 && nodes[i].edges.length > 2) junctions.push(cum[i]);
    }
    const length = cum[cum.length - 1];
    if (!best || length > best.length) best = { points, cum, length, junctions };
  }
  return best;
}

class LightRail {
  constructor(path, { terrain, uniforms, environment = null, modules = 5 }) {
    this.path = path;
    this.terrain = terrain;
    this.modules = modules;
    this.moduleLength = 6.6;
    this.gap = 0.5;
    this.trainLength = modules * this.moduleLength + (modules - 1) * this.gap;
    this.s = Math.min(path.length / 2, path.length - 1);
    this.dir = 1;
    this.speed = 0;
    this.dwell = 4;
    this.maxSpeed = 11; // 40 km/h in the city
    this.accel = 0.9;
    this.decel = 1.1;
    // Stops every ~350 m, plus both ends.
    this.stops = [];
    for (let d = 175; d < path.length - 20; d += 350) this.stops.push(d);
    this.group = new THREE.Group();
    this.group.name = 'LightRail';
    // Three instanced meshes share one material: the leading cab (white lamps), the trailing cab
    // (red lamps, turned round) and the passenger modules in between.
    const paint = vehicleMaterial(uniforms);
    this.head = new THREE.InstancedMesh(tramCabGeometry(false), paint, 1);
    this.tail = new THREE.InstancedMesh(tramCabGeometry(true), paint, 1);
    this.mid = new THREE.InstancedMesh(tramMidGeometry(), paint, Math.max(1, modules - 2));
    this.head.name = 'LightRail(head)';
    this.tail.name = 'LightRail(tail)';
    this.mid.name = 'LightRail(tram)';
    this.trams = [this.head, this.tail, this.mid];
    for (const m of this.trams) {
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
    }
    this.head.count = 1;
    this.tail.count = modules > 1 ? 1 : 0;
    this.mid.count = Math.max(0, modules - 2);
    this.rails = new THREE.Mesh(railGeometry(path, terrain), new THREE.MeshStandardMaterial({
      color: 0xa4a8ad, metalness: 0.85, roughness: 0.25,
      // Polished steel shows what it reflects: its own env map at full strength (the scene-wide
      // environment is kept dim for the stone), so the rail heads catch the sky and sun glints.
      envMap: environment, envMapIntensity: 1,
    }));
    this.rails.name = 'LightRail(rails)';
    this.rails.receiveShadow = true;
    this.group.add(...this.trams, this.rails);
    this._tmp = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(0, 0, 0, 'YXZ'), v: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1) };
    this.boxes = [];
  }

  /** Point and direction at distance d along the path. */
  at(d) {
    const { points, cum } = this.path;
    d = Math.max(0, Math.min(this.path.length, d));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid; else hi = mid;
    }
    const seg = Math.max(1e-6, cum[hi] - cum[lo]), t = (d - cum[lo]) / seg;
    const ax = points[lo * 2], az = points[lo * 2 + 1], bx = points[hi * 2], bz = points[hi * 2 + 1];
    return { x: ax + (bx - ax) * t, z: az + (bz - az) * t };
  }

  /** Distance along the path of the point nearest (x, z), and how far off the track that point is. */
  project(x, z) {
    const { points, cum } = this.path;
    let best = { d: 0, off: Infinity };
    for (let i = 0; i + 1 < cum.length; i++) {
      const ax = points[i * 2], az = points[i * 2 + 1], bx = points[i * 2 + 2], bz = points[i * 2 + 3];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const off = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (off < best.off) best = { d: cum[i] + t * (cum[i + 1] - cum[i]), off };
    }
    return best;
  }

  /** Takes over the position, direction and speed of the train on an older copy of the track. */
  continueFrom(old) {
    const head = old.at(old.s), tail = old.at(old.s - old.dir * old.trainLength);
    const h = this.project(head.x, head.z), t = this.project(tail.x, tail.z);
    if (h.off > 5 || t.off > 5) return; // the track changed under the train: keep the default
    this.dir = h.d >= t.d ? 1 : -1;
    this.s = h.d;
    this.speed = old.speed;
    this.dwell = old.dwell;
  }

  update(dt, collision, player = null) {
    const p = this.path;
    const front = this.s; // s is the leading end in the travel direction
    if (this.dwell > 0) {
      this.dwell -= dt;
      this.speed = 0;
    } else {
      // Speed limit from the next constraints ahead: stops (0), junctions (4 m/s), path end (0).
      const ahead = (d) => (this.dir > 0 ? d - front : front - d);
      let limit = this.maxSpeed;
      const brakeTo = (dist, v) => Math.sqrt(v * v + 2 * this.decel * Math.max(0, dist));
      for (const j of p.junctions) { const d = ahead(j); if (d > 0 && d < 120) limit = Math.min(limit, brakeTo(d - 5, 4)); }
      let nextStop = null;
      for (const st of [...this.stops, this.dir > 0 ? p.length - 2 : 2]) {
        const d = ahead(st);
        if (d > 0.3 && (nextStop === null || d < nextStop)) nextStop = d;
      }
      if (nextStop !== null) limit = Math.min(limit, brakeTo(nextStop - 0.3, 0));
      // Someone on the track ahead: stop short of them.
      if (player) {
        const pr = this.project(player.x, player.z);
        const d = ahead(pr.d);
        if (pr.off < 2.6 && d > -1 && d < 60 && Math.abs(player.y - this.terrain(player.x, player.z)) < 3) limit = Math.min(limit, brakeTo(d - 6, 0));
      }
      this.speed = limit > this.speed ? Math.min(limit, this.speed + this.accel * dt) : Math.max(limit, this.speed - this.decel * 1.6 * dt);
      this.s += this.dir * this.speed * dt;
      if (nextStop !== null && nextStop < 0.6 && this.speed < 0.4) {
        this.dwell = 10;
        this.speed = 0;
        if (this.dir > 0 ? this.s > p.length - 4 : this.s < 4) {
          // Terminus: the driver changes ends, so the leading end is now the other end of the train.
          this.s -= this.dir * this.trainLength;
          this.dir = -this.dir;
        }
        this.s += this.dir * 1.2; // move past the stop marker
      }
    }
    // The whole train stays on the track: leading end in [trainLength, length] going up the path,
    // [0, length - trainLength] going down.
    this.s = this.dir > 0 ? Math.max(this.trainLength, Math.min(p.length, this.s)) : Math.max(0, Math.min(p.length - this.trainLength, this.s));
    this._layout(collision);
  }

  _layout(collision) {
    // Module k spans [s - dir*(k*(L+gap)), ... - dir*L] along the path (articulated: each
    // module's ends sit on the track, so the train bends through curves).
    const t = this._tmp;
    collision.removeGroup('tram');
    this.poses = [];
    for (let k = 0; k < this.modules; k++) {
      const d0 = this.s - this.dir * k * (this.moduleLength + this.gap);
      const d1 = d0 - this.dir * this.moduleLength;
      const a = this.at(d0), b = this.at(d1);
      const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2;
      const ya = this.terrain(a.x, a.z), yb = this.terrain(b.x, b.z);
      const yaw = Math.atan2(-(a.x - b.x), -(a.z - b.z));
      const pitch = Math.atan2(ya - yb, this.moduleLength);
      this.poses.push({ x, y: (ya + yb) / 2 + 0.12, z, yaw, pitch });
      const hw = 1.3;
      collision.add({ minX: Math.min(a.x, b.x) - hw, maxX: Math.max(a.x, b.x) + hw, minZ: Math.min(a.z, b.z) - hw, maxZ: Math.max(a.z, b.z) + hw, minY: Math.min(ya, yb) + 0.3, maxY: Math.max(ya, yb) + 3.4, kind: 'tram', ref: 'light-rail' }, 'tram');
    }
  }

  render() {
    const t = this._tmp;
    const last = this.modules - 1;
    (this.poses ?? []).forEach((p, k) => {
      const rear = k === last && last > 0; // the trailing cab faces the other way
      t.q.setFromEuler(rear ? t.e.set(-p.pitch, p.yaw + Math.PI, 0) : t.e.set(p.pitch, p.yaw, 0));
      t.m.compose(t.v.set(p.x, p.y, p.z), t.q, t.s);
      (k === 0 ? this.head : rear ? this.tail : this.mid).setMatrixAt(rear || k === 0 ? 0 : k - 1, t.m);
    });
    for (const m of this.trams) m.instanceMatrix.needsUpdate = true;
  }

  dispose(collision) {
    collision.removeGroup('tram');
    for (const m of this.trams) m.geometry.dispose();
    this.head.material.dispose();
    this.rails.geometry.dispose();
    this.rails.material.dispose();
  }
}

// -------------------------------------------------------------------------------------------------
// Geometry and materials
// -------------------------------------------------------------------------------------------------

/**
 * Vehicle vertex layout (non-indexed, no UVs), 40 bytes per vertex:
 *   position, normal, color (vertex albedo, x instance colour on body panels only) and
 *   aMat: Uint8 x4 = (part, light, roughness * 255, metalness * 255).
 * part: 0 body paint (takes the instance colour), 1 tyre, 2 glass, 3 lens / lit glass, 4 alloy, 5 trim, 6 plate.
 * light: 0 none, 1 headlight, 2 tail light, 3 lit window.
 */
const KIND = {
  body: [0, 0.28, 0.6],
  tyre: [1, 0.9, 0],
  glass: [2, 0.06, 0.9],
  lens: [3, 0.12, 0.3],
  alloy: [4, 0.25, 0.9],
  trim: [5, 0.7, 0.1],
  plate: [6, 0.5, 0.1],
};

export const VEHICLE_ATTRIBUTES = ['position', 'normal', 'color', 'aMat'];

function tint(geo, hex, kind = 'body', light = 0) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const c = new THREE.Color(hex);
  const [part, rough, metal] = KIND[kind];
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3), mat = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    mat[i * 4] = part; mat[i * 4 + 1] = light; mat[i * 4 + 2] = Math.round(rough * 255); mat[i * 4 + 3] = Math.round(metal * 255);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
  return g;
}

const BODY = 0xffffff, GLASS = 0x141a20, TYRE = 0x151515, DARK = 0x18191b, ALLOY = 0xc9ced4, PLATE = 0xf2c20c;
const TAN15 = Math.tan(Math.PI / 12);

const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/**
 * A side profile [[z, y], ...] (z negative = front) extruded across `width` centred on x, with a
 * chamfer of `bevel` on every edge. The outline grows by `bevel`, so inset it by that much.
 */
function side(pts, width, x = 0, bevel = 0.03) {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(-z, y)));
  const depth = width - 2 * bevel;
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 1 })
    .translate(0, 0, -depth / 2).rotateY(Math.PI / 2).translate(x, 0, 0);
}

/** A front-view profile [[x, y], ...] extruded along z from z0 to z1. */
function prism(pts, z0, z1) {
  return new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))), { depth: z1 - z0, bevelEnabled: false, curveSegments: 1 }).translate(0, 0, z0);
}

/** A slim bar from a to b in the side view ([z, y] points), `t` thick, `w` wide, centred on x. */
function strip([az, ay], [bz, by], t, w, x) {
  const dz = bz - az, dy = by - ay, l = Math.hypot(dz, dy) || 1;
  const nz = (-dy / l) * t / 2, ny = (dz / l) * t / 2;
  return side([[az - nz, ay - ny], [bz - nz, by - ny], [bz + nz, by + ny], [az + nz, ay + ny]], w, x, 0);
}

/** Wheel bottom edge of a body profile: an arch of radius r over an axle at (zc, cy), from left to right. */
function arch(zc, cy, r, steps = 8) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI - (i / steps) * Math.PI;
    out.push([zc + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/**
 * Two-layer wheel: a rounded rubber tyre (lathe) and, recessed into it, a dark barrel with five alloy
 * spokes and a hub cap, so the wheel has depth from a metre away. s = +1 / -1 for the right / left side.
 */
function wheel(s, cx, z, r = 0.32, w = 0.22) {
  const cy = r;
  const tyre = new THREE.LatheGeometry([[r - 0.12, -w / 2], [r - 0.03, -w / 2], [r, -w / 2 + 0.03], [r, w / 2 - 0.03], [r - 0.03, w / 2], [r - 0.12, w / 2]].map(([a, b]) => new THREE.Vector2(a, b)), 14)
    .rotateZ(Math.PI / 2).translate(s * cx, cy, z);
  const face = s * (cx + w / 2);
  const barrel = new THREE.CylinderGeometry(r - 0.1, r - 0.1, 0.03, 12).rotateZ(Math.PI / 2).translate(face - s * 0.05, cy, z);
  const out = [tint(tyre, TYRE, 'tyre'), tint(barrel, 0x26282b, 'trim')];
  for (let k = 0; k < 5; k++) out.push(tint(new THREE.BoxGeometry(0.025, r - 0.13, 0.04).translate(0, (r - 0.13) / 2, 0).rotateX((k / 5) * Math.PI * 2).translate(face - s * 0.045, cy, z), ALLOY, 'alloy'));
  out.push(tint(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 10).rotateZ(Math.PI / 2).translate(face - s * 0.03, cy, z), ALLOY, 'alloy'));
  return out;
}

const wheelSet = (cx, zs, r, w) => zs.flatMap((z) => [1, -1].flatMap((s) => wheel(s, cx, z, r, w)));

/** Faceted (hexagonal, tapering forwards) lens, w x h across and d deep, swept back by `sweep`. */
function lens(x, y, z, w, h, d, sweep = 0) {
  return new THREE.CylinderGeometry(0.42, 0.5, 1, 6).rotateX(-Math.PI / 2).scale(w, h, d).rotateY(sweep).translate(x, y, z);
}

/** Rectangular bezel standing proud of a panel, so what it frames reads as recessed. */
function bezel(w, h, x, y, z, t = 0.03, d = 0.05, hex = 0x8d9297) {
  return [
    tint(box(w + 2 * t, t, d, x, y + h / 2 + t / 2, z), hex, 'alloy'), tint(box(w + 2 * t, t, d, x, y - h / 2 - t / 2, z), hex, 'alloy'),
    tint(box(t, h, d, x - w / 2 - t / 2, y, z), hex, 'alloy'), tint(box(t, h, d, x + w / 2 + t / 2, y, z), hex, 'alloy'),
  ];
}

/** Yellow Israeli plate with a dark digit band; `out` = -1 on a front (-z) face, +1 on a rear one. */
function plate(y, z, out) {
  return [
    tint(box(0.52, 0.12, 0.02, 0, y, z), PLATE, 'plate'),
    tint(box(0.44, 0.06, 0.006, 0, y, z + out * 0.012), 0x141414, 'plate'),
  ];
}

/** Hatchback / sedan, 4.3 m, facing -Z. White body parts take the instance colour. */
export function carGeometry() {
  const P = [
    [-2.1, 0.32], ...arch(-1.38, 0.32, 0.42), ...arch(1.38, 0.32, 0.42), [2.1, 0.32],
    [2.1, 0.78], [2.05, 0.92], [1.55, 0.95], [-0.85, 0.9], [-1.98, 0.76], [-2.1, 0.62],
  ];
  const parts = [
    tint(side(P, 1.76), BODY),
    // dark wheel-arch liners fill the notch through the body between the tyres
    ...[-1.38, 1.38].map((z) => tint(box(1.3, 0.46, 0.8, 0, 0.55, z), 0x0e0f10, 'trim')),
    tint(box(1.5, 0.12, 3.6, 0, 0.26, 0), 0x0e0f10, 'trim'),
    // greenhouse: dark glass volume, body-colour roof slab, black A / B / C pillars
    tint(side([[-0.92, 0.88], [-0.32, 1.42], [0.92, 1.44], [1.5, 0.93]], 1.46, 0, 0), GLASS, 'glass'),
    tint(side([[-0.36, 1.41], [0.93, 1.43], [0.93, 1.48], [-0.33, 1.47]], 1.48, 0, 0.015), BODY),
    tint(strip([-0.92, 0.9], [-0.32, 1.45], 0.07, 0.06, 0.75), DARK, 'trim'), tint(strip([-0.92, 0.9], [-0.32, 1.45], 0.07, 0.06, -0.75), DARK, 'trim'),
    tint(strip([0.12, 0.93], [0.15, 1.43], 0.08, 0.06, 0.75), DARK, 'trim'), tint(strip([0.12, 0.93], [0.15, 1.43], 0.08, 0.06, -0.75), DARK, 'trim'),
    tint(strip([0.95, 1.45], [1.52, 0.93], 0.16, 0.06, 0.75), DARK, 'trim'), tint(strip([0.95, 1.45], [1.52, 0.93], 0.16, 0.06, -0.75), DARK, 'trim'),
    // wing mirrors
    ...[1, -1].flatMap((s) => [tint(box(0.1, 0.07, 0.17, s * 0.93, 1.0, -0.7), BODY), tint(box(0.1, 0.03, 0.05, s * 0.86, 0.96, -0.66), DARK, 'trim')]),
    // front: recessed grille and air intake, plate, splitter
    tint(box(0.9, 0.14, 0.03, 0, 0.55, -2.125), 0x101112, 'trim'),
    tint(box(0.84, 0.012, 0.02, 0, 0.55, -2.145), 0x3a3c40, 'trim'),
    ...bezel(0.9, 0.14, 0, 0.55, -2.135),
    tint(box(1.2, 0.09, 0.03, 0, 0.36, -2.125), 0x101112, 'trim'),
    tint(box(1.62, 0.04, 0.14, 0, 0.3, -2.07), DARK, 'trim'),
    ...plate(0.44, -2.17, -1),
    // faceted headlights in dark housings (light 1)
    ...[1, -1].flatMap((s) => [tint(box(0.46, 0.17, 0.06, s * 0.62, 0.7, -2.03), DARK, 'trim'), tint(lens(s * 0.62, 0.7, -2.09, 0.38, 0.13, 0.08, s * 0.35), 0xffffff, 'lens', 1)]),
    // rear: segmented tail lights (light 2), plate, lower valance
    ...[1, -1].flatMap((s) => [
      tint(box(0.46, 0.15, 0.03, s * 0.62, 0.72, 2.13), DARK, 'trim'),
      ...[0.48, 0.62, 0.76].map((x, i) => tint(box(0.12, 0.11, 0.03, s * x, 0.72, 2.15 + i * 0.008), 0xaa1010, 'lens', 2)),
    ]),
    tint(box(1.5, 0.08, 0.06, 0, 0.36, 2.12), DARK, 'trim'),
    ...plate(0.56, 2.17, 1),
    ...wheelSet(0.77, [-1.38, 1.38], 0.32, 0.22),
  ];
  return mergeGeometries(parts, false);
}

/** Delivery van, 5.4 m, facing -Z. */
export function vanGeometry() {
  const P = [
    [-2.7, 0.35], ...arch(-1.6, 0.35, 0.44), ...arch(1.6, 0.35, 0.44), [2.7, 0.35],
    [2.7, 1.9], [2.62, 1.96], [-1.28, 1.9], [-1.72, 1.08], [-2.5, 0.98], [-2.7, 0.75],
  ];
  const parts = [
    tint(side(P, 1.96), BODY),
    ...[-1.6, 1.6].map((z) => tint(box(1.4, 0.5, 0.9, 0, 0.6, z), 0x0e0f10, 'trim')),
    tint(box(1.6, 0.12, 4.6, 0, 0.3, 0), 0x0e0f10, 'trim'),
    // raked windscreen slab, side windows, B pillar
    tint(side([[-1.79, 1.1], [-1.35, 1.9], [-1.24, 1.9], [-1.68, 1.1]], 1.78, 0, 0), GLASS, 'glass'),
    ...[1, -1].flatMap((s) => [tint(box(0.03, 0.55, 1.0, s * 0.985, 1.5, -0.85), GLASS, 'glass'), tint(box(0.05, 0.6, 0.07, s * 0.985, 1.5, -0.28), DARK, 'trim')]),
    // mirrors
    ...[1, -1].flatMap((s) => [tint(box(0.1, 0.24, 0.07, s * 1.1, 1.4, -1.4), DARK, 'trim'), tint(box(0.16, 0.04, 0.04, s * 1.03, 1.3, -1.36), DARK, 'trim')]),
    // front: recessed grille, black bumper, plate
    tint(box(1.1, 0.2, 0.03, 0, 0.66, -2.72), 0x101112, 'trim'),
    ...bezel(1.1, 0.2, 0, 0.66, -2.735),
    tint(box(1.96, 0.18, 0.1, 0, 0.42, -2.72), DARK, 'trim'),
    ...plate(0.42, -2.79, -1),
    ...[1, -1].flatMap((s) => [tint(box(0.5, 0.2, 0.06, s * 0.72, 0.92, -2.68), DARK, 'trim'), tint(lens(s * 0.72, 0.92, -2.74, 0.42, 0.15, 0.08, s * 0.3), 0xffffff, 'lens', 1)]),
    // rear: split doors, tail lights, bumper, plate
    tint(box(0.02, 1.3, 0.02, 0, 1.2, 2.72), 0x202224, 'trim'),
    ...[1, -1].flatMap((s) => [tint(box(0.16, 0.42, 0.04, s * 0.86, 0.92, 2.73), 0xaa1010, 'lens', 2), tint(box(0.22, 0.48, 0.03, s * 0.86, 0.92, 2.72), DARK, 'trim')]),
    tint(box(1.96, 0.16, 0.1, 0, 0.44, 2.72), DARK, 'trim'),
    ...plate(0.62, 2.78, 1),
    ...wheelSet(0.86, [-1.6, 1.6], 0.34, 0.24),
  ];
  return mergeGeometries(parts, false);
}

const TRAM_BODY = 0xc9cdd1, TRAM_GLASS = 0x1d252c, TRAM_GREY = 0x8f9599;
const TRAM_PROFILE = [[-1.325, 0.42], [1.325, 0.42], [1.325, 2.42], [1.22, 2.7], [-1.22, 2.7], [-1.325, 2.42]];
const TRAM_DOOR_Z = [-1.55, 1.55];

/** Glass band + door leaves + frame bars on a module, at the given door / window stations. */
function tramSides(windows, doors) {
  const out = [];
  for (const [z0, z1] of windows) out.push(tint(box(2.67, 0.9, z1 - z0, 0, 2.1, (z0 + z1) / 2), TRAM_GLASS, 'glass', 3));
  for (const z of doors) {
    out.push(tint(box(2.675, 2.0, 1.3, 0, 1.55, z), 0x232b31, 'glass', 3));
    for (const dz of [-0.65, 0, 0.65]) out.push(tint(box(2.69, 2.02, dz ? 0.05 : 0.03, 0, 1.55, z + dz), TRAM_GREY, 'trim'));
    out.push(tint(box(2.69, 0.05, 1.3, 0, 2.55, z), TRAM_GREY, 'trim'));
  }
  return out;
}

/** Everything a module has behind its cab: silver octagonal shell, red stripe, skirt, roof cowl, bellows. */
function tramShell(z0, z1, bellowsAt) {
  const out = [
    tint(prism(TRAM_PROFILE, z0, z1), TRAM_BODY),
    tint(box(2.67, 0.12, z1 - z0, 0, 1.4, (z0 + z1) / 2), 0xa0161c),
    tint(box(2.3, 0.3, z1 - z0 - 0.6, 0, 0.36, (z0 + z1) / 2), 0x202224, 'trim'),
    tint(box(1.8, 0.22, z1 - z0 - 1.2, 0, 2.8, (z0 + z1) / 2), 0x9ea3a8),
  ];
  for (const z of bellowsAt) out.push(tint(prism([[-1.2, 0.55], [1.2, 0.55], [1.2, 2.5], [-1.2, 2.5]], z > 0 ? z1 : z0 - 0.25, z > 0 ? z1 + 0.25 : z0), 0x141618, 'trim'));
  return out;
}

/** Middle passenger module, 6.6 m: two double doors per side, glass ribbon between them, bellows both ends. */
export function tramMidGeometry() {
  return mergeGeometries([...tramShell(-3.3, 3.3, [-1, 1]), ...tramSides([[-0.9, 0.9], [2.2, 3.1], [-3.1, -2.2]], TRAM_DOOR_Z)], false);
}

/**
 * Cab module, 6.6 m, nose towards -Z: vertical bumper apron, then a body leaning back 15 degrees with
 * a wraparound panoramic windscreen, LED destination sign, faceted lamps. `tail` shows red lamps
 * instead of white (the trailing cab).
 */
export function tramCabGeometry(tail = false) {
  const zl = (y) => -3.3 + (y - 1.1) * TAN15; // the leaning nose face
  const inset = 0.1; // side() grows the outline by its bevel
  const nose = side([[-3.3 + inset / Math.cos(Math.PI / 12), 0.42 + inset], [-3.3 + inset / Math.cos(Math.PI / 12), 1.1], [zl(2.7 - inset) + inset / Math.cos(Math.PI / 12), 2.7 - inset], [-1.1, 2.7 - inset], [-1.1, 0.42 + inset]], 2.66, 0, inset);
  const glass = (y0, y1, w) => side([[zl(y0) - 0.02, y0], [zl(y1) - 0.02, y1], [zl(y1) + 0.06, y1], [zl(y0) + 0.06, y0]], w, 0, 0);
  const lamp = (s) => tint(lens(s * 0.85, 0.82, -3.33, 0.42, 0.17, 0.09, s * 0.25), tail ? 0xaa1010 : 0xffffff, 'lens', tail ? 2 : 1);
  const parts = [
    tint(nose, TRAM_BODY),
    ...tramShell(-1.4, 3.3, [1]),
    tint(box(2.67, 0.12, 2.3, 0, 1.4, -2.15), 0xa0161c),
    tint(box(2.3, 0.3, 2.6, 0, 0.36, -2.0), 0x202224, 'trim'),
    tint(box(2.0, 0.16, 0.14, 0, 0.55, -3.33), 0x202224, 'trim'), // crash buffer
    tint(glass(1.3, 2.52, 2.56), TRAM_GLASS, 'glass'),
    tint(new THREE.BoxGeometry(1.5, 0.16, 0.05).rotateX(Math.PI / 12).translate(0, 2.6, zl(2.6) - 0.03), 0x4a3408, 'lens', 3),
    tint(box(2.67, 0.9, 3.2, 0, 2.1, -0.7), TRAM_GLASS, 'glass', 3),
    ...tramSides([[2.2, 3.1]], [TRAM_DOOR_Z[1]]),
    ...[1, -1].map(lamp),
    ...[1, -1].map((s) => tint(box(0.5, 0.22, 0.05, s * 0.85, 0.82, -3.29), 0x202224, 'trim')),
  ];
  return mergeGeometries(parts, false);
}

// Rail profile: the head stands RAIL_HEIGHT above the asphalt (+0.06 m over the terrain) and
// its base sinks just below it, so there is no gap at the road surface.
const RAIL_GAUGE_HALF = 0.7175; // 1435 mm standard gauge
const RAIL_HEAD = 0.072; // head width, m
const RAIL_BASE_Y = 0.055, RAIL_HEIGHT = 0.045;

/**
 * Two steel rails (1435 mm gauge) along the path: solid bars with a top and two side faces,
 * draped on the terrain in steps of at most 4 m. Faces are wound outward with flat normals,
 * so the polished top catches sun glints.
 */
export function railGeometry(path, terrain) {
  const pos = [], nrm = [];
  const tri = (a, b, c, n) => {
    // Wind so that (b - a) x (c - a) points along n.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    if ((uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2] < 0) [b, c] = [c, b];
    pos.push(...a, ...b, ...c);
    for (let k = 0; k < 3; k++) nrm.push(...n);
  };
  const quad = (a, b, c, d, n) => {
    tri(a, b, c, n);
    tri(a, c, d, n);
  };
  const p = path.points;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) continue;
    const steps = Math.max(1, Math.ceil(len / 4));
    const nx = -(bz - az) / len, nz = (bx - ax) / len;
    for (const off of [-RAIL_GAUGE_HALF, RAIL_GAUGE_HALF]) {
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps, t1 = (k + 1) / steps;
        // Corner of the bar: side -1 / +1 across it, top or bottom.
        const q = (t, side, top) => {
          const x = ax + (bx - ax) * t + nx * (off + side * RAIL_HEAD / 2), z = az + (bz - az) * t + nz * (off + side * RAIL_HEAD / 2);
          return [x, terrain(x, z) + RAIL_BASE_Y + (top ? RAIL_HEIGHT : 0), z];
        };
        quad(q(t0, -1, true), q(t1, -1, true), q(t1, 1, true), q(t0, 1, true), [0, 1, 0]);
        quad(q(t0, -1, false), q(t1, -1, false), q(t1, -1, true), q(t0, -1, true), [-nx, 0, -nz]);
        quad(q(t0, 1, false), q(t1, 1, false), q(t1, 1, true), q(t0, 1, true), [nx, 0, nz]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.computeBoundingSphere();
  return g;
}

/** Two long narrow cones ahead of the headlights (additive, night only). */
function headlightConeGeometry() {
  const cone = (x) => new THREE.ConeGeometry(1.6, 9, 12, 1, true).translate(0, -4.5, 0).rotateX(-Math.PI / 2).translate(x, 0.72, -2.2);
  const g = mergeGeometries([cone(-0.6), cone(0.6)], false);
  const pos = g.getAttribute('position');
  const fade = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) fade[i] = Math.min(1, Math.max(0, (pos.getZ(i) + 2.2) / -9)); // 0 at the lamp, 1 at the tip
  g.setAttribute('aFade', new THREE.BufferAttribute(fade, 1));
  return g;
}

function headlightMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { uNight: uniforms.uNight },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aFade;
      varying float vFade;
      void main() {
        vFade = aFade;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      varying float vFade;
      void main() {
        float a = pow(1.0 - vFade, 2.0) * 0.12 * uNight;
        gl_FragColor = vec4(vec3(1.0, 0.93, 0.78) * a, 1.0);
      }`,
  });
}

/**
 * Vehicle paint: vertex colour x instance colour on body panels only (aMat.x = 0), roughness / metalness
 * from the vertex (aMat.zw), and head / tail lights and lit windows glow at night (aMat.y).
 */
export function vehicleMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.45 });
  mat.customProgramCacheKey = () => 'vehicle-v2';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aMat;\nvarying vec3 vMat;')
      .replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_INSTANCING_COLOR
  if (aMat.x > 0.5) vColor.xyz = color.xyz; // only the paint takes the instance colour
#endif`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vMat = vec3(aMat.y, aMat.z, aMat.w) / vec3(1.0, 255.0, 255.0);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec3 vMat;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = vMat.y;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = vMat.z;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
if (vMat.x > 0.5 && vMat.x < 1.5) totalEmissiveRadiance += vec3(1.0, 0.95, 0.85) * (0.2 + 4.0 * uNight);
else if (vMat.x > 1.5 && vMat.x < 2.5) totalEmissiveRadiance += vec3(1.0, 0.05, 0.03) * (0.3 + 2.5 * uNight);
else if (vMat.x > 2.5) totalEmissiveRadiance += vec3(1.0, 0.85, 0.6) * 0.9 * uNight;`);
  };
  return mat;
}
