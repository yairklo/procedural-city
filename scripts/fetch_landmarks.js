#!/usr/bin/env node
// One-time data ingestion for the Old City landmarks: downloads the Old City from the main
// OpenStreetMap API (scripts/osm_api.js) and extracts what the custom landmark models need
// into public/data/landmarks.json (lat / lon; the game projects it):
//
//   walls        Suleiman's city walls and the Temple Mount enclosure (barrier=city_wall)
//   gates        the city gates (Jaffa, New, Damascus, Herod's, Lions', Golden, Dung, Zion)
//   crossings    where ground-level streets pass through the walls (openings are cut there)
//   westernWall  the Western Wall's outline (building=wall)
//   plaza        the Western Wall Plaza
//   prayer       the men's and women's prayer sections (positions); mughrabi: the Mughrabi Gate
//   templeMount  the compound's outline (for the esplanade platform)
//   citadel      the Tower of David (castle outline, minaret position)
//   sepulchre    the Church of the Holy Sepulchre with its mapped building parts (heights,
//                domes, bell tower)
//   haram        the buildings on the Temple Mount esplanade: the Dome of the Rock, al-Aqsa,
//                the Dome of the Chain, the arcades (qanatir) at the top of the stairs, the small
//                domes, the groves, the minarets, the raised platform around the Dome of the
//                Rock (from the arcades that stand on its edge) and the mapped trees
//   modern       the Knesset (outline) and its Menorah, the Chords Bridge (deck line, pylon)
//   olives       the Mount of Olives: the Jewish cemetery, the Church of Mary Magdalene, the
//                Church of All Nations, Absalom's Tomb, the Tomb of Zechariah, the Russian
//                bell tower, the Chapel of the Ascension, the Seven Arches Hotel
//   scopus       Mount Scopus: the Hebrew University tower and campus, Augusta Victoria
//                Where OSM (or the tiles) has no geometry for one of these, an approximate
//                position is used and flagged `approximate`.
//   patches      terrain patches: the raised platform, the esplanade and the plaza as flat
//                surfaces (the raised platform first: the first patch containing a point wins)
//   replaces     OSM building ids the landmark models replace (not generated again)
//
//   node scripts/fetch_landmarks.js
//   node scripts/fetch_landmarks.js --save-raw <file.json>   (also keeps the raw OSM dump)
//   node scripts/fetch_landmarks.js --raw <file.json>        (offline, from such a dump)
//   node scripts/fetch_landmarks.js --from-tiles   (no network: rebuilds `haram` from the tile
//                                                   files already in public/data/tiles, and keeps
//                                                   the rest of landmarks.json. Tiles have no
//                                                   nodes or land-use areas, so minarets fall back
//                                                   to their approximate positions and the only
//                                                   groves are the mapped gardens.)
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

export const ELEVATION = Object.freeze({ esplanade: 740.5, plaza: 740.5 - 19, upperPlatform: 740.5 + 4 });

// Low-rise villages around the Old City: 2-3 storey houses stepped down the slopes, not the
// modern city's 3-6 storey blocks. OSM has no outlines for them (Silwan is a place=suburb
// node; only the City of David ridge has a small landuse=residential area; Ras al-Amud and
// At-Tur have none), so these are approximate boxes (lat, lon), flagged as such in the data.
export const LOW_RISE_AREAS = Object.freeze([
  { name: 'Silwan and the City of David', approximate: true, floorsMin: 2, floorsMax: 3, facade: 'historic',
    ring: [31.7748, 35.2328, 31.7748, 35.2445, 31.7650, 35.2445, 31.7650, 35.2328] },
  { name: 'Kidron Valley and the Mount of Olives slope (At-Tur, Ras al-Amud)', approximate: true, floorsMin: 2, floorsMax: 3, facade: 'historic',
    ring: [31.7840, 35.2378, 31.7840, 35.2530, 31.7650, 35.2530, 31.7650, 35.2445, 31.7748, 35.2445, 31.7748, 35.2378] },
]);

// The four minarets of the Haram. Where OSM has no minaret node near one, its approximate
// position is used (next to the gate it is named after; flagged `approximate`).
export const HARAM_MINARETS = Object.freeze([
  { name: 'Fakhriyya Minaret', style: 'square', lat: 31.7759, lon: 35.23468 }, // south-west corner
  { name: 'Bab al-Silsila Minaret', style: 'square', lat: 31.77738, lon: 35.23436 }, // west, by the Chain Gate
  { name: 'Bab al-Ghawanima Minaret', style: 'square', lat: 31.78002, lon: 35.2338 }, // north-west corner
  { name: 'Bab al-Asbat Minaret', style: 'round', lat: 31.78019, lon: 35.23629 }, // north wall
]);
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
const areaM2 = (r) => {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += (r[j + 1] * r[i] - r[i + 1] * r[j]) * 110900 * 94600;
  return Math.abs(a / 2);
};
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

const hull2d = (pts) => {
  // Convex hull of [x, y] points (monotone chain), counter-clockwise.
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
};

/**
 * The Haram / Temple Mount buildings from generic features, so it works from OSM ways and
 * from the tile files alike.
 * @param {{id:string, tags:object, ring:number[]}[]} features  closed ways (ring: lat, lon, ...)
 * @param {{id:string, tags:object, lat:number, lon:number}[]} nodes
 * @param {number[]} enclosure  the compound's outer ring (lat, lon, ...)
 * @param {number[]} trees      mapped trees (lat, lon, ...)
 */
