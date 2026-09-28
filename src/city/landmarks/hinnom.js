// The Hinnom Valley (Gei Ben Hinnom) below the Old City's south-west corner, built from
// public/data/hinnom.json (scripts/fetch_hinnom.js):
//
//   mishkenot   Mishkenot Sha'ananim (1860), the first houses outside the walls: long one-storey
//               rows of rubble limestone facing the Old City across the valley, pointed-arch
//               doors and windows in dressed-stone frames, a crenellated parapet along the flat
//               roof, and a promenade under a sheet-metal veranda on thin iron columns
//   windmill    the Montefiore Windmill: a tapered stone tower on its stone terrace, the grey-
//               green metal cap, and four lattice sails facing the Old City
//   pool        Sultan's Pool: the reservoir's retaining walls (vertical ashlar, the ground
//               continuing behind them), the dam under the Hebron Road, the amphitheatre (stage
//               at the foot of the dam, rows of green seats raked up toward the northern floor)
//   slopes      dry-stone terraces along the contours of the valley's open slopes, from the real
//               terrain, and olive groves (with a few cypresses) on the open ground
//
// The stone goes into one mesh with the landmark material (one draw call per pass); the trees
// are two instanced meshes sharing the city's street-prop geometry and material. Everything
// solid adds collision boxes under the group 'hinnom'. The pool floors are terrain patches
// (hinnom.json `patches`), merged into the elevation data in main.js.

import * as THREE from 'three';
import { Mesher, STYLE, signedArea } from './geometry.js';
import { createLandmarkMaterial } from './materials.js';
import { decomposeFootprint, orientedBox } from '../footprint.js';

const COLLISION_GROUP = 'hinnom';

const C = {
  rubble: 0xcfc2a5, // Mishkenot: rough, warm limestone
  plinth: 0xc3b699,
  dressed: 0xe3dac6, // dressed-stone frames, parapet copings
  opening: 0x2b3134, // doors and windows behind their blue-grey iron grilles
  roof: 0xa9a59b,
  veranda: 0x6e7a73, // painted sheet metal
  iron: 0x464c4f,
  mill: 0xdacfb6,
  cap: 0x8a978d, // weathered grey-green
  spar: 0x5e4630,
  lattice: 0xd8d2c4,
  poolWall: 0xc4b596,
  poolWallOld: 0xb7a888,
  rim: 0xb9ad93,
  terrace: 0xb8ab8f,
  seat: 0x2f6a4c,
  tier: 0xb9b3a6,
  stage: 0x3a3a3c,
  truss: 0x55595c,
};

const hash = (a, b = 0) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** A box between two 3D points (half width `hw` across, half height `hh` along `up`). */
export function beam(m, a, b, hw, hh, up = [0, 1, 0]) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(...d);
  if (L < 1e-5) return;
  d[0] /= L; d[1] /= L; d[2] /= L;
  let s = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
  let sl = Math.hypot(...s);
  if (sl < 1e-4) { s = [1, 0, 0]; sl = 1; }
  s = [s[0] / sl, s[1] / sl, s[2] / sl];
  const u = [s[1] * d[2] - s[2] * d[1], s[2] * d[0] - s[0] * d[2], s[0] * d[1] - s[1] * d[0]];
  const P = (p, i, j) => [p[0] + s[0] * hw * i + u[0] * hh * j, p[1] + s[1] * hw * i + u[1] * hh * j, p[2] + s[2] * hw * i + u[2] * hh * j];
  const a00 = P(a, -1, -1), a10 = P(a, 1, -1), a11 = P(a, 1, 1), a01 = P(a, -1, 1);
  const b00 = P(b, -1, -1), b10 = P(b, 1, -1), b11 = P(b, 1, 1), b01 = P(b, -1, 1);
  const neg = (v) => [-v[0], -v[1], -v[2]];
  m.quad(a10, b10, b11, a11, s);
  m.quad(a00, a01, b01, b00, neg(s));
  m.quad(a01, a11, b11, b01, u);
  m.quad(a00, b00, b10, a10, neg(u));
  m.quad(b00, b01, b11, b10, d);
  m.quad(a00, a10, a11, a01, neg(d));
}

/**
 * Outline of a pointed (two-centred) arch opening, width w, from yBase to the springing
 * `spring` and up to the apex, as [s, y] points (s across the opening from 0 to w), convex.
 */
export function archOutline(w, yBase, spring, k = 6) {
  const R = w * 0.8;
  const pts = [[0, yBase], [w, yBase], [w, spring]];
  // Right half: arc centred at s = w - R; left half: centred at s = R. They meet at the apex.
  for (let i = 1; i < 2 * k; i++) {
    const s = w - (w * i) / (2 * k);
    const c = s >= w / 2 ? w - R : R;
    pts.push([s, spring + Math.sqrt(Math.max(0, R * R - (s - c) ** 2))]);
  }
  pts.push([0, spring]);
  return pts;
}

/**
 * @param {object} data  parsed hinnom.json
 * @param {object} ctx   { projection, terrain, collision, uniforms, props?: { material, olive, cypress } }
 */
