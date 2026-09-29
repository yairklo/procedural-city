#!/usr/bin/env node
// One-time data ingestion for the city's markets and remaining landmarks: downloads small areas
// from the main OpenStreetMap API (scripts/osm_api.js) and writes public/data/sites.json
// (lat / lon; the game projects it), read by src/city/landmarks/sites.js:
//
//   market      Mahane Yehuda: the covered block between Mahane Yehuda Street (open-air) and
//               Etz Haim Street (under a vaulted roof), cut into shop blocks by the fruit-named
//               alleys; the frontage along both streets and the alleys (where the shopfronts
//               are, so the stalls stand in front of them); the Iraqi market square and the
//               Georgian courtyard (free spots for stalls and tables)
//   souks       the Old City's market streets by name: the vaulted ones (David Street, the
//               three Crusader markets, al-Qattanin, Khan al-Zeit, the covered Cardo) and the
//               open ones with stalls (Christian Quarter Road, Aftimos, the Muristan, Silsila,
//               al-Wad), with their frontage and the goods they sell
//   cardo       the open, excavated part of the Cardo (Byzantine columns)
//   infill      the Old City is built wall to wall, but OSM does not map every building: the
//               unmapped gaps inside the walls (not a street, square, garden, courtyard,
//               excavation or landmark) become low stone buildings, as boxes
//   riwaq       the porticoes along the Temple Mount esplanade's west and north sides: the line of
//               the buildings' inner facades (from the mapped buildings), in stretches
//   hurva, ymca, kingDavid   outlines of the Hurva Synagogue, the YMCA and the King David Hotel
//   mamilla     Mamilla Avenue (the open-air mall promenade) and its buildings
//   lowRise     areas for the city generator: the market streets (2-3 storeys, every ground
//               floor a shop), Mamilla (shops everywhere); the facade style of the old
//               neighbourhoods (19th / early 20th century stone houses: tall shuttered windows,
//               iron balconies, 2-3 storeys) as circles around their place nodes, and of the
//               downtown triangle (a box); approximate, flagged
//   replaces    OSM building ids the models replace, and `excludes` (with reasons): mapped
//               buildings that don't stand (yet)
//
//   node scripts/fetch_sites.js                          (downloads ~14 small areas)
//   node scripts/fetch_sites.js --save-raw <file.json>   (also keeps the raw OSM dump)
//   node scripts/fetch_sites.js --raw <file.json>        (offline, from such a dump)
//
// Data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0).

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchOsmMap, mergeOsm, wayGeometry } from './osm_api.js';
import { stitchRings } from './fetch_jerusalem.js';
import { OLD_CITY_BBOX } from './fetch_landmarks.js';
import { createProjection } from '../src/city/geo.js';
import { pointInRings, segmentDistance, orientedBox } from '../src/city/footprint.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/sites.json');

export const SITE_BOXES = Object.freeze([
  { name: 'Mahane Yehuda', south: 31.7835, west: 35.2095, north: 31.7870, east: 35.2150 },
  { name: 'King David Hotel and YMCA', south: 31.7730, west: 35.2205, north: 31.7760, east: 35.2240 },
  { name: 'Mamilla', south: 31.7765, west: 35.2235, north: 31.7800, east: 35.2275 },
]);

// Mapped buildings that do not stand: two 30-storey towers drawn over the Etz Haim Yeshiva
// site by the market (no name; the site itself is tagged construction=yes, "being expanded
// into a multi-use site"): the project is being built, the towers are not there.
export const EXCLUDE = Object.freeze([
  { id: 'w1261829352', reason: 'planned 30-storey tower on the Etz Haim site (under construction, not built)' },
  { id: 'w1261829353', reason: 'planned 30-storey tower on the Etz Haim site (under construction, not built)' },
]);

// Old neighbourhoods (place nodes in the tile manifest, by English name) and the radius (m) of
// the area around each that gets the historic facade style and 2-3 storey defaults.
export const HISTORIC = Object.freeze({
  'Meah Shearim': 260, 'Batei Ungarin': 150, 'Beit Yisroel': 220, 'Zikhron Moshe': 170, 'Kerem Avraham': 200,
  "Sha'arei Yerushalayim": 170, 'מקור ברוך': 200, 'Nahlaot': 330, 'Shaarei Hesed': 170, 'Nahalat Shiva': 110,
  'Mahane Israel': 110, 'Morasha': 200, 'Russian Compound': 120, 'German Colony': 300, 'Bab a-Zahara': 180,
  'Silwan': 300, 'Ras al-Amud': 280, 'at-Tur': 320, 'Wadi al-Joz': 250,
});
// The downtown triangle (Jaffa Road, Ben Yehuda, King George): commercial facades (approximate box).
export const DOWNTOWN = Object.freeze({ name: 'Downtown', approximate: true, facade: 'downtown', ring: [31.7840, 35.2135, 31.7840, 35.2228, 31.7797, 35.2228, 31.7797, 35.2135] });

