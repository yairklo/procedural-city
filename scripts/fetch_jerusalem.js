#!/usr/bin/env node
// One-time data ingestion: downloads buildings, roads, parks, trees and place names for
// central Jerusalem (Jaffa St / Mahane Yehuda / King George) from the Overpass API and
// writes a compact, pre-parsed JSON file the game loads at runtime (no network needed).
//
//   node scripts/fetch_jerusalem.js                 # fetch from Overpass
//   node scripts/fetch_jerusalem.js --from raw.json # convert an Overpass JSON you saved yourself
//   node scripts/fetch_jerusalem.js --raw raw.json  # also keep the raw Overpass response
//
// Data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const JERUSALEM_BBOX = Object.freeze({ south: 31.778, west: 35.21, north: 31.788, east: 35.225 });

const OUT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/jerusalem_data.json');
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Roads are clipped to the bbox plus this margin (degrees, ~55 m) so long ways don't run off for kilometers.
const ROAD_MARGIN_DEG = 0.0005;
// Place names are looked up in a slightly wider box so every point in the area has a nearby label.
const PLACE_MARGIN_DEG = 0.006;

const BUILDING_TAGS = [
  'building', 'height', 'min_height', 'building:levels', 'building:min_level', 'roof:shape', 'roof:levels',
  'name', 'name:en', 'name:he', 'addr:street', 'addr:housenumber', 'amenity', 'shop', 'tourism',
];
const ROAD_SKIP = new Set(['proposed', 'construction', 'abandoned', 'razed', 'elevator', 'bus_stop', 'platform', 'traffic_signals', 'crossing', 'street_lamp']);

export function buildQuery({ south, west, north, east }) {
  const b = `${south},${west},${north},${east}`;
  const p = `${south - PLACE_MARGIN_DEG},${west - PLACE_MARGIN_DEG},${north + PLACE_MARGIN_DEG},${east + PLACE_MARGIN_DEG}`;
  return `[out:json][timeout:180];
(
  way["building"](${b});
  relation["building"]["type"="multipolygon"](${b});
  way["highway"](${b});
  way["leisure"~"^(park|garden|playground)$"](${b});
  way["landuse"~"^(grass|recreation_ground|village_green)$"](${b});
  node["natural"="tree"](${b});
  node["place"~"^(neighbourhood|quarter|suburb)$"](${p});
);
out body geom qt;`;
}

const round = (v) => Math.round(v * 1e7) / 1e7;
const flat = (geometry) => geometry.flatMap((p) => [round(p.lat), round(p.lon)]);
const pick = (tags, keys) => {
  const out = {};
  for (const k of keys) if (tags[k] != null && tags[k] !== '') out[k] = tags[k];
  return out;
};

/** Removes the duplicated closing point of a ring, returns null if fewer than 3 points remain. */
function openRing(coords) {
  const pts = coords.slice();
  if (pts.length >= 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts.length -= 2;
  return pts.length >= 6 ? pts : null;
}

const isClosed = (geometry) =>
  geometry.length >= 4 && geometry[0].lat === geometry[geometry.length - 1].lat && geometry[0].lon === geometry[geometry.length - 1].lon;

/**
 * Joins multipolygon member ways (each an array of {lat, lon}) end to end into closed rings.
 * Returns an array of flat [lat, lon, ...] rings; unclosable fragments are dropped.
 */
export function stitchRings(ways) {
  const key = (p) => `${p.lat},${p.lon}`;
  const pending = ways.filter((w) => w && w.length >= 2).map((w) => w.slice());
  const rings = [];
  while (pending.length) {
    let ring = pending.shift();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 10000) {
      const end = key(ring[ring.length - 1]);
      const i = pending.findIndex((w) => key(w[0]) === end || key(w[w.length - 1]) === end);
      if (i < 0) break;
      const next = pending.splice(i, 1)[0];
      if (key(next[0]) !== end) next.reverse();
      ring = ring.concat(next.slice(1));
    }
    if (key(ring[0]) === key(ring[ring.length - 1])) {
      const r = openRing(flat(ring));
      if (r) rings.push(r);
    }
  }
  return rings;
}

/** Bounding box of a flat [lat, lon, ...] ring. */
function ringBox(r) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    s = Math.min(s, r[i]); n = Math.max(n, r[i]);
    w = Math.min(w, r[i + 1]); e = Math.max(e, r[i + 1]);
  }
  return { s, w, n, e };
}