export function extractHaram(features, nodes, enclosure, trees = []) {
  const nameEn = (f) => f.tags['name:en'] ?? f.tags.name ?? '';
  const inside = (f) => { const c = centroid(f.ring); return inRing(enclosure, c.lat, c.lon); };
  const on = features.filter((f) => f.ring.length >= 6 && inside(f));
  const pick = (re) => on.find((f) => f.tags.building && re.test(nameEn(f)));
  const num = (v, d = null) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
  const part = (f) => f && { id: f.id, name: nameEn(f) || null, ring: f.ring, height: num(f.tags.height), minHeight: num(f.tags.min_height, 0) };

  const rock = pick(/^Dome of the Rock$/);
  const aqsa = pick(/al-Aqsa Mosque/i);
  const chain = pick(/^Dome of the Chain$/);
  const arcades = on.filter((f) => f.tags.building && /Arcade$/.test(nameEn(f))).map(part);
  const domes = on.filter((f) => f.tags.building && /^Dome of /.test(nameEn(f)) && f !== rock && f !== chain).map(part);
  const GROVE = { landuse: ['orchard', 'grass', 'meadow', 'forest', 'village_green'], natural: ['wood', 'scrub', 'grassland'], leisure: ['garden', 'park'] };
  const groves = on
    .filter((f) => !f.tags.building && Object.entries(GROVE).some(([k, vs]) => vs.includes(f.tags[k])))
    .map((f) => ({ id: f.id, kind: f.tags.landuse ?? f.tags.natural ?? f.tags.leisure, name: nameEn(f) || null, ring: f.ring }));

  // Minarets: mapped ones (node or outline) replace the approximate positions of the nearest
  // known minaret; the walls' own minarets stand on the enclosure line, so allow a margin.
  const near = (a, b) => Math.hypot((a.lat - b.lat) * 110900, (a.lon - b.lon) * 94600);
  const mapped = [
    ...nodes.filter((n) => n.tags['tower:type'] === 'minaret' || n.tags.building === 'minaret'),
    ...features.filter((f) => f.tags['tower:type'] === 'minaret' || f.tags.building === 'minaret').map((f) => ({ id: f.id, tags: f.tags, ...centroid(f.ring) })),
  ].filter((m) => HARAM_MINARETS.some((k) => near(k, m) < 60));
  const minarets = HARAM_MINARETS.map((k) => {
    const m = mapped.filter((x) => near(k, x) < 60).sort((a, b) => near(k, a) - near(k, b))[0];
    return m ? { name: k.name, style: k.style, id: m.id, lat: round(m.lat), lon: round(m.lon), approximate: false } : { ...k, approximate: true };
  });

  // The raised platform around the Dome of the Rock: the arcades stand at the top of its
  // stairs, so its outline is the hull of the arcades (and the Dome of the Rock), 2 m out.
  let upperPlatform = null;
  const edge = [...arcades.map((a) => a.ring), ...(rock ? [rock.ring] : [])];
  if (arcades.length >= 3) {
    const lat0 = centroid(rock?.ring ?? arcades[0].ring).lat;
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), kz = 110900;
    const pts = [];
    for (const r of edge) for (let i = 0; i < r.length; i += 2) pts.push([r[i + 1] * kx, r[i] * kz]);
    const h = hull2d(pts);
    const cx = h.reduce((s, p) => s + p[0], 0) / h.length, cz = h.reduce((s, p) => s + p[1], 0) / h.length;
    upperPlatform = { ring: h.flatMap(([x, z]) => { const d = Math.hypot(x - cx, z - cz) || 1, g = (d + 2) / d; return [round((cz + (z - cz) * g) / kz), round((cx + (x - cx) * g) / kx)]; }) };
  }

  const inTm = [];
  for (let i = 0; i + 1 < trees.length; i += 2) if (inRing(enclosure, trees[i], trees[i + 1])) inTm.push(round(trees[i]), round(trees[i + 1]));

  const haram = {
    domeOfTheRock: part(rock),
    aqsa: part(aqsa),
    domeOfTheChain: part(chain),
    arcades,
    domes,
    groves,
    minarets,
    upperPlatform,
    trees: inTm,
  };
  const replaces = [rock, aqsa, chain].filter(Boolean).map((f) => f.id).concat(arcades.map((a) => a.id), domes.map((d) => d.id));
  return { haram, replaces };
}

/** The raised-platform terrain patch for `haram` (goes first in the patch list). */
export const upperPlatformPatch = (haram) =>
  haram?.upperPlatform ? { name: 'Dome of the Rock platform', mode: 'raise', elevation: ELEVATION.upperPlatform, rings: [haram.upperPlatform.ring] } : null;

// Small areas around the landmarks outside the Old City (fetched as well, for their outlines).
export const EXTRA_BBOXES = Object.freeze([
  { name: 'Knesset', south: 31.7745, west: 35.2030, north: 31.7790, east: 35.2095 },
  { name: 'Chords Bridge', south: 31.7860, west: 35.1990, north: 31.7905, east: 35.2060 },
  { name: 'Mount of Olives', south: 31.7730, west: 35.2380, north: 31.7815, east: 35.2480 },
  { name: 'Mount Scopus', south: 31.7840, west: 35.2400, north: 31.7960, east: 35.2530 }, // east: all of Augusta Victoria
]);

// Approximate positions (lat, lon), used only where OSM has nothing to match (the tile files,
// with --from-tiles, have no nodes). `crest`: a tower on a ridge, placed on the highest ground
// within 40 m of the position. Mapped features are placed exactly (no crest).
export const APPROX = Object.freeze({
  menorah: { lat: 31.776, lon: 35.207 },
  // The light-rail bridge: from Jaffa Road by the Central Bus Station (east, at street level)
  // curving south-west over the Herzl / Shazar junction to Herzl Boulevard.
  chordsBridge: {
    deck: [31.78945, 35.20455, 31.7892, 35.2037, 31.78895, 35.2029, 31.78862, 35.20215, 31.78818, 35.2015, 31.78765, 35.201],
    pylon: { lat: 31.78878, lon: 35.2032 },
  },
  cemetery: [31.7792, 35.2398, 31.7792, 35.2432, 31.7779, 35.2447, 31.7756, 35.2446, 31.7743, 35.2432, 31.7743, 35.24, 31.7760, 35.2393],
  bellTower: { lat: 31.7792, lon: 35.2455, crest: true },
  chapelAscension: { lat: 31.7788, lon: 35.2448, crest: true },
  sevenArches: { lat: 31.7768, lon: 35.2446, crest: true },
  universityTower: { lat: 31.7927, lon: 35.2435, crest: true },
  augustaVictoria: { lat: 31.7858, lon: 35.2449, crest: true },
});

