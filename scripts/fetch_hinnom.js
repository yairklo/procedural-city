#!/usr/bin/env node
// One-time data ingestion for the Hinnom Valley (Gei Ben Hinnom), Mishkenot Sha'ananim and
// Yemin Moshe: downloads the area from the main OpenStreetMap API (scripts/osm_api.js) and
// extracts what the custom models in src/city/landmarks/hinnom.js need into
// public/data/hinnom.json (lat / lon; the game projects it):
//
//   mishkenot   the row houses of Mishkenot Sha'ananim (1860): the long, thin buildings next to
//               the guest house (the long row and the short one behind it)
//   windmill    the Montefiore Windmill (man_made=windmill) and the stone base it stands on
//   pool        Sultan's Pool: the reservoir (mapped as the amphitheatre plus the construction
//               site at its north end), its floor levels and the dam road along its south end
//   valley      the valley's thalweg (natural=valley), from the pool to the Kidron
//   sites       rock-cut burial caves and tombs on the slopes (Ketef Hinnom, Akeldama, ...)
//   slopes      a mask of open ground along the valley (not built on, no road, not in the pool):
//               where the game lays dry-stone terraces and plants olive groves
//   yeminMoshe  the neighbourhood outline: 2-3 storey stone houses with tile roofs
//   lowRise     low-rise areas for the city generator: Yemin Moshe; Mount Zion and Abu Tor
//               (approximate)
//   patches     terrain patches: the pool's two floor levels
//   replaces    OSM building ids the models replace (not generated again)
//
//   node scripts/fetch_hinnom.js                      (downloads; ~6 small API requests)
//   node scripts/fetch_hinnom.js --raw <file.json>    (offline: a saved { nodes, ways } dump)
//   node scripts/fetch_hinnom.js --save-raw <file>    (downloads and keeps the raw dump)
//
// Elevations (m above sea level): the 30 m DEM smears the pool into a shallow dip (731-738 m).
// The Hebron Road crosses the valley on the pool's dam at ~731 m, and the stage stands at the
// foot of the dam wall ~7 m below the road, so the southern (amphitheatre) floor is set to
// 724.5 m; the northern half, beyond the raked seating, to 728.5 m.
//
// Data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0).

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchOsmMap, mergeOsm } from './osm_api.js';
import { createProjection } from '../src/city/geo.js';
import { orientedBox, pointInRings, distanceToEdges, segmentDistance } from '../src/city/footprint.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/hinnom.json');
const MANIFEST = resolve(ROOT, 'public/data/tiles/manifest.json');

export const HINNOM_BBOX = Object.freeze({ south: 31.7655, west: 35.2215, north: 31.7755, east: 35.2375 });
export const ELEVATION = Object.freeze({ poolSouth: 724.5, poolNorth: 728.5 });

// Mount Zion, across the pool from Mishkenot: 2-3 storey stone buildings (schools, churches,
// monasteries) around the Dormition, not the modern city's blocks. No mapped outline: an
// approximate box (lat, lon) from the pool's east side to the Old City wall, flagged as such.
export const MOUNT_ZION = Object.freeze({ name: 'Mount Zion', approximate: true, floorsMin: 2, floorsMax: 3, shops: false,
  ring: [31.7736, 35.2266, 31.7736, 35.2312, 31.7688, 35.2312, 31.7688, 35.2266] });
// Abu Tor, on the valley's south rim: 2-4 storey houses stepped down the slope (approximate box).
export const ABU_TOR = Object.freeze({ name: 'Abu Tor', approximate: true, floorsMin: 2, floorsMax: 4, shops: false,
  ring: [31.7693, 35.2268, 31.7693, 35.2328, 31.7640, 35.2328, 31.7640, 35.2268] });

/** Slope mask: cell size (m) and how far from the valley line open ground counts. */
export const SLOPES = Object.freeze({ cell: 6, reach: 125, buildingGap: 6, roadGap: 2 });

const ROAD_WIDTH = { motorway: 16, trunk: 14, trunk_link: 7, primary: 12, secondary: 10, tertiary: 9, unclassified: 7, residential: 7, service: 5, living_street: 6, pedestrian: 5 };
const round = (v) => Math.round(v * 1e7) / 1e7;

/** Flat [lat, lon, ...] of a way (closed rings lose their repeated last point). */
function wayPts(osm, w) {
  const out = [];
  for (const r of w.refs) {
    const n = osm.nodes.get(r);
    if (n) out.push(round(n.lat), round(n.lon));
  }
  const k = out.length;
  if (k >= 8 && out[0] === out[k - 2] && out[1] === out[k - 1]) out.length = k - 2;
  return out;
}
const closed = (w) => w.refs.length >= 4 && w.refs[0] === w.refs[w.refs.length - 1];
const nameEn = (t) => t['name:en'] ?? t.name ?? '';

