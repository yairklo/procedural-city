// Geometry helpers for the hand-built landmarks (flat-shaded, non-indexed triangles).
//
// Mesher collects triangles with explicit normals (each triangle is wound to face its
// normal) plus a per-vertex stone style, and turns them into one BufferGeometry.
//   aStone = (course height m, mean stone length m, style): 0 = plain ashlar,
//            1 = Herodian (drafted margins), 2 = roof / lead, 3 = wood, 4 = dark metal,
//            5 = foliage, 6 = paving, 7 = plain (openings: flat dark, no pattern),
//            8 = glazed tiles, 9 = gold leaf, 10 = marble panels
//   aLight = (height above the local ground m, night lighting profile), see LIGHT: filled in
//            by geometry(ground, profile); `mesher.light` overrides the profile for the
//            triangles that follow (null = the mesh's default).

import * as THREE from 'three';

/** Night lighting profiles (materials.js): how a landmark is floodlit. */
export const LIGHT = Object.freeze({ wash: 0, sodium: 1, white: 2, warm: 3, dark: 4, blue: 5, neon: 6 });

export const STYLE = Object.freeze({ ashlar: 0, herodian: 1, lead: 2, wood: 3, metal: 4, foliage: 5, paving: 6, plain: 7, tile: 8, gold: 9, marble: 10 });