/**
 * The junction under the Chords Bridge as a terrain patch: a flat road level under the middle
 * of the deck (SRTM measures the surface with what stands on it, and the Central Bus Station
 * just east of the bridge makes a hump). A band 45 m either side of the middle of the deck,
 * blending back to the DEM over 50 m. `elevation`: the road level (m); pass the median of the
 * DEM under the middle of the deck (see deckElevation).
 */
export function bridgeJunctionPatch(deck, { from = 0.15, to = 0.85, half = 45, elevation = 813 } = {}) {
  const lat0 = deck[0], kx = 111320 * Math.cos((lat0 * Math.PI) / 180), kz = 110900;
  const pts = [];
  for (let i = 0; i < deck.length; i += 2) pts.push([deck[i + 1] * kx, deck[i] * kz]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  const at = (d) => {
    let i = 1;
    while (i < pts.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    return { x: a[0] + dx * t, z: a[1] + dz * t, nx: -dz / l, nz: dx / l };
  };
  const left = [], right = [];
  for (let k = 0; k <= 12; k++) {
    const p = at(L * (from + ((to - from) * k) / 12));
    left.push([p.x + p.nx * half, p.z + p.nz * half]);
    right.push([p.x - p.nx * half, p.z - p.nz * half]);
  }
  const ring = [...left, ...right.reverse()].flatMap(([x, z]) => [round(z / kz), round(x / kx)]);
  return { name: 'Chords Bridge junction', mode: 'lower', elevation: Math.round(elevation * 10) / 10, falloff: 50, approximate: true, rings: [ring] };
}

/** Median of elevationAt(lat, lon) over the middle 15-85 % of a deck line (lat, lon, ...). */
export function deckElevation(deck, elevationAt, { from = 0.15, to = 0.85 } = {}) {
  const pts = resampleLatLon(deck, 25);
  const k0 = Math.floor(pts.length * from), k1 = Math.ceil(pts.length * to);
  const hs = pts.slice(k0, Math.max(k0 + 1, k1)).map(([la, lo]) => elevationAt(la, lo)).sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)];
}

/** A polyline (lat, lon, ...) resampled to n evenly spaced points [[lat, lon], ...]. */
export function resampleLatLon(line, n) {
  const kx = 94600, kz = 110900;
  const P = [];
  for (let i = 0; i < line.length; i += 2) P.push([line[i], line[i + 1]]);
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot((P[i][0] - P[i - 1][0]) * kz, (P[i][1] - P[i - 1][1]) * kx));
  const L = cum[cum.length - 1], out = [];
  for (let k = 0; k < n; k++) {
    const d = (L * k) / (n - 1);
    let i = 1;
    while (i < P.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    out.push([P[i - 1][0] + (P[i][0] - P[i - 1][0]) * t, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * t]);
  }
  return out;
}

/**
 * The deck line of a bridge from its mapped track ways (lines, lat, lon, ...): the ways are
 * chained end to end into tracks, and the deck is the centre line between the two longest
 * tracks (one track: that track). Returns null without tracks.
 */
export function deckFromTracks(lines) {
  const key = (la, lo) => `${la.toFixed(7)},${lo.toFixed(7)}`;
  const left = lines.map((l) => [...l]).filter((l) => l.length >= 4);
  const tracks = [];
  while (left.length) {
    let t = left.shift();
    for (let grown = true; grown;) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const l = left[i], n = l.length, m = t.length;
        const tS = key(t[0], t[1]), tE = key(t[m - 2], t[m - 1]), lS = key(l[0], l[1]), lE = key(l[n - 2], l[n - 1]);
        const rev = (a) => { const o = []; for (let k = a.length - 2; k >= 0; k -= 2) o.push(a[k], a[k + 1]); return o; };
        if (tE === lS) t = [...t, ...l.slice(2)];
        else if (tE === lE) t = [...t, ...rev(l).slice(2)];
        else if (tS === lE) t = [...l, ...t.slice(2)];
        else if (tS === lS) t = [...rev(l), ...t.slice(2)];
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    tracks.push(t);
  }
  if (!tracks.length) return null;
  const len = (t) => { let d = 0; for (let i = 2; i < t.length; i += 2) d += Math.hypot((t[i] - t[i - 2]) * 110900, (t[i + 1] - t[i - 1]) * 94600); return d; };
  tracks.sort((a, b) => len(b) - len(a));
  if (tracks.length === 1) return tracks[0].map(round);
  const N = Math.max(8, Math.round(Math.max(len(tracks[0]), len(tracks[1])) / 8));
  const a = resampleLatLon(tracks[0], N);
  let b = resampleLatLon(tracks[1], N);
  // Run both the same way (the ways of a double track are often drawn in opposite directions).
  const d = (p, q) => Math.hypot((p[0] - q[0]) * 110900, (p[1] - q[1]) * 94600);
  if (d(a[0], b[0]) > d(a[0], b[N - 1])) b = b.reverse();
  return a.flatMap((p, i) => [round((p[0] + b[i][0]) / 2), round((p[1] + b[i][1]) / 2)]);
}

/**
 * An approximate pylon position for a curved deck: where the straighter end of the deck meets
 * the curve (30 % along from that end), 12 m toward the inside of the curve.
 */
