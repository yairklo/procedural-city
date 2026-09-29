// The Temple Mount esplanade beyond the buildings (landmarks.json `templeMount`, `haram`, and
// sites.json `riwaq`):
//
//   earth       most of the esplanade is not paved: the northern and eastern parts are bare,
//               dusty ground under trees. The paving stays around the raised platform (a band
//               around it), between it and al-Aqsa, and along the edges (where the buildings
//               and the walkways are); everything else is earth
//   trees       olives, cypresses and pines scattered over the earth (hundreds, instanced)
//   riwaq       the porticoes along the west and north sides: a screen of pointed arches 4 m in
//               front of the buildings' inner facades, roofed back to them
//   inscription the band of calligraphy around the top of the Dome of the Rock's octagon: light
//               strokes (tall letters, low connecting strokes, dots) on the dark tiles
//
// Geometry goes into the caller's Mesher; trees are returned for instancing.

import { STYLE } from './geometry.js';
import { pointInRings, distanceToEdges } from '../footprint.js';

const hash = (a, b = 0) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const centerOf = (ring) => {
  let x = 0, z = 0;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return { x: (x * 2) / ring.length, z: (z * 2) / ring.length };
};
const segDist = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
};

const EARTH = [0xa99a7a, 0x9f9070, 0xb2a384, 0xa39374];

/**
 * @param {object} lm     landmarks.json
 * @param {object} sites  sites.json (riwaq)
 * @param {object} ctx    { project, at, ground, addBox, quadBox, m (Mesher), kit (createKit on m) }
 * @returns {{ trees: {x,y,z,s,ry,kind}[], stats: object }}
 */
