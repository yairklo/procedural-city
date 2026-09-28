#!/usr/bin/env node
// One-time data ingestion for the Old City landmarks: downloads the Old City from the main
// OpenStreetMap API (scripts/osm_api.js) and extracts what the custom landmark models need
// into public/data/landmarks.json (lat / lon; the game projects it):
//
//   walls        Suleiman's city walls and the Temple Mount enclosure (barrier=city_wall)
//   gates        the city gates (Jaffa, New, Damascus, Herod's, Lions', Golden, Dung, Zion)
//   westernWall  the Western Wall's outline (building=wall)
//   plaza        the Western Wall Plaza
//   templeMount  the compound's outline (for the esplanade platform)
//   citadel      the Tower of David (castle outline, minaret position)
//   sepulchre    the Church of the Holy Sepulchre with its mapped building parts (heights,
//                domes, bell tower)
//   patches      terrain patches: the esplanade and the plaza as flat surfaces
//   replaces     OSM building ids the landmark models replace (not generated again)
//
//   node scripts/fetch_landmarks.js
//
// Elevations: the 90 m DEM smears the 19 m drop at the Western Wall (plaza 739.6 m, Dome of
// the Rock 744 m in the DEM). The esplanade is set to 740.5 m and the plaza 19 m below it
// (the height of the wall above the prayer plaza).
//
// Data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0).

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchOsmMap, mergeOsm, wayGeometry } from './osm_api.js';
import { stitchRings } from './fetch_jerusalem.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/landmarks.json');
export const OLD_CITY_BBOX = Object.freeze({ south: 31.77, west: 35.225, north: 31.7835, east: 35.239 });

export const ELEVATION = Object.freeze({ esplanade: 740.5, plaza: 740.5 - 19 });
const CITADEL_MINARET = Object.freeze({ lat: 31.77585, lon: 35.22776 });

// Gates of the Old City walls, by English name, and how they are modelled.
const CITY_GATES = {
  'Jaffa Gate': 'l-shaped',
  'New Gate': 'simple',
  'Damascus Gate': 'grand',
  "Herod's Gate": 'simple',
  "Lions' Gate": 'simple',
  'Golden Gate': 'sealed',
  'Dung Gate': 'simple',
  'Zion Gate': 'simple',
};

