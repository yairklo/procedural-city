// Pedestrians on Jerusalem's sidewalks.
//
// - One InstancedMesh for everyone (one draw call): per-instance scale (±12%) and clothing
//   colour (instance colour); legs and arms swing in the vertex shader with a per-instance
//   phase and stride rate, so nobody walks in lockstep.
// - Agents live only within `radius` (80 m) of the camera: groups spawn on sidewalk
//   waypoints of the loaded road network and are recycled when left behind.
// - About 60% walk in groups:
//     pairs (friends, yeshiva students) side by side; the companion compresses to single file
//       ("accordion") when the leader turns faster than 30°/s, the walkway is narrow, or a
//       wall is in the way;
//     clusters (a family: leader + 1-2 trailing children / companions).
//   Followers never pathfind: they replay the leader's recorded positions from 0.5 s earlier
//   ("breadcrumbs"), so they only ever stand where the leader already stood.
// - Flee: when the player lands or glides fast within 4 m, people scatter away from the
//   impact at double speed (with a random spread), then calm down after 3 s and walk back.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRng } from './random.js';

export const DEFAULT_PEDESTRIAN_OPTIONS = Object.freeze({
  maxAgents: 220,
  radius: 80, // agents exist / are drawn only within this distance of the camera
  density: 1 / 14, // target agents per meter of walkable edge near the camera (capped by maxAgents)
  walkSpeed: [1.05, 1.5],
  groupShare: 0.6, // share of spawns that are groups
  pairShare: 0.55, // of groups: pairs (the rest are clusters)
  breadcrumbDelay: 0.5, // s
  sideSpacing: 0.75, // m between side-by-side companions
  compressTurnRate: (30 * Math.PI) / 180, // rad/s
  narrowWidth: 3, // m: narrower walkways force single file
  fleeRadius: 4,
  fleeTime: 3,
  fleeSpeedFactor: 2,
  seed: 'pedestrians',
});

// Where people walk: pedestrian ways on their full width, sidewalks beside other streets.
const NO_WALK = new Set(['motorway', 'trunk', 'motorway_link', 'trunk_link']);
const PAVED = new Set(['pedestrian', 'footway', 'path', 'steps', 'living_street', 'corridor', 'sidewalk', 'cycleway']);
export const isWalkable = (edge) => !NO_WALK.has(edge.road.highway);

// Jerusalem street clothing (sRGB): tops and bottoms are picked separately. Blues, beiges,
// whites and dark tones, with a few accents; soldiers' olive; Haredi black coats over black.
const TOPS = [0x16161a, 0x1f2a44, 0x2f4a6e, 0x5b7fa6, 0xe9e6de, 0xf2efe8, 0xd8cfbf, 0xb8a27a, 0x8a7a5a, 0x5a6135, 0x6b6b70, 0x3c5a48, 0x7a2e2e];
const BOTTOMS = [0x141417, 0x1f2638, 0x2c3b58, 0x4a5a78, 0x3a3a3e, 0x5b5750, 0xb9ad94, 0x8c8068, 0x5a6135];
const HAREDI = { top: 0x141414, bottom: 0x141414 };
// Street surfaces sit this far above the terrain (see _groundY).
const SURFACE_LIFT = 0.05;