// Old City market streets (OSM names, English or Hebrew / Arabic), whether they are vaulted
// over, and what they sell.
export const SOUKS = Object.freeze([
  { re: /^David Street$|^דוד$/, name: 'David Street', covered: true, goods: 'souvenir' },
  { re: /La'?h'?hamin|הקצבים/, name: 'Suq al-Lahhamin', covered: true, goods: 'butcher' },
  { re: /Attarin|העטרים|הבשמים/, name: 'Suq al-Attarin', covered: true, goods: 'spice' },
  { re: /Khawajat|הסוחרים/, name: 'Suq al-Khawajat', covered: true, goods: 'fabric' },
  { re: /Qattan|הכותנה/, name: 'Suq al-Qattanin', covered: true, goods: 'fabric' },
  { re: /Khan al-Zeit|Khan Az-Zait|^Beit HaBad$|^בית הבד$/, name: 'Suq Khan al-Zeit', covered: true, goods: 'food' },
  { re: /^HaKardo$|^הקארדו$/, name: 'The Cardo', covered: true, goods: 'gallery', onlyTunnel: true },
  { re: /Christian Quarter|^הנוצרים$/, name: 'Christian Quarter Road', covered: false, goods: 'souvenir' },
  { re: /Aftimos|אבטימוס/, name: 'Suq Aftimos', covered: false, goods: 'souvenir' },
  { re: /^Muristan Street$|^מוריסטאן$/, name: 'Muristan', covered: false, goods: 'souvenir' },
  { re: /^Silsileh$|^השלשלת$/, name: 'Chain Street', covered: false, goods: 'souvenir' },
  { re: /^Al Wadi$|^הגיא$/, name: 'al-Wad', covered: false, goods: 'food' },
]);

const round = (v) => Math.round(v * 1e7) / 1e7;
const closed = (w) => w.refs.length >= 4 && w.refs[0] === w.refs[w.refs.length - 1];
const nameOf = (t) => `${t['name:en'] ?? ''}|${t.name ?? ''}|${t['name:he'] ?? ''}`;
const nameEn = (t) => t['name:en'] ?? t.name ?? null;

/** Packs a boolean array into base64 (bit i of byte i >> 3). */
export function packBits(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (i & 7); });
  return Buffer.from(bytes).toString('base64');
}

/**
 * @param {{ nodes: Map, ways: Map, relations: Map }} osm
 * @param {{ worldBBox: object, oldCity: number[] | null, keepOut: number[][] }} ctx
 *   oldCity: the Old City outline (lat, lon, ...); keepOut: rings (lat, lon, ...) where no
 *   infill may stand (the Temple Mount, the plaza, the landmark models, a band along the walls)
 */
