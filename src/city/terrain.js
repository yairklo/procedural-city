// Terrain from the elevation data written by scripts/fetch_elevation.js.
//
// heightAt(x, z) returns the ground height in game meters (bicubic over the grid). By default
// the datum is the lowest sample, so the terrain is >= 0 (Catmull-Rom may dip marginally
// below near a minimum); add `datum` to get meters above sea level. Outside the heightmap the edge values are extended and, further out,
// eased toward the mean edge height, so the landscape doesn't end in a cliff.
// No three.js dependency.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** A flat terrain (no heightmap). */
export const FLAT_TERRAIN = Object.freeze({
  flat: true,
  datum: 0,
  minHeight: 0,
  maxHeight: 0,
  meanEdge: 0,
  heightAt: () => 0,
});

/**
 * Accepts either elevation format written by scripts/fetch_elevation.js:
 *   heightmap-v1   { bbox, width, height, values }: samples on the bbox corners, edges inclusive
 *   dem-points-v1  { lattice: {north, west, stepLatDeg, stepLonDeg}, width, height, values }:
 *                  exact DEM samples at pixel centres (control points, may extend past the bbox)
 * Both are row-major, row 0 = north, col 0 = west, and are interpolated with Catmull-Rom.
 *
 * @param {object} heightmap
 * @param {ReturnType<import('./geo.js').createProjection>} projection
 * @param {{ fadeDistance?: number, bakeSpacing?: number, datum?: number }} [options]
 *   fadeDistance: distance outside the grid over which heights ease to the mean edge height
 *   bakeSpacing: meters between samples of the pre-baked bicubic surface (default: grid step / 16, 2–6 m)
 *   datum: meters above sea level of game y = 0 (default: the lowest sample)
 */
export function createTerrain(heightmap, projection, { fadeDistance = 500, bakeSpacing = null, datum: datumOption = null } = {}) {
  const { width: W, height: H, values } = heightmap;
  if (!(W >= 2 && H >= 2) || values?.length !== W * H) throw new Error('createTerrain: malformed heightmap');
  const lattice = heightmap.lattice ?? {
    north: heightmap.bbox.north,
    west: heightmap.bbox.west,
    stepLatDeg: (heightmap.bbox.north - heightmap.bbox.south) / (H - 1),
    stepLonDeg: (heightmap.bbox.east - heightmap.bbox.west) / (W - 1),
  };
  const bbox = {
    north: lattice.north,
    west: lattice.west,
    south: lattice.north - (H - 1) * lattice.stepLatDeg,
    east: lattice.west + (W - 1) * lattice.stepLonDeg,
  };

  let min = Infinity, max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const datum = datumOption ?? min;
  const grid = Float32Array.from(values, (v) => v - datum);

  let edgeSum = 0, edgeCount = 0;
  for (let c = 0; c < W; c++) { edgeSum += grid[c] + grid[(H - 1) * W + c]; edgeCount += 2; }
  for (let r = 1; r < H - 1; r++) { edgeSum += grid[r * W] + grid[r * W + W - 1]; edgeCount += 2; }
  const meanEdge = edgeSum / edgeCount;

  // Grid corners in game space (the projection is linear in lat / lon, so the grid is axis-aligned).
  const nw = projection.project(bbox.north, bbox.west);
  const se = projection.project(bbox.south, bbox.east);
  const x0 = nw.x, z0 = nw.z;
  if (bakeSpacing == null) {
    const step = Math.min((se.x - nw.x) / (W - 1), (se.z - nw.z) / (H - 1));
    bakeSpacing = clamp(step / 16, 2, 6);
  }

  // Bicubic (Catmull-Rom) interpolation: the slope is continuous across grid cells, so the
  // ground has no creases along the grid lines (bilinear leaves visible facets).
  const at = (c, r) => grid[clamp(r, 0, H - 1) * W + clamp(c, 0, W - 1)];
  const cr = (p0, p1, p2, p3, t) =>
    p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));

  function bicubic(fc, fr) {
    const c = Math.min(W - 2, Math.floor(fc)), r = Math.min(H - 2, Math.floor(fr));
    const tx = fc - c, tz = fr - r;
    const row = (rr) => cr(at(c - 1, rr), at(c, rr), at(c + 1, rr), at(c + 2, rr), tx);
    return cr(row(r - 1), row(r), row(r + 1), row(r + 2), tz);
  }

  // heightAt() is called millions of times while building the city, so the bicubic surface is
  // baked once into a fine grid (~bakeSpacing meters) and then read bilinearly. At a few
  // meters per cell that is indistinguishable from evaluating the bicubic directly.
  const BW = Math.max(2, Math.ceil(Math.abs(se.x - nw.x) / bakeSpacing) + 1);
  const BH = Math.max(2, Math.ceil(Math.abs(se.z - nw.z) / bakeSpacing) + 1);
  const baked = new Float32Array(BW * BH);
  for (let r = 0; r < BH; r++) {
    for (let c = 0; c < BW; c++) baked[r * BW + c] = bicubic((c / (BW - 1)) * (W - 1), (r / (BH - 1)) * (H - 1));
  }
  const bdx = (se.x - nw.x) / (BW - 1), bdz = (se.z - nw.z) / (BH - 1);

  function sample(x, z) {
    const fc = clamp((x - x0) / bdx, 0, BW - 1);
    const fr = clamp((z - z0) / bdz, 0, BH - 1);
    const c = Math.min(BW - 2, fc | 0), r = Math.min(BH - 2, fr | 0);
    const tx = fc - c, tz = fr - r;
    const i = r * BW + c;
    const a = baked[i] + (baked[i + 1] - baked[i]) * tx;
    const b = baked[i + BW] + (baked[i + BW + 1] - baked[i + BW]) * tx;
    return a + (b - a) * tz;
  }

  function heightAt(x, z) {
    const h = sample(x, z);
    const ox = Math.max(x0 - x, x - se.x, 0), oz = Math.max(z0 - z, z - se.z, 0);
    if (ox === 0 && oz === 0) return h;
    return h + (meanEdge - h) * smoothstep(0, fadeDistance, Math.hypot(ox, oz));
  }

  return {
    flat: false,
    datum,
    minHeight: min - datum,
    maxHeight: max - datum,
    meanEdge,
    bounds: { minX: x0, maxX: se.x, minZ: z0, maxZ: se.z },
    source: { name: heightmap.source, license: heightmap.license, attribution: heightmap.attribution },
    heightAt,
  };
}

/** Lowest / highest terrain under a footprint (ring vertices plus a few interior samples). */
export function footprintGround(terrain, rings, centroid) {
  let lo = Infinity, hi = -Infinity;
  const visit = (x, z) => {
    const h = terrain.heightAt(x, z);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  };
  for (const r of rings) for (let i = 0; i < r.length; i += 2) visit(r[i], r[i + 1]);
  visit(centroid.x, centroid.z);
  return { min: lo, max: hi };
}
