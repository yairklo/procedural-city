// The hills east of the Old City, from landmarks.json `olives` and `scopus`
// (scripts/fetch_landmarks.js):
//
//   Mount of Olives
//     cemetery        the Jewish cemetery on the western slope: ~20,000 limestone grave slabs
//                     in rows along the contours, long axis down the slope toward the Temple
//                     Mount; one instanced mesh (one draw call; they receive but don't cast
//                     shadows)
//     Mary Magdalene  the Russian church: white stone, seven gilded onion domes on drums
//     All Nations     the basilica by Gethsemane: portico of four columns under a gold mosaic
//                     pediment, twelve small domes over the roof
//     Absalom's Tomb  rock-cut cube, drum and the concave conical "hat"
//     Zechariah       rock-cut cube with a pyramid
//     the Russian bell tower of the Ascension (the tallest point on the ridge), the Chapel of
//     the Ascension in its walled court, the Seven Arches Hotel with its arcade to the west
//   Mount Scopus
//     the Hebrew University tower and campus blocks around it, Augusta Victoria (church and
//     its bell tower)
//
// Positions without mapped geometry are approximate (flagged in the data); ridge towers flagged
// `crest` are moved onto the highest ground within 40 m.

import * as THREE from 'three';
import { Mesher, STYLE, ringCenter, ringRadius, signedArea } from './geometry.js';
import { orientedBox, pointInRings } from '../footprint.js';
import { createKit, hash } from './kit.js';

const C = {
  stone: 0xd8cfbd,
  stoneOld: 0xc9bea8,
  white: 0xece8df,
  grave: 0xd9d2c3,
  lead: 0x7f878c,
  gold: 0xd9a441,
  opening: 0x24211d,
  mosaic: 0xc99a3b,
};

/**
 * @param {object} data  landmarks.json (uses `olives`, `scopus`)
 * @param {object} ctx   { project, at, ground, addBox, addFootprint, quadBox, finish, addObject, material }
 */