export function pylonFromDeck(deck) {
  const P = resampleLatLon(deck, 21).map(([la, lo]) => [lo * 94600, la * 110900]);
  const heading = (i) => Math.atan2(P[i + 1][1] - P[i][1], P[i + 1][0] - P[i][0]);
  const turn = (i0, i1) => { let t = 0; for (let i = i0; i + 1 < i1; i++) { let a = heading(i + 1) - heading(i); a = Math.atan2(Math.sin(a), Math.cos(a)); t += Math.abs(a); } return t; };
  const fromStart = turn(0, 7) <= turn(P.length - 8, P.length - 1);
  const i = fromStart ? 6 : P.length - 7;
  const mid = [(P[0][0] + P[P.length - 1][0]) / 2, (P[0][1] + P[P.length - 1][1]) / 2];
  const tx = P[i + 1][0] - P[i - 1][0], tz = P[i + 1][1] - P[i - 1][1], tl = Math.hypot(tx, tz) || 1;
  let nx = -tz / tl, nz = tx / tl;
  if ((mid[0] - P[i][0]) * nx + (mid[1] - P[i][1]) * nz < 0) { nx = -nx; nz = -nz; }
  return { lat: round((P[i][1] + nz * 12) / 110900), lon: round((P[i][0] + nx * 12) / 94600) };
}

/**
 * The Knesset, the Chords Bridge and the hills east of the Old City, from generic features
 * (OSM ways or tile buildings) and nodes; approximate positions fill the gaps.
 */