/** Convex hull of flat [lat, lon, ...] points (counter-clockwise in lon / lat). */
export function convexHull(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i + 1], flat[i]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of [...pts].reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)].flatMap(([lon, lat]) => [lat, lon]);
}

/** Packs a boolean grid (row-major) into base64. */
export function packBits(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (i & 7); });
  return Buffer.from(bytes).toString('base64');
}
export function unpackBits(b64, n) {
  const bytes = typeof Buffer !== 'undefined' ? Buffer.from(b64, 'base64') : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return out;
}

/**
 * @param {{ nodes: Map, ways: Map }} osm   parsed OSM (scripts/osm_api.js)
 * @param {object} worldBBox                the tile manifest's worldBBox (for the game projection)
 */
export function extractHinnom(osm, worldBBox) {
  const P = createProjection(worldBBox);
  const xz = (flat) => P.projectFlat(flat);
  const ways = [...osm.ways.values()];
  const nodes = [...osm.nodes.values()].filter((n) => Object.keys(n.tags).length);
  const replaces = [];

  const buildings = ways.filter((w) => w.tags.building && closed(w)).map((w) => ({ id: `w${w.id}`, tags: w.tags, ll: wayPts(osm, w) }));
  for (const b of buildings) b.rings = [xz(b.ll)];

  // --- Mishkenot Sha'ananim ----------------------------------------------------------------------
  // The guest house node sits between the rows; the rows are the long, thin buildings around it.
  const guest = nodes.find((n) => /Mishkenot|משכנות שאננים/.test(`${n.tags.name ?? ''} ${n.tags['name:he'] ?? ''}`) && n.tags.tourism);
  const mishkenot = [];
  if (guest) {
    const g = P.project(guest.lat, guest.lon);
    for (const b of buildings) {
      const box = orientedBox(b.rings[0]);
      if (!box) continue;
      const len = 2 * box.hl, wid = 2 * box.hw;
      if (Math.hypot(box.cx - g.x, box.cz - g.z) < 80 && len >= 25 && len / wid >= 3 && wid <= 16) {
        mishkenot.push({ id: b.id, ring: b.ll, length: +len.toFixed(1), width: +wid.toFixed(1) });
        replaces.push(b.id);
      }
    }
    mishkenot.sort((a, b) => b.length - a.length);
  }

  // --- Montefiore Windmill -----------------------------------------------------------------------
  const mill = nodes.find((n) => n.tags.man_made === 'windmill') ?? null;
  let windmill = null;
  if (mill) {
    const p = P.project(mill.lat, mill.lon);
    const base = buildings.find((b) => pointInRings(b.rings, p.x, p.z));
    windmill = { id: `n${mill.id}`, name: nameEn(mill.tags) || 'Montefiore Windmill', lat: round(mill.lat), lon: round(mill.lon), base: base ? { id: base.id, ring: base.ll } : null };
    if (base) replaces.push(base.id);
  }

  // --- Sultan's Pool -----------------------------------------------------------------------------
  const poolWay = ways.find((w) => /Sultan's Pool|בריכת הסולטן/.test(`${nameEn(w.tags)} ${w.tags.name ?? ''}`) && closed(w));
  let pool = null;
  const patches = [];
  if (poolWay) {
    const theatre = wayPts(osm, poolWay);
    // The reservoir's northern half is mapped as a separate area sharing the pool's corners.
    const refs = new Set(poolWay.refs);
    const north = ways.find((w) => w !== poolWay && closed(w) && !w.tags.building && !w.tags.highway && w.refs.filter((r) => refs.has(r)).length >= 2);
    const ring = convexHull([...theatre, ...(north ? wayPts(osm, north) : [])]).map(round);
    // The dam: the road that runs along the pool's south edge (the Hebron Road).
    const pr = xz(ring);
    let minZ = Infinity, maxZ = -Infinity, minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < pr.length; i += 2) { minX = Math.min(minX, pr[i]); maxX = Math.max(maxX, pr[i]); minZ = Math.min(minZ, pr[i + 1]); maxZ = Math.max(maxZ, pr[i + 1]); }
    let dam = null;
    for (const w of ways) {
      if (!ROAD_WIDTH[w.tags.highway] || ROAD_WIDTH[w.tags.highway] < 9) continue;
      const pts = xz(wayPts(osm, w));
      const along = [];
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i], z = pts[i + 1];
        if (x > minX - 10 && x < maxX + 10 && z > maxZ - 10 && z < maxZ + 25) along.push(i);
      }
      if (along.length >= 2) {
        const ll = wayPts(osm, w);
        dam = { road: nameEn(w.tags) || null, line: along.flatMap((i) => [ll[i], ll[i + 1]]) };
        break;
      }
    }
    // Split line between the two floor levels: the north edge of the mapped amphitheatre.
    const th = xz(theatre);
    let thMinZ = Infinity;
    for (let i = 1; i < th.length; i += 2) thMinZ = Math.min(thMinZ, th[i]);
    const splitLat = round(P.unproject(0, thMinZ).lat);
    pool = { id: `w${poolWay.id}`, name: "Sultan's Pool", north: north ? `w${north.id}` : null, ring, splitLat, floor: { south: ELEVATION.poolSouth, north: ELEVATION.poolNorth }, dam };
    // Two flat floors: the amphitheatre (south) and the garden floor beyond the seating (north).
    // A lowered patch reaches 2 m past its outline, so the rings are the pool clipped at the split.
    const clip = (keepNorth) => {
      const out = [];
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const a = [ring[i * 2], ring[i * 2 + 1]], b = [ring[((i + 1) % n) * 2], ring[((i + 1) % n) * 2 + 1]];
        const inA = keepNorth ? a[0] >= splitLat : a[0] <= splitLat, inB = keepNorth ? b[0] >= splitLat : b[0] <= splitLat;
        if (inA) out.push(a);
        if (inA !== inB) {
          const t = (splitLat - a[0]) / (b[0] - a[0]);
          out.push([splitLat, round(a[1] + (b[1] - a[1]) * t)]);
        }
      }
      return out.flat();
    };
    // The north floor goes first (the first patch containing a point wins): its 2 m edge band
    // then lies under the top rows of the seating instead of a trench below the north floor.
    patches.push({ name: "Sultan's Pool (north floor)", mode: 'lower', elevation: ELEVATION.poolNorth, rings: [clip(true)] });
    patches.push({ name: "Sultan's Pool (amphitheatre floor)", mode: 'lower', elevation: ELEVATION.poolSouth, rings: [clip(false)] });
  }

  // --- The valley ----------------------------------------------------------------------------------
  const valleyWay = ways.find((w) => w.tags.natural === 'valley' && /Hinnom|הינום/.test(`${nameEn(w.tags)} ${w.tags.name ?? ''}`));
  const valley = valleyWay ? { id: `w${valleyWay.id}`, name: nameEn(valleyWay.tags), line: wayPts(osm, valleyWay) } : null;

  // --- Burial caves and tombs on the slopes (rock-cut, Second Temple period) -------------------------
  const sites = nodes
    .filter((n) => n.tags.natural === 'cave_entrance' || n.tags.archaeological_site === 'tomb' || /Aceldama|Akeldama|חקל דמא|קבורה/.test(`${nameEn(n.tags)} ${n.tags.name ?? ''} ${n.tags.description ?? ''}`))
    .filter((n) => n.lat > HINNOM_BBOX.south && n.lat < HINNOM_BBOX.north && n.lon > HINNOM_BBOX.west && n.lon < HINNOM_BBOX.east)
    .map((n) => ({ id: `n${n.id}`, name: n.tags['name:en'] ?? n.tags.name ?? null, lat: round(n.lat), lon: round(n.lon) }));

  // --- Yemin Moshe -----------------------------------------------------------------------------------
  const ymWay = ways.find((w) => w.tags.place === 'neighbourhood' && /Yemin Moshe/.test(nameEn(w.tags)) && closed(w));
  const yeminMoshe = ymWay ? { id: `w${ymWay.id}`, name: 'Yemin Moshe', ring: wayPts(osm, ymWay) } : null;

  // --- Open slopes along the valley --------------------------------------------------------------------
  let slopes = null;
  if (valley) {
    const line = xz(valley.line);
    const C = SLOPES.cell;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < line.length; i += 2) {
      x0 = Math.min(x0, line[i]); x1 = Math.max(x1, line[i]); z0 = Math.min(z0, line[i + 1]); z1 = Math.max(z1, line[i + 1]);
    }
    x0 -= SLOPES.reach; x1 += SLOPES.reach; z0 -= SLOPES.reach; z1 += SLOPES.reach;
    const cols = Math.ceil((x1 - x0) / C), rows = Math.ceil((z1 - z0) / C);
    const lineDist = (x, z) => {
      let d = Infinity;
      for (let i = 0; i + 3 < line.length; i += 2) d = Math.min(d, segmentDistance(x, z, line[i], line[i + 1], line[i + 2], line[i + 3]));
      return d;
    };
    const roads = ways.filter((w) => w.tags.highway && !w.tags.area && w.tags.highway !== 'platform').map((w) => ({ pts: xz(wayPts(osm, w)), half: (ROAD_WIDTH[w.tags.highway] ?? 2.5) / 2 + SLOPES.roadGap }));
    // Paved or built-up areas count as buildings: pedestrian squares, car parks, sports pitches.
    const hard = ways.filter((w) => closed(w) && !w.tags.building && (w.tags.area === 'yes' && w.tags.highway || w.tags.amenity === 'parking' || w.tags.leisure === 'pitch'))
      .map((w) => ({ rings: [xz(wayPts(osm, w))] }));
    const blocked = [...buildings, ...hard].map((b) => ({ rings: b.rings, box: orientedBox(b.rings[0]) }));
    const poolRings = pool ? [xz(pool.ring)] : null;
    const bits = new Array(cols * rows).fill(0);
    let free = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = x0 + (c + 0.5) * C, z = z0 + (r + 0.5) * C;
        if (lineDist(x, z) > SLOPES.reach) continue;
        if (poolRings && (pointInRings(poolRings, x, z) || distanceToEdges(poolRings, x, z) < 6)) continue;
        let ok = true;
        for (const b of blocked) {
          if (!b.box || Math.hypot(b.box.cx - x, b.box.cz - z) > b.box.hl + b.box.hw + SLOPES.buildingGap + 4) continue;
          if (pointInRings(b.rings, x, z) || distanceToEdges(b.rings, x, z) < SLOPES.buildingGap) { ok = false; break; }
        }
        if (!ok) continue;
        for (const rd of roads) {
          for (let i = 0; i + 3 < rd.pts.length; i += 2) {
            if (segmentDistance(x, z, rd.pts[i], rd.pts[i + 1], rd.pts[i + 2], rd.pts[i + 3]) < rd.half) { ok = false; break; }
          }
          if (!ok) break;
        }
        if (!ok) continue;
        bits[r * cols + c] = 1;
        free++;
      }
    }
    const nw = P.unproject(x0, z0);
    slopes = { cell: C, cols, rows, origin: { lat: round(nw.lat), lon: round(nw.lon) }, free, bits: packBits(bits) };
  }

  return {
    format: 'hinnom-v1',
    source: 'OpenStreetMap via the main API',
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    bbox: { ...HINNOM_BBOX },
    elevation: { ...ELEVATION },
    mishkenot,
    windmill,
    pool,
    valley,
    yeminMoshe,
    sites,
    // Yemin Moshe: 2-3 storeys, and its (large, row-house) blocks mapped with a pitched roof get one.
    lowRise: [
      ...(yeminMoshe ? [{ name: 'Yemin Moshe', ring: yeminMoshe.ring, floorsMin: 2, floorsMax: 3, shops: false, tileRoofMaxArea: 1400 }] : []),
      { ...MOUNT_ZION, ring: [...MOUNT_ZION.ring] },
      { ...ABU_TOR, ring: [...ABU_TOR.ring] },
    ],
    slopes,
    patches,
    replaces: [...new Set(replaces)],
  };
}