const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class PedestrianSystem {
  /**
   * @param {object} p
   * @param {import('./CityCollision.js').CityCollisionWorld} p.collision
   * @param {Partial<typeof DEFAULT_PEDESTRIAN_OPTIONS>} [p.options]
   */
  constructor({ collision, options = {} }) {
    this.o = { ...DEFAULT_PEDESTRIAN_OPTIONS, ...options };
    this.collision = collision;
    this.rng = createRng(this.o.seed);
    // Appearance has its own stream, so looks never change how anyone moves.
    this.lookRng = createRng(`${this.o.seed}/look`);
    this.network = null;
    /** @type {import('./RiggedPedestrians.js').RiggedPedestrians | null} */
    this.rigged = null;
    this.walkEdges = [];
    this.agents = [];
    this.groups = [];
    this.time = 0;
    this.visible = 0;
    this.mesh = createPedestrianMesh(this.o.maxAgents);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /**
   * Swaps in a new road network (after cells stream in / out). Groups carry on along the same
   * road in the new network; groups on roads that were unloaded are removed (and respawn).
   */
  setNetwork(network) {
    this.network = network;
    this.walkEdges = network ? network.edges.filter(isWalkable) : [];
    this.groups = this.groups.filter((g) => {
      const e = network?.match(g.leader.edge);
      if (e) g.leader.edge = e;
      else this._removeGroup(g);
      return !!e;
    });
  }

  get count() {
    return this.agents.length;
  }

  // ------------------------------------------------------------------------------------------
  // Simulation
  // ------------------------------------------------------------------------------------------

  /**
   * @param {number} dt
   * @param {{x:number,y:number,z:number}} center  the camera (population follows it)
   * @param {{x:number,z:number, active:boolean}|null} threat  player impact / fast glide
   */
  update(dt, center, threat = null) {
    this.time += dt;
    const o = this.o;
    // Recycle groups left behind, then top up the population around the camera.
    this.groups = this.groups.filter((g) => {
      const far = Math.hypot(g.leader.x - center.x, g.leader.z - center.z) > o.radius * 1.15;
      if (far) this._removeGroup(g);
      return !far;
    });
    if (this.network) {
      const want = Math.min(o.maxAgents, Math.round(this._walkableLengthNear(center) * o.density));
      for (let tries = 0; tries < 8 && this.agents.length < want; tries++) this._spawnGroup(center, this.agents.length === 0 ? 0 : o.radius * 0.35);
    }
    for (const g of this.groups) this._updateGroup(g, dt, threat);
  }

  _walkableLengthNear(center) {
    // Cheap estimate, refreshed now and then: walkable length within the radius.
    if (this._lenCache && this.time - this._lenCache.t < 1 && Math.hypot(center.x - this._lenCache.x, center.z - this._lenCache.z) < 20) return this._lenCache.len;
    let len = 0;
    const r = this.o.radius;
    for (const e of this.walkEdges) {
      const mx = (e.a.x + e.b.x) / 2, mz = (e.a.z + e.b.z) / 2;
      if (Math.abs(mx - center.x) < r && Math.abs(mz - center.z) < r && Math.hypot(mx - center.x, mz - center.z) < r) len += e.len;
    }
    this._lenCache = { t: this.time, x: center.x, z: center.z, len };
    return len;
  }

  _spawnGroup(center, rMin) {
    const o = this.o, rng = this.rng;
    const edge = this.network.randomEdge(rng, { filter: null, x: center.x, z: center.z, rMin, rMax: o.radius, tries: 30 });
    if (!edge || !isWalkable(edge)) return;
    const r = rng.next();
    const kind = r > o.groupShare ? 'solo' : rng.chance(o.pairShare) ? 'pair' : 'cluster';
    const size = kind === 'solo' ? 1 : kind === 'pair' ? 2 : 2 + (rng.chance(0.5) ? 1 : 0);
    if (this.agents.length + size > o.maxAgents) return;

    const paved = PAVED.has(edge.road.highway);
    const hw = edge.road.width / 2;
    const side = rng.chance(0.5) ? 1 : -1;
    // Sidewalk beside a street, or anywhere across a pedestrian way.
    const offset = paved ? (hw > 1.5 ? rng.range(-hw + 1, hw - 1) : 0) : side * (hw + 1.9);
    const speed = rng.range(o.walkSpeed[0], o.walkSpeed[1]) * (kind === 'cluster' ? 0.85 : 1);
    const forward = rng.chance(0.5);
    const s = rng.range(0, edge.len);
    const theme = rng.next();
    const group = { kind, members: [], history: [], compress: 0, lastYaw: null, turnRate: 0 };
    const make = (role, index) => {
      // Groups often dress alike (a Haredi pair in black, a family in similar tones).
      const dressAlike = theme < 0.3 && kind !== 'solo';
      const look = this.lookRng;
      const clothing = rng.next(); // one draw on the behaviour stream, as before
      // Haredi men: groups dressed alike, and some people walking alone.
      const haredi = dressAlike || (kind === 'solo' && look.chance(0.12));
      const a = {
        role, index, group,
        edge, forward, s, offset, offsetScale: 1,
        speed, x: 0, y: 0, z: 0, yaw: 0,
        state: 'walk', fleeT: 0, fleeX: 0, fleeZ: 0,
        phase: rng.range(0, Math.PI * 2),
        stride: rng.range(0.9, 1.1),
        scale: (role === 'trail' && kind === 'cluster' && index === 1 ? 0.7 : 1) * rng.range(0.88, 1.12),
        girth: rng.range(0.9, 1.12),
        color: haredi ? HAREDI.top : TOPS[Math.floor(clothing * TOPS.length)],
        lower: haredi ? HAREDI.bottom : look.pick(BOTTOMS),
        rigged: haredi, // may be drawn as the rigged Haredi model up close
        skin: look.next(), // 0 = light .. 1 = dark
        hair: look.next(),
        moving: speed,
      };
      this.agents.push(a);
      group.members.push(a);
      return a;
    };
    group.leader = make('leader', 0);
    for (let k = 1; k < size; k++) make(kind === 'pair' ? 'side' : 'trail', k);
    this._placeLeader(group.leader, 0);
    for (const m of group.members) {
      if (m === group.leader) continue;
      m.x = group.leader.x; m.y = group.leader.y; m.z = group.leader.z; m.yaw = group.leader.yaw;
    }
    this.groups.push(group);
  }

  _removeGroup(g) {
    const gone = new Set(g.members);
    this.agents = this.agents.filter((a) => !gone.has(a));
  }

  /**
   * Target point for a leader on its edge: `offset` meters to the left (> 0) or right of the
   * walking direction, scaled down when a wall stands on the sidewalk line.
   */
  _pathPoint(a) {
    const p = this.network.pointOn(a.edge, a.forward, a.s);
    const off = a.offset * a.offsetScale;
    return { x: p.x - p.uz * off, z: p.z + p.ux * off, ux: p.ux, uz: p.uz };
  }

  /**
   * Feet height: the walking surface, not the bare terrain. Street surfaces are draped
   * SURFACE_LIFT above the terrain (paving +0.04 m, asphalt +0.06 m in buildChunkParts), so
   * standing on the terrain sank feet into the pavement.
   */
  _groundY(x, z) {
    return this.collision.terrainHeight(x, z) + SURFACE_LIFT;
  }

  _blocked(x, z, r = 0.3) {
    const y = this.collision.terrainHeight(x, z);
    return this.collision.queryAABB(x - r, y + 0.3, z - r, x + r, y + 1.6, z + r).some((b) => b.kind !== 'roof-prop');
  }

  _placeLeader(a, dt) {
    let t = this._pathPoint(a);
    // Walls on the sidewalk line (buildings right at the street): step toward the road centre.
    for (let k = 0; k < 4 && this._blocked(t.x, t.z); k++) {
      a.offsetScale *= 0.6;
      t = this._pathPoint(a);
    }
    if (dt === 0) {
      a.x = t.x; a.z = t.z;
    } else {
      a.x = damp(a.x, t.x, 6, dt);
      a.z = damp(a.z, t.z, 6, dt);
    }
    a.offsetScale = Math.min(1, a.offsetScale + dt * 0.1);
    a.y = this._groundY(a.x, a.z);
    const yaw = Math.atan2(-t.ux, -t.uz);
    a.yaw = dt === 0 ? yaw : a.yaw + wrap(yaw - a.yaw) * Math.min(1, dt * 6);
  }

  _updateGroup(g, dt, threat) {
    const o = this.o, L = g.leader;
    // Flee check for everyone in the group.
    for (const a of g.members) {
      if (threat?.active && a.state !== 'flee' && Math.hypot(a.x - threat.x, a.z - threat.z) < o.fleeRadius) {
        const away = Math.atan2(a.x - threat.x, a.z - threat.z) + this.rng.range(-0.45, 0.45);
        a.state = 'flee';
        a.fleeT = o.fleeTime;
        a.fleeX = Math.sin(away);
        a.fleeZ = Math.cos(away);
      }
    }

    // Leader: walk the network, or flee / return.
    if (L.state === 'flee') this._flee(L, dt);
    else {
      if (L.state !== 'return') L.s += L.speed * dt; // path progress pauses while walking back
      while (L.s > L.edge.len) {
        L.s -= L.edge.len;
        const n = this.network.next(L.edge, L.forward, this.rng, isWalkable);
        L.edge = n.edge;
        L.forward = n.forward;
      }
      if (L.state === 'return') {
        const t = this._pathPoint(L);
        if (this._walkTo(L, t.x, t.z, dt) < 0.3) L.state = 'walk';
      } else this._placeLeader(L, dt);
      L.moving = L.speed;
    }

    // Breadcrumbs: the leader's recent positions.
    g.history.push({ t: this.time, x: L.x, z: L.z, yaw: L.yaw });
    while (g.history.length > 2 && this.time - g.history[1].t > o.breadcrumbDelay * 3 + 0.5) g.history.shift();
    if (g.lastYaw != null && dt > 0) g.turnRate = damp(g.turnRate, Math.abs(wrap(L.yaw - g.lastYaw)) / dt, 8, dt);
    g.lastYaw = L.yaw;

    for (const a of g.members) {
      if (a === L) continue;
      if (a.state === 'flee') { this._flee(a, dt); continue; }
      const crumb = this._crumb(g, o.breadcrumbDelay * (a.role === 'trail' ? a.index : 1));
      let tx = crumb.x, tz = crumb.z, tyaw = crumb.yaw;
      if (a.role === 'side') {
        // Side by side, unless turning hard, narrow, or a wall is where the companion would be.
        const rx = Math.cos(L.yaw), rz = -Math.sin(L.yaw); // leader's right
        const sx = L.x + rx * o.sideSpacing, sz = L.z + rz * o.sideSpacing;
        const narrow = PAVED.has(L.edge.road.highway) && L.edge.road.width < o.narrowWidth;
        const squeeze = g.turnRate > o.compressTurnRate || narrow || this._blocked(sx, sz, 0.25);
        g.compress = damp(g.compress, squeeze ? 1 : 0, squeeze ? 6 : 1.5, dt);
        tx = sx + (crumb.x - sx) * g.compress;
        tz = sz + (crumb.z - sz) * g.compress;
        tyaw = L.yaw;
      }
      if (a.state === 'return') {
        if (this._walkTo(a, tx, tz, dt) < 0.3) a.state = 'walk';
      } else {
        a.x = tx;
        a.z = tz;
      }
      a.y = this._groundY(a.x, a.z);
      a.yaw = a.yaw + wrap(tyaw - a.yaw) * Math.min(1, dt * 8);
      a.moving = L.moving;
    }
  }

  /** Walks straight toward (tx, tz) a bit faster than normal; returns the remaining distance. */
  _walkTo(a, tx, tz, dt) {
    const dx = tx - a.x, dz = tz - a.z, d = Math.hypot(dx, dz);
    const step = Math.min(d, a.speed * 1.6 * dt);
    if (d > 1e-6) {
      a.x += (dx / d) * step;
      a.z += (dz / d) * step;
      a.yaw = a.yaw + wrap(Math.atan2(-dx, -dz) - a.yaw) * Math.min(1, dt * 8);
    }
    a.y = this._groundY(a.x, a.z);
    a.moving = a.speed;
    return d - step;
  }

  /** Breadcrumb `delay` seconds back in the leader's history (interpolated). */
  _crumb(g, delay) {
    const h = g.history, t = this.time - delay;
    if (!h.length) return g.leader;
    if (t <= h[0].t) return h[0];
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= t) {
        const a = h[i - 1], b = h[i], k = (t - a.t) / Math.max(1e-6, b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, yaw: a.yaw + wrap(b.yaw - a.yaw) * k };
      }
    }
    return h[h.length - 1];
  }

  _flee(a, dt) {
    const o = this.o;
    a.fleeT -= dt;
    // Double speed at first, easing back toward walking pace as the scare wears off.
    const k = Math.max(0, a.fleeT / o.fleeTime);
    const speed = a.speed * (1 + (o.fleeSpeedFactor - 1) * Math.min(1, k * 1.5));
    const nx = a.x + a.fleeX * speed * dt, nz = a.z + a.fleeZ * speed * dt;
    if (!this._blocked(nx, nz)) {
      a.x = nx;
      a.z = nz;
    } else {
      // Slide along the wall: try the two perpendicular directions.
      const alt = [[a.fleeZ, -a.fleeX], [-a.fleeZ, a.fleeX]].find(([dx, dz]) => !this._blocked(a.x + dx * speed * dt, a.z + dz * speed * dt));
      if (alt) { a.fleeX = alt[0]; a.fleeZ = alt[1]; }
    }
    a.y = this._groundY(a.x, a.z);
    a.yaw = a.yaw + wrap(Math.atan2(-a.fleeX, -a.fleeZ) - a.yaw) * Math.min(1, dt * 10);
    a.moving = speed;
    if (a.fleeT <= 0) a.state = 'return';
  }

  // ------------------------------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------------------------------

  /** Writes the instances within `radius` of the camera. Call once per frame. */
  render(camera, time) {
    const mesh = this.mesh, walk = mesh.geometry.getAttribute('aWalk'), look = mesh.geometry.getAttribute('aLook');
    const r2 = this.o.radius * this.o.radius;
    const p = camera.position;
    let n = 0;
    const riggedAgents = this.rigged ? this.rigged.assign(this.agents, camera) : null;
    for (const a of this.agents) {
      const dx = a.x - p.x, dz = a.z - p.z;
      if (dx * dx + dz * dz > r2) continue;
      if (riggedAgents?.has(a)) continue; // drawn as a rigged model
      // Agent yaw points the model's -Z along the walk (see _placeLeader); the mannequin and the
      // rigged model face +Z, so turn them half a circle.
      this._q.setFromAxisAngle(this._up, a.yaw + Math.PI);
      this._s.set(a.scale * a.girth, a.scale, a.scale * a.girth);
      this._m.compose(this._v.set(a.x, a.y, a.z), this._q, this._s);
      mesh.setMatrixAt(n, this._m);
      mesh.setColorAt(n, this._c.setHex(a.color)); // top (instance colour)
      this._c.setHex(a.lower); // bottoms, linear like the instance colour
      look.setXYZW(n, this._c.r, this._c.g, this._c.b, a.skin + Math.floor(a.hair * 4) * 2); // skin 0..1 + hair shade 0/2/4/6
      // Stride: phase, cadence (rad/s) and swing amplitude from the current speed.
      walk.setXYZ(n, a.phase, 5.2 * a.stride * (0.55 + 0.45 * a.moving / 1.3), Math.min(0.75, 0.32 * a.moving));
      n++;
    }
    mesh.count = n;
    this.visible = n + (riggedAgents ? riggedAgents.size : 0);
    this.rigged?.update(time);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    walk.needsUpdate = true;
    look.needsUpdate = true;
    mesh.material.userData.uniforms.uTime.value = time;
  }

  /** Hands the nearest eligible agents to rigged, animated models (see RiggedPedestrians). */
  attachRigged(rigged) {
    this.rigged = rigged;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.customDepthMaterial?.dispose();
    this.rigged?.dispose();
    this.mesh.dispose();
  }
}

