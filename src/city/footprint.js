// 2D polygon helpers for real building footprints.
//
// A footprint is an array of rings; ring 0 is the outline, the rest are holes
// (courtyards). Each ring is a flat [x0, z0, x1, z1, ...] array in meters, not closed
// (the last point does not repeat the first). No three.js dependency.

const EPS = 1e-9;

/** Signed shoelace area on the XZ plane. */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    a += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
  }
  return a / 2;
}

/** Area of a footprint (outline minus holes). */
export function footprintArea(rings) {
  let a = Math.abs(ringArea(rings[0]));
  for (let i = 1; i < rings.length; i++) a -= Math.abs(ringArea(rings[i]));
  return Math.max(0, a);
}

/**
 * Drops repeated / near-duplicate points and a closing point equal to the first.
 * Returns null if fewer than 3 points or no area remain.
 */
export function cleanRing(ring, minDist = 0.05) {
  const out = [];
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i], z = ring[i + 1];
    const n = out.length;
    if (n && Math.hypot(x - out[n - 2], z - out[n - 1]) < minDist) continue;
    out.push(x, z);
  }
  while (out.length >= 4 && Math.hypot(out[0] - out[out.length - 2], out[1] - out[out.length - 1]) < minDist) out.length -= 2;
  if (out.length < 6 || Math.abs(ringArea(out)) < 0.5) return null;
  return out;
}

/** Reverses a flat ring in place order (returns a new array). */
export function reverseRing(ring) {
  const out = new Array(ring.length);
  for (let i = 0, j = ring.length - 2; i < ring.length; i += 2, j -= 2) {
    out[i] = ring[j];
    out[i + 1] = ring[j + 1];
  }
  return out;
}

/**
 * Normalizes winding so the outline has positive signed area and holes negative.
 * With that convention the solid is always on the same side of every edge, so wall
 * normals can be computed with one formula.
 */
export function orientRings(rings) {
  return rings.map((r, i) => ((ringArea(r) > 0) === (i === 0) ? r : reverseRing(r)));
}

export function ringsBounds(rings) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < minX) minX = r[i];
      if (r[i] > maxX) maxX = r[i];
      if (r[i + 1] < minZ) minZ = r[i + 1];
      if (r[i + 1] > maxZ) maxZ = r[i + 1];
    }
  }
  return { minX, minZ, maxX, maxZ };
}

/** Area-weighted centroid of the outline. */
export function ringCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const f = ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
    a += f;
    cx += (ring[j] + ring[i]) * f;
    cz += (ring[j + 1] + ring[i + 1]) * f;
  }
  if (Math.abs(a) < EPS) return { x: ring[0], z: ring[1] };
  return { x: cx / (3 * a), z: cz / (3 * a) };
}

/** Even-odd point-in-footprint test (holes excluded). */
export function pointInRings(rings, x, z) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const zi = r[i + 1], zj = r[j + 1];
      if (zi > z !== zj > z && x < ((r[j] - r[i]) * (z - zi)) / (zj - zi) + r[i]) inside = !inside;
    }
  }
  return inside;
}

/** Distance from a point to a segment. */
export function segmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > EPS ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Distance from a point to the nearest footprint edge (outline or hole). */
export function distanceToEdges(rings, x, z) {
  let best = Infinity;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const d = segmentDistance(x, z, r[j], r[j + 1], r[i], r[i + 1]);
      if (d < best) best = d;
    }
  }
  return best;
}

/** True when a disc of radius `r` at (x, z) lies fully inside the footprint. */
export function discInside(rings, x, z, r) {
  return pointInRings(rings, x, z) && distanceToEdges(rings, x, z) >= r;
}