export function extractModern(features, nodes = [], { roads = [] } = {}) {
  const nameOf = (f) => `${f.tags['name:en'] ?? ''}|${f.tags.name ?? ''}|${f.tags['name:he'] ?? ''}`;
  const find = (re, pred = (f) => !!f.tags.building) => features.find((f) => pred(f) && re.test(nameOf(f)));
  const node = (re) => nodes.find((n) => re.test(nameOf(n)));
  const at = (p, fallback) => (p ? { lat: round(p.lat), lon: round(p.lon), approximate: false } : { ...fallback, approximate: true });
  // A mapped feature: node position or outline centroid (with its id; ways are replaced).
  const mapped = (f, fallback) => {
    if (!f) return { ...fallback, approximate: true };
    const c = f.ring ? centroid(f.ring) : f;
    return { id: f.id, lat: round(c.lat), lon: round(c.lon), approximate: false };
  };
  const distM = (a, b) => Math.hypot((a.lat - b.lat) * 110900, (a.lon - b.lon) * 94600);
  const nearTo = (p, r) => (f) => distM(f.ring ? centroid(f.ring) : f, p) < r;
  const outline = (f) => f && { id: f.id, name: f.tags['name:en'] ?? f.tags.name ?? null, ring: f.ring };
  const replaces = [];

  const knesset = find(/^Knesset\||משכן הכנסת/);
  // The Knesset's office wings: big unnamed buildings right next to it (within 30 m).
  const near = (f, g, d) => {
    for (let i = 0; i < f.ring.length; i += 2) {
      for (let j = 0; j < g.ring.length; j += 2) {
        if (Math.hypot((f.ring[i] - g.ring[j]) * 110900, (f.ring[i + 1] - g.ring[j + 1]) * 94600) < d) return true;
      }
    }
    return false;
  };
  const wings = knesset ? features.filter((f) => f !== knesset && f.tags.building && !f.tags.name && f.ring.length >= 8 && near(f, knesset, 30) && areaM2(f.ring) > 1500) : [];
  const menorahNode = node(/Knesset Menorah|מנורת הכנסת/) ?? nodes.find((n) => (n.tags.historic === 'memorial' || n.tags.tourism === 'artwork') && /Menorah|מנורה/.test(nameOf(n)));
  // The bridge: the light-rail tracks on it (bridge=yes, named for it or tagged with its
  // Wikidata item), chained, give the deck line (the centre between the two tracks).
  const BRIDGE = /Chords Bridge|Bridge of Strings|גשר המיתרים/;
  const onBridge = (f) => f.line && f.tags.railway === 'light_rail' && (BRIDGE.test(`${nameOf(f)}|${f.tags['bridge:name'] ?? ''}|${f.tags.alt_name ?? ''}|${f.tags['alt_name:en'] ?? ''}`) || f.tags.wikidata === 'Q1057872');
  const tracks = features.filter(onBridge);
  const deck = deckFromTracks(tracks.map((f) => f.line)) ?? [...APPROX.chordsBridge.deck];
  // The pylon: a mapped tower / pylon beside the deck, if any (bus stops and the like are
  // named after the bridge too, so only structures count).
  const deckPts = resampleLatLon(deck, 12).map(([lat, lon]) => ({ lat, lon }));
  const pylonNode = nodes.find((n) => (n.tags.man_made === 'tower' || n.tags.man_made === 'pylon' || n.tags['bridge:support']) &&
    (BRIDGE.test(nameOf(n)) || n.tags['tower:type'] === 'bridge') && deckPts.some((q) => distM(q, n) < 60));
  const pylonApprox = tracks.length ? { ...pylonFromDeck(deck) } : APPROX.chordsBridge.pylon;

  const church = (re) => outline(find(re));
  // The Jewish cemetery on the Mount of Olives: its mapped outline (the largest such area;
  // the individual plots are mapped inside it). Mapped buildings inside it: no graves there.
  const cemAreas = features.filter((f) => (f.tags.landuse === 'cemetery' || f.tags.amenity === 'grave_yard') && f.tags.religion === 'jewish' &&
    /Mount of Olives|הר הזיתים/.test(nameOf(f)) && f.ring.length >= 8);
  cemAreas.sort((a, b) => areaM2(b.ring) - areaM2(a.ring));
  const cemFeature = cemAreas[0] ?? null;
  const cem = cemFeature ? cemFeature.ring : APPROX.cemetery;
  const inCem = features.filter((f) => f.tags.building && f.ring.length >= 6 && inRing(cem, centroid(f.ring).lat, centroid(f.ring).lon)).map((f) => f.ring);
  // Roads and paths through the cemetery: no graves on them either (a thin rectangle per
  // segment, the road's width plus a margin).
  const ROAD_W = { primary: 10, secondary: 9, tertiary: 8, unclassified: 7, residential: 7, service: 5, living_street: 5, pedestrian: 4, footway: 2.5, path: 2.5, steps: 2.5, track: 3 };
  for (const r of roads) {
    const w = ROAD_W[r.tags.highway];
    if (!w) continue;
    const half = w / 2 + 0.8;
    for (let i = 0; i + 3 < r.line.length; i += 2) {
      const a = { lat: r.line[i], lon: r.line[i + 1] }, b = { lat: r.line[i + 2], lon: r.line[i + 3] };
      if (!inRing(cem, a.lat, a.lon) && !inRing(cem, b.lat, b.lon) && !inRing(cem, (a.lat + b.lat) / 2, (a.lon + b.lon) / 2)) continue;
      const dx = (b.lon - a.lon) * 94600, dz = (b.lat - a.lat) * 110900, l = Math.hypot(dx, dz);
      if (l < 0.5) continue;
      const ox = (-dz / l) * half / 94600, oz = (dx / l) * half / 110900; // perpendicular, in degrees
      const ex = (dx / l) * 0.5 / 94600, ez = (dz / l) * 0.5 / 110900; // half a metre past each end
      inCem.push([a.lat - ez + oz, a.lon - ex + ox, b.lat + ez + oz, b.lon + ex + ox, b.lat + ez - oz, b.lon + ex - ox, a.lat - ez - oz, a.lon - ex - ox].map(round));
    }
  }
  // Towers and buildings on the ridges, by name or structure, near their approximate positions.
  // The Russian bell tower is the tallest bell tower on the ridge (64 m).
  const bellTower = features.filter((f) => f.tags['tower:type'] === 'bell_tower' && nearTo(APPROX.bellTower, 350)(f))
    .sort((a, b) => (parseFloat(b.tags.height) || 0) - (parseFloat(a.tags.height) || 0))[0] ?? null;
  const sevenArchesParts = features.filter((f) => f.tags.building && /7 Arches|Seven Arches|שבע הקשתות/.test(nameOf(f)));
  const sevenArches = sevenArchesParts.length ? { id: sevenArchesParts[0].id, ring: sevenArchesParts.flatMap((f) => f.ring) } : null;
  const uniTower = features.find((f) => f.tags.building && /Har Hatzofim Tower|Mount Scopus Tower|מגדל הר הצופים|Hebrew University.*Tower|מגדל האוניברסיטה/.test(nameOf(f)));
  // Augusta Victoria: the Church of the Ascension (a node in the compound), else the compound.
  const avCompound = features.find((f) => /Augusta Victoria|Auguste Victoria|Auguste-Viktoria/.test(nameOf(f)) && !f.tags.building && !f.tags.landuse);
  const avChurch = nodes.find((n) => n.tags.amenity === 'place_of_worship' && /Himmelfahrt|Ascension|Augusta Victoria|Auguste Victoria|אוגוסטה ויקטוריה/.test(`${nameOf(n)}|${n.tags['name:de'] ?? ''}|${n.tags.alt_name ?? ''}|${n.tags['alt_name:en'] ?? ''}`) &&
    (avCompound ? inRing(avCompound.ring, n.lat, n.lon) : distM(n, APPROX.augustaVictoria) < 300));
  const olives = {
    cemetery: cemFeature ? { id: cemFeature.id, ring: [...cem], approximate: false, exclude: inCem } : { ring: [...cem], approximate: true, exclude: inCem },
    maryMagdalene: church(/Church of Mary Magdalene/),
    allNations: church(/Church of All Nations/),
    absalom: church(/Tomb of Absalom|יד אבשלום/),
    zechariah: church(/Tomb of Zacharias|Tomb of Zechariah|קבר זכריה/),
    bellTower: mapped(bellTower, APPROX.bellTower),
    chapelAscension: mapped(find(/Chapel of the Ascension/), APPROX.chapelAscension),
    sevenArches: mapped(sevenArches, APPROX.sevenArches),
  };
  const scopus = {
    universityTower: mapped(uniTower, APPROX.universityTower),
    augustaVictoria: mapped(avChurch, APPROX.augustaVictoria),
  };
  for (const k of ['maryMagdalene', 'allNations', 'absalom', 'zechariah']) if (olives[k]) replaces.push(olives[k].id);
  // The generic buildings where the tower / chapel / hotel models stand.
  for (const f of [bellTower, find(/Chapel of the Ascension/), uniTower, ...sevenArchesParts]) if (f?.tags?.building) replaces.push(f.id);
  // The Augusta Victoria church and hospital are mapped as one courtyard building: the model
  // (church and tower) replaces the building the church stands in.
  if (avChurch) for (const f of features) if (f.tags.building && f.ring.length >= 6 && inRing(f.ring, avChurch.lat, avChurch.lon)) replaces.push(f.id);
  if (knesset) replaces.push(knesset.id, ...wings.map((w) => w.id));
  return {
    modern: {
      knesset: outline(knesset),
      knessetWings: wings.map((w) => ({ id: w.id, ring: w.ring, holes: w.holes ?? [] })),
      menorah: at(menorahNode, APPROX.menorah),
      chordsBridge: { deck, tracks: tracks.map((f) => f.id), pylon: at(pylonNode, pylonApprox), approximate: !tracks.length },
    },
    olives,
    scopus,
    replaces,
  };
}

