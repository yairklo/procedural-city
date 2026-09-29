// The Temple Mount / Haram al-Sharif buildings, from landmarks.json `haram`
// (scripts/fetch_landmarks.js):
//
//   upper platform  the raised platform around the Dome of the Rock (a terrain patch 4 m above
//                   the esplanade): paving, retaining faces, and a flight of stairs below
//                   each arcade
//   arcades         the qanatir: free-standing screens of pointed arches on slender piers at
//                   the top of the stairs (open: you can walk through them)
//   Dome of the Rock  the octagon (marble below, blue tilework above, arched windows), four
//                   porches, the lead roof ring, the tiled drum with 16 windows and the gold
//                   dome with its finial
//   al-Aqsa         the hall with the raised nave and its lead gable roof, the arcaded portico
//                   on the north facade, and the grey dome over the qibla end
//   Dome of the Chain  an open ring of columns under a lead roof, the tiled drum and dome
//   small domes     open column pavilions (the small ones, the Ascension) or closed square /
//                   octagonal buildings, each with its dome
//   minarets        square Mamluk towers with string courses, a balcony and a domed top; the
//                   round Ottoman shaft of Bab al-Asbat
//   groves          grass and olive trees in the mapped gardens / groves (mapped trees are
//                   planted by the city itself; these fill the rest)
//
// Everything goes into one mesh (one draw call per pass) with the landmark material, and
// adds collision boxes: walls, piers, stairs you can climb, domes you can land on.

import * as THREE from 'three';
import { Mesher, STYLE, ringCenter, ringRadius, resample, signedArea } from './geometry.js';
import { orientedBox, pointInRings, distanceToEdges } from '../footprint.js';
import { createKit, rayRing, archOutline, hash } from './kit.js';
export { pointedArch, archRise } from './kit.js';

const C = {
  stone: 0xd6ccb8,
  stoneOld: 0xc9bea8,
  paving: 0xd4cbb9,
  marble: 0xe6e2da,
  tileBlue: 0x24518f,
  tileDark: 0x183a6a,
  tileGreen: 0x2f6f73,
  gold: 0xd9a441,
  lead: 0x8a9096,
  leadDark: 0x6d7378,
  opening: 0x24211d,
  wood: 0x5b4a3a,
  grass: 0x76834a,
  olive: [0x6f7a55, 0x66734f, 0x78805a, 0x5f6b4a],
  iron: 0x2a2d2e,
};

const STEP = { rise: 0.25, tread: 0.32 };

/**
 * @param {object} haram  landmarks.json `haram`
 * @param {object} ctx    { project, at, ground, patches, addBox, addFootprint, quadBox, finish }
 */
