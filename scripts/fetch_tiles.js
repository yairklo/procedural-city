#!/usr/bin/env node
// Tiled OSM ingestion for a streamed Jerusalem world.
//
// The world is cut into a fixed grid of tiles (~556 x 568 m). Each tile is fetched and
// converted on its own and saved as public/data/tiles/osm_<i>_<j>.json in the same
// `osm-city-v1` format as jerusalem_data.json, so any tile can be loaded independently and
// new areas are added by fetching more tiles without touching existing ones.
// public/data/tiles/manifest.json lists every tile that exists.
//
//   node scripts/fetch_tiles.js --phase 1            # fetch missing tiles of phase 1
//   node scripts/fetch_tiles.js --tiles 0_0,1_0      # specific tiles
//   node scripts/fetch_tiles.js --phase 1 --force    # refetch even if the file exists
//
// Ownership (no duplicates across tiles; tile bounds are half-open [south, north) x [west, east)):
//   buildings, road areas, parks: the tile containing the centroid of the outer ring
//   roads: split per segment; a segment belongs to the tile containing its midpoint, so
//          neighbouring tiles' runs meet exactly at a shared vertex
//   trees: the tile containing the point
//   places (neighbourhood names): deduplicated into the manifest, not stored per tile
//
// Data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0).

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildQuery, convertOverpass } from './fetch_jerusalem.js';
import { gridCellBBox, inBBox, ringVertexAverage, ownedRuns } from '../src/city/tiling.js';

/** Tile (i, j) covers lon [west + i*dLon, +dLon) and lat [south + j*dLat, +dLat). i grows east, j grows north. */
export const TILE_GRID = Object.freeze({ south: 31.765, west: 35.205, dLat: 0.005, dLon: 0.006 });

/**
 * The full planned world. Its centre is the projection origin for every phase:
 * createProjection(WORLD_BBOX) from src/city/geo.js gives stable game coordinates, so
 * adding tiles later never moves what is already placed.
 */
export const WORLD_BBOX = Object.freeze({ south: 31.765, west: 35.205, north: 31.79, east: 35.253 });

export const PHASES = Object.freeze({
  1: { name: 'Rehavia, Talbiye, Hinnom Valley, Mount Zion', i: [0, 4], j: [0, 2] },
  2: { name: 'City centre, Old City, Kidron Valley (fills the rest of the world)', i: [0, 7], j: [0, 4] },
});

const TILES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/tiles');
const MANIFEST = resolve(TILES_DIR, 'manifest.json');
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// A stuck server otherwise hangs the whole run; the query itself asks for at most 180 s.
const REQUEST_TIMEOUT_MS = 200_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function tileBBox(i, j) {
  return gridCellBBox(TILE_GRID, i, j);
}

export const tileId = (i, j) => `${i}_${j}`;
const inTile = inBBox;
const ringCentroid = ringVertexAverage;

// The ownership rules (vertex average, half-open bounds, Liang-Barsky road cutting) live in
// src/city/tiling.js, shared with the game's legacy-data partition. Re-exported for callers.
export { ownedRuns };

/** Converts one tile's Overpass response and keeps only what the tile owns. */
export function convertTile(raw, i, j, { fetchedAt } = {}) {
  const b = tileBBox(i, j);
  // Convert against a much wider box: convertOverpass drops road segments with no endpoint
  // near its bbox, which would lose long straight segments that cross the tile. The exact
  // per-tile cut happens below (centroids for areas, clipSegment for roads).
  const M = 0.05;
  const wide = { south: b.south - M, west: b.west - M, north: b.north + M, east: b.east + M };
  const all = convertOverpass(raw, wide, { fetchedAt });
  const owns = (ring) => {
    const c = ringCentroid(ring);
    return inTile(b, c.lat, c.lon);
  };

  const roads = [];
  for (const road of all.roads) {
    const runs = ownedRuns(road.points, b);
    runs.forEach((points, k) => roads.push({ ...road, id: runs.length > 1 ? `${road.id}.${k}` : road.id, points }));
  }
  const trees = [];
  for (let k = 0; k < all.trees.length; k += 2) if (inTile(b, all.trees[k], all.trees[k + 1])) trees.push(all.trees[k], all.trees[k + 1]);

  const buildings = all.buildings.filter((x) => owns(x.rings[0]));
  const roadAreas = all.roadAreas.filter((x) => owns(x.rings[0]));
  const parks = all.parks.filter((x) => owns(x.rings[0]));

  return {
    tile: { i, j, id: tileId(i, j) },
    doc: {
      ...all,
      bbox: b,
      tile: { i, j, id: tileId(i, j), grid: { ...TILE_GRID } },
      stats: { buildings: buildings.length, roads: roads.length, roadAreas: roadAreas.length, parks: parks.length, trees: trees.length / 2, places: 0 },
      buildings,
      roads,
      roadAreas,
      parks,
      trees,
      places: [],
    },
    places: all.places,
  };
}

