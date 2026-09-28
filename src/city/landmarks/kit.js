// Shared building kit for the hand-built landmarks: pointed arches, arcades, windows, domes,
// finials and surfaces of revolution, all written into a Mesher (geometry.js) with the
// landmark material's styles, plus stepped collision boxes for domes.
//
//   const k = createKit(mesher, { addBox, quadBox });
//   k.arcadeScreen(...); k.revolve(cx, cz, k.domeProfile(r, y, h)); k.finial(x, y, z);

import * as THREE from 'three';
import { STYLE } from './geometry.js';

export const KIT_COLORS = Object.freeze({
  stone: 0xd6ccb8,
  stoneOld: 0xc9bea8,
  opening: 0x24211d,
  gold: 0xd9a441,
});

export const hash = (a, b = 0) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Nearest intersection (t > 0) of the ray (x, z) + t (dx, dz) with a closed ring, or null. */
export function rayRing(ring, x, z, dx, dz) {
  let best = null;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[j], az = ring[j + 1], bx = ring[i], bz = ring[i + 1];
    const ex = bx - ax, ez = bz - az;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - x) * ez - (az - z) * ex) / den;
    const u = ((ax - x) * dz - (az - z) * dx) / den;
    if (t > 1e-6 && u >= 0 && u <= 1 && (best === null || t < best)) best = t;
  }
  return best;
}

/** Points along a pointed arch over [sL, sR] springing at ys (apex included), left to right. */
export function pointedArch(sL, sR, ys, k = 8) {
  const w = sR - sL, R = w * 0.8, mid = (sL + sR) / 2;
  const out = [];
  for (let i = 1; i < k; i++) {
    const x = sL + (w * i) / k;
    const c = x <= mid ? sL + R : sR - R;
    out.push([x, ys + Math.sqrt(Math.max(0, R * R - (x - c) ** 2))]);
  }
  return out;
}
export const archRise = (w) => Math.sqrt((0.8 * w) ** 2 - (0.3 * w) ** 2);

/** Outline (counter-clockwise, y up) of a pointed-arch opening w wide, apex at `apex`. */
export function archOutline(w, apex) {
  const ys = apex - archRise(w);
  const arc = pointedArch(-w / 2, w / 2, ys).reverse();
  return [[-w / 2, 0], [w / 2, 0], [w / 2, ys], ...arc, [-w / 2, ys]];
}

/**
 * @param {import('./geometry.js').Mesher} m
 * @param {{ addBox: Function, quadBox: Function }} ctx  collision helpers (LandmarkLayer)
 */