const round = (v) => Math.round(v * 1e7) / 1e7;
const flat = (geometry) => geometry.flatMap((p) => [round(p.lat), round(p.lon)]);
const openRing = (pts) => (pts.length >= 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1] ? pts.slice(0, -2) : pts);
const centroid = (pts) => {
  let a = 0, b = 0;
  for (let i = 0; i < pts.length; i += 2) { a += pts[i]; b += pts[i + 1]; }
  return { lat: round((a * 2) / pts.length), lon: round((b * 2) / pts.length) };
};
const inRing = (r, lat, lon) => {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const yi = r[i], xi = r[i + 1], yj = r[j], xj = r[j + 1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** Extracts the landmark data from merged OSM data (see osm_api.js). */
export function extractLandmarks(osm) {
  const ways = [...osm.ways.values()], nodes = [...osm.nodes.values()], rels = [...osm.relations.values()];
  const nameEn = (e) => e.tags['name:en'] ?? e.tags.name ?? '';
  const wayPts = (w) => flat(wayGeometry(osm, w));
  const relRings = (r, role) => stitchRings(r.members.filter((m) => m.type === 'way' && (role === 'outer' ? m.role !== 'inner' : m.role === 'inner'))
    .map((m) => osm.ways.get(m.ref)).filter(Boolean).map((w) => wayGeometry(osm, w)));
  const replaces = [];

  const walls = ways
    .filter((w) => w.tags.barrier === 'city_wall' || (w.tags.historic === 'citywalls' && w.tags.barrier === 'wall'))
    .map((w) => ({ id: `w${w.id}`, name: nameEn(w) || null, points: wayPts(w) }))
    .filter((w) => w.points.length >= 4);

  const gates = [];
  for (const [name, kind] of Object.entries(CITY_GATES)) {
    // Prefer a mapped gate building (its outline), else the gate node.
    const way = ways.find((w) => nameEn(w) === name && (w.tags.historic === 'city_gate' || w.tags.building));
    const node = nodes.find((n) => nameEn(n) === name && (n.tags.historic === 'city_gate' || n.tags.barrier));
    if (!way && !node) continue;
    const ring = way ? openRing(wayPts(way)) : null;
    const at = ring ? centroid(ring) : { lat: round(node.lat), lon: round(node.lon) };
    if (way?.tags.building) replaces.push(`w${way.id}`);
    gates.push({ name, kind, id: way ? `w${way.id}` : `n${node.id}`, ...at, ring });
  }

  const ww = ways.find((w) => w.tags.building === 'wall' && /Western Wall/.test(nameEn(w)));
  if (ww) replaces.push(`w${ww.id}`);
  const plaza = ways.find((w) => /Western Wall Plaza/.test(nameEn(w)));
  const tm = rels.find((r) => /Temple Mount/.test(nameEn(r)));

  const citadelRel = rels.find((r) => r.tags.historic === 'castle' && /Tower of David/.test(nameEn(r)));
  let citadel = null;
  if (citadelRel) {
    const outer = relRings(citadelRel, 'outer'), inner = relRings(citadelRel, 'inner');
    replaces.push(`r${citadelRel.id}`);
    const minaret = nodes.find((n) => n.tags['tower:type'] === 'minaret' && outer.some((r) => inRing(r, n.lat, n.lon)));
    citadel = {
      id: `r${citadelRel.id}`,
      outer,
      inner,
      // The Ottoman minaret (the "Tower of David" of postcards) is not mapped in OSM: its
      // approximate position in the south-west of the Citadel is used instead.
      minaret: minaret ? { lat: round(minaret.lat), lon: round(minaret.lon), approximate: false } : { ...CITADEL_MINARET, approximate: true },
    };
  }

  const church = ways.find((w) => w.tags.building && /Holy Sepulchre/.test(nameEn(w)));
  let sepulchre = null;
  if (church) {
    const ring = openRing(wayPts(church));
    replaces.push(`w${church.id}`);
    const parts = ways
      .filter((w) => w.tags['building:part'] && w.tags.layer !== '-1')
      .map((w) => ({ w, pts: openRing(wayPts(w)) }))
      .filter(({ pts }) => pts.length >= 6 && inRing(ring, centroid(pts).lat, centroid(pts).lon))
      .map(({ w, pts }) => ({
        id: `w${w.id}`,
        name: w.tags['name:en'] ?? w.tags.name ?? null,
        ring: pts,
        height: w.tags.height ? Number(w.tags.height) : null,
        minHeight: w.tags.min_height ? Number(w.tags.min_height) : 0,
        roofShape: w.tags['roof:shape'] ?? 'flat',
        roofHeight: w.tags['roof:height'] ? Number(w.tags['roof:height']) : null,
        tower: w.tags['tower:type'] ?? null,
      }));
    sepulchre = { id: `w${church.id}`, ring, parts };
  }

  const patches = [];
  // Outer outline only: the relation's inner ring (the Marwani mosque garden) is excluded from
  // the land use, but physically it lies on the esplanade too.
  if (tm) patches.push({ name: 'Temple Mount esplanade', mode: 'raise', elevation: ELEVATION.esplanade, rings: relRings(tm, 'outer') });
  if (plaza) patches.push({ name: 'Western Wall Plaza', mode: 'lower', elevation: ELEVATION.plaza, rings: [openRing(wayPts(plaza))] });

  return {
    format: 'landmarks-v1',
    source: 'OpenStreetMap via the main API',
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    bbox: { ...OLD_CITY_BBOX },
    elevation: { ...ELEVATION },
    walls,
    gates,
    westernWall: ww ? { id: `w${ww.id}`, ring: openRing(wayPts(ww)), height: Number(ww.tags.height ?? 20) } : null,
    plaza: plaza ? { id: `w${plaza.id}`, ring: openRing(wayPts(plaza)) } : null,
    templeMount: tm ? { id: `r${tm.id}`, outer: relRings(tm, 'outer'), inner: relRings(tm, 'inner') } : null,
    citadel,
    sepulchre,
    patches,
    replaces: [...new Set(replaces)],
  };
}

async function main() {
  const rows = 3, cols = 3, b = OLD_CITY_BBOX;
  const docs = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      docs.push(await fetchOsmMap({
        south: b.south + ((b.north - b.south) * r) / rows, north: b.south + ((b.north - b.south) * (r + 1)) / rows,
        west: b.west + ((b.east - b.west) * c) / cols, east: b.west + ((b.east - b.west) * (c + 1)) / cols,
      }));
      process.stdout.write(`\r[landmarks] ${docs.length}/${rows * cols} areas`);
    }
  }
  process.stdout.write('\n');
  const data = extractLandmarks(mergeOsm(docs));
  data.fetchedAt = new Date().toISOString();
  await mkdir(dirname(OUT), { recursive: true });
  const json = JSON.stringify(data);
  await writeFile(OUT, json);
  console.log(`[landmarks] wrote ${OUT} (${(json.length / 1024).toFixed(0)} KB): ${data.walls.length} wall ways, ${data.gates.length} gates` +
    ` (${data.gates.map((g) => g.name).join(', ')}), western wall ${!!data.westernWall}, plaza ${!!data.plaza}, temple mount ${!!data.templeMount},` +
    ` citadel ${!!data.citadel} (minaret ${!!data.citadel?.minaret}), sepulchre parts ${data.sepulchre?.parts.length ?? 0}, replaces ${data.replaces.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