async function fetchOverpass(query, label) {
  let lastError;
  for (const url of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'procedural-city tile fetch (one-time)' },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        console.warn(`[tiles] ${label}: ${url} failed: ${err.message}`);
        await sleep(3000 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch {
    return null;
  }
}

async function main(argv) {
  const arg = (name) => {
    const k = argv.indexOf(name);
    return k >= 0 ? argv[k + 1] : null;
  };
  const force = argv.includes('--force');
  let wanted = [];
  if (arg('--tiles')) {
    wanted = arg('--tiles').split(',').map((s) => s.split('_').map(Number));
  } else {
    const phase = PHASES[arg('--phase') ?? '1'];
    if (!phase) throw new Error(`unknown --phase; known: ${Object.keys(PHASES).join(', ')}`);
    for (let j = phase.j[0]; j <= phase.j[1]; j++) for (let i = phase.i[0]; i <= phase.i[1]; i++) wanted.push([i, j]);
  }
  if (wanted.some(([i, j]) => !Number.isInteger(i) || !Number.isInteger(j))) throw new Error('bad tile list');

  await mkdir(TILES_DIR, { recursive: true });
  const manifest = (await readManifest()) ?? { tiles: [], places: [] };
  const tiles = new Map(manifest.tiles.map((t) => [t.id, t]));
  const places = new Map(manifest.places.map((p) => [p.id, p]));

  const failed = [];
  const entry = (doc, bytes) => ({ id: doc.tile.id, i: doc.tile.i, j: doc.tile.j, bbox: doc.bbox, file: `osm_${doc.tile.id}.json`, bytes, fetchedAt: doc.fetchedAt, stats: doc.stats });

  for (const [i, j] of wanted) {
    const id = tileId(i, j);
    const file = resolve(TILES_DIR, `osm_${id}.json`);
    if (!force && (await exists(file))) {
      // Re-register tiles written by an interrupted run.
      if (!tiles.has(id)) {
        const text = await readFile(file, 'utf8');
        tiles.set(id, entry(JSON.parse(text), text.length));
      }
      console.log(`[tiles] ${id}: already fetched, skipping`);
      continue;
    }
    let raw;
    try {
      raw = await fetchOverpass(buildQuery(tileBBox(i, j)), id);
    } catch (err) {
      // Tiles are independent: record the failure and keep going; rerun later to fill gaps.
      failed.push(id);
      console.warn(`[tiles] ${id}: FAILED on every server (${err.message}); continuing`);
      continue;
    }
    const fetchedAt = raw.osm3s?.timestamp_osm_base ?? new Date().toISOString();
    const { doc, places: tilePlaces } = convertTile(raw, i, j, { fetchedAt });
    const json = JSON.stringify(doc);
    await writeFile(file, json);
    for (const p of tilePlaces) places.set(p.id, p);
    tiles.set(id, entry(doc, json.length));
    await writeManifest(tiles, places); // after every tile, so an interrupted run loses nothing
    console.log(`[tiles] ${id}: ${doc.stats.buildings} buildings, ${doc.stats.roads} roads, ${(json.length / 1024).toFixed(0)} KB`);
    await sleep(2000); // be polite to the public Overpass servers
  }

  const out = await writeManifest(tiles, places);
  const total = out.tiles.reduce((n, t) => n + t.stats.buildings, 0);
  console.log(`[tiles] manifest: ${out.tiles.length} tiles, ${total} buildings, ${out.places.length} places`);
  if (failed.length) {
    console.warn(`[tiles] ${failed.length} tile(s) failed: ${failed.join(', ')}. Rerun the same command to retry them.`);
    process.exitCode = 2;
  }
}

async function writeManifest(tiles, places) {
  const out = {
    format: 'tiles-v1',
    source: 'OpenStreetMap via Overpass API',
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    grid: { ...TILE_GRID, tileMeters: { lat: 556, lon: 568 }, note: 'tile (i, j): lon [west + i*dLon, +dLon), lat [south + j*dLat, +dLat); i east, j north' },
    worldBBox: { ...WORLD_BBOX },
    projection: 'createProjection(worldBBox) from src/city/geo.js: fixed origin at the world centre for every phase',
    elevation: 'dem_points.json (dem-points-v1, covers worldBBox)',
    phases: PHASES,
    tiles: [...tiles.values()].sort((a, b) => a.j - b.j || a.i - b.i),
    places: [...places.values()],
  };
  await writeFile(MANIFEST, JSON.stringify(out, null, 1));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