/**
 * Faceted low-poly mannequin (1.75 m), flat-shaded: head with hair, neck, torso widening to
 * the shoulders, pelvis, two-part legs with shoes, two-part arms with hands.
 *
 * aPart tags the limbs for the vertex-shader swing (1/2 legs pivot at the hips, 3/4 arms at
 * the shoulders). aZone picks the colour: 0 top (instance colour), 1 bottoms, 2 skin,
 * 3 shoes, 4 hair. Per instance, aLook = (bottoms rgb, skin tone 0..1 + 2 * hair shade 0..3).
 * A matching depth material applies the same swing, so shadows move with the limbs.
 */
const ZONE = { top: 0, bottom: 1, skin: 2, shoe: 3, hair: 4 };

export function createPedestrianMesh(max) {
  const part = (geo, partId, zone) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.deleteAttribute('uv');
    g.computeVertexNormals(); // non-indexed: one normal per face, i.e. faceted
    const n = g.getAttribute('position').count;
    g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(partId), 1));
    g.setAttribute('aZone', new THREE.BufferAttribute(new Float32Array(n).fill(zone), 1));
    return g;
  };
  // Tapered prism from y0 to y1, flattened front-to-back by `depth`.
  const prism = (rBottom, rTop, y0, y1, x, depth = 1, sides = 6) =>
    new THREE.CylinderGeometry(rTop, rBottom, y1 - y0, sides).scale(1, 1, depth).translate(x, (y0 + y1) / 2, 0);

  const limbs = [];
  for (const side of [-1, 1]) {
    const leg = side < 0 ? 1 : 2, arm = side < 0 ? 3 : 4;
    limbs.push(
      part(prism(0.058, 0.075, 0.07, 0.48, side * 0.095), leg, ZONE.bottom), // shin
      part(prism(0.075, 0.098, 0.46, 0.88, side * 0.1), leg, ZONE.bottom), // thigh
      part(new THREE.BoxGeometry(0.1, 0.075, 0.25).translate(side * 0.095, 0.037, 0.035), leg, ZONE.shoe),
      part(prism(0.047, 0.056, 1.14, 1.46, side * 0.235, 1, 5), arm, ZONE.top), // upper arm
      part(prism(0.037, 0.046, 0.88, 1.15, side * 0.24, 1, 5), arm, ZONE.top), // forearm (long sleeves)
      part(new THREE.IcosahedronGeometry(0.045, 0).scale(0.8, 1.1, 0.6).translate(side * 0.24, 0.84, 0), arm, ZONE.skin), // hand
    );
  }
  const geo = mergeGeometries([
    part(prism(0.15, 0.165, 0.84, 1.0, 0, 0.62), 0, ZONE.bottom), // pelvis
    part(prism(0.155, 0.2, 0.98, 1.4, 0, 0.58), 0, ZONE.top), // torso, widening to the chest
    part(prism(0.2, 0.12, 1.4, 1.5, 0, 0.58), 0, ZONE.top), // shoulders
    part(prism(0.045, 0.045, 1.49, 1.57, 0, 1, 5), 0, ZONE.skin), // neck
    part(new THREE.IcosahedronGeometry(0.108, 1).scale(0.92, 1.12, 1).translate(0, 1.67, 0.005), 0, ZONE.skin), // head
    part(new THREE.SphereGeometry(0.116, 7, 3, 0, Math.PI * 2, 0, Math.PI * 0.45).translate(0, 1.685, -0.008), 0, ZONE.hair),
    ...limbs,
  ], false);
  geo.setAttribute('aWalk', new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage));

  const uniforms = { uTime: { value: 0 } };
  // Shared by the colour and the shadow-depth shaders.
  const SWING_DECL = /* glsl */ `
attribute float aPart;
attribute vec3 aWalk;
uniform float uTime;
vec3 pedSwing(vec3 p, float pivotY, float angle) {
  float c = cos(angle), s = sin(angle);
  p.y -= pivotY;
  p = vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
  p.y += pivotY;
  return p;
}`;
  const SWING = /* glsl */ `
  {
    float swing = sin(uTime * aWalk.y + aWalk.x) * aWalk.z;
    if (aPart > 0.5 && aPart < 2.5) transformed = pedSwing(transformed, 0.86, aPart < 1.5 ? swing : -swing);
    else if (aPart > 2.5) transformed = pedSwing(transformed, 1.46, (aPart < 3.5 ? -swing : swing) * 0.8);
    transformed.y += abs(sin(uTime * aWalk.y + aWalk.x)) * aWalk.z * 0.05;
  }`;

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0, flatShading: true });
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => 'pedestrian-v2';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
${SWING_DECL}
attribute float aZone;
attribute vec4 aLook;
varying float vZone;
varying vec4 vLook;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vZone = aZone;
  vLook = aLook;
${SWING}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vZone;\nvarying vec4 vLook;')
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float skinTone = mod(vLook.w, 2.0);
    float hairShade = floor(vLook.w * 0.5) / 3.0;
    vec3 skin = mix(vec3(0.60, 0.38, 0.27), vec3(0.16, 0.09, 0.055), skinTone);
    vec3 hair = mix(vec3(0.02, 0.017, 0.015), vec3(0.16, 0.09, 0.04), hairShade);
    if (vZone > 3.5) diffuseColor.rgb = hair;
    else if (vZone > 2.5) diffuseColor.rgb = vec3(0.025, 0.022, 0.02); // shoes
    else if (vZone > 1.5) diffuseColor.rgb = skin;
    else if (vZone > 0.5) diffuseColor.rgb = vLook.rgb; // bottoms
  }`);
  };

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.customProgramCacheKey = () => 'pedestrian-depth-v1';
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SWING_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SWING}`);
  };

  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.customDepthMaterial = depth;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color(0xffffff)); // allocates instanceColor
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false; // bounds change every frame; the population is local anyway
  mesh.name = 'Pedestrians';
  mesh.userData.detail = true; // near shadow cascades only
  return mesh;
}
