// Tile ownership rules, shared by the data pipeline (scripts/fetch_tiles.js) and the game
// (src/world/TileWorld.js), so both always agree on which tile / cell owns a feature.
//
// Tile bounds are half-open: [south, north) x [west, east).
//   buildings, road areas, parks: the tile containing the VERTEX AVERAGE of the outer ring
//                                 (as stored: flat [lat, lon, ...], no duplicated closing point)
//   roads: cut at tile borders (Liang-Barsky per segment, a new vertex on the border); a piece
//          lying exactly on a border goes to the tile containing its midpoint
//   trees: the tile containing the point
//
// Pure functions on lat / lon, no dependencies.

/** Rounds to 7 decimals (~1 cm), like the coordinates in the data files. */
export const r7 = (v) => Math.round(v * 1e7) / 1e7;

/** Tile (i, j) bounds on a grid { south, west, dLat, dLon }, rounded like the data files. */
export function gridCellBBox(grid, i, j) {
  return {
    south: r7(grid.south + j * grid.dLat),
    west: r7(grid.west + i * grid.dLon),
    north: r7(grid.south + (j + 1) * grid.dLat),
    east: r7(grid.west + (i + 1) * grid.dLon),
  };
}

/** Half-open containment: [south, north) x [west, east). */
export const inBBox = (b, lat, lon) => lat >= b.south && lat < b.north && lon >= b.west && lon < b.east;

/** Vertex average of a flat [lat, lon, ...] ring (no duplicated closing point). */
export function ringVertexAverage(ring) {
  let lat = 0, lon = 0;
  for (let k = 0; k < ring.length; k += 2) {
    lat += ring[k];
    lon += ring[k + 1];
  }
  const n = ring.length / 2;
  return { lat: lat / n, lon: lon / n };
}

/**
 * The grid cell (i, j) owning a point, with the exact half-open bounds of gridCellBBox (the
 * floor() guess is corrected by one cell when rounding puts the point across a border).
 */
export function gridCellOf(grid, lat, lon) {
  let i = Math.floor((lon - grid.west) / grid.dLon), j = Math.floor((lat - grid.south) / grid.dLat);
  for (let tries = 0; tries < 4; tries++) {
    const b = gridCellBBox(grid, i, j);
    if (lon < b.west) i--;
    else if (lon >= b.east) i++;
    else if (lat < b.south) j--;
    else if (lat >= b.north) j++;
    else break;
  }
  return { i, j };
}

/** Liang-Barsky: the [t0, t1] part of segment a->b inside the rectangle, or null. */
export function clipSegment(aLat, aLon, bLat, bLon, b) {
  let t0 = 0, t1 = 1;
  const dLat = bLat - aLat, dLon = bLon - aLon;
  for (const [p, q] of [[-dLon, aLon - b.west], [dLon, b.east - aLon], [-dLat, aLat - b.south], [dLat, b.north - aLat]]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
  }
  return t1 > t0 ? [t0, t1] : null;
}

/**
 * Cuts a flat [lat, lon, ...] polyline at the tile border and returns the runs inside it.
 * Border crossings become new vertices, so the pieces of neighbouring tiles meet exactly
 * and no piece extends outside its tile. A piece lying exactly on a border goes to the
 * tile containing its midpoint (half-open bounds), so nothing is duplicated.
 */
export function ownedRuns(points, b) {
  const EPS = 1e-9;
  const runs = [];
  let run = null;
  for (let k = 0; k + 3 < points.length; k += 2) {
    const aLat = points[k], aLon = points[k + 1], bLat = points[k + 2], bLon = points[k + 3];
    const c = clipSegment(aLat, aLon, bLat, bLon, b);
    const at = (t) => [r7(aLat + (bLat - aLat) * t), r7(aLon + (bLon - aLon) * t)];
    const mid = c && at((c[0] + c[1]) / 2);
    if (!c || !inBBox(b, mid[0], mid[1])) {
      if (run) { runs.push(run); run = null; }
      continue;
    }
    if (run && c[0] > EPS) { runs.push(run); run = null; } // re-entered the tile mid-segment
    if (!run) run = at(c[0]);
    run.push(...at(c[1]));
    if (c[1] < 1 - EPS) { runs.push(run); run = null; } // left the tile
  }
  if (run) runs.push(run);
  return runs;
}