/**
 * Extracts the landmark data from merged OSM data (see osm_api.js).
 * `elevationAt(lat, lon)` (m, optional): the DEM, for the level of the road under the bridge.
 * `tileBuildings` (optional, [{ id, tags, ring }]): buildings from the tile files, added where the
 * fetched boxes miss them (the cemetery's `exclude`, what the ridge models stand in).
 */
export function extractLandmarks(osm, { elevationAt = null, tileBuildings = [] } = {}) {
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

  // Western Wall prayer sections (their split places the partition) and the Mughrabi Gate
  // (the top of the bridge from the plaza up to the esplanade).
  const section = (re) => {
    const n = nodes.find((x) => re.test(x.tags['name:en'] ?? ''));
    return n ? { lat: round(n.lat), lon: round(n.lon) } : null;
  };
  const prayer = { men: section(/Western Wall men/), women: section(/Western Wall women/) };
  const mughrabiWay = ways.find((w) => /Mughrabi Gate/.test(nameEn(w)) && w.tags.building);
  const mughrabi = mughrabiWay ? { id: `w${mughrabiWay.id}`, ring: openRing(wayPts(mughrabiWay)) } : null;

  // Where streets pass through the walls: openings are cut there (gates, the breach beside
  // Jaffa Gate). Ground-level ways only (no tunnels or bridges).
  const ROAD_WIDTH = { primary: 9, secondary: 9, tertiary: 8, unclassified: 7, residential: 7, service: 5, pedestrian: 5, living_street: 5, footway: 3, path: 3, steps: 3, cycleway: 3 };
  const crossings = [];
  const segX = (a, b, c, d) => {
    // Intersection of segments ab and cd in (lon, lat), or null.
    const r = [b.lon - a.lon, b.lat - a.lat], q = [d.lon - c.lon, d.lat - c.lat];
    const den = r[0] * q[1] - r[1] * q[0];
    if (Math.abs(den) < 1e-15) return null;
    const t = ((c.lon - a.lon) * q[1] - (c.lat - a.lat) * q[0]) / den, u = ((c.lon - a.lon) * r[1] - (c.lat - a.lat) * r[0]) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { lat: a.lat + t * r[1], lon: a.lon + t * r[0] } : null;
  };
  const wallGeoms = walls.map((w) => ({ id: w.id, g: wayGeometry(osm, osm.ways.get(Number(w.id.slice(1)))) }));
  for (const road of ways) {
    const t = road.tags;
    const width = ROAD_WIDTH[t.highway];
    if (!width || t.tunnel === 'yes' || t.bridge === 'yes' || Number(t.layer ?? 0) !== 0 || t.covered === 'yes') continue;
    // Pedestrian squares are mapped as closed areas; their outlines are not passages.
    if (road.refs[0] === road.refs[road.refs.length - 1] && (t.area === 'yes' || t.place || t.highway === 'pedestrian')) continue;
    const g = wayGeometry(osm, road);
    for (let i = 1; i < g.length; i++) {
      for (const wall of wallGeoms) {
        for (let k = 1; k < wall.g.length; k++) {
          const x = segX(g[i - 1], g[i], wall.g[k - 1], wall.g[k]);
          if (!x) continue;
          // Angle between the street and the wall (0 = running along it, 90 = straight through).
          const ang = (p, q) => Math.atan2((q.lat - p.lat) * 110900, (q.lon - p.lon) * 94600);
          let angle = Math.abs(ang(g[i - 1], g[i]) - ang(wall.g[k - 1], wall.g[k])) % Math.PI;
          angle = Math.round((Math.min(angle, Math.PI - angle) * 180) / Math.PI);
          crossings.push({ wall: wall.id, lat: round(x.lat), lon: round(x.lon), width, angle, highway: t.highway, name: t['name:en'] ?? t.name ?? null });
        }
      }
    }
  }

  // The Wilson's Arch prayer hall: a low vaulted hall against the Wall at the north end of the
  // prayer plaza (the map has no height, so the generic generator made it a 3-6 storey block).
  const wilsonWay = ways.find((w) => /Wilson's Arch/.test(nameEn(w)) && w.tags.building);
  const wilson = wilsonWay ? { id: `w${wilsonWay.id}`, ring: openRing(wayPts(wilsonWay)) } : null;
  if (wilson) replaces.push(wilson.id);
  // Other stretches mapped as building=wall (e.g. south of the prayer area): plain stone masses.
  const plainWalls = ways
    .filter((w) => w.tags.building === 'wall' && w !== ww && w.refs.length >= 4)
    .map((w) => ({ id: `w${w.id}`, ring: openRing(wayPts(w)), height: Number(w.tags.height ?? 12) }));
  for (const w of plainWalls) replaces.push(w.id);

  // The Old City: convex hull of the city walls. Inside it, buildings without a mapped height
  // default to 2-3 storeys (it is low-rise), not the 3-6 of the modern city.
  const hullPts = walls.flatMap((w) => { const o = []; for (let i = 0; i < w.points.length; i += 2) o.push([w.points[i + 1], w.points[i]]); return o; });
  hullPts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of hullPts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...hullPts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)].flatMap(([lon, lat]) => [round(lat), round(lon)]);

  const patches = [];
  let haram = null;
  let modern = null;
  if (tm) {
    const features = ways
      .filter((w) => w.refs.length >= 4 && w.refs[0] === w.refs[w.refs.length - 1])
      .map((w) => ({ id: `w${w.id}`, tags: w.tags, ring: openRing(wayPts(w)) }));
    // Building multipolygons (e.g. a Knesset wing, with its courtyards): the largest outer ring
    // with the inner rings as holes.
    for (const r of rels) {
      if (!r.tags.building || r.tags.type !== 'multipolygon') continue;
      const outer = relRings(r, 'outer').map(openRing).filter((q) => q.length >= 6);
      if (!outer.length) continue;
      outer.sort((a, b) => areaM2(b) - areaM2(a));
      features.push({ id: `r${r.id}`, tags: r.tags, ring: outer[0], holes: relRings(r, 'inner').map(openRing).filter((q) => q.length >= 6) });
    }
    const known = new Set(features.map((f) => f.id));
    for (const b of tileBuildings) if (!known.has(b.id) && b.ring?.length >= 6) { known.add(b.id); features.push(b); }
    const trees = nodes.filter((n) => n.tags.natural === 'tree').flatMap((n) => [n.lat, n.lon]);
    const nodeList = nodes.filter((n) => Object.keys(n.tags).length).map((n) => ({ id: `n${n.id}`, tags: n.tags, lat: n.lat, lon: n.lon }));
    const h = extractHaram(features, nodeList, relRings(tm, 'outer')[0], trees);
    const lines = ways.filter((w) => w.tags.bridge === 'yes' && (w.tags.railway || w.tags.highway)).map((w) => ({ id: `w${w.id}`, tags: w.tags, ring: [], line: wayPts(w) }));
    const roads = ways.filter((w) => w.tags.highway && !(w.refs[0] === w.refs[w.refs.length - 1] && w.tags.area === 'yes') && w.tags.tunnel !== 'yes')
      .map((w) => ({ id: `w${w.id}`, tags: w.tags, line: wayPts(w) }));
    modern = extractModern([...features, ...lines], nodeList, { roads });
    replaces.push(...modern.replaces);
    haram = h.haram;
    replaces.push(...h.replaces);
    const up = upperPlatformPatch(haram);
    if (up) patches.push(up);
  }
  // Outer outline only: the relation's inner ring (the Marwani mosque garden) is excluded from
  // the land use, but physically it lies on the esplanade too.
  if (tm) patches.push({ name: 'Temple Mount esplanade', mode: 'raise', elevation: ELEVATION.esplanade, rings: relRings(tm, 'outer') });
  // The ground around the plaza blends back to the DEM over 60 m: it rises gently to the
  // Jewish Quarter and Chain Street, and stays near plaza level toward Dung Gate.
  if (plaza) patches.push({ name: 'Western Wall Plaza', mode: 'lower', elevation: ELEVATION.plaza, falloff: 60, rings: [openRing(wayPts(plaza))] });
  // Last, as --from-tiles appends it: the road level under the Chords Bridge.
  if (modern?.modern.chordsBridge) {
    const deck = modern.modern.chordsBridge.deck;
    patches.push(bridgeJunctionPatch(deck, elevationAt ? { elevation: deckElevation(deck, elevationAt) } : {}));
  }

  return {
    format: 'landmarks-v1',
    source: 'OpenStreetMap via the main API',
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    bbox: { ...OLD_CITY_BBOX },
    elevation: { ...ELEVATION },
    oldCity: { ring: hull, floorsMin: 2, floorsMax: 3 },
    lowRise: LOW_RISE_AREAS.map((a) => ({ ...a, ring: [...a.ring] })),
    walls,
    crossings,
    wilson,
    plainWalls,
    gates,
    prayer,
    mughrabi,
    westernWall: ww ? { id: `w${ww.id}`, ring: openRing(wayPts(ww)), height: Number(ww.tags.height ?? 20) } : null,
    plaza: plaza ? { id: `w${plaza.id}`, ring: openRing(wayPts(plaza)) } : null,
    templeMount: tm ? { id: `r${tm.id}`, outer: relRings(tm, 'outer'), inner: relRings(tm, 'inner') } : null,
    citadel,
    sepulchre,
    haram,
    modern: modern?.modern ?? null,
    olives: modern?.olives ?? null,
    scopus: modern?.scopus ?? null,
    patches,
    replaces: [...new Set(replaces)],
  };
}