async function main() {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  let osm;
  if (arg('--raw')) {
    const raw = JSON.parse(await readFile(arg('--raw'), 'utf8'));
    osm = { nodes: new Map(raw.nodes.map((n) => [n.id, n])), ways: new Map(raw.ways.map((w) => [w.id, w])), relations: new Map() };
  } else {
    const rows = 2, cols = 3, b = HINNOM_BBOX, docs = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        docs.push(await fetchOsmMap({
          south: b.south + ((b.north - b.south) * r) / rows, north: b.south + ((b.north - b.south) * (r + 1)) / rows,
          west: b.west + ((b.east - b.west) * c) / cols, east: b.west + ((b.east - b.west) * (c + 1)) / cols,
        }));
        process.stdout.write(`\r[hinnom] ${docs.length}/${rows * cols} areas`);
      }
    }
    process.stdout.write('\n');
    osm = mergeOsm(docs);
    if (arg('--save-raw')) await writeFile(arg('--save-raw'), JSON.stringify({ nodes: [...osm.nodes.values()], ways: [...osm.ways.values()] }));
  }
  const data = extractHinnom(osm, manifest.worldBBox);
  data.fetchedAt = new Date().toISOString();
  await mkdir(dirname(OUT), { recursive: true });
  const json = JSON.stringify(data);
  await writeFile(OUT, json);
  console.log(`[hinnom] wrote ${OUT} (${(json.length / 1024).toFixed(0)} KB): mishkenot rows ${data.mishkenot.length}` +
    ` (${data.mishkenot.map((m) => `${m.length} m`).join(', ')}), windmill ${!!data.windmill} (base ${!!data.windmill?.base}),` +
    ` pool ${!!data.pool} (dam ${data.pool?.dam?.road ?? 'none'}), valley ${!!data.valley}, yemin moshe ${!!data.yeminMoshe},` +
    ` slopes ${data.slopes ? `${data.slopes.cols}x${data.slopes.rows}, ${data.slopes.free} open cells` : 'none'}, replaces ${data.replaces.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