/** Point in ring (even-odd) on flat [lat, lon, ...] coordinates. */
function inRing(r, lat, lon) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const yi = r[i], xi = r[i + 1], yj = r[j], xj = r[j + 1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Splits a polyline into runs whose segments touch the (expanded) bbox. */
function clipPolyline(geometry, box) {
  const inside = (p) => p.lat >= box.south && p.lat <= box.north && p.lon >= box.west && p.lon <= box.east;
  const runs = [];
  let run = null;
  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i], b = geometry[i + 1];
    if (inside(a) || inside(b)) {
      if (!run) run = [a];
      run.push(b);
    } else if (run) {
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  return runs;
}

/**
 * Converts a raw Overpass JSON response into the game's compact format.
 * Coordinates are flat [lat, lon, lat, lon, ...] arrays (7 decimals, ~1 cm).
 */
export function convertOverpass(raw, bbox = JERUSALEM_BBOX, { fetchedAt = new Date().toISOString() } = {}) {
  const elements = raw?.elements ?? [];
  const buildings = [];
  const roads = [];
  const areas = [];
  const parks = [];
  const trees = [];
  const places = [];
  const roadBox = {
    south: bbox.south - ROAD_MARGIN_DEG, north: bbox.north + ROAD_MARGIN_DEG,
    west: bbox.west - ROAD_MARGIN_DEG, east: bbox.east + ROAD_MARGIN_DEG,
  };

  for (const el of elements) {
    const tags = el.tags ?? {};

    if (el.type === 'node') {
      if (tags.natural === 'tree') trees.push(round(el.lat), round(el.lon));
      else if (tags.place && tags.name) {
        places.push({ id: `n${el.id}`, place: tags.place, name: tags.name, nameEn: tags['name:en'] ?? null, lat: round(el.lat), lon: round(el.lon) });
      }
      continue;
    }

    if (el.type === 'way' && el.geometry) {
      const geom = el.geometry.filter(Boolean);
      if (tags.building && tags.building !== 'no') {
        if (!isClosed(geom)) continue;
        const ring = openRing(flat(geom));
        if (ring) buildings.push({ id: `w${el.id}`, tags: pick(tags, BUILDING_TAGS), rings: [ring] });
        continue;
      }
      if (tags.highway) {
        if (ROAD_SKIP.has(tags.highway) || tags.tunnel === 'yes' || tags.indoor === 'yes') continue;
        const base = {
          highway: tags.highway,
          name: tags.name ?? null,
          nameEn: tags['name:en'] ?? null,
          ...(tags.width ? { width: tags.width } : {}),
          ...(tags.lanes ? { lanes: tags.lanes } : {}),
          ...(tags.oneway ? { oneway: tags.oneway } : {}),
          ...(tags.bridge && tags.bridge !== 'no' ? { bridge: true } : {}),
        };
        if (tags.area === 'yes' && isClosed(geom)) {
          const ring = openRing(flat(geom));
          if (ring) areas.push({ id: `w${el.id}`, ...base, rings: [ring] });
          continue;
        }
        const runs = clipPolyline(geom, roadBox);
        runs.forEach((run, i) => {
          if (run.length >= 2) roads.push({ id: runs.length > 1 ? `w${el.id}-${i}` : `w${el.id}`, ...base, points: flat(run) });
        });
        continue;
      }
      if ((tags.leisure || tags.landuse) && isClosed(geom)) {
        const ring = openRing(flat(geom));
        if (ring) parks.push({ id: `w${el.id}`, kind: tags.leisure ?? tags.landuse, name: tags.name ?? null, rings: [ring] });
      }
      continue;
    }

    if (el.type === 'relation' && tags.building && el.members) {
      const outers = stitchRings(el.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => m.geometry));
      const inners = stitchRings(el.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => m.geometry));
      // Each outer ring becomes its own building; holes go to the outer that contains them.
      outers.forEach((outer, i) => {
        const holes = inners.filter((h) => inRing(outer, h[0], h[1]));
        buildings.push({ id: outers.length > 1 ? `r${el.id}-${i}` : `r${el.id}`, tags: pick(tags, BUILDING_TAGS), rings: [outer, ...holes] });
      });
    }
  }

  // Drop buildings that lie entirely outside the requested box (Overpass returns anything intersecting it).
  const keep = buildings.filter((b) => {
    const r = ringBox(b.rings[0]);
    return r.n >= bbox.south && r.s <= bbox.north && r.e >= bbox.west && r.w <= bbox.east;
  });

  return {
    format: 'osm-city-v1',
    source: 'OpenStreetMap via Overpass API',
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    fetchedAt,
    bbox: { ...bbox },
    stats: { buildings: keep.length, roads: roads.length, roadAreas: areas.length, parks: parks.length, trees: trees.length / 2, places: places.length },
    buildings: keep,
    roads,
    roadAreas: areas,
    parks,
    trees,
    places,
  };
}

async function fetchOverpass(query) {
  let lastError;
  for (const url of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        console.log(`[fetch] POST ${url}${attempt ? ' (retry)' : ''}`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'procedural-city data fetch (one-time)' },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        console.warn(`[fetch] ${url} failed: ${err.message}`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const from = arg('--from');
  const rawOut = arg('--raw');
  const out = arg('--out') ?? OUT_FILE;

  let raw;
  if (from) {
    raw = JSON.parse(await readFile(from, 'utf8'));
  } else {
    raw = await fetchOverpass(buildQuery(JERUSALEM_BBOX));
    if (rawOut) await writeFile(rawOut, JSON.stringify(raw));
  }

  const data = convertOverpass(raw, JERUSALEM_BBOX, { fetchedAt: raw.osm3s?.timestamp_osm_base ?? new Date().toISOString() });
  await mkdir(dirname(out), { recursive: true });
  const json = JSON.stringify(data);
  await writeFile(out, json);
  console.log(`[fetch] wrote ${out} (${(json.length / 1024).toFixed(0)} KB)`, data.stats);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
