// "Footfall": a coarse map of how busy the ground is with people on foot, painted from the
// road data into one channel of the world's ground-mask texture. The ground and paving
// shaders polish the stone where it is high (smoother, slightly darker slabs that catch the
// low sun) and leave quiet lanes rough and dusty.
//
// Weights by highway class: pedestrian malls and squares are the busiest, then footways and
// living streets, then the sidewalks of the main streets; quiet residential streets and
// service roads get little. Each road is splatted along its length with a soft falloff
// (~1.5 texels), and the maximum is kept, so it is order-independent. No three.js dependency.

import { pointInRings } from './footprint.js';

export const FOOTFALL_WEIGHT = Object.freeze({
  pedestrian: 1,
  footway: 0.8,
  living_street: 0.8,
  steps: 0.6,
  path: 0.45,
  primary: 0.6,
  secondary: 0.55,
  tertiary: 0.5,
  unclassified: 0.35,
  residential: 0.3,
  service: 0.15,
});

/**
 * @param {Uint8Array} data  RGBA texels, w x h, row 0 at rect.minZ
 * @param {number} w
 * @param {number} h
 * @param {{minX:number,minZ:number,maxX:number,maxZ:number}} rect
 * @param {object[]} roads  { highway, points?: [x, z, ...], rings?: [[x, z, ...]] }
 * @param {number} [channel]  0..3 (default 1: green)
 * @returns {number} texels changed
 */
export function paintFootfall(data, w, h, rect, roads, channel = 1) {
  const sx = w / (rect.maxX - rect.minX), sz = h / (rect.maxZ - rect.minZ);
  let changed = 0;
  const put = (tx, ty, v) => {
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return;
    const i = (ty * w + tx) * 4 + channel;
    const q = Math.round(v * 255);
    if (q > data[i]) { data[i] = q; changed++; }
  };
  const splat = (x, z, weight) => {
    const fx = (x - rect.minX) * sx - 0.5, fz = (z - rect.minZ) * sz - 0.5;
    const cx = Math.round(fx), cz = Math.round(fz);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d = Math.hypot(cx + dx - fx, cz + dz - fz);
        if (d < 2) put(cx + dx, cz + dz, weight * (1 - (d / 2) ** 2));
      }
    }
  };
  const step = 0.5 / Math.max(sx, sz); // half a texel
  for (const r of roads) {
    const weight = FOOTFALL_WEIGHT[r.highway] ?? 0.2;
    if (r.points) {
      const p = r.points;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
        const n = Math.max(1, Math.ceil(len / step));
        for (let k = 0; k <= n; k++) splat(p[i] + ((p[i + 2] - p[i]) * k) / n, p[i + 1] + ((p[i + 3] - p[i + 1]) * k) / n, weight);
      }
    } else if (r.rings?.[0]) {
      // Squares and pedestrian areas: fill the outline.
      const ring = r.rings[0];
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]);
        minZ = Math.min(minZ, ring[i + 1]); maxZ = Math.max(maxZ, ring[i + 1]);
      }
      for (let ty = Math.floor((minZ - rect.minZ) * sz); ty <= Math.ceil((maxZ - rect.minZ) * sz); ty++) {
        for (let tx = Math.floor((minX - rect.minX) * sx); tx <= Math.ceil((maxX - rect.minX) * sx); tx++) {
          const x = rect.minX + (tx + 0.5) / sx, z = rect.minZ + (ty + 0.5) / sz;
          if (pointInRings(r.rings, x, z)) put(tx, ty, weight);
        }
      }
      for (let i = 0; i < ring.length; i += 2) splat(ring[i], ring[i + 1], weight * 0.8);
    }
  }
  return changed;
}