export function extractSites(osm, { worldBBox, oldCity = null, walls = null, keepOut = [], tileBuildings = [], templeMount = null, places = [] }) {
  const P = createProjection(worldBBox);
  const xz = (ll) => P.projectFlat(ll);
  const toLL = (x, z) => { const q = P.unproject(x, z); return [round(q.lat), round(q.lon)]; };
  const pts = (w) => wayGeometry(osm, w).flatMap((p) => [round(p.lat), round(p.lon)]);
  const open = (r) => (r.length >= 4 && r[0] === r[r.length - 2] && r[1] === r[r.length - 1] ? r.slice(0, -2) : r);
  const ways = [...osm.ways.values()];
  const byId = (id) => osm.ways.get(Number(String(id).slice(1)));

  // --- buildings (x, z), with a coarse grid of their edges for ray casts ---------------------------
  const buildings = [];
  const seen = new Set();
  for (const w of ways) {
    if (!w.tags.building || !closed(w)) continue;
    seen.add(`w${w.id}`);
    buildings.push({ id: `w${w.id}`, tags: w.tags, rings: [xz(open(pts(w)))] });
  }
  for (const r of osm.relations.values()) {
    if (!r.tags.building || r.tags.type !== 'multipolygon') continue;
    const ring = (role) => stitchRings(r.members.filter((m) => m.type === 'way' && (role === 'outer' ? m.role !== 'inner' : m.role === 'inner'))
      .map((m) => osm.ways.get(m.ref)).filter(Boolean).map((w) => wayGeometry(osm, w)));
    const outer = ring('outer'), inner = ring('inner');
    seen.add(`r${r.id}`);
    for (const o of outer) buildings.push({ id: `r${r.id}`, tags: r.tags, rings: [xz(o), ...inner.map(xz)] });
  }
  for (const b of tileBuildings) if (!seen.has(b.id)) { seen.add(b.id); buildings.push({ id: b.id, tags: b.tags, rings: b.rings.map((r) => xz(open(r))) }); }
  const excluded = new Set(EXCLUDE.map((e) => e.id));
  const GRID = 20;
  const edgeGrid = new Map();
  const addEdges = (list) => {
    for (const b of list) {
      if (excluded.has(b.id)) continue;
      for (const r of b.rings) {
        for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
          const e = { ax: r[j], az: r[j + 1], bx: r[i], bz: r[i + 1], id: b.id };
          const x0 = Math.floor(Math.min(e.ax, e.bx) / GRID), x1 = Math.floor(Math.max(e.ax, e.bx) / GRID);
          const z0 = Math.floor(Math.min(e.az, e.bz) / GRID), z1 = Math.floor(Math.max(e.az, e.bz) / GRID);
          for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
            const k = `${gx},${gz}`;
            if (!edgeGrid.has(k)) edgeGrid.set(k, []);
            edgeGrid.get(k).push(e);
          }
        }
      }
    }
  };
  addEdges(buildings);
  /** Distance along the ray (x, z) + t (dx, dz) to the nearest building edge, up to max. */
  const ray = (x, z, dx, dz, max, skip = null) => {
    let best = null;
    const seenE = new Set();
    for (let t = 0; t <= max + GRID; t += GRID / 2) {
      const k = `${Math.floor((x + dx * t) / GRID)},${Math.floor((z + dz * t) / GRID)}`;
      for (const e of edgeGrid.get(k) ?? []) {
        if (seenE.has(e) || (skip && skip.has(e.id))) continue;
        seenE.add(e);
        const ex = e.bx - e.ax, ez = e.bz - e.az;
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) continue;
        const s = ((e.ax - x) * ez - (e.az - z) * ex) / den;
        const u = ((e.ax - x) * dz - (e.az - z) * dx) / den;
        if (s > 0.05 && s <= max && u >= 0 && u <= 1 && (best === null || s < best)) best = s;
      }
      if (best !== null && best < t) break;
    }
    return best;
  };
  /**
   * Frontage along a street: every `step` m, the distance to the building face on the left
   * and on the right (null where there is none within `max`), and the street direction.
   */
  const frontage = (line, { step = 3.4, max = 9, skip = null } = {}) => {
    const q = xz(line);
    const out = [];
    let carry = step / 2;
    for (let i = 0; i + 3 < q.length; i += 2) {
      const ax = q[i], az = q[i + 1], bx = q[i + 2], bz = q[i + 3];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      for (let d = carry; d <= L; d += step) {
        const x = ax + tx * d, z = az + tz * d;
        // Left normal (x east, z south): (tz, -tx).
        const left = ray(x, z, tz, -tx, max, skip), right = ray(x, z, -tz, tx, max, skip);
        const [lat, lon] = toLL(x, z);
        out.push({ lat, lon, dir: Math.round(Math.atan2(tx, -tz) * 1000) / 1000, left: left === null ? null : Math.round(left * 10) / 10, right: right === null ? null : Math.round(right * 10) / 10 });
      }
      carry = (carry - L) % step;
      if (carry < 0) carry += step;
    }
    return out;
  };

  const replaces = [];

  // --- Mahane Yehuda ------------------------------------------------------------------------------------
  let market = null;
  const lowRise = [];
  const block = ways.find((w) => w.tags.amenity === 'marketplace' && w.tags.building && /Yehuda|יהודה/.test(nameOf(w.tags)) && closed(w));
  const openSt = ways.find((w) => w.tags.highway === 'pedestrian' && /^Mahane Yehuda$|^מחנה יהודה$/.test(w.tags['name:en'] ?? w.tags.name ?? '') && w.refs.length > 5);
  const coveredSt = ways.find((w) => w.tags.highway === 'pedestrian' && /^Etz Haim$|^עץ חיים$/.test(w.tags['name:en'] ?? w.tags.name ?? ''));
  if (block && openSt && coveredSt) {
    replaces.push(`w${block.id}`);
    const W = xz(pts(openSt)), E = xz(pts(coveredSt));
    // Local frame: v runs north along the covered street (its end-to-end direction), u east.
    let vx = E[E.length - 2] - E[0], vz = E[E.length - 1] - E[1];
    const vl = Math.hypot(vx, vz); vx /= vl; vz /= vl;
    if (vz > 0) { vx = -vx; vz = -vz; }
    const ux = -vz, uz = vx;
    const o = { x: E[0], z: E[1] };
    const toUV = (x, z) => ({ u: (x - o.x) * ux + (z - o.z) * uz, v: (x - o.x) * vx + (z - o.z) * vz });
    const fromUV = (u, v) => [o.x + ux * u + vx * v, o.z + uz * u + vz * v];
    const uAt = (line, v) => {
      // u of a street line at v (linear between its points, clamped to its ends).
      const q = [];
      for (let i = 0; i < line.length; i += 2) q.push(toUV(line[i], line[i + 1]));
      q.sort((a, b) => a.v - b.v);
      if (v <= q[0].v) return q[0].u;
      for (let i = 1; i < q.length; i++) if (v <= q[i].v) return q[i - 1].u + ((q[i].u - q[i - 1].u) * (v - q[i - 1].v)) / (q[i].v - q[i - 1].v || 1);
      return q[q.length - 1].u;
    };
    const vRange = (line) => { let a = Infinity, b = -Infinity; for (let i = 0; i < line.length; i += 2) { const v = toUV(line[i], line[i + 1]).v; a = Math.min(a, v); b = Math.max(b, v); } return [a, b]; };
    const blockRing = xz(open(pts(block)));
    const [bv0, bv1] = vRange(blockRing), [wv0, wv1] = vRange(W), [ev0, ev1] = vRange(E);
    const v0 = Math.max(bv0, wv0, ev0) + 1, v1 = Math.min(bv1, wv1, ev1) - 1;
    const HALF = { open: 3.6, covered: 2.9, alley: 1.6 }; // half widths of the walkways
    // Alleys crossing the block: centre v of each mapped alley between the streets.
    const alleyWays = ways.filter((w) => w.tags.highway && /האגוז|התות|האפרסק|השקד|התפוח|האגס|השזיף|אליהו בנאי|Egoz|Tut|Afarsek|Shaked|Tapua|Agas|Shazif|Banai/.test(nameOf(w.tags) + (w.tags.alt_name ?? '') + (w.tags['alt_name:en'] ?? '')));
    const alleyVs = [];
    for (const w of alleyWays) {
      const q = xz(pts(w));
      let s = 0, n = 0;
      for (let i = 0; i < q.length; i += 2) { const p = toUV(q[i], q[i + 1]); if (p.v > v0 && p.v < v1) { s += p.v; n++; } }
      if (!n) continue;
      const v = s / n;
      if (!alleyVs.some((a) => Math.abs(a.v - v) < 5)) alleyVs.push({ v, name: (w.tags['name:en'] ?? w.tags.name), id: `w${w.id}` });
    }
    alleyVs.sort((a, b) => a.v - b.v);
    // Shop blocks between the alleys (and the block ends).
    const cuts = [v0 - HALF.alley, ...alleyVs.map((a) => a.v), v1 + HALF.alley];
    const blocks = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i] + HALF.alley, b = cuts[i + 1] - HALF.alley;
      if (b - a < 3) continue;
      const K = Math.max(1, Math.ceil((b - a) / 8));
      const west = [], east = [];
      // Distance from a point to a street's centre line (where the streets bend at their ends,
      // the offset along u alone is not enough: push the face out until the walkway is clear).
      const lineDist = (line, x, z) => { let d = Infinity; for (let i = 0; i + 3 < line.length; i += 2) d = Math.min(d, segmentDistance(x, z, line[i], line[i + 1], line[i + 2], line[i + 3])); return d; };
      for (let k = 0; k <= K; k++) {
        const v = a + ((b - a) * k) / K;
        let uw = uAt(W, v) + HALF.open, ue = uAt(E, v) - HALF.covered;
        for (let it = 0; it < 30 && lineDist(W, ...fromUV(uw, v)) < HALF.open; it++) uw += 0.3;
        for (let it = 0; it < 30 && lineDist(E, ...fromUV(ue, v)) < HALF.covered; it++) ue -= 0.3;
        west.push(fromUV(uw, v));
        east.push(fromUV(Math.max(ue, uw + 2), v));
      }
      const ring = [...west, ...east.reverse()];
      blocks.push({ ring: ring.flatMap(([x, z]) => toLL(x, z)) });
    }
    const alleys = alleyVs.map((a) => {
      const west = fromUV(uAt(W, a.v) + HALF.open, a.v), east = fromUV(uAt(E, a.v) - HALF.covered, a.v);
      return { id: a.id, name: a.name, line: [...toLL(...west), ...toLL(...east)], width: HALF.alley * 2 };
    });
    // Squares: the Iraqi market and the Georgian courtyard; free spots for stalls and tables.
    const squares = [];
    for (const [re, kind] of [[/השוק העירקי|Iraqi/, 'iraqi'], [/השוק הגרוזיני|Georgian/, 'georgian']]) {
      const w = ways.find((x) => closed(x) && !x.tags.highway && re.test(nameOf(x.tags)));
      if (!w) continue;
      const ring = xz(open(pts(w)));
      const spots = [];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
      for (let x = x0 + 2; x < x1 - 1; x += 3.2) {
        for (let z = z0 + 2; z < z1 - 1; z += 3.2) {
          if (!pointInRings([ring], x, z)) continue;
          if (buildings.some((b) => !excluded.has(b.id) && pointInRings(b.rings, x, z))) continue;
          if (ray(x, z, 1, 0, 1.6) !== null || ray(x, z, -1, 0, 1.6) !== null || ray(x, z, 0, 1, 1.6) !== null || ray(x, z, 0, -1, 1.6) !== null) continue;
          spots.push(toLL(x, z));
        }
      }
      squares.push({ id: `w${w.id}`, kind, name: nameEn(w.tags), ring: open(pts(w)), spots: spots.flat() });
    }
    // Frontage on the far side of each street (the city's buildings), and the covered street's
    // width for its roof (from the block face to the buildings opposite).
    const skip = new Set([`w${block.id}`]);
    market = {
      id: `w${block.id}`,
      name: 'Mahane Yehuda Market',
      block: { id: `w${block.id}`, ring: open(pts(block)) },
      openStreet: { id: `w${openSt.id}`, name: 'Mahane Yehuda Street', line: pts(openSt), half: HALF.open, frontage: frontage(pts(openSt), { skip }) },
      coveredStreet: { id: `w${coveredSt.id}`, name: 'Etz Haim Street', line: pts(coveredSt), half: HALF.covered, frontage: frontage(pts(coveredSt), { skip }) },
      blocks,
      alleys,
      squares,
    };
    // The market streets: 2-3 storey buildings with a shop on every ground floor.
    const hull = [...W, ...E];
    let hx0 = Infinity, hx1 = -Infinity, hz0 = Infinity, hz1 = -Infinity;
    for (let i = 0; i < hull.length; i += 2) { hx0 = Math.min(hx0, hull[i]); hx1 = Math.max(hx1, hull[i]); hz0 = Math.min(hz0, hull[i + 1]); hz1 = Math.max(hz1, hull[i + 1]); }
    const pad = 16;
    lowRise.push({ name: 'Mahane Yehuda Market', floorsMin: 2, floorsMax: 3, shops: 'all', facade: 'historic',
      ring: [[hx0 - pad, hz0 - pad], [hx1 + pad, hz0 - pad], [hx1 + pad, hz1 + pad], [hx0 - pad, hz1 + pad]].flatMap(([x, z]) => toLL(x, z)) });
  }

  // --- Old City souks ---------------------------------------------------------------------------------
  const inOld = (w) => {
    if (!oldCity) return false;
    const g = wayGeometry(osm, w);
    const c = g[Math.floor(g.length / 2)];
    return c && pointInRings([xz(oldCity)], ...Object.values(P.project(c.lat, c.lon)));
  };
  const souks = [];
  for (const S of SOUKS) {
    const list = ways.filter((w) => ['pedestrian', 'footway', 'steps', 'living_street', 'residential', 'service'].includes(w.tags.highway) &&
      (S.re.test(w.tags['name:en'] ?? '') || S.re.test(w.tags.name ?? '')));
    for (const w of list) {
      if (!inOld(w) || (S.onlyTunnel && w.tags.tunnel !== 'yes')) continue;
      const line = pts(w);
      if (line.length < 4) continue;
      souks.push({ id: `w${w.id}`, name: S.name, covered: S.covered, goods: S.goods, steps: w.tags.highway === 'steps', line, frontage: frontage(line, { max: 6 }) });
    }
  }

  // --- the open Cardo (Byzantine colonnade) -------------------------------------------------------------
  const cardoOpen = ways.find((w) => w.tags.highway === 'pedestrian' && /^HaKardo$|^הקארדו$/.test(w.tags['name:en'] ?? w.tags.name ?? '') && w.tags.tunnel !== 'yes' && inOld(w));
  const cardo = cardoOpen ? { id: `w${cardoOpen.id}`, line: pts(cardoOpen) } : null;

  // --- Hurva, YMCA, King David Hotel, Mamilla ---------------------------------------------------------------
  const building = (re, pred = () => true) => ways.find((w) => w.tags.building && closed(w) && re.test(nameOf(w.tags)) && pred(w));
  const outline = (w) => (w ? { id: `w${w.id}`, name: nameEn(w.tags), ring: open(pts(w)), height: w.tags.height ? Number(w.tags.height) : null, levels: w.tags['building:levels'] ? Number(w.tags['building:levels']) : null } : null);
  const hurva = outline(building(/Hurva|החורבה/, (w) => w.tags.building === 'synagogue' || w.tags.amenity === 'place_of_worship'));
  const ymca = outline(building(/YMCA|ימקא|ימק"א/));
  const kingDavid = outline(building(/King David Hotel|מלון המלך דוד/));
  for (const s of [hurva, ymca, kingDavid]) if (s) replaces.push(s.id);
  const mamillaSt = ways.filter((w) => w.tags.highway && /^Mamilla( Avenue)?$|^ממילא$/.test(w.tags['name:en'] ?? w.tags.name ?? ''));
  const mamillaMall = ways.filter((w) => w.tags.building && closed(w) && /Mamil+a Mall|קניון ממילא/.test(nameOf(w.tags)));
  let mamilla = null;
  if (mamillaSt.length || mamillaMall.length) {
    mamilla = {
      promenade: mamillaSt.map((w) => ({ id: `w${w.id}`, line: pts(w), steps: w.tags.highway === 'steps', frontage: frontage(pts(w), { max: 14 }) })),
      buildings: mamillaMall.map((w) => `w${w.id}`),
    };
    const all = mamillaMall.flatMap((w) => xz(open(pts(w))));
    if (all.length) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < all.length; i += 2) { x0 = Math.min(x0, all[i]); x1 = Math.max(x1, all[i]); z0 = Math.min(z0, all[i + 1]); z1 = Math.max(z1, all[i + 1]); }
      lowRise.push({ name: 'Mamilla', floorsMin: 2, floorsMax: 3, shops: 'all', ring: [[x0 - 4, z0 - 4], [x1 + 4, z0 - 4], [x1 + 4, z1 + 4], [x0 - 4, z1 + 4]].flatMap(([x, z]) => toLL(x, z)) });
    }
  }

  // --- the riwaq: the esplanade's west and north porticoes -------------------------------------------------
  // Along each west- or north-facing edge of the enclosure, every 3 m: from 45 m inside, look
  // back toward the edge for the first building face (the inner facade of the madrasas and
  // houses on the edge). Runs of similar depth become stretches of portico.
  const riwaq = [];
  if (templeMount) {
    const R = xz(templeMount);
    let area = 0;
    for (let i = 0, j = R.length - 2; i < R.length; j = i, i += 2) area += R[j] * R[i + 1] - R[i] * R[j + 1];
    const n = R.length / 2;
    for (let i = 0; i < n; i++) {
      const k = (i + 1) % n;
      const ax = R[i * 2], az = R[i * 2 + 1], bx = R[k * 2], bz = R[k * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 30) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      let nx = uz, nz = -ux; // outward for a counter-clockwise ring (x east, z south)
      if (area < 0) { nx = -nx; nz = -nz; }
      if (!(nx < -0.7 || nz < -0.7)) continue; // west or north side
      let run = [];
      const flush = () => {
        if (run.length >= 5) {
          const a = run[0], b = run[run.length - 1];
          const depth = run.reduce((s2, r) => s2 + r.depth, 0) / run.length;
          riwaq.push({ a: toLL(a.x, a.z), b: toLL(b.x, b.z), n: [Math.round(nx * 1000) / 1000, Math.round(nz * 1000) / 1000], depth: Math.round(depth * 10) / 10 });
        }
        run = [];
      };
      for (let s2 = 12; s2 <= L - 12; s2 += 3) {
        const ex = ax + ux * s2, ez = az + uz * s2;
        const ix = ex - nx * 45, iz = ez - nz * 45;
        const t = ray(ix, iz, nx, nz, 44);
        const depth = t === null ? null : 45 - t; // from the edge in to the facade
        if (depth === null || depth < 3 || depth > 30 || (run.length && Math.abs(depth - run[run.length - 1].depth) > 2.5)) { flush(); if (depth !== null && depth >= 3 && depth <= 30) run.push({ x: ex - nx * depth, z: ez - nz * depth, depth }); continue; }
        run.push({ x: ex - nx * depth, z: ez - nz * depth, depth });
      }
      flush();
    }
  }

  // --- Old City infill ------------------------------------------------------------------------------------------
  let infill = null;
  if (oldCity) {
    // Inside the walls, not just inside their convex hull (that reaches out over the moat and
    // the roads): rays in four directions cross the wall lines an odd number of times (three
    // of four must agree: gate gaps and the Temple Mount's inner walls spoil single rays).
    const hull = xz(oldCity);
    const keep = keepOut.map((r) => [xz(r)]);
    const wallSegs = (walls ?? []).flatMap((w) => { const q = xz(w); const o = []; for (let i = 0; i + 3 < q.length; i += 2) o.push([q[i], q[i + 1], q[i + 2], q[i + 3]]); return o; });
    const crossings = (x, z, dx, dz) => {
      let n = 0;
      for (const [ax, az, bx, bz] of wallSegs) {
        const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((ax - x) * ez - (az - z) * ex) / den, u = ((ax - x) * dz - (az - z) * dx) / den;
        if (t > 0 && u >= 0 && u < 1) n++;
      }
      return n;
    };
    const insideWalls = (x, z) => !wallSegs.length || [[1, 0.013], [-1, 0.021], [0.017, 1], [0.011, -1]].filter(([dx, dz]) => crossings(x, z, dx, dz) % 2 === 1).length >= 3;
    // Open ground: streets (their width plus a margin), squares, gardens, courtyards,
    // excavations, parking, religious compounds' open land.
    const RW = { primary: 9, secondary: 9, tertiary: 8, unclassified: 7, residential: 6, service: 4.5, living_street: 4.5, pedestrian: 3.6, footway: 2.4, path: 2.4, steps: 2.6, cycleway: 2.4, track: 3 };
    const streets = [];
    const areas = [];
    for (const w of ways) {
      const t = w.tags;
      if (t.highway && closed(w) && (t.area === 'yes' || t.highway === 'pedestrian' && t.area !== 'no' && w.refs.length > 4 && t.area)) { areas.push([xz(open(pts(w)))]); continue; }
      if (t.highway && RW[t.highway] && t.tunnel !== 'yes' && Number(t.layer ?? 0) > -2) { streets.push({ q: xz(pts(w)), half: RW[t.highway] / 2 + 0.9 }); continue; }
      if (closed(w) && !t.building && (t.place === 'square' || t.leisure || t.landuse === 'grass' || t.landuse === 'cemetery' || t.amenity === 'parking' ||
        t.historic || t.natural || t.landuse === 'construction' || t.man_made === 'courtyard' || t.area === 'yes' && !t.highway)) areas.push([xz(open(pts(w)))]);
    }
    for (const r of osm.relations.values()) {
      const t = r.tags;
      if (t.type !== 'multipolygon' || t.building) continue;
      if (!(t.place === 'square' || t.leisure || t.landuse || t.amenity === 'parking' || t.historic || t.natural || t.highway)) continue;
      const outer = stitchRings(r.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => osm.ways.get(m.ref)).filter(Boolean).map((w) => wayGeometry(osm, w)));
      for (const o of outer) areas.push([xz(o)]);
    }
    const holes = buildings.flatMap((b) => b.rings.slice(1).map((r) => [r]));
    const C = 3, NEAR = 8, MAX_PATCH = 100; // cell size (m), reach from a building (m), largest patch (cells)
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < hull.length; i += 2) { x0 = Math.min(x0, hull[i]); x1 = Math.max(x1, hull[i]); z0 = Math.min(z0, hull[i + 1]); z1 = Math.max(z1, hull[i + 1]); }
    const cols = Math.ceil((x1 - x0) / C), rows = Math.ceil((z1 - z0) / C);
    const cell = new Uint8Array(cols * rows); // 1 = gap to fill
    const bgrid = new Map();
    for (const b of buildings) {
      if (excluded.has(b.id)) continue;
      const bb = b.rings[0];
      let a = Infinity, bx = -Infinity, c = Infinity, d = -Infinity;
      for (let i = 0; i < bb.length; i += 2) { a = Math.min(a, bb[i]); bx = Math.max(bx, bb[i]); c = Math.min(c, bb[i + 1]); d = Math.max(d, bb[i + 1]); }
      for (let gx = Math.floor(a / GRID); gx <= Math.floor(bx / GRID); gx++) for (let gz = Math.floor(c / GRID); gz <= Math.floor(d / GRID); gz++) {
        const k = `${gx},${gz}`;
        if (!bgrid.has(k)) bgrid.set(k, []);
        bgrid.get(k).push(b);
      }
    }
    const sgrid = new Map();
    for (const s of streets) {
      for (let i = 0; i + 3 < s.q.length; i += 2) {
        const seg = { ax: s.q[i], az: s.q[i + 1], bx: s.q[i + 2], bz: s.q[i + 3], half: s.half };
        for (let gx = Math.floor((Math.min(seg.ax, seg.bx) - 6) / GRID); gx <= Math.floor((Math.max(seg.ax, seg.bx) + 6) / GRID); gx++) {
          for (let gz = Math.floor((Math.min(seg.az, seg.bz) - 6) / GRID); gz <= Math.floor((Math.max(seg.az, seg.bz) + 6) / GRID); gz++) {
            const k = `${gx},${gz}`;
            if (!sgrid.has(k)) sgrid.set(k, []);
            sgrid.get(k).push(seg);
          }
        }
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = x0 + (c + 0.5) * C, z = z0 + (r + 0.5) * C;
        if (!pointInRings([hull], x, z) || !insideWalls(x, z)) continue;
        const k = `${Math.floor(x / GRID)},${Math.floor(z / GRID)}`;
        if ((bgrid.get(k) ?? []).some((b) => pointInRings(b.rings, x, z) || pointInRings([b.rings[0]], x, z))) continue; // built (or a courtyard)
        if ((sgrid.get(k) ?? []).some((s) => segmentDistance(x, z, s.ax, s.az, s.bx, s.bz) < s.half + C * 0.5)) continue;
        if (areas.some((a) => pointInRings(a, x, z)) || holes.some((h) => pointInRings(h, x, z)) || keep.some((kr) => pointInRings(kr, x, z))) continue;
        // Only between buildings: a missing house stands next to its neighbours; open ground
        // far from any building is a garden or a yard that OSM hasn't outlined.
        let near = false;
        for (let gx = Math.floor((x - NEAR) / GRID); gx <= Math.floor((x + NEAR) / GRID) && !near; gx++) {
          for (let gz = Math.floor((z - NEAR) / GRID); gz <= Math.floor((z + NEAR) / GRID) && !near; gz++) {
            for (const e of edgeGrid.get(`${gx},${gz}`) ?? []) if (segmentDistance(x, z, e.ax, e.az, e.bx, e.bz) < NEAR) { near = true; break; }
          }
        }
        if (!near) continue;
        cell[r * cols + c] = 1;
      }
    }
    // Drop specks: a gap must have at least 2 filled neighbours (no single-cell spikes).
    const at = (c, r) => (c >= 0 && r >= 0 && c < cols && r < rows ? cell[r * cols + c] : 0);
    for (let pass = 0; pass < 2; pass++) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (!at(c, r)) continue;
        const n = at(c - 1, r) + at(c + 1, r) + at(c, r - 1) + at(c, r + 1);
        if (n < 2) cell[r * cols + c] = 0;
      }
    }
    // Large connected patches are open ground (a garden, an excavation, a car park), not houses.
    const comp = new Int32Array(cols * rows).fill(-1);
    for (let i = 0; i < cell.length; i++) {
      if (!cell[i] || comp[i] >= 0) continue;
      const stack = [i], members = [];
      comp[i] = i;
      while (stack.length) {
        const k = stack.pop();
        members.push(k);
        const c = k % cols, r = (k - c) / cols;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = (r + dr) * cols + c + dc;
          if (c + dc < 0 || c + dc >= cols || r + dr < 0 || r + dr >= rows || !cell[n] || comp[n] >= 0) continue;
          comp[n] = i;
          stack.push(n);
        }
      }
      if (members.length > MAX_PATCH) for (const k of members) cell[k] = 0;
    }
    // Greedy rectangles (runs along x, grown along z while the run repeats), then boxes.
    const used = new Uint8Array(cols * rows);
    const boxes = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!at(c, r) || used[r * cols + c]) continue;
        let w = 0;
        while (c + w < cols && at(c + w, r) && !used[r * cols + c + w] && w < 8) w++;
        let h = 1;
        grow: while (r + h < rows && h < 8) {
          for (let k = 0; k < w; k++) if (!at(c + k, r + h) || used[(r + h) * cols + c + k]) break grow;
          h++;
        }
        for (let dr = 0; dr < h; dr++) for (let k = 0; k < w; k++) used[(r + dr) * cols + c + k] = 1;
        if (w * h < 3) continue; // under ~27 m²: leave open
        const bx0 = x0 + c * C, bz0 = z0 + r * C;
        boxes.push([...toLL(bx0, bz0), ...toLL(bx0 + w * C, bz0 + h * C)]);
      }
    }
    infill = { cell: C, boxes: boxes.flat(), count: boxes.length };
  }

  // Facade styles by neighbourhood (after the market and Mamilla: the first area containing a
  // building wins).
  lowRise.push({ ...DOWNTOWN, ring: [...DOWNTOWN.ring] });
  for (const p of places) {
    const r = HISTORIC[p.nameEn ?? p.name];
    if (!r || p.lat == null) continue;
    const ring = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      ring.push(round(p.lat + (Math.sin(a) * r) / 110900), round(p.lon + (Math.cos(a) * r) / 94600));
    }
    lowRise.push({ name: p.nameEn ?? p.name, approximate: true, facade: 'historic', floorsMin: 2, floorsMax: 3, ring });
  }

  return {
    format: 'sites-v1',
    source: 'OpenStreetMap via the main API',
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    market,
    souks,
    cardo,
    riwaq,
    hurva,
    ymca,
    kingDavid,
    mamilla,
    infill,
    lowRise,
    excludes: EXCLUDE.map((e) => ({ ...e })),
    replaces: [...new Set([...replaces, ...EXCLUDE.map((e) => e.id)])],
  };
}