/** Sorted crossings of the footprint's edges with the line (axis u) = c; returns v values. */
function scanline(rings, c, uIdx, out) {
  out.length = 0;
  const vIdx = 1 - uIdx;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const ui = r[i + uIdx], uj = r[j + uIdx];
      if (ui > c !== uj > c) {
        const t = (c - ui) / (uj - ui);
        out.push(r[i + vIdx] + t * (r[j + vIdx] - r[i + vIdx]));
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

function stripBoxes(rings, bounds, step, uIdx, mergeTol) {
  const u0 = uIdx === 0 ? bounds.minX : bounds.minZ;
  const u1 = uIdx === 0 ? bounds.maxX : bounds.maxZ;
  const n = Math.max(1, Math.ceil((u1 - u0) / step - 1e-6));
  const w = (u1 - u0) / n;
  const boxes = [];
  let open = [];
  const hits = [];

  for (let s = 0; s < n; s++) {
    const a = u0 + s * w, b = s === n - 1 ? u1 : a + w;
    scanline(rings, (a + b) / 2, uIdx, hits);
    const spans = [];
    for (let k = 0; k + 1 < hits.length; k += 2) if (hits[k + 1] - hits[k] > 0.05) spans.push(hits[k], hits[k + 1]);

    // Extend the previous strip's boxes when the cross-section is (almost) unchanged.
    let same = open.length * 2 === spans.length;
    for (let k = 0; same && k < open.length; k++) {
      same = Math.abs(open[k].v0 - spans[2 * k]) <= mergeTol && Math.abs(open[k].v1 - spans[2 * k + 1]) <= mergeTol;
    }
    if (same) {
      for (let k = 0; k < open.length; k++) {
        open[k].u1 = b;
        open[k].v0 = Math.min(open[k].v0, spans[2 * k]);
        open[k].v1 = Math.max(open[k].v1, spans[2 * k + 1]);
      }
    } else {
      boxes.push(...open);
      open = [];
      for (let k = 0; k < spans.length; k += 2) open.push({ u0: a, u1: b, v0: spans[k], v1: spans[k + 1] });
    }
  }
  boxes.push(...open);
  return boxes.map((q) =>
    uIdx === 0 ? { minX: q.u0, maxX: q.u1, minZ: q.v0, maxZ: q.v1 } : { minX: q.v0, maxX: q.v1, minZ: q.u0, maxZ: q.u1 },
  );
}

/**
 * Approximates a footprint (any shape, any orientation, with holes) by a set of
 * axis-aligned rectangles for the AABB collision world.
 *
 * The footprint is cut into strips `step` meters wide along X or Z (whichever gives
 * fewer boxes); each strip holds one box per interval its center line spends inside
 * the polygon, and consecutive strips with the same cross-section are merged. Axis-
 * aligned rectangles therefore become a single box, and any wall is matched to within
 * step / 2 (measured perpendicular to the wall).
 */
export function decomposeFootprint(rings, { step = 0.6, mergeTol = 0.04 } = {}) {
  const bounds = ringsBounds(rings);
  const alongX = stripBoxes(rings, bounds, step, 0, mergeTol);
  if (alongX.length <= 1) return alongX;
  const alongZ = stripBoxes(rings, bounds, step, 1, mergeTol);
  return alongZ.length < alongX.length ? alongZ : alongX;
}

/**
 * Minimum-area oriented rectangle around a ring, tested against each edge direction.
 * Returns center, unit long axis (ax, az), and half length / half width (hl >= hw).
 */
export function orientedBox(ring) {
  let best = null;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const dx = ring[i] - ring[j], dz = ring[i + 1] - ring[j + 1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const ux = dx / len, uz = dz / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let k = 0; k < ring.length; k += 2) {
      const u = ring[k] * ux + ring[k + 1] * uz, v = -ring[k] * uz + ring[k + 1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      best = { area, cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ux, uz, hu: (maxU - minU) / 2, hv: (maxV - minV) / 2 };
    }
  }
  if (!best) return null;
  // Long axis first.
  const long = best.hu >= best.hv;
  return {
    cx: best.cx, cz: best.cz,
    ax: long ? best.ux : -best.uz, az: long ? best.uz : best.ux,
    hl: long ? best.hu : best.hv, hw: long ? best.hv : best.hu,
    area: best.area,
  };
}