export function createKit(m, { addBox, quadBox }) {
  const C = KIT_COLORS;

  /** A flat 2D outline [[s, y], ...] (counter-clockwise) placed on a vertical plane. */
  const face = (pts, ox, oy, oz, ux, uz, nx, nz) => {
    const contour = pts.map(([s, y]) => new THREE.Vector2(s, y));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const P = (i) => [ox + ux * pts[i][0], oy + pts[i][1], oz + uz * pts[i][0]];
    for (const [a, b, c] of tris) m.tri(P(a), P(b), P(c), [nx, 0, nz]);
  };

  /** Extrudes a 2D outline (counter-clockwise, y up) `thick` m deep, centred on the plane. */
  const slab = (pts, ox, oy, oz, ux, uz, nx, nz, thick) => {
    const h = thick / 2;
    face(pts, ox + nx * h, oy, oz + nz * h, ux, uz, nx, nz);
    face(pts, ox - nx * h, oy, oz - nz * h, ux, uz, -nx, -nz);
    const P = ([s, y], d) => [ox + ux * s + nx * d, oy + y, oz + uz * s + nz * d];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const ds = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(ds, dy);
      if (l < 1e-5) continue;
      const es = dy / l, ey = -ds / l; // outward for a counter-clockwise outline
      m.quad(P(p, h), P(q, h), P(q, -h), P(p, -h), [ux * es, ey, uz * es]);
    }
  };

  /** Dark pointed-arch opening drawn 2 cm in front of a face. */
  const window_ = (cx, y0, cz, ux, uz, nx, nz, w, apex) => {
    m.paint(C.opening, 1, 1, STYLE.plain);
    face(archOutline(w, apex), cx + nx * 0.02, y0, cz + nz * 0.02, ux, uz, nx, nz);
  };

  /** Surface of revolution: profile [[r, y], ...] from bottom to top around (cx, cz). */
  const revolve = (cx, cz, profile, seg = 24) => {
    for (let k = 0; k + 1 < profile.length; k++) {
      const [r0, y0] = profile[k], [r1, y1] = profile[k + 1];
      const dr = r1 - r0, dy = y1 - y0, l = Math.hypot(dr, dy) || 1;
      const nr = dy / l, ny = -dr / l;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
        const p = (a, r, y) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
        const n = [Math.cos(am) * nr, ny, Math.sin(am) * nr];
        if (r1 < 1e-4) m.tri(p(a0, r0, y0), p(a1, r0, y0), p(am, 0, y1), n);
        else m.quad(p(a0, r0, y0), p(a1, r0, y0), p(a1, r1, y1), p(a0, r1, y1), n);
      }
    }
  };

  /** Dome profile: radius r, rise h from y; `point` > 0 sharpens the top (0 = hemisphere). */
  const domeProfile = (r, y, h, point = 0, n = 10) => {
    const out = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n, a = t * (Math.PI / 2);
      out.push([r * Math.cos(a) * (1 - point * t * t), y + h * Math.sin(a) ** (1 - point * 0.5)]);
    }
    out[n][0] = 0;
    return out;
  };

  /** Stepped collision boxes for a dome (so it can be landed on). */
  const domeBoxes = (cx, cz, r, y, h, ref) => {
    for (const [f0, f1] of [[0, 0.45], [0.45, 0.75], [0.75, 0.95]]) {
      const half = r * Math.cos(Math.asin(f1)) * 0.75;
      addBox({ minX: cx - half, maxX: cx + half, minZ: cz - half, maxZ: cz + half, minY: y + h * f0, maxY: y + h * f1 }, 'building', ref);
    }
  };

  /** Rod, two knobs and a crescent on top of a dome. */
  const finial = (x, y, z, s = 1, ux = 1, uz = 0) => {
    m.paint(C.gold, 1, 1, STYLE.gold);
    m.cylinder(x, z, 0.08 * s, 0.08 * s, y, y + 2.2 * s, 6);
    revolve(x, z, domeProfile(0.28 * s, y + 0.5 * s, 0.28 * s), 8);
    revolve(x, z, [[0.001, y + 0.22 * s], [0.28 * s, y + 0.5 * s]], 8);
    revolve(x, z, domeProfile(0.2 * s, y + 1.2 * s, 0.2 * s), 8);
    revolve(x, z, [[0.001, y + 1.0 * s], [0.2 * s, y + 1.2 * s]], 8);
    // Crescent opening upward, in the plane of (ux, uz).
    const cy = y + 2.25 * s + 0.35 * s;
    for (let k = 0; k < 9; k++) {
      const a = Math.PI * 0.15 + (k / 8) * Math.PI * 0.7 + Math.PI;
      const a2 = Math.PI * 0.15 + ((k + 1) / 8) * Math.PI * 0.7 + Math.PI;
      const r = 0.42 * s;
      const px = x + ux * Math.cos(a) * r, py = cy + Math.sin(a) * r, pz = z + uz * Math.cos(a) * r;
      const qx = x + ux * Math.cos(a2) * r, qy = cy + Math.sin(a2) * r, qz = z + uz * Math.cos(a2) * r;
      if (k < 8) m.orientedBox((px + qx) / 2, (pz + qz) / 2, ux || 1e-6, uz, Math.max(0.03, Math.abs((qx - px) * ux + (qz - pz) * uz) / 2 + 0.03), 0.03, Math.min(py, qy) - 0.04, Math.max(py, qy) + 0.04);
    }
  };

  /**
   * A screen of `bays` pointed arches, L long and H high, centred at (cx, cz), along (ux, uz).
   * Piers `pier` wide at the ends, `col` between the bays. Collision: the piers and the beam.
   */
  const arcadeScreen = (cx, y0, cz, ux, uz, L, H, bays, { pier = 0.9, col = 0.55, thick = 0.9, style = [C.stone, 0.5, 1.0, STYLE.ashlar], ref = 'arcade' } = {}) => {
    const nx = -uz, nz = ux;
    const w = (L - 2 * pier - (bays - 1) * col) / bays;
    const rise = archRise(w);
    const ys = Math.max(1.8, H - 0.7 - rise);
    const pts = [[-L / 2, 0]];
    const cols = [];
    let s = -L / 2 + pier;
    for (let b = 0; b < bays; b++) {
      const sL = s, sR = s + w;
      pts.push([sL, 0], [sL, ys], ...pointedArch(sL, sR, ys), [sR, ys], [sR, 0]);
      s = sR + (b < bays - 1 ? col : 0);
      cols.push([sL, sR]);
    }
    pts.push([L / 2, 0], [L / 2, H], [-L / 2, H]);
    m.paint(...style);
    slab(pts, cx, y0, cz, ux, uz, nx, nz, thick);
    // Cornice along the top.
    m.paint(C.stoneOld, 0.4, 0.8, STYLE.ashlar);
    m.orientedBox(cx, cz, ux, uz, L / 2 + 0.15, thick / 2 + 0.15, y0 + H, y0 + H + 0.35);
    // Collision: piers between the openings, the beam above them.
    let prev = -L / 2;
    for (const [sL, sR] of cols) {
      const a = prev, b = sL;
      const q = (t, d) => [cx + ux * t + nx * d, cz + uz * t + nz * d];
      quadBox([...q(a, -thick / 2), ...q(b, -thick / 2), ...q(b, thick / 2), ...q(a, thick / 2)], y0, y0 + H + 0.35, 'wall', ref);
      prev = sR;
    }
    const q = (t, d) => [cx + ux * t + nx * d, cz + uz * t + nz * d];
    quadBox([...q(prev, -thick / 2), ...q(L / 2, -thick / 2), ...q(L / 2, thick / 2), ...q(prev, thick / 2)], y0, y0 + H + 0.35, 'wall', ref);
    quadBox([...q(-L / 2, -thick / 2), ...q(L / 2, -thick / 2), ...q(L / 2, thick / 2), ...q(-L / 2, thick / 2)], y0 + ys + rise, y0 + H + 0.35, 'wall', ref);
    return { ys, rise };
  };

  /**
   * A tapered prism (n-gon) from point a to point b ([x, y, z]), radii r0 -> r1: leaning
   * masts, struts, cables. `rot` turns the section around the axis (radians).
   */
  const tube = (a, b, r0, r1, seg = 6, { rot = 0, caps = true } = {}) => {
    const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
    const len = Math.hypot(ax, ay, az);
    if (len < 1e-6) return;
    const d = [ax / len, ay / len, az / len];
    // A frame around the axis.
    const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let u = [d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]];
    const ul = Math.hypot(...u);
    u = u.map((v) => v / ul);
    const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    const ring = (c, r, k) => {
      const t = (k / seg) * Math.PI * 2 + rot;
      const cs = Math.cos(t), sn = Math.sin(t);
      return [c[0] + (u[0] * cs + v[0] * sn) * r, c[1] + (u[1] * cs + v[1] * sn) * r, c[2] + (u[2] * cs + v[2] * sn) * r];
    };
    for (let k = 0; k < seg; k++) {
      const tm = ((k + 0.5) / seg) * Math.PI * 2 + rot;
      const n = [u[0] * Math.cos(tm) + v[0] * Math.sin(tm), u[1] * Math.cos(tm) + v[1] * Math.sin(tm), u[2] * Math.cos(tm) + v[2] * Math.sin(tm)];
      m.quad(ring(a, r0, k), ring(a, r0, k + 1), ring(b, r1, k + 1), ring(b, r1, k), n);
      if (caps) {
        if (r1 > 1e-4) m.tri(b, ring(b, r1, k), ring(b, r1, k + 1), d);
        if (r0 > 1e-4) m.tri(a, ring(a, r0, k + 1), ring(a, r0, k), [-d[0], -d[1], -d[2]]);
      }
    }
  };

  return { face, slab, window: window_, revolve, domeProfile, domeBoxes, finial, arcadeScreen, tube };
}