/** Where no infill may stand: the Temple Mount, the plaza, the landmark models, the walls. */
export function keepOutFrom(landmarks) {
  const out = [];
  const push = (r) => r && r.length >= 6 && out.push(r);
  for (const r of landmarks.templeMount?.outer ?? []) push(r);
  push(landmarks.plaza?.ring);
  push(landmarks.westernWall?.ring);
  for (const r of landmarks.citadel?.outer ?? []) push(r);
  push(landmarks.sepulchre?.ring);
  for (const g of landmarks.gates ?? []) {
    // A 30 m square around each gate: the gate plaza stays open.
    const d = 0.00015;
    push([g.lat - d, g.lon - d * 1.17, g.lat - d, g.lon + d * 1.17, g.lat + d, g.lon + d * 1.17, g.lat + d, g.lon - d * 1.17]);
  }
  // A band 7 m inside the city walls (the walls' own model stands there).
  for (const w of landmarks.walls ?? []) {
    const p = w.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const la0 = p[i], lo0 = p[i + 1], la1 = p[i + 2], lo1 = p[i + 3];
      const dz = (la1 - la0) * 110900, dx = (lo1 - lo0) * 94600, l = Math.hypot(dx, dz);
      if (l < 0.5) continue;
      const nla = (dx / l) * 7 / 110900, nlo = (-dz / l) * 7 / 94600;
      push([la0 - nla, lo0 - nlo, la1 - nla, lo1 - nlo, la1 + nla, lo1 + nlo, la0 + nla, lo0 + nlo]);
    }
  }
  return out;
}