export function buildHills(data, ctx) {
  const { project, at, ground, addBox, addFootprint, quadBox, finish } = ctx;
  const stats = { graves: 0, towers: 0, churches: 0 };
  const m = new Mesher();
  const kit = createKit(m, { addBox, quadBox });

  /** A position, moved onto the highest ground within 40 m for ridge features. */
  const place = (p) => {
    let q = at(p);
    if (!p.crest) return q;
    let best = ground(q.x, q.z), bx = q.x, bz = q.z;
    for (let dx = -40; dx <= 40; dx += 5) {
      for (let dz = -40; dz <= 40; dz += 5) {
        if (dx * dx + dz * dz > 1600) continue;
        const h = ground(q.x + dx, q.z + dz);
        if (h > best + 0.2) { best = h; bx = q.x + dx; bz = q.z + dz; }
      }
    }
    return { x: bx, z: bz };
  };
  const footing = (x, z, r) => {
    let g = Infinity;
    for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) g = Math.min(g, ground(x + dx, z + dz));
    return g;
  };

  /** Onion dome on a drum: gilded bulb, a small cross-less finial. */
  const onion = (x, z, y, r, drumH = r * 1.1) => {
    m.paint(C.white, 0.4, 0.8, STYLE.ashlar);
    m.cylinder(x, z, r * 0.9, r * 0.9, y, y + drumH, 12, { top: false });
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      kit.window(x + Math.cos(a) * r * 0.9, y + drumH * 0.25, z + Math.sin(a) * r * 0.9, -Math.sin(a), Math.cos(a), Math.cos(a), Math.sin(a), r * 0.35, drumH * 0.6);
    }
    const b = y + drumH;
    m.paint(C.gold, 1, 1, STYLE.gold);
    kit.revolve(x, z, [[r * 0.95, b], [r * 1.22, b + r * 0.35], [r * 1.18, b + r * 0.75], [r * 0.8, b + r * 1.12], [r * 0.34, b + r * 1.45], [r * 0.12, b + r * 1.7], [0, b + r * 1.95]], 14);
    m.cylinder(x, z, 0.06 * r + 0.04, 0.04, b + r * 1.9, b + r * 2.5, 6);
    return b + r * 1.95;
  };

  /** A plain building from an outline: stone walls, windows, flat or lead roof. */
  const shell = (ring, y0, h, color = C.stone, ref = 'hill') => {
    m.paint(color, 0.45, 1.0, STYLE.ashlar);
    m.prism(ring, y0 - 0.5, y0 + h);
    addFootprint([ring], y0 - 0.5, y0 + h, 'building', ref);
    const ccw = signedArea(ring) > 0;
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 3) continue;
      let nx = (bz - az) / len, nz = -(bx - ax) / len;
      if (!ccw) { nx = -nx; nz = -nz; }
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      const count = Math.max(1, Math.floor(len / 4));
      for (let k = 0; k < count; k++) {
        const s = ((k + 0.5) * len) / count;
        kit.window(ax + ux * s, y0 + h * 0.35, az + uz * s, ux, uz, nx, nz, 1.0, h * 0.35 + 1.4);
      }
    }
  };

  const ol = data.olives;
  if (ol) {
    // --- the Jewish cemetery ------------------------------------------------------------------
    if (ol.cemetery?.ring) graves(ol.cemetery, ctx, stats);

    // --- Church of Mary Magdalene --------------------------------------------------------------
    if (ol.maryMagdalene) {
      const ring = project(ol.maryMagdalene.ring);
      const c = ringCenter(ring), box = orientedBox(ring);
      const y0 = footing(c.x, c.z, 8);
      shell(ring, y0, 12, C.white, 'mary-magdalene');
      m.paint(C.lead, 1, 1, STYLE.lead);
      m.polygon([ring], y0 + 12, 1);
      // Seven domes: the big one in the middle, four at the corners, one over the entrance
      // (west) and one over the apse (east).
      const P = (s, t) => [c.x + box.ax * s - box.az * t, c.z + box.az * s + box.ax * t];
      const west = box.ax > 0 ? -1 : 1;
      const spots = [[0, 0, 3.2], [box.hl * 0.55, box.hw * 0.55, 1.7], [-box.hl * 0.55, box.hw * 0.55, 1.7], [box.hl * 0.55, -box.hw * 0.55, 1.7], [-box.hl * 0.55, -box.hw * 0.55, 1.7], [west * box.hl * 0.85, 0, 1.9], [-west * box.hl * 0.85, 0, 1.4]];
      let top = 0;
      for (const [s, t, r] of spots) {
        const [x, z] = P(s, t);
        top = Math.max(top, onion(x, z, y0 + 12, r, r === 3.2 ? 5 : 2.4));
      }
      kit.domeBoxes(c.x, c.z, 3.2, y0 + 17, top - y0 - 17, 'mary-magdalene');
      stats.churches++;
    }

    // --- Church of All Nations ----------------------------------------------------------------
    if (ol.allNations) {
      const ring = project(ol.allNations.ring);
      const c = ringCenter(ring), box = orientedBox(ring);
      const y0 = footing(c.x, c.z, 10);
      const H = 11;
      shell(ring, y0, H, C.stone, 'all-nations');
      m.paint(C.stoneOld, 0.45, 1.0, STYLE.ashlar);
      m.polygon([ring], y0 + H, 1);
      // Facade toward the Kidron (west): portico of four columns, pediment with gold mosaic.
      const sides = [[box.ax, box.az, box.hl, box.hw], [-box.ax, -box.az, box.hl, box.hw], [-box.az, box.ax, box.hw, box.hl], [box.az, -box.ax, box.hw, box.hl]];
      const [fx, fz, fd, fw] = sides.reduce((a, b) => (b[0] < a[0] ? b : a));
      const ux = -fz, uz = fx;
      const px = c.x + fx * (fd + 3.5), pz = c.z + fz * (fd + 3.5);
      kit.arcadeScreen(px, y0, pz, ux, uz, fw * 2 * 0.8, 8.5, 3, { pier: 1.4, col: 1.2, thick: 1.1, ref: 'all-nations' });
      m.paint(C.stone, 0.45, 1.0, STYLE.ashlar);
      m.orientedBox(c.x + fx * (fd + 1.75), c.z + fz * (fd + 1.75), ux, uz, fw * 0.8, 2.3, y0 + 8.5, y0 + 9.3, { bottom: true });
      // The pediment: a triangle of gold mosaic under a stone frame.
      const pw = fw * 0.8, ph = 4.2, py = y0 + 9.3;
      const Pp = (s, h, o) => [px + ux * s + fx * o, py + h, pz + uz * s + fz * o];
      m.paint(C.stone, 0.45, 1.0, STYLE.ashlar);
      m.tri(Pp(-pw, 0, 0.6), Pp(pw, 0, 0.6), Pp(0, ph, 0.6), [fx, 0, fz]);
      m.paint(C.mosaic, 1, 1, STYLE.gold);
      m.tri(Pp(-pw * 0.8, 0.4, 0.63), Pp(pw * 0.8, 0.4, 0.63), Pp(0, ph - 0.7, 0.63), [fx, 0, fz]);
      m.paint(C.stone, 0.45, 1.0, STYLE.ashlar);
      m.tri(Pp(pw, 0, -1), Pp(-pw, 0, -1), Pp(0, ph, -1), [-fx, 0, -fz]);
      for (const side of [-1, 1]) {
        const nl = Math.hypot(ph, pw);
        m.quad(Pp(side * pw, 0, 0.6), Pp(side * pw, 0, -1), Pp(0, ph, -1), Pp(0, ph, 0.6), [(ux * side * ph) / nl, pw / nl, (uz * side * ph) / nl]);
      }
      // Twelve small domes: three naves of four bays.
      m.paint(C.lead, 1, 1, STYLE.lead);
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 4; b++) {
          const across = (a - 1) * (fw * 0.62), deep = (b - 1.5) * ((fd * 2) / 4.4);
          const x = c.x + ux * across - fx * deep, z = c.z + uz * across - fz * deep;
          m.cylinder(x, z, 2.3, 2.3, y0 + H, y0 + H + 1.1, 10, { top: false });
          kit.revolve(x, z, kit.domeProfile(2.35, y0 + H + 1.1, 1.9, 0.05, 6), 10);
        }
      }
      stats.churches++;
    }

    // --- Absalom's Tomb and the Tomb of Zechariah ----------------------------------------------
    if (ol.absalom) {
      const ring = project(ol.absalom.ring);
      const c = ringCenter(ring), box = orientedBox(ring);
      const g = footing(c.x, c.z, 4);
      const s = Math.min(box.hl, box.hw) * 0.75;
      m.paint(C.stoneOld, 1.1, 2.2, STYLE.herodian);
      m.orientedBox(c.x, c.z, box.ax, box.az, s, s, g - 0.5, g + 6.6);
      m.paint(C.stoneOld, 0.5, 1.0, STYLE.ashlar);
      m.orientedBox(c.x, c.z, box.ax, box.az, s + 0.25, s + 0.25, g + 6.6, g + 7.2);
      m.orientedBox(c.x, c.z, box.ax, box.az, s * 0.8, s * 0.8, g + 7.2, g + 8.6);
      const r = s * 0.78;
      m.cylinder(c.x, c.z, r, r, g + 8.6, g + 9.8, 16, { top: false });
      // The concave cone ("the hat") with a lotus knob.
      const prof = [];
      for (let k = 0; k <= 8; k++) { const t = k / 8; prof.push([r * (1 - t) ** 1.9 + 0.12 * t, g + 9.8 + 7.5 * t]); }
      kit.revolve(c.x, c.z, prof, 16);
      kit.revolve(c.x, c.z, [[0.2, g + 17.3], [0.45, g + 17.7], [0.3, g + 18.1], [0, g + 18.4]], 10);
      addBox({ minX: c.x - s, maxX: c.x + s, minZ: c.z - s, maxZ: c.z + s, minY: g - 0.5, maxY: g + 9.8 }, 'building', 'absalom');
      stats.churches++;
    }
    if (ol.zechariah) {
      const ring = project(ol.zechariah.ring);
      const c = ringCenter(ring), box = orientedBox(ring);
      const g = footing(c.x, c.z, 4);
      const s = Math.min(box.hl, box.hw) * 0.7;
      m.paint(C.stoneOld, 1.1, 2.2, STYLE.herodian);
      m.orientedBox(c.x, c.z, box.ax, box.az, s, s, g - 0.5, g + 5.2);
      const q = [c.x - s, c.z - s, c.x + s, c.z - s, c.x + s, c.z + s, c.x - s, c.z + s];
      m.paint(C.stoneOld, 0.6, 1.2, STYLE.ashlar);
      m.pyramid(q, g + 5.2, 3.6);
      addBox({ minX: c.x - s, maxX: c.x + s, minZ: c.z - s, maxZ: c.z + s, minY: g - 0.5, maxY: g + 5.2 }, 'building', 'zechariah');
    }

    // --- Russian bell tower of the Ascension -----------------------------------------------------
    if (ol.bellTower) {
      const p = place(ol.bellTower);
      tower(m, kit, p.x, p.z, footing(p.x, p.z, 4), { stages: 6, width: 7.5, height: 64, color: C.white, cap: 'onion' }, { addBox, onion });
      stats.towers++;
    }
    // --- Chapel of the Ascension in its walled court ----------------------------------------------
    if (ol.chapelAscension) {
      const p = place(ol.chapelAscension);
      const g = footing(p.x, p.z, 16);
      m.paint(C.stoneOld, 0.45, 1.0, STYLE.ashlar);
      const W = 15;
      for (const [dx, dz, ux, uz] of [[0, -W, 1, 0], [0, W, 1, 0], [-W, 0, 0, 1], [W, 0, 0, 1]]) {
        m.orientedBox(p.x + dx, p.z + dz, ux, uz, W, 0.45, g - 0.5, g + 4.5);
        addBox({ minX: p.x + dx - (ux ? W : 0.45), maxX: p.x + dx + (ux ? W : 0.45), minZ: p.z + dz - (uz ? W : 0.45), maxZ: p.z + dz + (uz ? W : 0.45), minY: g - 0.5, maxY: g + 4.5 }, 'wall', 'chapel-ascension');
      }
      const oct = [];
      for (let k = 0; k < 8; k++) oct.push(p.x + Math.cos((k / 8) * Math.PI * 2) * 3.4, p.z + Math.sin((k / 8) * Math.PI * 2) * 3.4);
      m.paint(C.stone, 0.45, 1.0, STYLE.ashlar);
      m.prism(oct, g - 0.3, g + 4.2);
      m.paint(C.lead, 1, 1, STYLE.lead);
      m.cylinder(p.x, p.z, 2.4, 2.4, g + 4.2, g + 5.2, 12, { top: false });
      kit.revolve(p.x, p.z, kit.domeProfile(2.5, g + 5.2, 2.2, 0.1), 12);
      addFootprint([oct], g - 0.3, g + 4.2, 'building', 'chapel-ascension');
    }
    // --- Seven Arches Hotel ---------------------------------------------------------------------
    if (ol.sevenArches) {
      const p = place(ol.sevenArches);
      const g = footing(p.x, p.z, 30);
      const L = 78, D = 18, H = 11;
      // Long side facing west (toward the Old City); an arcade of seven tall arches in front.
      m.paint(C.stone, 0.45, 1.0, STYLE.ashlar);
      m.orientedBox(p.x, p.z, 0, 1, L / 2, D / 2, g - 1, g + H);
      addBox({ minX: p.x - D / 2, maxX: p.x + D / 2, minZ: p.z - L / 2, maxZ: p.z + L / 2, minY: g - 1, maxY: g + H }, 'building', 'seven-arches');
      kit.arcadeScreen(p.x - D / 2 - 2.5, g, p.z, 0, 1, L * 0.62, H - 1, 7, { pier: 1.6, col: 1.4, thick: 1.2, ref: 'seven-arches' });
      m.paint(C.stone, 0.45, 1.0, STYLE.ashlar);
      m.orientedBox(p.x - D / 2 - 1.2, p.z, 0, 1, L * 0.31, 1.4, g + H - 0.6, g + H + 0.2, { bottom: true });
    }
  }

  const sc = data.scopus;
  if (sc) {
    // --- Hebrew University tower and campus -------------------------------------------------------
    if (sc.universityTower) {
      const p = place(sc.universityTower);
      const g = footing(p.x, p.z, 5);
      tower(m, kit, p.x, p.z, g, { stages: 1, width: 8, height: 62, color: C.stone, cap: 'flat', slits: true }, { addBox, onion });
      stats.towers++;
      // The campus: long fortress-like stone blocks around the tower, on the ridge.
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2 + hash(k, 3) * 0.5;
        const r = 45 + hash(k, 7) * 110;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        const L = 26 + hash(k, 11) * 34, D = 14 + hash(k, 13) * 8, H = 12 + hash(k, 17) * 10;
        const ux = Math.cos(a + Math.PI / 2), uz = Math.sin(a + Math.PI / 2);
        const gg = footing(x, z, L / 2);
        m.paint(k % 2 ? C.stone : C.stoneOld, 0.5, 1.3, STYLE.ashlar);
        m.orientedBox(x, z, ux, uz, L / 2, D / 2, gg - 1, gg + H);
        for (const side of [-1, 1]) {
          for (let s = -L / 2 + 2; s < L / 2 - 1; s += 3.2) kit.window(x + ux * s - uz * side * (D / 2), gg + H * 0.3, z + uz * s + ux * side * (D / 2), ux, uz, -uz * side, ux * side, 0.9, H * 0.3 + 1.6);
        }
        const q = [x - ux * L / 2 + uz * D / 2, z - uz * L / 2 - ux * D / 2, x + ux * L / 2 + uz * D / 2, z + uz * L / 2 - ux * D / 2, x + ux * L / 2 - uz * D / 2, z + uz * L / 2 + ux * D / 2, x - ux * L / 2 - uz * D / 2, z - uz * L / 2 + ux * D / 2];
        addFootprint([q], gg - 1, gg + H, 'building', 'hebrew-university');
      }
    }
    // --- Augusta Victoria: the church and its bell tower -----------------------------------------
    if (sc.augustaVictoria) {
      const p = place(sc.augustaVictoria);
      const g = footing(p.x, p.z, 25);
      tower(m, kit, p.x, p.z, g, { stages: 4, width: 7, height: 60, color: C.stoneOld, cap: 'pyramid' }, { addBox, onion });
      // The church nave east of the tower, with a lead gable roof.
      const cx = p.x + 24, cz = p.z;
      m.paint(C.stoneOld, 0.5, 1.2, STYLE.ashlar);
      m.orientedBox(cx, cz, 1, 0, 20, 8.5, g - 1, g + 14);
      addBox({ minX: cx - 20, maxX: cx + 20, minZ: cz - 8.5, maxZ: cz + 8.5, minY: g - 1, maxY: g + 14 }, 'building', 'augusta-victoria');
      m.paint(C.lead, 1, 1, STYLE.lead);
      for (const side of [-1, 1]) {
        const rise = 5, run = 9, nl = Math.hypot(rise, run);
        m.quad([cx - 20, g + 14, cz + side * 9], [cx + 20, g + 14, cz + side * 9], [cx + 20, g + 19, cz], [cx - 20, g + 19, cz], [0, run / nl, (side * rise) / nl]);
      }
      m.paint(C.stoneOld, 0.5, 1.2, STYLE.ashlar);
      for (const e of [-1, 1]) m.tri([cx + e * 20, g + 14, cz - 9], [cx + e * 20, g + 14, cz + 9], [cx + e * 20, g + 19, cz], [e, 0, 0]);
      stats.towers++;
    }
  }

  finish(m, 'Hills');
  return stats;
}