export function buildHaram(haram, ctx) {
  const { project, at, ground, patches, addBox, addFootprint, quadBox, finish } = ctx;
  const raised = (patches ?? []).filter((p) => p.mode === 'raise').sort((a, b) => a.y - b.y);
  const esplanade = raised[0];
  const upper = raised.find((p) => p.name === 'Dome of the Rock platform') ?? null;
  const lowY = esplanade?.y ?? 0;
  const m = new Mesher();
  const stats = { arcades: 0, domes: 0, minarets: 0, trees: 0, steps: 0 };

  const { face, slab, window: window_, revolve, domeProfile, domeBoxes, finial, arcadeScreen } = createKit(m, { addBox, quadBox });

  // --- the raised platform: paving, retaining faces, edge band collision ------------------------
  let upperRing = null, upperC = null;
  if (upper) {
    upperRing = upper.rings[0];
    upperC = ringCenter(upperRing);
    m.paint(C.paving, 1, 1.2, STYLE.paving);
    m.polygon(upper.rings, upper.y + 0.03, 1);
    const ccw = signedArea(upperRing) > 0;
    const pts = resample([...upperRing, upperRing[0], upperRing[1]], 4);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-3) continue;
      let nx = (b.z - a.z) / len, nz = -(b.x - a.x) / len;
      if (!ccw) { nx = -nx; nz = -nz; }
      m.paint(C.stoneOld, 0.5, 1.1, STYLE.ashlar);
      m.wall(a.x, a.z, b.x, b.z, lowY - 0.3, lowY - 0.3, upper.y + 0.03, upper.y + 0.03, [nx, 0, nz]);
      // The terrain's raised level starts 2 m inside the outline: the band is a solid ledge.
      quadBox([a.x, a.z, b.x, b.z, b.x - nx * 2.6, b.z - nz * 2.6, a.x - nx * 2.6, a.z - nz * 2.6], lowY - 1, upper.y, 'wall', 'haram-platform');
    }
  }

  // --- arcades (qanatir) and the stairs below them ------------------------------------------------
  for (const a of haram.arcades ?? []) {
    const ring = project(a.ring);
    const box = orientedBox(ring);
    const L = box.hl * 2;
    let ux = box.ax, uz = box.az;
    let nx = -uz, nz = ux;
    const ref = upperC ?? ringCenter(ring);
    if ((box.cx - ref.x) * nx + (box.cz - ref.z) * nz < 0) { nx = -nx; nz = -nz; ux = -ux; uz = -uz; }
    const y0 = upper ? upper.y : ground(box.cx, box.cz);
    const H = a.height ?? 6;
    const bays = Math.max(2, Math.min(5, Math.round(L / 3.8)));
    arcadeScreen(box.cx, y0, box.cz, ux, uz, L, H, bays, { pier: 0.85, col: 0.5, thick: 1.0, style: [C.stone, 0.5, 1.0, STYLE.ashlar], ref: a.id });
    stats.arcades++;

    // Stairs: from the platform edge in front of the arcade down to the esplanade.
    if (upper) {
      const d = rayRing(upperRing, box.cx, box.cz, nx, nz) ?? box.hw + 2;
      const n = Math.round((upper.y - lowY) / STEP.rise);
      const W = Math.max(L, 6);
      for (let k = 0; k < n; k++) {
        const top = upper.y - (k + 1) * STEP.rise;
        if (top <= lowY + 0.01) break;
        const s0 = d + k * STEP.tread;
        const cx = box.cx + nx * (s0 + STEP.tread / 2), cz = box.cz + nz * (s0 + STEP.tread / 2);
        m.paint(k % 2 ? C.paving : C.stone, 0.25, 1.2, STYLE.paving);
        m.orientedBox(cx, cz, ux, uz, W / 2, STEP.tread / 2 + 0.01, lowY - 0.3, top);
        const q = (t, s) => [box.cx + ux * t + nx * s, box.cz + uz * t + nz * s];
        quadBox([...q(-W / 2, s0), ...q(W / 2, s0), ...q(W / 2, s0 + STEP.tread), ...q(-W / 2, s0 + STEP.tread)], lowY - 0.3, top, 'stairs', a.id);
        stats.steps++;
      }
      // Side walls of the flight.
      m.paint(C.stoneOld, 0.5, 1.1, STYLE.ashlar);
      const run = n * STEP.tread;
      for (const side of [-1, 1]) {
        const t = side * (W / 2 + 0.35);
        m.orientedBox(box.cx + ux * t + nx * (d + run / 2), box.cz + uz * t + nz * (d + run / 2), nx, nz, run / 2, 0.35, lowY - 0.3, upper.y + 0.5);
      }
    }
  }

  // --- the Dome of the Rock -----------------------------------------------------------------------
  const rock = haram.domeOfTheRock;
  if (rock) {
    const ring = project(rock.ring);
    const c = ringCenter(ring);
    const R = ringRadius(ring, c);
    const y0 = ground(c.x, c.z);
    const wallTop = y0 + 12.4, band = y0 + 13.2;
    const drumR = R * 0.39, drumTop = y0 + 23.2, domeY = drumTop + 0.6, domeH = drumR * 1.08;
    const ccw = signedArea(ring) > 0;
    const n = ring.length / 2;
    const faces = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      let nx = (bz - az) / len, nz = -(bx - ax) / len;
      if (!ccw) { nx = -nx; nz = -nz; }
      faces.push({ ax, az, bx, bz, len, ux: (bx - ax) / len, uz: (bz - az) / len, nx, nz, card: Math.max(Math.abs(nx), Math.abs(nz)) });
    }
    // The four porches: on the faces that look most nearly north, east, south and west.
    const porchFaces = new Set([...faces].sort((p, q) => q.card - p.card).slice(0, 4));
    for (const f of faces) {
      const N = [f.nx, 0, f.nz];
      m.paint(C.marble, 1, 1, STYLE.marble);
      m.wall(f.ax, f.az, f.bx, f.bz, y0 - 0.5, y0 - 0.5, y0 + 5.6, y0 + 5.6, N);
      m.paint(C.tileBlue, 1, 1, STYLE.tile);
      m.wall(f.ax, f.az, f.bx, f.bz, y0 + 5.6, y0 + 5.6, wallTop, wallTop, N);
      m.paint(C.tileDark, 1, 1, STYLE.tile);
      m.wall(f.ax, f.az, f.bx, f.bz, wallTop, wallTop, band, band, N);
      // Seven arched bays per face: the middle five are windows, the outer two blind (tiled).
      const bay = f.len / 7;
      for (let k = 1; k < 6; k++) {
        const s = (k + 0.5) * bay;
        window_(f.ax + f.ux * s, y0 + 7.2, f.az + f.uz * s, f.ux, f.uz, f.nx, f.nz, bay * 0.45, 4.1);
      }
      if (porchFaces.has(f)) {
        // Porch: an arcade of three arches 3.2 m out, flat roof, the door behind it.
        const mid = f.len / 2, W = Math.min(10, f.len * 0.5), D = 3.2, H = 7.2;
        const px = f.ax + f.ux * mid + f.nx * D, pz = f.az + f.uz * mid + f.nz * D;
        arcadeScreen(px, y0, pz, f.ux, f.uz, W, H, 3, { pier: 0.8, col: 0.6, thick: 0.7, style: [C.marble, 1, 1, STYLE.marble], ref: 'dome-of-the-rock' });
        m.paint(C.marble, 1, 1, STYLE.marble);
        m.orientedBox(f.ax + f.ux * mid + f.nx * (D / 2), f.az + f.uz * mid + f.nz * (D / 2), f.ux, f.uz, W / 2 + 0.1, D / 2 + 0.35, y0 + H, y0 + H + 0.6);
        m.paint(C.opening, 1, 1, STYLE.plain);
        face(archOutline(2.6, 4.8), f.ax + f.ux * mid + f.nx * 0.03, y0, f.az + f.uz * mid + f.nz * 0.03, f.ux, f.uz, f.nx, f.nz);
        quadBox([f.ax + f.ux * (mid - W / 2), f.az + f.uz * (mid - W / 2), f.ax + f.ux * (mid + W / 2), f.az + f.uz * (mid + W / 2),
          f.ax + f.ux * (mid + W / 2) + f.nx * D, f.az + f.uz * (mid + W / 2) + f.nz * D, f.ax + f.ux * (mid - W / 2) + f.nx * D, f.az + f.uz * (mid - W / 2) + f.nz * D], y0 + H, y0 + H + 0.6, 'building', 'dome-of-the-rock');
      }
    }
    addFootprint([ring], y0 - 0.5, band, 'building', 'dome-of-the-rock');
    // Roof: lead, sloping from the octagon's parapet up to the drum.
    const seg = 32;
    m.paint(C.lead, 1, 1, STYLE.lead);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const e = (a) => { const t = rayRing(ring, c.x, c.z, Math.cos(a), Math.sin(a)) ?? R; return [c.x + Math.cos(a) * (t - 0.4), band, c.z + Math.sin(a) * (t - 0.4)]; };
      const d = (a) => [c.x + Math.cos(a) * drumR, band + 1.4, c.z + Math.sin(a) * drumR];
      // Explicit normal (up, tilted outward: the roof rises toward the drum), so the quad is
      // wound to face the sky whatever order its corners come in.
      const am = (a0 + a1) / 2, k = 1.4 / Math.max(R - drumR, 1);
      const nl = Math.hypot(k, 1);
      m.quad(e(a0), e(a1), d(a1), d(a0), [(Math.cos(am) * k) / nl, 1 / nl, (Math.sin(am) * k) / nl]);
    }
    // Drum: tiled, 16 windows, a dark band of inscription tiles at the top.
    m.paint(C.tileBlue, 1, 1, STYLE.tile);
    m.cylinder(c.x, c.z, drumR, drumR, band + 1.3, drumTop - 1.2, seg, { top: false });
    m.paint(C.tileDark, 1, 1, STYLE.tile);
    m.cylinder(c.x, c.z, drumR, drumR, drumTop - 1.2, drumTop, seg, { top: false });
    for (let k = 0; k < 16; k++) {
      const a = ((k + 0.5) / 16) * Math.PI * 2;
      const nx = Math.cos(a), nz = Math.sin(a);
      window_(c.x + nx * drumR, band + 3.6, c.z + nz * drumR, -nz, nx, nx, nz, 1.5, 4.0);
    }
    m.paint(C.lead, 1, 1, STYLE.lead);
    m.cylinder(c.x, c.z, drumR + 0.3, drumR + 0.2, drumTop, domeY, seg, { top: false });
    // The gold dome: slightly stilted (a short upright base) and slightly pointed.
    m.paint(C.gold, 1, 1, STYLE.gold);
    m.cylinder(c.x, c.z, drumR + 0.15, drumR + 0.15, domeY, domeY + 0.9, 40, { top: false });
    revolve(c.x, c.z, domeProfile(drumR + 0.15, domeY + 0.9, domeH - 0.9, 0.2, 14), 40);
    finial(c.x, domeY + domeH - 0.1, c.z, 1.6, faces[0].ux, faces[0].uz);
    addBox({ minX: c.x - drumR * 0.72, maxX: c.x + drumR * 0.72, minZ: c.z - drumR * 0.72, maxZ: c.z + drumR * 0.72, minY: band, maxY: domeY }, 'building', 'dome-of-the-rock');
    domeBoxes(c.x, c.z, drumR, domeY, domeH, 'dome-of-the-rock');
    stats.domes++;
  }

  // --- the Dome of the Chain ----------------------------------------------------------------------
  const chain = haram.domeOfTheChain;
  if (chain) {
    const ring = project(chain.ring);
    const c = ringCenter(ring), R = ringRadius(ring, c);
    const y0 = ground(c.x, c.z);
    const colH = 4.4, beam = colH + 0.7;
    // Outer ring: 11 columns; inner ring: 6 columns carrying the drum.
    for (const [count, r] of [[11, R - 0.6], [6, R * 0.42]]) {
      for (let k = 0; k < count; k++) {
        const a = (k / count) * Math.PI * 2;
        const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
        m.paint(C.marble, 1, 1, STYLE.marble);
        m.cylinder(x, z, 0.22, 0.2, y0, y0 + colH - 0.3, 8);
        m.paint(C.stone, 0.3, 0.6, STYLE.ashlar);
        m.orientedBox(x, z, 1, 0, 0.32, 0.32, y0 + colH - 0.3, y0 + colH);
        addBox({ minX: x - 0.25, maxX: x + 0.25, minZ: z - 0.25, maxZ: z + 0.25, minY: y0, maxY: y0 + colH }, 'building', 'dome-of-the-chain');
      }
    }
    // Ring beam and the lead roof sloping in to the drum.
    m.paint(C.stoneOld, 0.4, 0.8, STYLE.ashlar);
    m.cylinder(c.x, c.z, R - 0.2, R - 0.2, y0 + colH, y0 + beam, 22, { top: false });
    m.paint(C.lead, 1, 1, STYLE.lead);
    revolve(c.x, c.z, [[R, y0 + beam], [R * 0.45, y0 + beam + 1.1]], 22);
    revolve(c.x, c.z, [[R * 0.45, y0 + colH], [R - 0.2, y0 + colH]], 22); // ceiling seen from below
    const dr = R * 0.42;
    m.paint(C.tileGreen, 1, 1, STYLE.tile);
    m.cylinder(c.x, c.z, dr, dr, y0 + colH, y0 + beam + 2.2, 12, { top: false });
    m.paint(C.leadDark, 1, 1, STYLE.lead);
    revolve(c.x, c.z, domeProfile(dr + 0.1, y0 + beam + 2.2, dr * 0.95, 0.1), 16);
    finial(c.x, y0 + beam + 2.2 + dr * 0.95 - 0.05, c.z, 0.7);
    addBox({ minX: c.x - R * 0.7, maxX: c.x + R * 0.7, minZ: c.z - R * 0.7, maxZ: c.z + R * 0.7, minY: y0 + colH, maxY: y0 + beam + 1 }, 'building', 'dome-of-the-chain');
    domeBoxes(c.x, c.z, dr, y0 + beam + 2.2, dr * 0.95, 'dome-of-the-chain');
    stats.domes++;
  }

  // --- al-Aqsa ------------------------------------------------------------------------------------
  const aqsa = haram.aqsa;
  if (aqsa) {
    const ring = project(aqsa.ring);
    let gMin = Infinity, gMax = -Infinity;
    for (let i = 0; i < ring.length; i += 2) { const g = ground(ring[i], ring[i + 1]); gMin = Math.min(gMin, g); gMax = Math.max(gMax, g); }
    const y0 = esplanade ? Math.max(gMin, lowY) : gMin;
    const base = gMin - 0.5, wallTop = y0 + 10.5;
    m.paint(C.stone, 0.5, 1.1, STYLE.ashlar);
    m.prism(ring, base, wallTop, { top: false });
    m.paint(C.lead, 1, 1, STYLE.lead);
    m.polygon([ring], wallTop, 1);
    addFootprint([ring], base, wallTop, 'building', 'al-aqsa');
    // Windows along the outer walls.
    const ccw = signedArea(ring) > 0;
    const n = ring.length / 2;
    let facade = null;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 4) continue;
      let nx = (bz - az) / len, nz = -(bx - ax) / len;
      if (!ccw) { nx = -nx; nz = -nz; }
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      // The north facade: the longest edge facing north.
      if (nz < -0.7 && (!facade || len > facade.len)) facade = { ax, az, bx, bz, len, ux, uz, nx, nz };
      const count = Math.floor(len / 5.5);
      for (let k = 0; k < count; k++) {
        const s = ((k + 0.5) * len) / count;
        window_(ax + ux * s, y0 + 5.2, az + uz * s, ux, uz, nx, nz, 1.3, 3.6);
      }
    }
    if (facade) {
      // Nave: from the facade south to the qibla wall, raised above the aisles.
      const f = facade;
      let ax = -f.nx, az = -f.nz; // into the building (south)
      const mx = (f.ax + f.bx) / 2, mz = (f.az + f.bz) / 2;
      const depth = rayRing(ring, mx + ax * 0.5, mz + az * 0.5, ax, az) ?? 70;
      const domeD = depth - 10, naveL = domeD - 7;
      const hw = 6.5;
      const nc = [mx + ax * (naveL / 2), mz + az * (naveL / 2)];
      m.paint(C.stone, 0.5, 1.1, STYLE.ashlar);
      m.orientedBox(nc[0], nc[1], ax, az, naveL / 2, hw, wallTop - 0.1, wallTop + 4.2, { top: false });
      for (const side of [-1, 1]) {
        for (let s = 3; s < naveL - 2; s += 5) {
          const px = mx + ax * s + f.ux * side * hw, pz = mz + az * s + f.uz * side * hw;
          window_(px, wallTop + 0.9, pz, ax, az, f.ux * side, f.uz * side, 1.1, 2.6);
        }
      }
      // Gable roof over the nave.
      m.paint(C.lead, 1, 1, STYLE.lead);
      const ridge = wallTop + 6.6, eave = wallTop + 4.1;
      const P = (s, t, y) => [mx + ax * s + f.ux * t, y, mz + az * s + f.uz * t];
      for (const side of [-1, 1]) {
        // Up and out toward this side's eave (explicit, so the roof faces the sky).
        const rise = ridge - eave, run = hw + 0.3, nl = Math.hypot(rise, run);
        const n = [(f.ux * side * rise) / nl, run / nl, (f.uz * side * rise) / nl];
        m.quad(P(0, side * (hw + 0.3), eave), P(naveL, side * (hw + 0.3), eave), P(naveL, 0, ridge), P(0, 0, ridge), n);
      }
      m.paint(C.stone, 0.5, 1.1, STYLE.ashlar);
      m.tri(P(0, -hw, eave), P(0, hw, eave), P(0, 0, ridge), [f.nx, 0, f.nz]);
      addBox({ minX: Math.min(P(0, -hw, 0)[0], P(naveL, hw, 0)[0], P(0, hw, 0)[0], P(naveL, -hw, 0)[0]), maxX: Math.max(P(0, -hw, 0)[0], P(naveL, hw, 0)[0], P(0, hw, 0)[0], P(naveL, -hw, 0)[0]),
        minZ: Math.min(P(0, -hw, 0)[2], P(naveL, hw, 0)[2], P(0, hw, 0)[2], P(naveL, -hw, 0)[2]), maxZ: Math.max(P(0, -hw, 0)[2], P(naveL, hw, 0)[2], P(0, hw, 0)[2], P(naveL, -hw, 0)[2]),
        minY: wallTop, maxY: eave }, 'building', 'al-aqsa');
      // The dome over the qibla end: square base, octagonal drum, grey dome.
      const dc = [mx + ax * domeD, mz + az * domeD];
      m.paint(C.stone, 0.5, 1.1, STYLE.ashlar);
      m.orientedBox(dc[0], dc[1], ax, az, 7.5, 7.5, wallTop - 0.1, wallTop + 5.5);
      m.cylinder(dc[0], dc[1], 7.2, 7.2, wallTop + 5.5, wallTop + 8, 8, { top: false });
      for (let k = 0; k < 8; k++) {
        const a = ((k + 0.5) / 8) * Math.PI * 2;
        window_(dc[0] + Math.cos(a) * 6.9, wallTop + 5.9, dc[1] + Math.sin(a) * 6.9, -Math.sin(a), Math.cos(a), Math.cos(a), Math.sin(a), 1.2, 1.8);
      }
      m.paint(C.leadDark, 1, 1, STYLE.lead);
      revolve(dc[0], dc[1], domeProfile(7.3, wallTop + 8, 7.4, 0.15, 10), 28);
      finial(dc[0], wallTop + 15.3, dc[1], 1.1, f.ux, f.uz);
      addBox({ minX: dc[0] - 7.5, maxX: dc[0] + 7.5, minZ: dc[1] - 7.5, maxZ: dc[1] + 7.5, minY: wallTop, maxY: wallTop + 8 }, 'building', 'al-aqsa');
      domeBoxes(dc[0], dc[1], 7.3, wallTop + 8, 7.4, 'al-aqsa');
      // North portico: seven arches 5 m in front of the facade under a flat roof, and the
      // doors in the facade behind them.
      const pw = Math.min(f.len - 2, 50), pd = 5, ph = 8.6;
      arcadeScreen(mx + f.nx * pd, y0, mz + f.nz * pd, f.ux, f.uz, pw, ph, 7, { pier: 1.2, col: 1.1, thick: 1.2, style: [C.stone, 0.5, 1.1, STYLE.ashlar], ref: 'al-aqsa' });
      m.paint(C.stone, 0.5, 1.1, STYLE.ashlar);
      m.orientedBox(mx + f.nx * (pd / 2), mz + f.nz * (pd / 2), f.ux, f.uz, pw / 2, pd / 2 + 0.6, y0 + ph - 0.4, y0 + ph + 0.35, { bottom: true });
      for (const side of [-1, 1]) {
        const sx = mx + f.ux * side * (pw / 2 - 0.6), sz = mz + f.uz * side * (pw / 2 - 0.6);
        m.orientedBox(sx + f.nx * (pd / 2), sz + f.nz * (pd / 2), f.nx, f.nz, pd / 2, 0.6, y0, y0 + ph);
      }
      for (let k = -3; k <= 3; k += 1.5) {
        const s = k * (pw / 7.2);
        m.paint(C.opening, 1, 1, STYLE.plain);
        face(archOutline(Math.abs(k) < 0.1 ? 3.2 : 2.2, Math.abs(k) < 0.1 ? 5.4 : 4.2), mx + f.ux * s + f.nx * 0.03, y0, mz + f.uz * s + f.nz * 0.03, f.ux, f.uz, f.nx, f.nz);
      }
      const q = (t, d) => [mx + f.ux * t + f.nx * d, mz + f.uz * t + f.nz * d];
      quadBox([...q(-pw / 2, 0), ...q(pw / 2, 0), ...q(pw / 2, pd + 0.6), ...q(-pw / 2, pd + 0.6)], y0 + ph - 0.4, y0 + ph + 0.35, 'building', 'al-aqsa');
      stats.domes++;
    }
  }

  // --- small domes ---------------------------------------------------------------------------------
  for (const d of haram.domes ?? []) {
    const ring = project(d.ring);
    const c = ringCenter(ring), R = ringRadius(ring, c);
    const n = ring.length / 2;
    const y0 = ground(c.x, c.z);
    const open = n >= 6 && (R < 4.5 || /Ascension/.test(d.name ?? ''));
    const H = Math.min(6.5, Math.max(3.4, R * 0.95));
    if (open) {
      // Columns at the corners, a beam around, the dome on top.
      for (let i = 0; i < n; i++) {
        const x = ring[i * 2] + (c.x - ring[i * 2]) * 0.06, z = ring[i * 2 + 1] + (c.z - ring[i * 2 + 1]) * 0.06;
        m.paint(C.marble, 1, 1, STYLE.marble);
        m.cylinder(x, z, 0.16, 0.14, y0, y0 + H - 0.5, 8);
        addBox({ minX: x - 0.2, maxX: x + 0.2, minZ: z - 0.2, maxZ: z + 0.2, minY: y0, maxY: y0 + H }, 'building', d.id);
      }
      m.paint(C.stone, 0.4, 0.8, STYLE.ashlar);
      m.prism(ring, y0 + H - 0.5, y0 + H, { top: true, bottom: true });
      addFootprint([ring], y0 + H - 0.5, y0 + H, 'building', d.id);
    } else {
      m.paint(C.stone, 0.45, 0.9, STYLE.ashlar);
      m.prism(ring, y0 - 0.3, y0 + H);
      addFootprint([ring], y0 - 0.3, y0 + H, 'building', d.id);
      // A door and windows on each face.
      const ccw = signedArea(ring) > 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1.8) continue;
        let nx = (bz - az) / len, nz = -(bx - ax) / len;
        if (!ccw) { nx = -nx; nz = -nz; }
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        window_(ax + ux * len / 2, y0 + (i === 0 ? 0 : 1.2), az + uz * len / 2, ux, uz, nx, nz, Math.min(1.4, len * 0.3), i === 0 ? 2.8 : 1.6);
      }
    }
    // Dome: on a short drum for the bigger ones.
    let dy = y0 + H;
    const dr = Math.max(1.1, R * (open ? 0.85 : 0.72));
    if (R > 3.5) {
      m.paint(C.stone, 0.4, 0.8, STYLE.ashlar);
      m.cylinder(c.x, c.z, dr + 0.15, dr + 0.15, dy, dy + 0.9, 16, { top: false });
      dy += 0.9;
    }
    m.paint(/Prophet|Tablets/.test(d.name ?? '') ? C.leadDark : C.lead, 1, 1, STYLE.lead);
    revolve(c.x, c.z, domeProfile(dr + 0.1, dy, dr * 0.9, 0.1), 16);
    finial(c.x, dy + dr * 0.9 - 0.05, c.z, Math.min(0.7, 0.3 + R * 0.06));
    domeBoxes(c.x, c.z, dr, dy, dr * 0.9, d.id);
    stats.domes++;
  }

  // --- minarets -------------------------------------------------------------------------------------
  const axis = esplanade ? orientedBox(esplanade.rings[0]) : { ax: 1, az: 0 };
  // Walls of the compound run close to north-south: align the towers with them.
  let mux = axis.ax, muz = axis.az;
  if (Math.abs(mux) < Math.abs(muz)) [mux, muz] = [-muz, mux];
  for (const mn of haram.minarets ?? []) {
    const p = at(mn);
    let g0 = Infinity;
    for (const [dx, dz] of [[-3, -3], [3, -3], [3, 3], [-3, 3], [0, 0]]) g0 = Math.min(g0, ground(p.x + dx, p.z + dz));
    g0 -= 1;
    const T = Math.max(g0 + 26, lowY + 25);
    const nx = -muz, nz = mux;
    const faceDirs = [[mux, muz, nx, nz], [-mux, -muz, -nx, -nz], [nx, nz, -mux, -muz], [-nx, -nz, mux, muz]];
    if (mn.style === 'round') {
      const B = Math.max(g0 + 8, lowY + 6);
      m.paint(C.stone, 0.45, 0.9, STYLE.ashlar);
      m.orientedBox(p.x, p.z, mux, muz, 2.8, 2.8, g0, B);
      m.cylinder(p.x, p.z, 2.1, 2.0, B, T, 16, { top: true });
      m.paint(C.stoneOld, 0.3, 0.6, STYLE.ashlar);
      for (let y = B + 6; y < T - 2; y += 6) m.cylinder(p.x, p.z, 2.2, 2.2, y, y + 0.3, 16);
      m.cylinder(p.x, p.z, 1.9, 3.0, T - 0.6, T, 16, { top: false });
      m.cylinder(p.x, p.z, 3.0, 3.0, T, T + 0.35, 16);
      m.paint(C.stone, 0.45, 0.9, STYLE.ashlar);
      m.cylinder(p.x, p.z, 1.5, 1.45, T + 0.35, T + 4.2, 12, { top: false });
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        window_(p.x + Math.cos(a) * 1.45, T + 1.0, p.z + Math.sin(a) * 1.45, -Math.sin(a), Math.cos(a), Math.cos(a), Math.sin(a), 0.6, 1.7);
      }
      m.paint(C.lead, 1, 1, STYLE.lead);
      m.cylinder(p.x, p.z, 1.6, 0.02, T + 4.2, T + 9.5, 12, { top: false });
      finial(p.x, T + 9.3, p.z, 0.55, mux, muz);
      for (let y = B + 3; y < T - 2; y += 6) {
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2 + y;
          window_(p.x + Math.cos(a) * 2.05, y, p.z + Math.sin(a) * 2.05, -Math.sin(a), Math.cos(a), Math.cos(a), Math.sin(a), 0.5, 1.3);
        }
      }
      addBox({ minX: p.x - 2.8, maxX: p.x + 2.8, minZ: p.z - 2.8, maxZ: p.z + 2.8, minY: g0, maxY: B }, 'building', mn.name);
      addBox({ minX: p.x - 2.1, maxX: p.x + 2.1, minZ: p.z - 2.1, maxZ: p.z + 2.1, minY: B, maxY: T + 4.2 }, 'building', mn.name);
    } else {
      const hw = 2.6;
      m.paint(C.stone, 0.45, 0.9, STYLE.ashlar);
      m.orientedBox(p.x, p.z, mux, muz, hw, hw, g0, T);
      // String courses and small windows between them.
      for (let y = g0 + 7; y < T - 1; y += 7) {
        m.paint(C.stoneOld, 0.3, 0.6, STYLE.ashlar);
        m.orientedBox(p.x, p.z, mux, muz, hw + 0.12, hw + 0.12, y, y + 0.3);
        for (const [ux, uz, fx, fz] of faceDirs) window_(p.x + fx * hw, y + 2.2, p.z + fz * hw, ux, uz, fx, fz, 0.55, 1.6);
      }
      // Balcony on corbels, railing.
      m.paint(C.stoneOld, 0.3, 0.6, STYLE.ashlar);
      m.orientedBox(p.x, p.z, mux, muz, hw + 0.4, hw + 0.4, T - 0.5, T);
      m.paint(C.stone, 0.3, 0.6, STYLE.ashlar);
      m.orientedBox(p.x, p.z, mux, muz, hw + 0.8, hw + 0.8, T, T + 0.4);
      m.paint(C.iron, 1, 1, STYLE.metal);
      for (const [ux, uz, fx, fz] of faceDirs) {
        m.orientedBox(p.x + fx * (hw + 0.7), p.z + fz * (hw + 0.7), ux, uz, hw + 0.8, 0.04, T + 1.2, T + 1.3);
        for (let s = -hw; s <= hw + 0.01; s += 1.3) m.orientedBox(p.x + fx * (hw + 0.7) + ux * s, p.z + fz * (hw + 0.7) + uz * s, ux, uz, 0.04, 0.04, T + 0.4, T + 1.3);
      }
      // Upper stage: square (or round, at the Chain Gate) drum with openings, lead dome.
      m.paint(C.stone, 0.45, 0.9, STYLE.ashlar);
      const round = /Silsila/.test(mn.name);
      if (round) m.cylinder(p.x, p.z, 1.9, 1.9, T + 0.4, T + 4.6, 12, { top: true });
      else m.orientedBox(p.x, p.z, mux, muz, 1.9, 1.9, T + 0.4, T + 4.6);
      for (const [ux, uz, fx, fz] of faceDirs) window_(p.x + fx * 1.9, T + 1.0, p.z + fz * 1.9, ux, uz, fx, fz, 0.8, 2.6);
      m.paint(C.lead, 1, 1, STYLE.lead);
      revolve(p.x, p.z, domeProfile(2.0, T + 4.6, 2.3, 0.25), 12);
      finial(p.x, T + 6.8, p.z, 0.55, mux, muz);
      addBox({ minX: p.x - hw, maxX: p.x + hw, minZ: p.z - hw, maxZ: p.z + hw, minY: g0, maxY: T }, 'building', mn.name);
      addBox({ minX: p.x - 1.9, maxX: p.x + 1.9, minZ: p.z - 1.9, maxZ: p.z + 1.9, minY: T, maxY: T + 4.6 }, 'building', mn.name);
    }
    stats.minarets++;
  }

  // --- groves: grass and olive trees ------------------------------------------------------------------
  const mapped = [];
  for (let i = 0; i + 1 < (haram.trees ?? []).length; i += 2) mapped.push(at({ lat: haram.trees[i], lon: haram.trees[i + 1] }));
  for (const [gi, g] of (haram.groves ?? []).entries()) {
    const ring = project(g.ring);
    const c = ringCenter(ring);
    const y = ground(c.x, c.z) + 0.12;
    m.paint(C.grass, 1, 1, STYLE.foliage);
    m.polygon([ring], y, 1);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < ring.length; i += 2) { minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]); minZ = Math.min(minZ, ring[i + 1]); maxZ = Math.max(maxZ, ring[i + 1]); }
    const gap = 7;
    for (let x = minX + gap / 2; x < maxX; x += gap) {
      for (let z = minZ + gap / 2; z < maxZ; z += gap) {
        const tx = x + (hash(x, z + gi) - 0.5) * 3.5, tz = z + (hash(z, x - gi) - 0.5) * 3.5;
        if (!pointInRings([ring], tx, tz) || distanceToEdges([ring], tx, tz) < 2.5) continue;
        if (mapped.some((q) => Math.hypot(q.x - tx, q.z - tz) < 4.5)) continue;
        const gy = ground(tx, tz);
        const s = 0.8 + hash(tx, tz) * 0.5;
        m.paint(C.wood, 1, 1, STYLE.wood);
        m.cylinder(tx, tz, 0.2 * s, 0.14 * s, gy, gy + 1.7 * s, 6);
        m.paint(C.olive[Math.floor(hash(tz, tx) * C.olive.length)], 1, 1, STYLE.foliage);
        const geo = new THREE.IcosahedronGeometry(1.9 * s, 1).scale(1.2, 0.75, 1.2).rotateY(hash(tx, 1) * 6).translate(tx, gy + 2.7 * s, tz);
        const pa = geo.getAttribute('position');
        const idx = geo.index;
        const v = (i) => [pa.getX(i), pa.getY(i), pa.getZ(i)];
        if (idx) for (let t = 0; t < idx.count; t += 3) m.tri(v(idx.getX(t)), v(idx.getX(t + 1)), v(idx.getX(t + 2)), null);
        else for (let t = 0; t < pa.count; t += 3) m.tri(v(t), v(t + 1), v(t + 2), null);
        geo.dispose();
        addBox({ minX: tx - 0.25, maxX: tx + 0.25, minZ: tz - 0.25, maxZ: tz + 0.25, minY: gy, maxY: gy + 1.7 * s }, 'tree', g.id);
        stats.trees++;
      }
    }
  }

  finish(m, 'Haram');
  return stats;
}