/** --from-tiles: rebuilds `haram` (and its patch and replaced ids) from the tile files. */
async function fromTiles() {
  const { readFile, readdir } = await import('node:fs/promises');
  const data = JSON.parse(await readFile(OUT, 'utf8'));
  if (!data.templeMount) throw new Error('landmarks.json has no templeMount outline: run the full fetch first');
  const dir = resolve(dirname(OUT), 'tiles');
  const features = [], trees = [];
  const seen = new Set();
  for (const file of (await readdir(dir)).filter((f) => /^osm_.*\.json$/.test(f))) {
    const t = JSON.parse(await readFile(resolve(dir, file), 'utf8'));
    for (const b of t.buildings ?? []) if (!seen.has(b.id) && b.rings?.[0]) { seen.add(b.id); features.push({ id: b.id, tags: b.tags ?? {}, ring: openRing(b.rings[0]), holes: b.rings.slice(1).map(openRing) }); }
    for (const p of t.parks ?? []) if (!seen.has(p.id) && p.rings?.[0]) { seen.add(p.id); features.push({ id: p.id, tags: { leisure: p.kind, ...(p.name ? { name: p.name } : {}) }, ring: openRing(p.rings[0]) }); }
    if (Array.isArray(t.trees)) trees.push(...t.trees);
  }
  const { haram, replaces } = extractHaram(features, [], data.templeMount.outer[0], trees);
  const modern = extractModern(features);
  const oldModern = new Set([data.modern?.knesset?.id, ...(data.modern?.knessetWings ?? []).map((w) => w.id), ...['maryMagdalene', 'allNations', 'absalom', 'zechariah'].map((k) => data.olives?.[k]?.id)]);
  data.modern = modern.modern;
  data.olives = modern.olives;
  data.scopus = modern.scopus;
  replaces.push(...modern.replaces);
  const old = new Set([data.haram?.domeOfTheRock?.id, data.haram?.aqsa?.id, data.haram?.domeOfTheChain?.id, ...(data.haram?.arcades ?? []).map((a) => a.id), ...(data.haram?.domes ?? []).map((d) => d.id)]);
  data.haram = haram;
  data.lowRise = LOW_RISE_AREAS.map((a) => ({ ...a, ring: [...a.ring] }));
  data.patches = data.patches.filter((p) => p.name !== 'Chords Bridge junction');
  data.patches.push(bridgeJunctionPatch(data.modern.chordsBridge.deck));
  data.replaces = [...new Set([...data.replaces.filter((id) => !old.has(id) && !oldModern.has(id)), ...replaces])];
  data.patches = data.patches.filter((p) => p.name !== 'Dome of the Rock platform');
  const up = upperPlatformPatch(haram);
  if (up) data.patches.unshift(up);
  const json = JSON.stringify(data);
  await writeFile(OUT, json);
  console.log(`[landmarks] haram from tiles: dome of the rock ${!!haram.domeOfTheRock}, al-aqsa ${!!haram.aqsa}, dome of the chain ${!!haram.domeOfTheChain},` +
    ` ${haram.arcades.length} arcades, ${haram.domes.length} small domes, ${haram.groves.length} groves, ${haram.minarets.length} minarets` +
    ` (${haram.minarets.filter((m) => m.approximate).length} approximate), ${haram.trees.length / 2} trees, platform ${!!haram.upperPlatform}; wrote ${(json.length / 1024).toFixed(0)} KB`);
}