export class Mesher {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.stone = [];
    this.lp = [];
    this.light = null;
    this.color = [1, 1, 1];
    this.style = [0.55, 1.2, STYLE.ashlar];
  }

  /** Sets the colour (sRGB hex) and stone style for the triangles that follow. */
  paint(hex, course = 0.55, length = 1.2, style = STYLE.ashlar) {
    const c = new THREE.Color(hex);
    this.color = [c.r, c.g, c.b];
    this.style = [course, length, style];
    return this;
  }

  tri(a, b, c, n) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    if (!n) {
      n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const l = Math.hypot(...n) || 1;
      n = [n[0] / l, n[1] / l, n[2] / l];
    } else if ((uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2] < 0) {
      [b, c] = [c, b];
    }
    this.pos.push(...a, ...b, ...c);
    for (let k = 0; k < 3; k++) {
      this.nrm.push(...n);
      this.col.push(...this.color);
      this.stone.push(...this.style);
      this.lp.push(this.light ?? -1);
    }
  }

  quad(a, b, c, d, n) {
    this.tri(a, b, c, n);
    this.tri(a, c, d, n);
  }

  /** A vertical wall quad from a to b (x, z), bottoms y0a/y0b, tops y1a/y1b, facing n. */
  wall(ax, az, bx, bz, y0a, y0b, y1a, y1b, n) {
    if (y1a - y0a < 1e-3 && y1b - y0b < 1e-3) return;
    this.quad([ax, y0a, az], [bx, y0b, bz], [bx, y1b, bz], [ax, y1a, az], n);
  }

  /** Axis-free box: centre (x, z), half sizes along the unit direction (ux, uz) and across it. */
  orientedBox(x, z, ux, uz, halfLen, halfWid, y0, y1, { top = true, bottom = false } = {}) {
    const px = -uz, pz = ux;
    const c = [
      [x - ux * halfLen - px * halfWid, z - uz * halfLen - pz * halfWid],
      [x + ux * halfLen - px * halfWid, z + uz * halfLen - pz * halfWid],
      [x + ux * halfLen + px * halfWid, z + uz * halfLen + pz * halfWid],
      [x - ux * halfLen + px * halfWid, z - uz * halfLen + pz * halfWid],
    ];
    this.prism(c.flat(), y0, y1, { top, bottom });
  }

  /** Extrudes a closed ring [x, z, ...] from y0 to y1 (walls outward, optional caps). */
  prism(ring, y0, y1, { top = true, bottom = false, topRing = null } = {}) {
    const n = ring.length / 2;
    const cw = signedArea(ring) < 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-4) continue;
      // Outward normal: right of the edge for a counter-clockwise ring (x east, z south).
      let nx = (bz - az) / len, nz = -(bx - ax) / len;
      if (cw) { nx = -nx; nz = -nz; }
      this.wall(ax, az, bx, bz, y0, y0, y1, y1, [nx, 0, nz]);
    }
    if (top) this.polygon([topRing ?? ring], y1, 1);
    if (bottom) this.polygon([ring], y0, -1);
  }

  /** Flat polygon (rings: outline + holes, [x, z, ...]) at height y, facing up (1) or down (-1). */
  polygon(rings, y, facing = 1) {
    const toV2 = (r) => {
      const out = [];
      for (let i = 0; i < r.length; i += 2) out.push(new THREE.Vector2(r[i], r[i + 1]));
      return out;
    };
    const contour = toV2(rings[0]);
    const holes = rings.slice(1).map(toV2);
    const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
    const all = [...contour, ...holes.flat()];
    for (const [a, b, c] of faces) {
      this.tri([all[a].x, y, all[a].y], [all[b].x, y, all[b].y], [all[c].x, y, all[c].y], [0, facing, 0]);
    }
  }

  /** Dome over a circle: radius r, springing at y, rise h, `seg` around, `rings` up. */
  dome(cx, cz, r, y, h, { seg = 20, rings = 6 } = {}) {
    const pt = (i, k) => {
      const a = (i / seg) * Math.PI * 2, t = (k / rings) * (Math.PI / 2);
      return [cx + Math.cos(a) * r * Math.cos(t), y + Math.sin(t) * h, cz + Math.sin(a) * r * Math.cos(t)];
    };
    for (let k = 0; k < rings; k++) {
      for (let i = 0; i < seg; i++) {
        const a = pt(i, k), b = pt(i + 1, k), c = pt(i + 1, k + 1), d = pt(i, k + 1);
        const mx = (a[0] + c[0]) / 2 - cx, my = ((a[1] + c[1]) / 2 - y) * (r / Math.max(h, 1e-3)), mz = (a[2] + c[2]) / 2 - cz;
        const l = Math.hypot(mx, my, mz) || 1;
        const n = [mx / l, my / l, mz / l];
        if (k === rings - 1) this.tri(a, b, c, n);
        else this.quad(a, b, c, d, n);
      }
    }
  }

  /** Pyramid over a ring from y to an apex at the centroid, height h (faces out and up, whatever the ring's winding). */
  pyramid(ring, y, h) {
    const c = ringCenter(ring);
    const apex = [c.x, y + h, c.z];
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = [ring[i * 2], y, ring[i * 2 + 1]], b = [ring[j * 2], y, ring[j * 2 + 1]];
      const ux = b[0] - a[0], uz = b[2] - a[2], vx = apex[0] - a[0], vy = apex[1] - a[1], vz = apex[2] - a[2];
      let nrm = [-uz * vy, uz * vx - ux * vz, ux * vy];
      if (nrm[1] < 0) nrm = nrm.map((v) => -v);
      const l = Math.hypot(...nrm) || 1;
      this.tri(a, b, apex, nrm.map((v) => v / l));
    }
  }

  /** Vertical cylinder (n-gon), optionally tapered. */
  cylinder(cx, cz, r0, r1, y0, y1, seg = 12, { top = true } = {}) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
      const p = (a, r, y) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      this.quad(p(a0, r0, y0), p(a1, r0, y0), p(a1, r1, y1), p(a0, r1, y1), [Math.cos(am), (r0 - r1) / Math.max(y1 - y0, 1e-3), Math.sin(am)]);
      if (top && r1 > 1e-3) this.tri([cx, y1, cz], p(a0, r1, y1), p(a1, r1, y1), [0, 1, 0]);
    }
  }

  get empty() {
    return this.pos.length === 0;
  }

  /**
   * @param {(x:number, z:number) => number} [ground]  for the floodlight falloff (height above it)
   * @param {number} [profile]  default night lighting profile (LIGHT)
   */
  geometry(ground = null, profile = LIGHT.wash) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aStone', new THREE.Float32BufferAttribute(this.stone, 3));
    const light = new Float32Array(this.lp.length * 2);
    for (let i = 0; i < this.lp.length; i++) {
      const x = this.pos[i * 3], y = this.pos[i * 3 + 1], z = this.pos[i * 3 + 2];
      light[i * 2] = ground ? Math.max(0, y - ground(x, z)) : 0;
      light[i * 2 + 1] = this.lp[i] >= 0 ? this.lp[i] : profile;
    }
    g.setAttribute('aLight', new THREE.Float32BufferAttribute(light, 2));
    g.computeBoundingSphere();
    return g;
  }
}

export function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) a += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
  return a / 2;
}

export function ringCenter(ring) {
  let x = 0, z = 0;
  const n = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return { x: x / n, z: z / n };
}

/** Mean distance from the centre to the vertices: the radius of a round part's outline. */
export function ringRadius(ring, c = ringCenter(ring)) {
  let s = 0;
  for (let i = 0; i < ring.length; i += 2) s += Math.hypot(ring[i] - c.x, ring[i + 1] - c.z);
  return s / (ring.length / 2);
}

/** Resamples a polyline [x, z, ...] into points at most `step` apart, with running distance. */
export function resample(points, step) {
  const out = [];
  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = points[i], az = points[i + 1], bx = points[i + 2], bz = points[i + 3];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  if (points.length >= 2) out.push([points[points.length - 2], points[points.length - 1]]);
  let d = 0;
  return out.map((p, i) => {
    if (i > 0) d += Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]);
    return { x: p[0], z: p[1], d };
  });
}