export function buildHinnom(data, { projection, terrain, collision, uniforms, props = null }) {
  const material = createLandmarkMaterial(uniforms);
  const group = new THREE.Group();
  group.name = 'Hinnom';
  const ground = (x, z) => terrain.heightAt(x, z);
  const project = (flat) => projection.projectFlat(flat);
  const at = (p) => projection.project(p.lat, p.lon);
  const stats = { meshes: 0, triangles: 0, boxes: 0, olives: 0, cypresses: 0, terraceSegments: 0, seats: 0 };

  const addBox = (b, kind = 'building', ref = 'hinnom') => {
    if (!(b.maxX > b.minX && b.maxY > b.minY && b.maxZ > b.minZ)) return;
    collision?.add({ ...b, kind, ref }, COLLISION_GROUP);
    stats.boxes++;
  };
  const addFootprint = (rings, minY, maxY, kind, ref) => {
    for (const b of decomposeFootprint(rings, { step: 0.6 })) addBox({ ...b, minY, maxY }, kind, ref);
  };
  /** Axis-aligned box around an oriented piece (centre, unit axis, half length / width). */
  const orientedCollider = (x, z, ux, uz, hl, hw, minY, maxY, kind, ref) => {
    const ex = Math.abs(ux) * hl + Math.abs(uz) * hw, ez = Math.abs(uz) * hl + Math.abs(ux) * hw;
    addBox({ minX: x - ex, maxX: x + ex, minZ: z - ez, maxZ: z + ez, minY, maxY }, kind, ref);
  };

  const m = new Mesher();

  // --- Mishkenot Sha'ananim ------------------------------------------------------------------
  const MISH = { storey: 4.6, parapet: 0.55, merlonW: 0.62, merlonH: 0.6, merlonPitch: 1.75, bay: 3.5, promenade: 4.2, verandaH: 3.5, verandaD: 3.0 };
  // Openings are drawn on the face from s0 to s1 (metres along the facade), set 2 cm proud.
  const arch = (face, s0, w, yBase, spring, frame) => {
    const { ax, az, ux, uz, nx, nz } = face;
    const P = (s, y, off) => [ax + ux * s + nx * off, y, az + uz * s + nz * off];
    const poly = (pts, off) => {
      for (let i = 1; i + 1 < pts.length; i++) m.tri(P(pts[0][0], pts[0][1], off), P(pts[i][0], pts[i][1], off), P(pts[i + 1][0], pts[i + 1][1], off), [nx, 0, nz]);
    };
    m.paint(C.dressed, 0.36, 0.55, STYLE.ashlar);
    poly(archOutline(w + frame * 2, yBase - 0.12, spring, 6).map(([s, y]) => [s0 - frame + s, y]), 0.015);
    m.paint(C.opening, 1, 1, STYLE.plain);
    poly(archOutline(w, yBase, spring - 0.05, 6).map(([s, y]) => [s0 + s, y]), 0.03);
  };
  const merlons = (x0, z0, x1, z1, y, nx, nz) => {
    const L = Math.hypot(x1 - x0, z1 - z0);
    const ux = (x1 - x0) / L, uz = (z1 - z0) / L;
    const n = Math.max(1, Math.round(L / MISH.merlonPitch));
    m.paint(C.dressed, 0.3, 0.6, STYLE.ashlar);
    for (let k = 0; k <= n; k++) {
      const s = Math.min(L - MISH.merlonW / 2, Math.max(MISH.merlonW / 2, (k * L) / n));
      const cx = x0 + ux * s - nx * 0.2, cz = z0 + uz * s - nz * 0.2;
      m.orientedBox(cx, cz, ux, uz, MISH.merlonW / 2, 0.22, y, y + MISH.merlonH);
    }
  };

  for (const row of data.mishkenot ?? []) {
    const ring = project(row.ring);
    const box = orientedBox(ring);
    if (!box) continue;
    const { cx, cz, ax, az, hl, hw } = box;
    const px = -az, pz = ax; // across the row
    // The front faces the valley: the side where the ground is lower.
    const sideGround = (sgn) => {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += ground(cx + ax * hl * 0.4 * k + px * (hw + 4) * sgn, cz + az * hl * 0.4 * k + pz * (hw + 4) * sgn);
      return s / 5;
    };
    const f = sideGround(1) < sideGround(-1) ? 1 : -1; // front = +f across
    let lo = Infinity;
    const level = [];
    for (let k = 0; k <= 8; k++) {
      const s = -hl + (2 * hl * k) / 8;
      for (const t of [-1, 0, 1]) lo = Math.min(lo, ground(cx + ax * s + px * hw * t, cz + az * s + pz * hw * t));
      level.push((ground(cx + ax * s - px * hw * f, cz + az * s - pz * hw * f) + ground(cx + ax * s, cz + az * s)) / 2);
    }
    level.sort((a, b) => a - b);
    // On its terrace: a little into the slope on the uphill side, a plinth on the downhill side.
    const floor = level[Math.floor(level.length / 2)] + 0.2;
    const roofY = floor + MISH.storey, top = roofY + MISH.parapet;
    const bottom = Math.min(lo, floor) - 0.6;
    const corner = (s, t) => [cx + ax * s + px * t, cz + az * s + pz * t];
    const rect = [...corner(-hl, -hw), ...corner(hl, -hw), ...corner(hl, hw), ...corner(-hl, hw)];
    // Plinth (the terrace it stands on) below the floor, the rubble walls above.
    m.paint(C.plinth, 0.34, 0.5, STYLE.ashlar);
    m.prism(rect, bottom, floor - 0.25, { top: false });
    m.paint(C.dressed, 0.25, 0.7, STYLE.ashlar); // string course at the floor
    m.prism(rect, floor - 0.25, floor + 0.05, { top: false });
    m.paint(C.rubble, 0.3, 0.42, STYLE.ashlar);
    m.prism(rect, floor + 0.05, top, { top: false });
    m.paint(C.roof, 1, 1, STYLE.paving);
    m.polygon([rect], roofY + 0.05, 1);
    // Parapet coping and merlons on all four sides (inner face lines of the parapet).
    m.paint(C.dressed, 0.3, 0.6, STYLE.ashlar);
    const inner = [...corner(-hl + 0.35, -hw + 0.35), ...corner(hl - 0.35, -hw + 0.35), ...corner(hl - 0.35, hw - 0.35), ...corner(-hl + 0.35, hw - 0.35)];
    m.polygon([rect, inner], top, 1);
    for (let e = 0; e < 4; e++) {
      const a = [rect[e * 2], rect[e * 2 + 1]], b = [rect[((e + 1) % 4) * 2], rect[((e + 1) % 4) * 2 + 1]];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let nx = (b[1] - a[1]) / L, nz = -(b[0] - a[0]) / L;
      if (signedArea(rect) < 0) { nx = -nx; nz = -nz; }
      merlons(a[0], a[1], b[0], b[1], top, nx, nz);
    }
    // Facades: pointed-arch doors and windows in bays; a Star of David tablet over the middle
    // door of the front (the foundation stone).
    for (const sgn of [f, -f]) {
      const face = { ax: cx - ax * hl + px * hw * sgn, az: cz - az * hl + pz * hw * sgn, ux: ax, uz: az, nx: px * sgn, nz: pz * sgn };
      const bays = Math.max(1, Math.floor((2 * hl - 1.6) / MISH.bay));
      const pitch = (2 * hl) / bays;
      for (let k = 0; k < bays; k++) {
        const mid = (k + 0.5) * pitch;
        const door = sgn === f ? k % 3 === 1 : k % 4 === 2;
        if (door) arch(face, mid - 0.62, 1.24, floor + 0.02, floor + 2.25, 0.2);
        else arch(face, mid - 0.5, 1.0, floor + 0.95, floor + 2.55, 0.18);
      }
      if (sgn === f) {
        const mid = hl, y = floor + 3.55;
        const P = (s, yy) => [face.ax + ax * s + face.nx * 0.04, yy, face.az + az * s + face.nz * 0.04];
        m.paint(0xece5d6, 0.3, 0.5, STYLE.marble);
        for (const d of [1, -1]) m.tri(P(mid - 0.62, y - 0.36 * d), P(mid + 0.62, y - 0.36 * d), P(mid, y + 0.72 * d), [face.nx, 0, face.nz]);
      }
    }
    // End walls: a window each side of the middle.
    for (const sgn of [-1, 1]) {
      const face = { ax: cx + ax * hl * sgn + px * hw * sgn, az: cz + az * hl * sgn + pz * hw * sgn, ux: -px * sgn, uz: -pz * sgn, nx: ax * sgn, nz: az * sgn };
      for (const s of [hw * 0.55, hw * 1.45]) arch(face, s - 0.45, 0.9, floor + 1.0, floor + 2.5, 0.16);
    }
    // Promenade in front (paved, on a retaining wall down to the slope) under the veranda.
    const pr = [...corner(-hl, hw * f), ...corner(hl, hw * f), ...corner(hl, (hw + MISH.promenade) * f), ...corner(-hl, (hw + MISH.promenade) * f)];
    m.paint(C.poolWallOld, 0.42, 0.8, STYLE.ashlar);
    m.prism(pr, bottom, floor, { top: false });
    m.paint(0xd6ccb8, 1, 1, STYLE.paving);
    m.polygon([pr], floor + 0.01, 1);
    // A low stone parapet along its outer edge.
    m.paint(C.dressed, 0.3, 0.7, STYLE.ashlar);
    const pe = corner(0, (hw + MISH.promenade - 0.2) * f);
    m.orientedBox(pe[0], pe[1], ax, az, hl, 0.2, floor, floor + 0.75);
    // Veranda: sheet-metal roof sloping away from the wall, on iron columns with a beam.
    const vIn = hw * f, vOut = (hw + MISH.verandaD) * f;
    const yIn = floor + MISH.verandaH + 0.25, yOut = floor + MISH.verandaH - 0.1;
    const V = (s, t, y) => { const c = corner(s, t); return [c[0], y, c[1]]; };
    m.paint(C.veranda, 1, 1, STYLE.lead);
    const slope = [px * f * (yIn - yOut), MISH.verandaD, pz * f * (yIn - yOut)];
    const sl = Math.hypot(...slope);
    m.quad(V(-hl + 0.3, vIn, yIn), V(hl - 0.3, vIn, yIn), V(hl - 0.3, vOut, yOut), V(-hl + 0.3, vOut, yOut), slope.map((v) => v / sl));
    m.quad(V(-hl + 0.3, vIn, yIn - 0.06), V(hl - 0.3, vIn, yIn - 0.06), V(hl - 0.3, vOut, yOut - 0.06), V(-hl + 0.3, vOut, yOut - 0.06), slope.map((v) => -v / sl));
    m.paint(C.iron, 1, 1, STYLE.metal);
    beam(m, V(-hl + 0.3, vOut - 0.1 * f, yOut - 0.2), V(hl - 0.3, vOut - 0.1 * f, yOut - 0.2), 0.06, 0.12);
    const cols = Math.max(2, Math.round((2 * hl - 0.6) / 3.2));
    for (let k = 0; k <= cols; k++) {
      const s = -hl + 0.3 + ((2 * hl - 0.6) * k) / cols;
      const c = corner(s, vOut - 0.1 * f);
      m.cylinder(c[0], c[1], 0.09, 0.07, floor, yOut - 0.2, 6, { top: false });
      m.cylinder(c[0], c[1], 0.15, 0.15, floor, floor + 0.3, 6);
    }
    addFootprint([rect], bottom, top, 'building', row.id);
    addFootprint([pr], bottom, floor, 'building', `${row.id}-promenade`);
    stats.mishkenot = (stats.mishkenot ?? 0) + 1;
  }

  // --- Montefiore Windmill -------------------------------------------------------------------
  if (data.windmill) {
    const w = data.windmill;
    const c = at(w);
    let baseTop = ground(c.x, c.z);
    if (w.base) {
      const ring = project(w.base.ring);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < ring.length; i += 2) { const g = ground(ring[i], ring[i + 1]); lo = Math.min(lo, g); hi = Math.max(hi, g); }
      baseTop = hi + 1.2;
      m.paint(C.poolWall, 0.5, 1.1, STYLE.ashlar);
      m.prism(ring, lo - 0.6, baseTop, { top: false });
      m.paint(0xd4cab6, 1, 1, STYLE.paving);
      m.polygon([ring], baseTop, 1);
      // Iron railing round the terrace.
      m.paint(C.iron, 1, 1, STYLE.metal);
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const a = [ring[i * 2], ring[i * 2 + 1]], b = [ring[((i + 1) % n) * 2], ring[((i + 1) % n) * 2 + 1]];
        beam(m, [a[0], baseTop + 1.0, a[1]], [b[0], baseTop + 1.0, b[1]], 0.03, 0.03);
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let s = 0; s < L; s += 1.6) {
          const x = a[0] + ((b[0] - a[0]) * s) / L, z = a[1] + ((b[1] - a[1]) * s) / L;
          beam(m, [x, baseTop, z], [x, baseTop + 1.0, z], 0.025, 0.025, [1, 0, 0]);
        }
      }
      addFootprint([ring], lo - 0.6, baseTop, 'building', w.base.id);
    }
    const TOWER = { r0: 3.9, r1: 3.05, h: 10.8, capR: 3.35, capH: 2.9 };
    const y0 = baseTop, yt = y0 + TOWER.h;
    m.paint(C.mill, 0.42, 0.85, STYLE.ashlar);
    m.cylinder(c.x, c.z, TOWER.r0, TOWER.r1, y0 - 0.3, yt, 24, { top: true });
    m.paint(C.dressed, 0.3, 0.6, STYLE.ashlar);
    m.cylinder(c.x, c.z, TOWER.r1 + 0.12, TOWER.r1 + 0.12, yt - 0.35, yt, 24, { top: false });
    // The cap: a faceted dome of grey-green sheet metal, and a finial.
    m.paint(C.cap, 1, 1, STYLE.lead);
    m.cylinder(c.x, c.z, TOWER.capR, TOWER.capR, yt, yt + 0.9, 16, { top: false });
    m.dome(c.x, c.z, TOWER.capR, yt + 0.9, TOWER.capH - 0.9, { seg: 16, rings: 4 });
    m.paint(C.iron, 1, 1, STYLE.metal);
    m.cylinder(c.x, c.z, 0.12, 0.04, yt + TOWER.capH - 0.05, yt + TOWER.capH + 0.6, 6);
    // Sails face the Old City (east-north-east); the door faces the street behind.
    const face = [Math.cos(-0.35), 0, Math.sin(-0.35)]; // unit, horizontal (x east, z south)
    const doorDir = [-face[0], -face[2]];
    const openingOn = (dx, dz, yA, yB, halfW, pointed) => {
      const nx = dx, nz = dz, ux = -dz, uz = dx;
      const rAt = (y) => TOWER.r0 + ((TOWER.r1 - TOWER.r0) * (y - y0)) / TOWER.h + 0.03;
      const P = (s, y) => [c.x + nx * rAt(y) + ux * s, y, c.z + nz * rAt(y) + uz * s];
      m.paint(C.opening, 1, 1, STYLE.plain);
      const outline = pointed ? archOutline(halfW * 2, yA, yB - halfW * 1.1, 5) : [[0, yA], [halfW * 2, yA], [halfW * 2, yB], [0, yB]];
      for (let i = 1; i + 1 < outline.length; i++) {
        const p = (k) => P(outline[k][0] - halfW, outline[k][1]);
        m.tri(p(0), p(i), p(i + 1), [nx, 0, nz]);
      }
    };
    openingOn(doorDir[0], doorDir[1], y0, y0 + 2.5, 0.65, true);
    for (const [ang, y] of [[0.9, 4.6], [-1.3, 7.4], [2.6, 6.2]]) {
      const ca = Math.cos(ang), sa = Math.sin(ang);
      openingOn(doorDir[0] * ca - doorDir[1] * sa, doorDir[0] * sa + doorDir[1] * ca, y0 + y, y0 + y + 1.1, 0.35, true);
    }
    // Hub and windshaft, then four lattice sails at 20° off vertical.
    const hubD = TOWER.capR + 0.6, hubY = yt + 1.3;
    const hub = [c.x + face[0] * hubD, hubY, c.z + face[2] * hubD];
    m.paint(C.spar, 1, 1, STYLE.wood);
    beam(m, [c.x + face[0] * (TOWER.capR - 0.8), hubY, c.z + face[2] * (TOWER.capR - 0.8)], [hub[0] + face[0] * 0.5, hubY, hub[2] + face[2] * 0.5], 0.28, 0.28);
    const e1 = [-face[2], 0, face[0]], e2 = [0, 1, 0];
    const SAIL = { len: 8.6, from: 1.9, width: 1.75, spar: 0.14, bars: 13 };
    for (let k = 0; k < 4; k++) {
      const th = (20 * Math.PI) / 180 + (k * Math.PI) / 2;
      const a = [Math.cos(th) * e1[0] + Math.sin(th) * e2[0], Math.sin(th), Math.cos(th) * e1[2] + Math.sin(th) * e2[2]];
      const b = [-Math.sin(th) * e1[0] + Math.cos(th) * e2[0], Math.cos(th), -Math.sin(th) * e1[2] + Math.cos(th) * e2[2]];
      const Q = (r, s, d = 0.3) => [hub[0] + a[0] * r + b[0] * s + face[0] * d, hub[1] + a[1] * r + b[1] * s, hub[2] + a[2] * r + b[2] * s + face[2] * d];
      m.paint(C.spar, 1, 1, STYLE.wood);
      beam(m, Q(0, 0), Q(SAIL.len, 0), SAIL.spar, SAIL.spar, face);
      m.paint(C.lattice, 1, 1, STYLE.wood);
      for (const s of [0.18, SAIL.width]) beam(m, Q(SAIL.from, s, 0.36), Q(SAIL.len, s, 0.36), 0.035, 0.035, face);
      beam(m, Q(SAIL.from, SAIL.width * 0.6, 0.38), Q(SAIL.len, SAIL.width * 0.6, 0.38), 0.02, 0.02, face);
      for (let i = 0; i <= SAIL.bars; i++) {
        const r = SAIL.from + ((SAIL.len - SAIL.from) * i) / SAIL.bars;
        beam(m, Q(r, 0.05, 0.4), Q(r, SAIL.width + 0.05, 0.4), 0.03, 0.025, face);
      }
    }
    // Collision: the tower as a stack of shrinking boxes, the cap on top.
    for (let k = 0; k < 3; k++) {
      const r = (TOWER.r0 + ((TOWER.r1 - TOWER.r0) * (k + 0.5)) / 3) * 0.8;
      addBox({ minX: c.x - r, maxX: c.x + r, minZ: c.z - r, maxZ: c.z + r, minY: y0 + (TOWER.h * k) / 3, maxY: y0 + (TOWER.h * (k + 1)) / 3 }, 'building', w.id);
    }
    addBox({ minX: c.x - 2.6, maxX: c.x + 2.6, minZ: c.z - 2.6, maxZ: c.z + 2.6, minY: yt, maxY: yt + TOWER.capH }, 'building', w.id);
    stats.windmill = true;
  }

  // --- Sultan's Pool -------------------------------------------------------------------------
  if (data.pool) {
    const p = data.pool;
    const ring = project(p.ring);
    const n = ring.length / 2;
    const ccw = signedArea(ring) > 0;
    const split = projection.project(p.splitLat, p.ring[1]).z;
    const floorS = p.floor.south - terrain.datum, floorN = p.floor.north - terrain.datum;
    const floorAt = (z) => (z > split ? floorS : floorN);
    const WALL = { thick: 1.6, parapet: 0.9, rim: 15 };
    // Retaining walls: every edge, in ~4 m panels, from below the floor up to the ground behind
    // (sampled beyond the lowered edge band), with a parapet; behind the wall a rim strip that
    // follows the true ground covers the terrain mesh's ramp down to the floor.
    for (let i = 0; i < n; i++) {
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[((i + 1) % n) * 2], bz = ring[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.5) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      let nx = uz, nz = -ux; // outward for a counter-clockwise ring (x east, z south)
      if (!ccw) { nx = -nx; nz = -nz; }
      const panels = Math.max(1, Math.round(L / 4));
      for (let k = 0; k < panels; k++) {
        const s0 = (L * k) / panels, s1 = (L * (k + 1)) / panels;
        const x0 = ax + ux * s0, z0 = az + uz * s0, x1 = ax + ux * s1, z1 = az + uz * s1;
        const behind = (x, z, d) => ground(x + nx * d, z + nz * d);
        const f0 = floorAt(z0), f1 = floorAt(z1);
        const t0 = Math.max(f0 + 3, behind(x0, z0, 3.5)), t1 = Math.max(f1 + 3, behind(x1, z1, 3.5));
        const old = hash(i, k) > 0.55;
        m.paint(old ? C.poolWallOld : C.poolWall, 0.62, 1.3, STYLE.ashlar);
        // Inner face (toward the pool), top, parapet.
        m.wall(x0, z0, x1, z1, f0 - 0.5, f1 - 0.5, t0, t1, [-nx, 0, -nz]);
        const ox0 = x0 + nx * WALL.thick, oz0 = z0 + nz * WALL.thick, ox1 = x1 + nx * WALL.thick, oz1 = z1 + nz * WALL.thick;
        m.paint(C.dressed, 0.4, 0.9, STYLE.ashlar);
        m.quad([x0, t0 + WALL.parapet, z0], [x1, t1 + WALL.parapet, z1], [x1 + nx * 0.5, t1 + WALL.parapet, z1 + nz * 0.5], [x0 + nx * 0.5, t0 + WALL.parapet, z0 + nz * 0.5], [0, 1, 0]);
        m.wall(x0, z0, x1, z1, t0, t1, t0 + WALL.parapet, t1 + WALL.parapet, [-nx, 0, -nz]);
        m.wall(x0 + nx * 0.5, z0 + nz * 0.5, x1 + nx * 0.5, z1 + nz * 0.5, t0, t1, t0 + WALL.parapet, t1 + WALL.parapet, [nx, 0, nz]);
        m.paint(C.rim, 1, 1, STYLE.paving);
        m.quad([x0 + nx * 0.5, t0 + 0.02, z0 + nz * 0.5], [x1 + nx * 0.5, t1 + 0.02, z1 + nz * 0.5], [ox1, t1 + 0.02, oz1], [ox0, t0 + 0.02, oz0], [0, 1, 0]);
        // Rim: 3 bands out to WALL.rim metres, each vertex on the true ground (a hair below).
        const bands = [WALL.thick, 5, 10, WALL.rim];
        for (let bi = 0; bi + 1 < bands.length; bi++) {
          const da = bands[bi], db = bands[bi + 1];
          const A0 = [x0 + nx * da, bi === 0 ? t0 : behind(x0, z0, da) - 0.08, z0 + nz * da];
          const A1 = [x1 + nx * da, bi === 0 ? t1 : behind(x1, z1, da) - 0.08, z1 + nz * da];
          const B1 = [x1 + nx * db, behind(x1, z1, db) - 0.08, z1 + nz * db];
          const B0 = [x0 + nx * db, behind(x0, z0, db) - 0.08, z0 + nz * db];
          m.paint(0x9d9a78, 1, 1, STYLE.foliage);
          m.quad(A0, A1, B1, B0, null);
        }
        orientedCollider((x0 + x1) / 2 + nx * 0.4, (z0 + z1) / 2 + nz * 0.4, ux, uz, (s1 - s0) / 2, 0.45, Math.min(f0, f1) - 0.5, Math.max(t0, t1) + WALL.parapet, 'wall', p.id);
      }
    }

    // Local frame: v runs north from the dam along the pool's long axis, u across it.
    const box = orientedBox(ring);
    let vx = box.ax, vz = box.az;
    if (vz > 0) { vx = -vx; vz = -vz; } // north = -z
    const uxA = -vz, uzA = vx; // across (east-ish)
    let vMin = Infinity;
    for (let i = 0; i < ring.length; i += 2) vMin = Math.min(vMin, (ring[i] - box.cx) * vx + (ring[i + 1] - box.cz) * vz);
    const W = (u, v) => [box.cx + uxA * u + vx * (v + vMin), box.cz + uzA * u + vz * (v + vMin)];
    const vSplit = (() => { const q = W(0, 0); return (q[1] - split) / -vz; })();
    // Width of the pool at v (u range), from the ring edges crossing that line.
    const span = (v) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const a = [ring[i * 2] - box.cx, ring[i * 2 + 1] - box.cz], b = [ring[((i + 1) % n) * 2] - box.cx, ring[((i + 1) % n) * 2 + 1] - box.cz];
        const va = a[0] * vx + a[1] * vz - vMin, vb = b[0] * vx + b[1] * vz - vMin;
        if ((va - v) * (vb - v) > 0 || va === vb) continue;
        const t = (v - va) / (vb - va);
        const u = (a[0] + (b[0] - a[0]) * t) * uxA + (a[1] + (b[1] - a[1]) * t) * uzA;
        lo = Math.min(lo, u); hi = Math.max(hi, u);
      }
      return lo < hi ? [lo, hi] : null;
    };
    const Y = (u, v, dy) => { const q = W(u, v); return [q[0], floorS + dy, q[1]]; };

    // Stage at the foot of the dam: a dark platform, truss towers and a roof grid.
    const STAGE = { v0: 1.8, v1: 15, halfW: 15, h: 1.4, roof: 11 };
    const ss = span(8);
    if (ss) {
      const um = (ss[0] + ss[1]) / 2;
      const corners = [W(um - STAGE.halfW, STAGE.v0), W(um + STAGE.halfW, STAGE.v0), W(um + STAGE.halfW, STAGE.v1), W(um - STAGE.halfW, STAGE.v1)];
      m.paint(C.stage, 1, 1, STYLE.wood);
      m.prism(corners.flat(), floorS - 0.2, floorS + STAGE.h);
      m.paint(C.truss, 1, 1, STYLE.metal);
      const towers = [[um - STAGE.halfW + 0.5, STAGE.v0 + 0.5], [um + STAGE.halfW - 0.5, STAGE.v0 + 0.5], [um - STAGE.halfW + 0.5, STAGE.v1 - 0.5], [um + STAGE.halfW - 0.5, STAGE.v1 - 0.5]];
      for (const [u, v] of towers) {
        for (const [du, dv] of [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]]) beam(m, Y(u + du, v + dv, STAGE.h), Y(u + du, v + dv, STAGE.roof), 0.05, 0.05, [1, 0, 0]);
        for (let y = STAGE.h + 1.2; y < STAGE.roof; y += 1.8) beam(m, Y(u - 0.3, v - 0.3, y), Y(u + 0.3, v + 0.3, y + 1.2), 0.03, 0.03);
      }
      for (let k = 0; k < 4; k++) {
        const [ua, va] = towers[k], [ub, vb] = towers[[1, 3, 0, 2][k]];
        beam(m, Y(ua, va, STAGE.roof), Y(ub, vb, STAGE.roof), 0.3, 0.35);
      }
      for (let v = STAGE.v0 + 3; v < STAGE.v1 - 1; v += 3) beam(m, Y(um - STAGE.halfW + 0.5, v, STAGE.roof), Y(um + STAGE.halfW - 0.5, v, STAGE.roof), 0.12, 0.15);
      // Back scenery screen against the dam.
      m.paint(0x1f2124, 1, 1, STYLE.plain);
      m.orientedBox(...W(um, STAGE.v0 + 0.3), uxA, uzA, STAGE.halfW - 1, 0.15, floorS + STAGE.h, floorS + STAGE.roof - 0.6);
      addFootprint([corners.flat()], floorS - 0.2, floorS + STAGE.h, 'building', 'sultans-pool-stage');
    }

    // Seating: rows of green seats in three blocks, flat on the floor near the stage, then
    // raked up to the northern floor level.
    const SEAT = { v0: 25, pitch: 0.95, rise: (floorN - floorS) / 20, flatRows: 0, aisle: 1.6 };
    const rows = Math.floor((vSplit - 1 - SEAT.v0) / SEAT.pitch);
    SEAT.flatRows = Math.max(0, rows - 20);
    for (let r = 0; r < rows; r++) {
      const v = SEAT.v0 + r * SEAT.pitch;
      const sp = span(v + SEAT.pitch);
      if (!sp) continue;
      const u0 = sp[0] + 2.2, u1 = sp[1] - 2.2;
      if (u1 - u0 < 8) continue;
      const tier = r < SEAT.flatRows ? 0 : (r - SEAT.flatRows + 1) * SEAT.rise;
      if (tier > 0) {
        m.paint(C.tier, 1, 1, STYLE.paving);
        const q = [W(sp[0] + 0.3, v), W(sp[1] - 0.3, v), W(sp[1] - 0.3, v + SEAT.pitch), W(sp[0] + 0.3, v + SEAT.pitch)];
        m.prism(q.flat(), floorS - 0.2, floorS + tier);
        addFootprint([q.flat()], floorS - 0.2, floorS + tier, 'building', 'sultans-pool-tiers');
      }
      const third = (u1 - u0) / 3;
      for (let b = 0; b < 3; b++) {
        const ua = u0 + b * third + (b > 0 ? SEAT.aisle / 2 : 0), ub = u0 + (b + 1) * third - (b < 2 ? SEAT.aisle / 2 : 0);
        const mid = W((ua + ub) / 2, v + 0.45);
        m.paint(C.seat, 1, 1, STYLE.plain);
        m.orientedBox(mid[0], mid[1], uxA, uzA, (ub - ua) / 2, 0.24, floorS + tier, floorS + tier + 0.45);
        const back = W((ua + ub) / 2, v + 0.72);
        m.orientedBox(back[0], back[1], uxA, uzA, (ub - ua) / 2, 0.04, floorS + tier + 0.45, floorS + tier + 0.85);
        orientedCollider(mid[0], mid[1], uxA, uzA, (ub - ua) / 2, 0.3, floorS + tier, floorS + tier + 0.5, 'building', 'sultans-pool-seats');
        stats.seats += Math.floor((ub - ua) / 0.5);
      }
    }
    stats.pool = { rows, vSplit: +vSplit.toFixed(1) };
  }

  // --- Terraces and groves on the valley slopes ---------------------------------------------------
  const trees = { olive: [], cypress: [] };
  if (data.slopes) {
    const S = data.slopes;
    const bytes = Uint8Array.from(atob(S.bits), (ch) => ch.charCodeAt(0));
    const free = (c, r) => c >= 0 && r >= 0 && c < S.cols && r < S.rows && ((bytes[(r * S.cols + c) >> 3] >> ((r * S.cols + c) & 7)) & 1) === 1;
    const o = at(S.origin);
    const cell = S.cell;
    const LEVEL = 2.4; // metres between terrace walls
    // Heights on the cell corners (shared by neighbouring cells, so contours join up).
    const H = new Float32Array((S.cols + 1) * (S.rows + 1));
    for (let r = 0; r <= S.rows; r++) for (let c = 0; c <= S.cols; c++) H[r * (S.cols + 1) + c] = ground(o.x + c * cell, o.z + r * cell);
    const h = (c, r) => H[r * (S.cols + 1) + c];
    m.paint(C.terrace, 0.28, 0.42, STYLE.ashlar);
    for (let r = 0; r < S.rows; r++) {
      for (let c = 0; c < S.cols; c++) {
        if (!free(c, r)) continue;
        const hs = [h(c, r), h(c + 1, r), h(c + 1, r + 1), h(c, r + 1)];
        const lo = Math.min(...hs), hi = Math.max(...hs);
        const grade = (hi - lo) / cell;
        const x0 = o.x + c * cell, z0 = o.z + r * cell;
        // Olives on gentle and moderate ground, now and then a cypress; none on cliffs.
        const k = hash(c * 0.37 + 11, r * 0.53 + 7);
        if (grade < 0.75 && k < 0.16) {
          const x = x0 + cell * (0.2 + 0.6 * hash(c, r * 3.1)), z = z0 + cell * (0.2 + 0.6 * hash(c * 2.3, r));
          const kind = k < 0.012 ? 'cypress' : 'olive';
          trees[kind].push({ x, z, y: ground(x, z) - 0.1, s: kind === 'olive' ? 0.8 + 0.5 * hash(r, c) : 0.85 + 0.3 * hash(r, c), ry: hash(c, r) * Math.PI * 2 });
        }
        // Terraces: only on real slopes (not the valley floor, not cliffs), in patches.
        if (grade < 0.1 || grade > 1.1) continue;
        if (hash(Math.floor(c / 4) * 1.7, Math.floor(r / 4) * 2.9) < 0.22) continue;
        for (let lvl = Math.ceil(lo / LEVEL) * LEVEL; lvl < hi; lvl += LEVEL) {
          // Marching squares on this cell: crossing points on its edges.
          const P = [[x0, z0], [x0 + cell, z0], [x0 + cell, z0 + cell], [x0, z0 + cell]];
          const pts = [];
          for (let e = 0; e < 4; e++) {
            const ha = hs[e], hb = hs[(e + 1) % 4];
            if ((ha - lvl) * (hb - lvl) >= 0 && !(ha === lvl && hb !== lvl)) continue;
            const t = (lvl - ha) / (hb - ha);
            pts.push([P[e][0] + (P[(e + 1) % 4][0] - P[e][0]) * t, P[e][1] + (P[(e + 1) % 4][1] - P[e][1]) * t]);
          }
          for (let q = 0; q + 1 < pts.length; q += 2) {
            const [ax, az] = pts[q], [bx, bz] = pts[q + 1];
            const L = Math.hypot(bx - ax, bz - az);
            if (L < 0.3) continue;
            // Downhill direction: toward the lower cell corners.
            const gx = (hs[1] + hs[2] - hs[0] - hs[3]) / 2, gz = (hs[2] + hs[3] - hs[0] - hs[1]) / 2; // uphill gradient
            const gl = Math.hypot(gx, gz) || 1;
            const dx = -gx / gl, dz = -gz / gl;
            const T = 0.45, top = lvl + 0.35;
            const A = [ax, az], B = [bx, bz];
            const A2 = [ax + dx * T, az + dz * T], B2 = [bx + dx * T, bz + dz * T];
            const botA = ground(A2[0], A2[1]) - 0.3, botB = ground(B2[0], B2[1]) - 0.3;
            // Downhill face (the visible one), top and the uphill lip.
            m.quad([A2[0], botA, A2[1]], [B2[0], botB, B2[1]], [B2[0], top, B2[1]], [A2[0], top, A2[1]], [dx, 0, dz]);
            m.quad([A[0], top, A[1]], [B[0], top, B[1]], [B2[0], top, B2[1]], [A2[0], top, A2[1]], [0, 1, 0]);
            m.quad([A[0], lvl - 0.4, A[1]], [B[0], lvl - 0.4, B[1]], [B[0], top, B[1]], [A[0], top, A[1]], [-dx, 0, -dz]);
            stats.terraceSegments++;
          }
        }
      }
    }
  }

  // --- Meshes ----------------------------------------------------------------------------------
  if (!m.empty) {
    const mesh = new THREE.Mesh(m.geometry(), material);
    mesh.name = 'Landmark(Hinnom)';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    stats.meshes++;
    stats.triangles += mesh.geometry.getAttribute('position').count / 3;
  }
  const instanced = [];
  if (props?.material) {
    const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _c = new THREE.Color();
    for (const [kind, geo, tint] of [['olive', props.olive, 0xe8eee0], ['cypress', props.cypress, 0xffffff]]) {
      const list = trees[kind];
      if (!geo || !list.length) continue;
      const im = new THREE.InstancedMesh(geo, props.material, list.length);
      im.name = `Hinnom(${kind})`;
      list.forEach((t, i) => {
        _p.set(t.x, t.y, t.z);
        _s.setScalar(t.s);
        _q.setFromEuler(_e.set(0, t.ry, 0));
        im.setMatrixAt(i, _m.compose(_p, _q, _s));
        im.setColorAt(i, _c.setHex(tint));
        const r = 0.3 * t.s;
        addBox({ minX: t.x - r, maxX: t.x + r, minZ: t.z - r, maxZ: t.z + r, minY: t.y, maxY: t.y + (kind === 'olive' ? 2.2 : 6) * t.s }, 'tree', `hinnom-${kind}`);
      });
      im.computeBoundingSphere();
      im.castShadow = true;
      im.receiveShadow = true;
      group.add(im);
      instanced.push(im);
      stats[kind === 'olive' ? 'olives' : 'cypresses'] = list.length;
      stats.triangles += list.length * (geo.getAttribute('position').count / 3);
    }
  }

  return {
    group,
    material,
    stats,
    dispose() {
      collision?.removeGroup?.(COLLISION_GROUP);
      for (const o of group.children) if (!o.isInstancedMesh) o.geometry?.dispose();
      for (const im of instanced) im.dispose();
      material.dispose();
      group.removeFromParent();
    },
  };
}