async function main() {
  if (process.argv.includes('--from-tiles')) return fromTiles();
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  if (arg('--raw')) {
    // Offline: a dump written by --save-raw (no API requests).
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(arg('--raw'), 'utf8'));
    const osm = { nodes: new Map(raw.nodes.map((n) => [n.id, n])), ways: new Map(raw.ways.map((w) => [w.id, w])), relations: new Map(raw.relations.map((r) => [r.id, r])) };
    return write(extractLandmarks(osm, { elevationAt: await demSampler(), tileBuildings: await readTileBuildings() }), raw.fetchedAt);
  }
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
  for (const b of EXTRA_BBOXES) {
    docs.push(await fetchOsmMap(b));
    process.stdout.write(`\r[landmarks] ${b.name}          `);
  }
  process.stdout.write('\n');
  const osm = mergeOsm(docs);
  const fetchedAt = new Date().toISOString();
  if (arg('--save-raw')) {
    await writeFile(arg('--save-raw'), JSON.stringify({ fetchedAt, nodes: [...osm.nodes.values()], ways: [...osm.ways.values()], relations: [...osm.relations.values()] }));
  }
  return write(extractLandmarks(osm, { elevationAt: await demSampler(), tileBuildings: await readTileBuildings() }), fetchedAt);
}

/** Buildings from the tile files in public/data/tiles ({ id, tags, ring: lat, lon, ... }). */
async function readTileBuildings() {
  const { readFile, readdir } = await import('node:fs/promises');
  const dir = resolve(dirname(OUT), 'tiles');
  const out = [], seen = new Set();
  let files = [];
  try { files = (await readdir(dir)).filter((f) => /^osm_.*\.json$/.test(f)); } catch { return out; }
  for (const file of files) {
    const t = JSON.parse(await readFile(resolve(dir, file), 'utf8'));
    for (const b of t.buildings ?? []) {
      if (seen.has(b.id) || !b.rings?.[0]) continue;
      seen.add(b.id);
      out.push({ id: b.id, tags: b.tags ?? {}, ring: openRing(b.rings[0]), holes: b.rings.slice(1).map(openRing) });
    }
  }
  return out;
}

/** The game's DEM (public/data/tiles/dem_points.json) as elevationAt(lat, lon) in m, or null. */
async function demSampler() {
  const { readFile } = await import('node:fs/promises');
  const { createProjection } = await import('../src/city/geo.js');
  const { createTerrain } = await import('../src/city/terrain.js');
  try {
    const tiles = resolve(dirname(OUT), 'tiles');
    const manifest = JSON.parse(await readFile(resolve(tiles, 'manifest.json'), 'utf8'));
    const dem = JSON.parse(await readFile(resolve(tiles, 'dem_points.json'), 'utf8'));
    const P = createProjection(manifest.worldBBox), T = createTerrain(dem, P);
    return (lat, lon) => { const q = P.project(lat, lon); return T.heightAt(q.x, q.z) + T.datum; };
  } catch (err) {
    console.warn(`[landmarks] no DEM (${err.message}): the bridge junction keeps its default level`);
    return null;
  }
}

async function write(data, fetchedAt) {
  data.fetchedAt = fetchedAt;
  await mkdir(dirname(OUT), { recursive: true });
  const json = JSON.stringify(data);
  await writeFile(OUT, json);
  console.log(`[landmarks] wrote ${OUT} (${(json.length / 1024).toFixed(0)} KB): ${data.walls.length} wall ways, ${data.gates.length} gates` +
    ` (${data.gates.map((g) => g.name).join(', ')}), western wall ${!!data.westernWall}, plaza ${!!data.plaza}, temple mount ${!!data.templeMount},` +
    ` citadel ${!!data.citadel} (minaret ${!!data.citadel?.minaret}), sepulchre parts ${data.sepulchre?.parts.length ?? 0}, replaces ${data.replaces.length},` +
    ` ${data.crossings.length} street crossings, prayer sections ${!!data.prayer.men && !!data.prayer.women}, Mughrabi Gate ${!!data.mughrabi}` +
    (data.haram ? `; haram: ${data.haram.arcades.length} arcades, ${data.haram.domes.length} small domes, ${data.haram.groves.length} groves,` +
      ` ${data.haram.minarets.length} minarets (${data.haram.minarets.filter((m) => m.approximate).length} approximate)` : ''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