/** A tall tower: square shaft in stages with arched openings, then an onion, pyramid or flat top. */
function tower(m, kit, x, z, g, { stages, width, height, color, cap, slits = false }, { addBox, onion }) {
  const stageH = (height - (cap === 'flat' ? 2 : 10)) / stages;
  let y = g - 1, w = width;
  for (let s = 0; s < stages; s++) {
    m.paint(color, 0.45, 0.9, STYLE.ashlar);
    m.orientedBox(x, z, 1, 0, w / 2, w / 2, y, y + stageH);
    for (const [ux, uz, nx, nz] of [[1, 0, 0, 1], [-1, 0, 0, -1], [0, 1, -1, 0], [0, -1, 1, 0]]) {
      const fx = x + nx * (w / 2), fz = z + nz * (w / 2);
      if (slits) {
        for (let o = -w / 2 + 1.2; o <= w / 2 - 1.2 + 0.01; o += 1.6) {
          m.paint(0x24211d, 1, 1, STYLE.plain);
          m.quad([fx + ux * (o - 0.25) + nx * 0.02, y + 4, fz + uz * (o - 0.25) + nz * 0.02], [fx + ux * (o + 0.25) + nx * 0.02, y + 4, fz + uz * (o + 0.25) + nz * 0.02],
            [fx + ux * (o + 0.25) + nx * 0.02, y + stageH - 3, fz + uz * (o + 0.25) + nz * 0.02], [fx + ux * (o - 0.25) + nx * 0.02, y + stageH - 3, fz + uz * (o - 0.25) + nz * 0.02], [nx, 0, nz]);
        }
      } else {
        kit.window(fx, y + stageH * 0.35, fz, ux, uz, nx, nz, Math.min(1.6, w * 0.3), stageH * 0.45);
      }
    }
    m.paint(color, 0.3, 0.6, STYLE.ashlar);
    m.orientedBox(x, z, 1, 0, w / 2 + 0.25, w / 2 + 0.25, y + stageH - 0.4, y + stageH);
    addBox({ minX: x - w / 2, maxX: x + w / 2, minZ: z - w / 2, maxZ: z + w / 2, minY: y, maxY: y + stageH }, 'building', 'tower');
    y += stageH;
    w *= stages > 1 ? 0.9 : 1;
  }
  if (cap === 'onion') {
    onion(x, z, y, w * 0.42, w * 0.6);
  } else if (cap === 'pyramid') {
    m.paint(0x7f878c, 1, 1, STYLE.lead);
    m.pyramid([x - w / 2, z - w / 2, x + w / 2, z - w / 2, x + w / 2, z + w / 2, x - w / 2, z + w / 2], y, 9);
  } else {
    m.paint(color, 0.3, 0.6, STYLE.ashlar);
    m.orientedBox(x, z, 1, 0, w / 2 + 0.4, w / 2 + 0.4, y, y + 1.2);
    m.paint(0x3a3d40, 1, 1, STYLE.metal);
    m.cylinder(x, z, 0.12, 0.06, y + 1.2, y + 7, 6);
  }
}

