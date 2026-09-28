// Terrain from the elevation heightmap written by scripts/fetch_elevation.js.
//
// heightAt(x, z) returns the ground height in game meters (bilinear over the grid). The
// datum is the lowest sample, so the terrain is always >= 0; add `datum` to get meters
// above sea level. Outside the heightmap the edge values are extended and, further out,
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
 * @param {object} heightmap  JSON with { bbox, width, height, values } (row 0 = north, col 0 = west,
 *                            samples on cell corners, edges inclusive)
 * @param {ReturnType<import('./geo.js').createProjection>} projection
 * @param {{ fadeDistance?: number }} [options]  distance outside the grid over which heights ease to the mean edge height
 */
export function createTerrain(heightmap, projection, { fadeDistance = 500 } = {}) {
  const { width: W, height: H, values, bbox } = heightmap;
  if (!(W >= 2 && H >= 2) || values?.length !== W * H) throw new Error('createTerrain: malformed heightmap');

  let min = Infinity, max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const datum = min;
  const grid = Float32Array.from(values, (v) => v - datum);

  let edgeSum = 0, edgeCount = 0;
  for (let c = 0; c < W; c++) { edgeSum += grid[c] + grid[(H - 1) * W + c]; edgeCount += 2; }
  for (let r = 1; r < H - 1; r++) { edgeSum += grid[r * W] + grid[r * W + W - 1]; edgeCount += 2; }
  const meanEdge = edgeSum / edgeCount;

  // Grid corners in game space (the projection is linear in lat / lon, so the grid is axis-aligned).
  const nw = projection.project(bbox.north, bbox.west);
  const se = projection.project(bbox.south, bbox.east);
  const x0 = nw.x, z0 = nw.z, dx = (se.x - nw.x) / (W - 1), dz = (se.z - nw.z) / (H - 1);

  function sample(x, z) {
    const fc = clamp((x - x0) / dx, 0, W - 1);
    const fr = clamp((z - z0) / dz, 0, H - 1);
    const c = Math.min(W - 2, Math.floor(fc)), r = Math.min(H - 2, Math.floor(fr));
    const tx = fc - c, tz = fr - r;
    const i = r * W + c;
    const a = grid[i] + (grid[i + 1] - grid[i]) * tx;
    const b = grid[i + W] + (grid[i + W + 1] - grid[i + W]) * tx;
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
    minHeight: 0,
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