export function buildEsplanade(lm, sites, { project, ground, quadBox, m, kit }) {
  const stats = { earthCells: 0, trees: 0, riwaqBays: 0, letters: 0 };
  const trees = [];
  const tm = lm.templeMount?.outer?.[0];
  const h = lm.haram;
  if (!tm || !h) return { trees, stats };
  const ring = project(tm);
  const up = h.upperPlatform ? project(h.upperPlatform.ring) : null;
  const aqsa = h.aqsa ? project(h.aqsa.ring) : null;
  const rock = h.domeOfTheRock ? project(h.domeOfTheRock.ring) : null;
  const groves = (h.groves ?? []).map((g) => project(g.ring));
  const small = [...(h.domes ?? []), ...(h.arcades ?? []), ...(h.domeOfTheChain ? [h.domeOfTheChain] : [])].map((d) => project(d.ring));
  const rc = rock ? centerOf(rock) : null, ac = aqsa ? centerOf(aqsa) : null;

  // --- earth and trees ----------------------------------------------------------------------------
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
  const C = 4;
  for (let x = x0 + C / 2; x < x1; x += C) {
    for (let z = z0 + C / 2; z < z1; z += C) {
      if (!pointInRings([ring], x, z) || distanceToEdges([ring], x, z) < 16) continue;
      if (up && (pointInRings([up], x, z) || distanceToEdges([up], x, z) < 10)) continue;
      if (aqsa && (pointInRings([aqsa], x, z) || distanceToEdges([aqsa], x, z) < 22)) continue;
      if (rc && ac && segDist(x, z, rc.x, rc.z, ac.x, ac.z) < 26) continue; // the paved way between them
      if (groves.some((g) => pointInRings([g], x, z))) continue;
      if (small.some((s) => pointInRings([s], x, z) || distanceToEdges([s], x, z) < 4)) continue;
      const y = ground(x, z) + 0.07;
      m.paint(EARTH[Math.floor(hash(x * 0.3, z * 0.7) * EARTH.length)], 1, 1, STYLE.foliage);
      const j = 0.15; // overlap a little so cells join
      m.quad([x - C / 2 - j, y, z - C / 2 - j], [x + C / 2 + j, y, z - C / 2 - j], [x + C / 2 + j, y, z + C / 2 + j], [x - C / 2 - j, y, z + C / 2 + j], [0, 1, 0]);
      stats.earthCells++;
      const t = hash(x * 1.3, z * 0.9);
      if (t < 0.2) {
        const tx = x + (hash(z, x) - 0.5) * 3, tz = z + (hash(x, z * 2) - 0.5) * 3;
        const k = hash(tx, tz);
        trees.push({ x: tx, y: ground(tx, tz), z: tz, s: k < 0.3 ? 0.9 + t * 1.2 : 1 + t * 2.2, ry: t * 31, kind: k < 0.3 ? 'cypress' : k < 0.85 ? 'olive' : 'pine' });
        stats.trees++;
      }
    }
  }

  // --- riwaq ---------------------------------------------------------------------------------------------
  const H = 6.6, BAY = 4.2, D = 4;
  for (const r of sites?.riwaq ?? []) {
    const [ax, az, bx, bz] = project([...r.a, ...r.b]);
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 8) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    const [nx, nz] = r.n; // outward (toward the facade and the wall)
    const bays = Math.max(2, Math.round(L / BAY));
    const cx = (ax + bx) / 2 - nx * D, cz = (az + bz) / 2 - nz * D;
    const y0 = Math.min(ground(ax - nx * D, az - nz * D), ground(bx - nx * D, bz - nz * D));
    kit.arcadeScreen(cx, y0, cz, ux, uz, L, H, bays, { pier: 0.9, col: 0.7, thick: 0.8, ref: 'riwaq' });
    // Roof back to the facade, and the facade behind the arches in shade.
    m.paint(0xcfc4ae, 0.45, 0.9, STYLE.ashlar);
    const q = (s, d) => [(ax + bx) / 2 + ux * s - nx * d, (az + bz) / 2 + uz * s - nz * d];
    const [p0x, p0z] = q(-L / 2, D + 0.4), [p1x, p1z] = q(L / 2, D + 0.4), [p2x, p2z] = q(L / 2, -0.2), [p3x, p3z] = q(-L / 2, -0.2);
    m.prism([p0x, p0z, p1x, p1z, p2x, p2z, p3x, p3z], y0 + H, y0 + H + 0.45);
    quadBox([p0x, p0z, p1x, p1z, p2x, p2z, p3x, p3z], y0 + H, y0 + H + 0.45, 'building', 'riwaq');
    stats.riwaqBays += bays;
  }

  // --- the Dome of the Rock's inscription band --------------------------------------------------------
  if (rock) {
    const c = centerOf(rock);
    const y0 = ground(c.x, c.z);
    const yb = y0 + 12.4 + 0.1, yt = y0 + 13.2 - 0.1; // the dark tile band between the tiled wall and the parapet
    const n = rock.length / 2;
    let area = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) area += rock[j * 2] * rock[i * 2 + 1] - rock[i * 2] * rock[j * 2 + 1];
    m.paint(0xf1ead2, 1, 1, STYLE.plain);
    for (let i = 0; i < n; i++) {
      const k = (i + 1) % n;
      const ax = rock[i * 2], az = rock[i * 2 + 1], bx = rock[k * 2], bz = rock[k * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 2) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      let nx = uz, nz = -ux;
      if (area < 0) { nx = -nx; nz = -nz; }
      const P = (s, y) => [ax + ux * s + nx * 0.035, y, az + uz * s + nz * 0.035];
      const rect = (s0, s1, y0r, y1r) => m.quad(P(s0, y0r), P(s1, y0r), P(s1, y1r), P(s0, y1r), [nx, 0, nz]);
      const base = yb + 0.12;
      rect(0.3, L - 0.3, yb + 0.02, yb + 0.05); // a thin rule under the text
      rect(0.3, L - 0.3, yt - 0.05, yt - 0.02); // and over it
      for (let s = 0.5; s < L - 0.5; s += 0.13) {
        const r = hash(s * 7.3 + i, i * 3.1);
        if (r < 0.3) rect(s, s + 0.05, base, base + 0.34 + r * 0.25); // tall letters (alif, lam)
        else if (r < 0.7) rect(s - 0.04, s + 0.11, base, base + 0.05 + (r - 0.3) * 0.12); // the baseline strokes
        else if (r < 0.85) rect(s, s + 0.05, base + 0.1, base + 0.15); // a small letter body
        else rect(s + 0.02, s + 0.05, base + 0.24, base + 0.27); // dots
        stats.letters++;
      }
    }
  }
  return { trees, stats };
}