/** The Mount of Olives Jewish cemetery: instanced limestone grave slabs in contour rows. */
function graves(cem, ctx, stats) {
  const { project, ground, addObject, material } = ctx;
  const ring = project(cem.ring);
  const exclude = (cem.exclude ?? []).map((r) => project(r));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) { minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]); minZ = Math.min(minZ, ring[i + 1]); maxZ = Math.max(maxZ, ring[i + 1]); }
  const c = ringCenter(ring);
  // Downslope direction at the middle: rows run across it (along the contours).
  const e = 10;
  let dx = ground(c.x - e, c.z) - ground(c.x + e, c.z), dz = ground(c.x, c.z - e) - ground(c.x, c.z + e);
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl; dz /= dl; // points downhill
  const ax = -dz, az = dx; // along the contour
  const rowGap = 3.3, colGap = 2.25; // ~one grave per 7 m² (paths between the rows)
  const items = [];
  const R = Math.hypot(maxX - minX, maxZ - minZ) / 2 + 5;
  for (let v = -R; v <= R; v += rowGap) {
    for (let u = -R; u <= R; u += colGap) {
      const jitter = (hash(u, v) - 0.5) * 0.35;
      const x = c.x + ax * (u + jitter) + dx * v, z = c.z + az * (u + jitter) + dz * v;
      if (x < minX || x > maxX || z < minZ || z > maxZ || !pointInRings([ring], x, z)) continue;
      if (hash(v * 1.7, u * 0.3) < 0.1) continue; // paths and gaps
      if (exclude.some((r) => pointInRings([r], x, z))) continue;
      items.push([x, z]);
    }
  }
  if (!items.length) return;
  // One slab: 1.9 m down the slope, 0.95 m across, 0.5 m tall, with a slightly ridged top.
  const box = new THREE.BoxGeometry(0.95, 0.5, 1.9).translate(0, 0.25, 0).toNonIndexed();
  // Drop the bottom faces (never seen): 10 triangles per grave.
  const bp = box.getAttribute('position').array, bn = box.getAttribute('normal').array;
  const keepP = [], keepN = [];
  for (let t = 0; t < bp.length; t += 9) {
    if (bn[t + 1] < -0.5) continue;
    keepP.push(...bp.slice(t, t + 9));
    keepN.push(...bn.slice(t, t + 9));
  }
  box.dispose();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(keepP, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(keepN, 3));
  const n = geo.getAttribute('position').count;
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  const st = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) st.set([1.6, 2.4, STYLE.ashlar], i * 3);
  geo.setAttribute('aStone', new THREE.Float32BufferAttribute(st, 3));
  const mesh = new THREE.InstancedMesh(geo, material, items.length);
  mesh.name = 'Landmark(OliveCemetery)';
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  const yaw = Math.atan2(dx, dz);
  items.forEach(([x, z], i) => {
    const lo = Math.min(ground(x - dx * 0.95, z - dz * 0.95), ground(x + dx * 0.95, z + dz * 0.95));
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + (hash(x, z) - 0.5) * 0.06);
    s.set(0.9 + hash(z, x) * 0.2, 0.8 + hash(x * 3, z) * 0.5, 0.9 + hash(x, z * 3) * 0.2);
    p.set(x, lo - 0.15, z);
    M.compose(p, q, s);
    mesh.setMatrixAt(i, M);
    const t = hash(x * 7, z * 7);
    col.setHex(C.grave).multiplyScalar(0.86 + t * 0.2);
    mesh.setColorAt(i, col);
  });
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  addObject(mesh);
  stats.graves = items.length;
}
