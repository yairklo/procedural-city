// Synthetic Overpass response for tests: a street grid rotated 28° (like central
// Jerusalem's diagonal streets) with rotated, L-shaped, courtyard and canopy buildings.
// It is NOT real map data; it only exercises the pipeline without network access.

import { createProjection } from '../../src/city/geo.js';
import { JERUSALEM_BBOX } from '../../scripts/fetch_jerusalem.js';

export function syntheticOverpass({ blocks = 6, angleDeg = 28 } = {}) {
  const proj = createProjection(JERUSALEM_BBOX);
  const a = (angleDeg * Math.PI) / 180;
  const rot = (u, v) => ({ x: u * Math.cos(a) - v * Math.sin(a), z: u * Math.sin(a) + v * Math.cos(a) });
  const ll = (u, v) => {
    const p = rot(u, v);
    const { lat, lon } = proj.unproject(p.x, p.z);
    return { lat, lon };
  };
  const closed = (pts) => [...pts, pts[0]];
  const elements = [];
  let id = 1000;

  const PITCH = 80, STREET = 14;
  const half = (blocks * PITCH) / 2;
  // Streets along both grid axes.
  for (let i = 0; i <= blocks; i++) {
    const c = -half + i * PITCH;
    const name = i === Math.floor(blocks / 2) ? ['יפו', 'Jaffa Road'] : [`רחוב ${i}`, `Street ${i}`];
    elements.push({ type: 'way', id: id++, tags: { highway: i % 3 === 0 ? 'primary' : 'residential', name: name[0], 'name:en': name[1] }, geometry: [ll(c, -half - 20), ll(c, half + 20)] });
    elements.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `שדרה ${i}`, 'name:en': `Avenue ${i}` }, geometry: [ll(-half - 20, c), ll(half + 20, c)] });
  }

  for (let bx = 0; bx < blocks; bx++) {
    for (let bz = 0; bz < blocks; bz++) {
      const u0 = -half + bx * PITCH + STREET / 2 + 3, v0 = -half + bz * PITCH + STREET / 2 + 3;
      const size = PITCH - STREET - 6;
      const k = (bx * 7 + bz * 3) % 5;
      if (k === 0) {
        // L-shaped building with a height tag.
        const s = size;
        elements.push({ type: 'way', id: id++, tags: { building: 'apartments', height: '17' }, geometry: closed([ll(u0, v0), ll(u0 + s, v0), ll(u0 + s, v0 + s * 0.4), ll(u0 + s * 0.4, v0 + s * 0.4), ll(u0 + s * 0.4, v0 + s), ll(u0, v0 + s)]) });
      } else if (k === 1) {
        // Courtyard building as a multipolygon relation (outer split into two ways).
        const outer = [ll(u0, v0), ll(u0 + size, v0), ll(u0 + size, v0 + size), ll(u0, v0 + size)];
        const inner = [ll(u0 + 18, v0 + 18), ll(u0 + size - 18, v0 + 18), ll(u0 + size - 18, v0 + size - 18), ll(u0 + 18, v0 + size - 18)];
        elements.push({
          type: 'relation', id: id++, tags: { type: 'multipolygon', building: 'yes', 'building:levels': '5' },
          members: [
            { type: 'way', role: 'outer', geometry: [outer[0], outer[1], outer[2]] },
            { type: 'way', role: 'outer', geometry: [outer[2], outer[3], outer[0]] },
            { type: 'way', role: 'inner', geometry: closed(inner) },
          ],
        });
      } else if (k === 2) {
        // Market canopy + stalls.
        elements.push({ type: 'way', id: id++, tags: { building: 'roof' }, geometry: closed([ll(u0, v0), ll(u0 + size, v0), ll(u0 + size, v0 + 12), ll(u0, v0 + 12)]) });
        for (let s = 0; s < 4; s++) {
          const su = u0 + 2 + s * 15;
          elements.push({ type: 'way', id: id++, tags: { building: 'retail', shop: 'greengrocer' }, geometry: closed([ll(su, v0 + 20), ll(su + 12, v0 + 20), ll(su + 12, v0 + 30), ll(su, v0 + 30)]) });
        }
      } else {
        // Row of plain buildings, no height tags (fallback heights).
        const n = 3;
        const w = (size - (n - 1) * 2) / n;
        for (let s = 0; s < n; s++) {
          const su = u0 + s * (w + 2);
          elements.push({ type: 'way', id: id++, tags: { building: 'yes', ...(k === 3 && s === 1 ? { 'building:levels': '8', name: 'Tall Test Tower' } : {}) }, geometry: closed([ll(su, v0), ll(su + w, v0), ll(su + w, v0 + size), ll(su, v0 + size)]) });
        }
      }
    }
  }

  // A pedestrian square, a park and some trees.
  elements.push({ type: 'way', id: id++, tags: { highway: 'pedestrian', area: 'yes', name: 'כיכר', 'name:en': 'Test Square' }, geometry: closed([ll(-8, -8), ll(8, -8), ll(8, 8), ll(-8, 8)]) });
  const pu = half + 30;
  elements.push({ type: 'way', id: id++, tags: { leisure: 'park', name: 'Test Park' }, geometry: closed([ll(pu, -60), ll(pu + 60, -60), ll(pu + 60, 60), ll(pu, 60)]) });
  for (let i = 0; i < 20; i++) {
    const t = ll(pu + 8 + (i % 5) * 11, -50 + Math.floor(i / 5) * 25);
    elements.push({ type: 'node', id: id++, lat: t.lat, lon: t.lon, tags: { natural: 'tree' } });
  }
  const c = ll(0, 0);
  elements.push({ type: 'node', id: id++, lat: c.lat, lon: c.lon, tags: { place: 'neighbourhood', name: 'מרכז', 'name:en': 'Test Center' } });

  return { version: 0.6, generator: 'synthetic test fixture', elements };
}