async function readTileBuildings() {
  const { readdir } = await import('node:fs/promises');
  const dir = resolve(ROOT, 'public/data/tiles');
  const out = [];
  for (const f of (await readdir(dir)).filter((x) => /^osm_.*\.json$/.test(x))) {
    const t = JSON.parse(await readFile(resolve(dir, f), 'utf8'));
    for (const b of t.buildings ?? []) if (b.rings?.[0]) out.push({ id: b.id, tags: b.tags ?? {}, rings: b.rings });
  }
  return out;
}

async function main() {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const manifest = JSON.parse(await readFile(resolve(ROOT, 'public/data/tiles/manifest.json'), 'utf8'));
  const landmarks = JSON.parse(await readFile(resolve(ROOT, 'public/data/landmarks.json'), 'utf8'));
  let osm, fetchedAt;
  if (arg('--raw')) {
    const raw = JSON.parse(await readFile(arg('--raw'), 'utf8'));
    osm = { nodes: new Map(raw.nodes.map((n) => [n.id, n])), ways: new Map(raw.ways.map((w) => [w.id, w])), relations: new Map(raw.relations.map((r) => [r.id, r])) };
    fetchedAt = raw.fetchedAt;
  } else {
    const docs = [];
    const b = OLD_CITY_BBOX, rows = 3, cols = 3;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      docs.push(await fetchOsmMap({
        south: b.south + ((b.north - b.south) * r) / rows, north: b.south + ((b.north - b.south) * (r + 1)) / rows,
        west: b.west + ((b.east - b.west) * c) / cols, east: b.west + ((b.east - b.west) * (c + 1)) / cols,
      }));
      process.stdout.write(`\r[sites] Old City ${docs.length}/9   `);
    }
    for (const box of SITE_BOXES) { docs.push(await fetchOsmMap(box)); process.stdout.write(`\r[sites] ${box.name}          `); }
    process.stdout.write('\n');
    osm = mergeOsm(docs);
    fetchedAt = new Date().toISOString();
    if (arg('--save-raw')) await writeFile(arg('--save-raw'), JSON.stringify({ fetchedAt, nodes: [...osm.nodes.values()], ways: [...osm.ways.values()], relations: [...osm.relations.values()] }));
  }
  const data = extractSites(osm, { worldBBox: manifest.worldBBox, oldCity: landmarks.oldCity?.ring ?? null, walls: (landmarks.walls ?? []).map((w) => w.points), keepOut: keepOutFrom(landmarks), tileBuildings: await readTileBuildings(), templeMount: landmarks.templeMount?.outer?.[0] ?? null, places: manifest.places ?? [] });
  data.fetchedAt = fetchedAt;
  await mkdir(dirname(OUT), { recursive: true });
  const json = JSON.stringify(data);
  await writeFile(OUT, json);
  const m = data.market;
  console.log(`[sites] wrote ${OUT} (${(json.length / 1024).toFixed(0)} KB): market ${!!m}` +
    (m ? ` (${m.blocks.length} shop blocks, ${m.alleys.length} alleys, ${m.squares.length} squares, ${m.openStreet.frontage.length + m.coveredStreet.frontage.length} frontage samples)` : '') +
    `, ${data.souks.length} souk ways (${[...new Set(data.souks.map((s) => s.name))].join(', ')}), cardo ${!!data.cardo}, hurva ${!!data.hurva}, ymca ${!!data.ymca}, king david ${!!data.kingDavid},` +
    ` mamilla ${data.mamilla ? data.mamilla.promenade.length + ' ways' : 'none'}, riwaq ${data.riwaq.length} stretches, infill ${data.infill?.count ?? 0} boxes, replaces ${data.replaces.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
