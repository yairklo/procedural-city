// The Old City landmarks, built from public/data/landmarks.json (scripts/fetch_landmarks.js):
//
//   walls        Suleiman's walls: follow the terrain, 12 m over the outside ground, a
//                walkway on top (walkable, like the Ramparts Walk), a crenellated parapet on
//                the outer side and square towers at bends and every ~85 m. Openings are cut
//                where streets pass through.
//   gates        gatehouses with a pointed-arch passage lined up with the street (Damascus
//                Gate with flanking towers, the sealed Golden Gate with its two domes)
//   platform     the Temple Mount esplanade: a paved top over the compound and retaining walls
//                where the ground outside is lower (buildings on it come from the map data)
//   westernWall  Herodian courses as individual stones with drafted margins, Umayyad and
//                Ottoman courses above, caper bushes in the joints; the prayer plaza with its
//                partition and railing, and the covered Mughrabi bridge up to the esplanade
//   citadel      the Tower of David: fortress mass around its courtyard, towers, the large
//                Phasael tower and the Ottoman minaret
//   sepulchre    the Church of the Holy Sepulchre from its mapped parts (heights, lead domes,
//                the bell tower)
//   haram        the buildings on the Temple Mount esplanade (haram.js): the raised platform
//                with its stairs and arcades, the Dome of the Rock, al-Aqsa, the Dome of the
//                Chain, the small domes, the minarets and the groves
//
// Everything shares one material (materials.js) and adds collision boxes to the world under
// the group 'landmarks'. The same OSM buildings are left out of the generated city
// (landmarks.json `replaces` -> CityGenerator option excludeBuildings).

import * as THREE from 'three';
import { Mesher, STYLE, LIGHT, resample, ringCenter, ringRadius, signedArea } from './geometry.js';
import { createLandmarkMaterial, createShowUniforms } from './materials.js';
import { decomposeFootprint, pointInRings, distanceToEdges, orientedBox } from '../footprint.js';
import { buildHaram } from './haram.js';
import { buildModern } from './modern.js';
import { buildHills } from './hills.js';

const COLOR = {
  wall: 0xd6ccb8, // Jerusalem limestone: cream with a hint of pink, not yellow
  wallOld: 0xc9bea8,
  herodian: 0xd8cdb6,
  umayyad: 0xcdc3ad,
  ottoman: 0xc4baa4,
  paving: 0xd4cbb9,
  opening: 0x24211d, // arches and windows in shadow
  lead: 0x858b90,
  wood: 0x6b5039,
  iron: 0x2a2d2e,
  screen: 0xe6e0d2,
  caper: 0x566f36,
};
const CAPERS = [0x4d6630, 0x5b7338, 0x61773f, 0x475d2c];
const ASHLAR = { course: 0.68, length: 1.45 }; // Suleiman's walls: larger stones than a house

const WALL = { height: 12, thick: 2.8, parapet: 1.3, parapetThick: 0.7, merlonW: 0.95, merlonH: 1.1, merlonGap: 1.9, towerEvery: 85, towerLen: 8, towerOut: 3.2, towerExtra: 3 };
const GATE = {
  simple: { half: 7, extra: 4, width: 4.2 },
  'l-shaped': { half: 8, extra: 6, width: 4.4 },
  grand: { half: 12, extra: 6, width: 5.2 },
  sealed: { half: 11, extra: 3, width: 0 },
};
const COLLISION_GROUP = 'landmarks';

const hash = (a, b = 0) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * @param {object} data  parsed landmarks.json
 * @param {object} ctx   { projection, terrain, collision, uniforms }
 * @returns {{ group: THREE.Group, material: THREE.Material, stats: object, dispose(): void }}
 */
export function buildLandmarks(data, { projection, terrain, collision, uniforms }) {
  const show = createShowUniforms(); // time and festival switch for the night lighting
  const material = createLandmarkMaterial(uniforms, show);
  const materials = [material];
  const group = new THREE.Group();
  group.name = 'Landmarks';
  const ground = (x, z) => terrain.heightAt(x, z);
  const project = (flatLatLon) => projection.projectFlat(flatLatLon);
  const at = (p) => projection.project(p.lat, p.lon);
  const stats = { meshes: 0, triangles: 0, boxes: 0 };

  const addBox = (b, kind = 'building', ref = 'landmark') => {
    if (!(b.maxX > b.minX && b.maxY > b.minY && b.maxZ > b.minZ)) return;
    collision?.add({ ...b, kind, ref }, COLLISION_GROUP);
    stats.boxes++;
  };
  const addFootprint = (rings, minY, maxY, kind, ref) => {
    for (const b of decomposeFootprint(rings, { step: 0.6 })) addBox({ ...b, minY, maxY }, kind, ref);
  };
  const quadBox = (corners, minY, maxY, kind, ref) => {
    // Axis-aligned box around a (short) oriented piece.
    const xs = corners.filter((_, i) => i % 2 === 0), zs = corners.filter((_, i) => i % 2 === 1);
    addBox({ minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), minY, maxY }, kind, ref);
  };
  /** Turns a Mesher into a landmark mesh; `light`: its night lighting profile (LIGHT). */
  const finish = (mesher, name, light = LIGHT.warm) => {
    if (mesher.empty) return;
    const mesh = new THREE.Mesh(mesher.geometry(ground, light), material);
    mesh.name = `Landmark(${name})`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    stats.meshes++;
    stats.triangles += mesh.geometry.getAttribute('position').count / 3;
  };

  // --- shared: merlons (crenellations) -------------------------------------------------------
  const merlon = (m, x, z, ux, uz, y, big = false) => {
    const h = big ? WALL.merlonH * 1.3 : WALL.merlonH;
    m.orientedBox(x, z, ux, uz, WALL.merlonW / 2, WALL.parapetThick / 2, y, y + h);
    // Pointed cap, as on Suleiman's walls.
    const px = -uz, pz = ux, hw = WALL.merlonW / 2, hd = WALL.parapetThick / 2;
    const ring = [x - ux * hw - px * hd, z - uz * hw - pz * hd, x + ux * hw - px * hd, z + uz * hw - pz * hd, x + ux * hw + px * hd, z + uz * hw + pz * hd, x - ux * hw + px * hd, z - uz * hw + pz * hd];
    m.pyramid(ring, y + h, big ? 0.55 : 0.35);
  };

  // --- shared: openings (arcades, windows) on a flat face ------------------------------------
  // Dark panels 2 cm in front of a face from a to b (facing n), between y0 and y1: pointed
  // arches along the bottom (if `arcade`) and rows of tall windows with pointed heads above,
  // as on the terraced stone buildings around the plaza.
  const archPanel = (m, ax, az, ux, uz, nx, nz, s0, s1, yBase, spring, apex) => {
    const P = (s, y) => [ax + ux * s + nx * 0.02, y, az + uz * s + nz * 0.02];
    m.quad(P(s0, yBase), P(s1, yBase), P(s1, spring), P(s0, spring), [nx, 0, nz]);
    const w2 = (s1 - s0) / 2, R = (s1 - s0) * 0.8, c0 = R - w2, rise = Math.sqrt(R * R - c0 * c0);
    const K = 6;
    for (let k = 0; k < K; k++) {
      const sa = -w2 + (k / K) * (s1 - s0), sb = -w2 + ((k + 1) / K) * (s1 - s0);
      const ya = spring + Math.sqrt(Math.max(0, R * R - (Math.abs(sa) + c0) ** 2)) * ((apex - spring) / rise);
      const yb = spring + Math.sqrt(Math.max(0, R * R - (Math.abs(sb) + c0) ** 2)) * ((apex - spring) / rise);
      m.quad(P(s0 + w2 + sa, spring), P(s0 + w2 + sb, spring), P(s0 + w2 + sb, yb), P(s0 + w2 + sa, ya), [nx, 0, nz]);
    }
  };
  const openings = (m, ax, az, bx, bz, nx, nz, y0, y1, { arcade = true } = {}) => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 3 || y1 - y0 < 4) return;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    m.paint(COLOR.opening, 1, 1, STYLE.plain);
    let first = y0 + 1;
    if (arcade && y1 - y0 > 4.4) {
      const n = Math.max(1, Math.floor((L - 1) / 4.6));
      const pitch = L / n;
      for (let k = 0; k < n; k++) archPanel(m, ax, az, ux, uz, nx, nz, k * pitch + (pitch - 3) / 2, k * pitch + (pitch + 3) / 2, y0, y0 + 3, y0 + 4.4);
      return;
    }
    for (let y = first; y + 2.4 < y1 - 1; y += 3.4) {
      const n = Math.max(1, Math.floor(L / 3.6));
      const pitch = L / n;
      for (let k = 0; k < n; k++) {
        if (hash(k, Math.floor(y)) < 0.18) continue; // some blank bays
        const c = k * pitch + pitch / 2;
        archPanel(m, ax, az, ux, uz, nx, nz, c - 0.55, c + 0.55, y, y + 1.6, y + 2.2);
      }
    }
  };

  // --- Temple Mount platform ----------------------------------------------------------------
  // The esplanade is the lowest raised patch (the platform around the Dome of the Rock sits on it).
  const platform = (terrain.patches ?? []).filter((p) => p.mode === 'raise').sort((a, b) => a.y - b.y)[0];
  const plazaPatch = (terrain.patches ?? []).find((p) => p.mode === 'lower');
  if (platform) {
    const m = new Mesher();
    m.paint(COLOR.paving, 1, 1.2, STYLE.paving);
    m.polygon(platform.rings, platform.y + 0.03, 1);
    m.paint(COLOR.wallOld, 0.6, 1.3, STYLE.ashlar);
    const ring = platform.rings[0];
    const ccw = signedArea(ring) > 0;
    const pts = resample([...ring, ring[0], ring[1]], 4);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-3) continue;
      let nx = (b.z - a.z) / len, nz = -(b.x - a.x) / len; // outward for a counter-clockwise ring
      if (!ccw) { nx = -nx; nz = -nz; }
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const outside = Math.min(ground(mx + nx * 2, mz + nz * 2), ground(a.x + nx * 2, a.z + nz * 2), ground(b.x + nx * 2, b.z + nz * 2));
      if (outside > platform.y - 0.3) continue;
      // Face 0.6 m inside the edge (city walls on the same line hide it there).
      const ax = a.x - nx * 0.6, az = a.z - nz * 0.6, bx = b.x - nx * 0.6, bz = b.z - nz * 0.6;
      const y0 = outside - 1, y1 = platform.y + 0.6;
      m.wall(ax, az, bx, bz, y0, y0, y1, y1, [nx, 0, nz]);
      m.quad([ax, y1, az], [bx, y1, bz], [bx - nx * 1.5, y1, bz - nz * 1.5], [ax - nx * 1.5, y1, az - nz * 1.5], [0, 1, 0]);
      m.wall(bx - nx * 1.5, bz - nz * 1.5, ax - nx * 1.5, az - nz * 1.5, platform.y, platform.y, y1, y1, [-nx, 0, -nz]);
      quadBox([ax, az, bx, bz, bx - nx * 1.5, bz - nz * 1.5, ax - nx * 1.5, az - nz * 1.5], y0, y1, 'wall', 'temple-mount');
    }
    finish(m, 'TempleMountPlatform', LIGHT.sodium);
  }

  // --- Western Wall ---------------------------------------------------------------------------
  let wwBuffer = null;
  if (data.westernWall && plazaPatch) {
    const ring = project(data.westernWall.ring);
    const box = orientedBox(ring);
    const plazaC = ringCenter(plazaPatch.rings[0]);
    let nx = -box.az, nz = box.ax; // perpendicular to the wall
    if ((plazaC.x - box.cx) * nx + (plazaC.z - box.cz) * nz < 0) { nx = -nx; nz = -nz; }
    const base = plazaPatch.y - 1, top = plazaPatch.y + (data.westernWall.height ?? 20);
    const y0 = plazaPatch.y;
    const HER = 7, HER_H = 1.05, UMA_TOP = y0 + HER * HER_H + 6 * 0.85;
    const m = new Mesher();
    const ccw = signedArea(ring) > 0;
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      let ex = (bz - az) / len, ez = -(bx - ax) / len;
      if (!ccw) { ex = -ex; ez = -ez; }
      const front = ex * nx + ez * nz > 0.7;
      if (!front) {
        m.paint(COLOR.umayyad, 0.85, 1.3, STYLE.ashlar);
        m.wall(ax, az, bx, bz, base, base, top, top, [ex, 0, ez]);
        continue;
      }
      // The prayer face in three bands: Herodian (behind the stones built below), Umayyad, Ottoman.
      m.paint(COLOR.herodian, HER_H, 3.2, STYLE.herodian);
      m.wall(ax, az, bx, bz, base, base, y0 + HER * HER_H, y0 + HER * HER_H, [ex, 0, ez]);
      m.paint(COLOR.umayyad, 0.85, 1.25, STYLE.ashlar);
      m.wall(ax, az, bx, bz, y0 + HER * HER_H, y0 + HER * HER_H, UMA_TOP, UMA_TOP, [ex, 0, ez]);
      m.paint(COLOR.ottoman, 0.42, 0.6, STYLE.ashlar);
      m.wall(ax, az, bx, bz, UMA_TOP, UMA_TOP, top, top, [ex, 0, ez]);
    }
    m.paint(COLOR.ottoman, 0.42, 0.6, STYLE.ashlar);
    m.polygon([ring], top, 1);

    // Herodian courses as real stones: each course set back ~2.5 cm, 4 cm joints, drafted margins.
    const ux = box.ax, uz = box.az;
    // The face line: the ring's extreme along +n.
    let face = -Infinity;
    for (let i = 0; i < ring.length; i += 2) face = Math.max(face, (ring[i] - box.cx) * nx + (ring[i + 1] - box.cz) * nz);
    const len = box.hl * 2 - 0.4;
    m.paint(COLOR.herodian, HER_H, 3.2, STYLE.herodian);
    for (let c = 0; c < HER; c++) {
      const cy0 = y0 + c * HER_H + 0.02, cy1 = y0 + (c + 1) * HER_H - 0.02;
      const out = 0.2 - c * 0.025;
      let s = -len / 2 + hash(c, 1) * 1.2;
      while (s < len / 2 - 0.5) {
        const L = Math.min(len / 2 - s, 1.6 + hash(c, s) * 3.4);
        const mid = s + L / 2;
        const cx = box.cx + ux * mid + nx * (face + out / 2), cz = box.cz + uz * mid + nz * (face + out / 2);
        const shade = 0.93 + hash(s, c * 7) * 0.12;
        const base0 = new THREE.Color(COLOR.herodian).multiplyScalar(shade);
        m.color = [base0.r, base0.g, base0.b];
        m.orientedBox(cx, cz, ux, uz, L / 2 - 0.02, out / 2, cy0, cy1, { top: true, bottom: true });
        // The boss: the raised centre inside the drafted margin (~11 cm), standing 3 cm proud.
        const bx = box.cx + ux * mid + nx * (face + out + 0.015), bz = box.cz + uz * mid + nz * (face + out + 0.015);
        if (L > 0.6) m.orientedBox(bx, bz, ux, uz, L / 2 - 0.13, 0.015, cy0 + 0.11, cy1 - 0.11, { top: true, bottom: true });
        s += L;
      }
    }
    // Caper bushes growing from the joints higher up.
    for (let k = 0; k < 34; k++) {
      m.paint(CAPERS[k % CAPERS.length], 1, 1, STYLE.foliage);
      const along = (hash(k, 3) - 0.5) * len * 0.95, y = y0 + 6 + hash(k, 5) * (top - y0 - 8);
      const r = 0.25 + hash(k, 9) * 0.45;
      const cx = box.cx + ux * along + nx * (face + r * 0.4), cz = box.cz + uz * along + nz * (face + r * 0.4);
      const g = new THREE.IcosahedronGeometry(r, 0).scale(1.3, 0.8, 0.7).rotateY(Math.atan2(nx, nz)).translate(cx, y, cz); // already non-indexed
      const p = g.getAttribute('position');
      for (let t = 0; t < p.count; t += 3) {
        m.tri([p.getX(t), p.getY(t), p.getZ(t)], [p.getX(t + 1), p.getY(t + 1), p.getZ(t + 1)], [p.getX(t + 2), p.getY(t + 2), p.getZ(t + 2)], null);
      }
      g.dispose();
    }
    finish(m, 'WesternWall');
    addFootprint([ring], base, top, 'wall', 'western-wall');
    wwBuffer = { ring, box, nx, nz, face, len };

    // --- prayer plaza: partition, railing ---------------------------------------------------
    const p = new Mesher();
    const along = (pt) => (pt.x - box.cx) * ux + (pt.z - box.cz) * uz;
    const menT = data.prayer?.men ? along(at(data.prayer.men)) : -len * 0.15;
    const womenT = data.prayer?.women ? along(at(data.prayer.women)) : len * 0.3;
    const splitT = (menT + womenT) / 2;
    const faceX = (t, off) => box.cx + ux * t + nx * (face + off), faceZ = (t, off) => box.cz + uz * t + nz * (face + off);
    // Mechitza: a screen of panels from the wall out into the plaza.
    p.paint(COLOR.screen, 1, 1, STYLE.metal);
    for (let d = 0.5; d < 24; d += 2.1) {
      p.orientedBox(faceX(splitT, d + 1), faceZ(splitT, d + 1), nx, nz, 1.0, 0.05, y0, y0 + 1.9);
      p.paint(COLOR.iron, 1, 1, STYLE.metal);
      p.orientedBox(faceX(splitT, d), faceZ(splitT, d), nx, nz, 0.06, 0.06, y0, y0 + 2.0);
      p.paint(COLOR.screen, 1, 1, STYLE.metal);
      quadBox([faceX(splitT, d), faceZ(splitT, d), faceX(splitT, d + 2.1), faceZ(splitT, d + 2.1)], y0, y0 + 1.9, 'fence', 'mechitza');
    }
    // Low railing closing the prayer area off from the plaza, with an opening on each side.
    p.paint(COLOR.iron, 1, 1, STYLE.metal);
    const railOff = 27;
    for (let t = -len / 2 + 1; t < len / 2 - 1; t += 2.5) {
      if (Math.abs(t - (menT + splitT) / 2) < 2.5 || Math.abs(t - (womenT + splitT) / 2) < 2.5) continue; // entrances
      p.orientedBox(faceX(t + 1.25, railOff), faceZ(t + 1.25, railOff), ux, uz, 1.25, 0.04, y0 + 1.0, y0 + 1.08);
      p.orientedBox(faceX(t, railOff), faceZ(t, railOff), ux, uz, 0.05, 0.05, y0, y0 + 1.08);
      quadBox([faceX(t, railOff), faceZ(t, railOff), faceX(t + 2.5, railOff), faceZ(t + 2.5, railOff)], y0, y0 + 1.08, 'fence', 'prayer-railing');
    }
    finish(p, 'PrayerPlaza');
  }

  // --- terraces around the plaza ---------------------------------------------------------------
  // The plaza lies well below the Jewish Quarter and the streets around it. Wherever the ground
  // just outside is higher, a stone retaining wall rises from the plaza floor to it, with a
  // paved terrace on top that covers the terrain mesh's ramp (terrain.js moves that ramp
  // TERRACE meters outward, off the plaza) and a low parapet along the edge.
  if (plazaPatch) {
    const TERRACE = 17; // >= 2 x the near terrain spacing (8 m)
    const m = new Mesher();
    const terraceFaces = [];
    const ring = plazaPatch.rings[0];
    const ccw = signedArea(ring) > 0;
    const pts = resample([...ring, ring[0], ring[1]], 3);
    const y0 = plazaPatch.y;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-3) continue;
      let nx = (b.z - a.z) / L, nz = -(b.x - a.x) / L;
      if (!ccw) { nx = -nx; nz = -nz; }
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      if (wwBuffer && distanceToEdges([wwBuffer.ring], mx, mz) < 8) continue; // the Western Wall itself
      if (platform && pointInRings(platform.rings, mx + nx * 3, mz + nz * 3)) continue; // the platform edge
      // Ground beyond the plaza's 2 m edge tolerance (terrain.js).
      const gA = ground(a.x + nx * 2.5, a.z + nz * 2.5), gB = ground(b.x + nx * 2.5, b.z + nz * 2.5);
      if (Math.max(gA, gB) < y0 + 1.2) continue; // level enough: the ground just runs on
      const oA = [a.x + nx * TERRACE, a.z + nz * TERRACE], oB = [b.x + nx * TERRACE, b.z + nz * TERRACE];
      const tA = Math.max(gA, y0), tB = Math.max(gB, y0);
      m.paint(COLOR.wallOld, 0.5, 1.1, STYLE.ashlar);
      m.wall(a.x, a.z, b.x, b.z, y0 - 0.3, y0 - 0.3, tA, tB, [-nx, 0, -nz]); // retaining face
      terraceFaces.push([a.x, a.z, b.x, b.z, -nx, -nz, y0, Math.min(tA, tB)]);
      m.paint(COLOR.paving, 1, 1.2, STYLE.paving);
      m.quad([a.x, tA, a.z], [b.x, tB, b.z], [oB[0], Math.max(ground(oB[0], oB[1]), y0), oB[1]], [oA[0], Math.max(ground(oA[0], oA[1]), y0), oA[1]], [0, 1, 0]);
      // Parapet: 0.9 m stone rail along the drop.
      if (Math.max(tA, tB) > y0 + 2) {
        m.paint(COLOR.wall, 0.45, 0.9, STYLE.ashlar);
        const pA = [a.x + nx * 0.45, a.z + nz * 0.45], pB = [b.x + nx * 0.45, b.z + nz * 0.45];
        m.wall(a.x, a.z, b.x, b.z, tA, tB, tA + 0.9, tB + 0.9, [-nx, 0, -nz]);
        m.wall(pB[0], pB[1], pA[0], pA[1], tB, tA, tB + 0.9, tA + 0.9, [nx, 0, nz]);
        m.quad([a.x, tA + 0.9, a.z], [b.x, tB + 0.9, b.z], [pB[0], tB + 0.9, pB[1]], [pA[0], tA + 0.9, pA[1]], [0, 1, 0]);
      }
      // Collision: the retaining face and parapet only (the terrace top is the terrain itself).
      const strip = [a.x, a.z, b.x, b.z, b.x + nx * 0.6, b.z + nz * 0.6, a.x + nx * 0.6, a.z + nz * 0.6];
      addFootprint([strip], y0 - 0.3, Math.max(tA, tB) + (Math.max(tA, tB) > y0 + 2 ? 0.9 : 0), 'wall', 'plaza-terrace');
    }
    // Merge consecutive 3 m face pieces into facades (same direction), then add openings: an
    // arcade along the plaza at the foot and windows above, so the terraces read as the stepped
    // stone buildings of the Jewish Quarter rising from a lower retaining wall.
    let run = null;
    const flush = () => {
      if (run && run.len > 6) {
        openings(m, run.ax, run.az, run.bx, run.bz, run.nx, run.nz, run.y0, Math.min(run.y1, run.y0 + 5), { arcade: true });
        openings(m, run.ax, run.az, run.bx, run.bz, run.nx, run.nz, run.y0 + 5.5, run.y1, { arcade: false });
      }
      run = null;
    };
    for (const [ax, az, bx, bz, nx, nz, y0, y1] of terraceFaces) {
      if (run && Math.abs(run.bx - ax) < 0.01 && Math.abs(run.bz - az) < 0.01 && run.nx * nx + run.nz * nz > 0.98) {
        run.bx = bx; run.bz = bz; run.len += Math.hypot(bx - ax, bz - az); run.y1 = Math.min(run.y1, y1);
      } else {
        flush();
        run = { ax, az, bx, bz, nx, nz, y0, y1, len: Math.hypot(bx - ax, bz - az) };
      }
    }
    flush();
    finish(m, 'PlazaTerraces', LIGHT.sodium);
  }

  // --- Wilson's Arch prayer hall and the stretches mapped as building=wall ----------------------
  {
    const m = new Mesher();
    if (data.wilson && plazaPatch) {
      // Seen from the plaza: a stone front rising to the street level above (the hall lies under
      // Chain Street), with the great arch of the hall's entrance and windows above it.
      const ring = project(data.wilson.ring);
      let gMax = -Infinity;
      for (let i = 0; i < ring.length; i += 2) gMax = Math.max(gMax, ground(ring[i], ring[i + 1]));
      const y0 = plazaPatch.y - 0.5, top = Math.max(gMax + 0.8, plazaPatch.y + 9);
      m.paint(COLOR.wallOld, 0.55, 1.2, STYLE.ashlar);
      m.prism(ring, y0, top);
      const pc = ringCenter(plazaPatch.rings[0]);
      const ccw = signedArea(ring) > 0;
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 4) continue;
        let ex = (bz - az) / L, ez = -(bx - ax) / L;
        if (!ccw) { ex = -ex; ez = -ez; }
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if ((pc.x - mx) * ex + (pc.z - mz) * ez < 0) continue; // faces away from the plaza
        m.paint(COLOR.opening, 1, 1, STYLE.plain);
        const w = Math.min(7, L - 2);
        archPanel(m, ax, az, (bx - ax) / L, (bz - az) / L, ex, ez, L / 2 - w / 2, L / 2 + w / 2, plazaPatch.y, plazaPatch.y + 4.5, plazaPatch.y + 7.8);
        openings(m, ax, az, bx, bz, ex, ez, plazaPatch.y + 9, top, { arcade: false });
      }
      addFootprint([ring], y0, top, 'building', 'wilsons-arch');
    }
    for (const w of data.plainWalls ?? []) {
      const ring = project(w.ring);
      let gMin = Infinity, gMax = -Infinity;
      for (let i = 0; i < ring.length; i += 2) { const h = ground(ring[i], ring[i + 1]); gMin = Math.min(gMin, h); gMax = Math.max(gMax, h); }
      const top = Math.max(gMin + (w.height ?? 12), gMax + 0.6);
      m.paint(COLOR.wallOld, ASHLAR.course, ASHLAR.length, STYLE.ashlar);
      m.prism(ring, gMin - 1, top);
      addFootprint([ring], gMin - 1, top, 'wall', w.id);
    }
    finish(m, 'StoneMasses');
  }

  // --- Mughrabi bridge: covered wooden ramp from the plaza up to the Mughrabi Gate -------------
  if (data.mughrabi && platform && plazaPatch) {
    const gate = ringCenter(project(data.mughrabi.ring));
    const tm = ringCenter(platform.rings[0]);
    let dx = gate.x - tm.x, dz = gate.z - tm.z;
    const dl = Math.hypot(dx, dz);
    dx /= dl; dz /= dl;
    const rise = platform.y - plazaPatch.y;
    const L = rise / Math.tan((12 * Math.PI) / 180);
    const W = 3.4;
    const m = new Mesher();
    const steps = Math.ceil(L / 3);
    for (let k = 0; k < steps; k++) {
      const t0 = (k / steps) * L, t1 = ((k + 1) / steps) * L;
      const x0 = gate.x + dx * t0, z0 = gate.z + dz * t0, x1 = gate.x + dx * t1, z1 = gate.z + dz * t1;
      const yA = platform.y + 0.1 - (t0 / L) * rise, yB = platform.y + 0.1 - (t1 / L) * rise;
      const px = -dz, pz = dx;
      const c = (x, z, s) => [x + px * s, z + pz * s];
      const [l0x, l0z] = c(x0, z0, -W / 2), [r0x, r0z] = c(x0, z0, W / 2), [l1x, l1z] = c(x1, z1, -W / 2), [r1x, r1z] = c(x1, z1, W / 2);
      m.paint(COLOR.wood, 1, 1, STYLE.wood);
      m.quad([l0x, yA, l0z], [r0x, yA, r0z], [r1x, yB, r1z], [l1x, yB, l1z], [0, 1, 0]); // deck
      m.quad([l0x, yA - 0.4, l0z], [r0x, yA - 0.4, r0z], [r1x, yB - 0.4, r1z], [l1x, yB - 0.4, l1z], [0, -1, 0]);
      m.wall(l0x, l0z, l1x, l1z, yA - 0.4, yB - 0.4, yA + 1.2, yB + 1.2, [-px, 0, -pz]); // side boards
      m.wall(r0x, r0z, r1x, r1z, yA - 0.4, yB - 0.4, yA + 1.2, yB + 1.2, [px, 0, pz]);
      // Roof and posts.
      m.paint(COLOR.iron, 1, 1, STYLE.metal);
      m.quad([l0x, yA + 2.7, l0z], [r0x, yA + 2.7, r0z], [r1x, yB + 2.7, r1z], [l1x, yB + 2.7, l1z], [0, 1, 0]);
      m.quad([l0x, yA + 2.62, l0z], [r0x, yA + 2.62, r0z], [r1x, yB + 2.62, r1z], [l1x, yB + 2.62, l1z], [0, -1, 0]);
      for (const s of [-W / 2, W / 2]) m.orientedBox(x0 + px * s, z0 + pz * s, dx, dz, 0.07, 0.07, yA, yA + 2.62);
      // Steel legs down to the ground.
      if (k % 2 === 0) {
        for (const s of [-W / 2 + 0.3, W / 2 - 0.3]) {
          const gx = x0 + px * s, gz = z0 + pz * s;
          const g = ground(gx, gz);
          if (yA - 0.4 > g + 0.2) m.orientedBox(gx, gz, dx, dz, 0.12, 0.12, g, yA - 0.4, { top: false });
        }
      }
      quadBox([l0x, l0z, r0x, r0z, r1x, r1z, l1x, l1z], Math.min(yA, yB) - 0.4, Math.max(yA, yB), 'bridge', 'mughrabi-bridge');
    }
    finish(m, 'MughrabiBridge');
  }

  // --- city walls, towers, gates ---------------------------------------------------------------
  const walls = data.walls.map((w) => ({ id: w.id, pts: project(w.points) }));
  const allPts = walls.flatMap((w) => w.pts);
  const center = ringCenter(allPts);
  const gates = data.gates.map((g) => ({ ...g, cfg: GATE[g.kind] ?? GATE.simple, ...at(g) }));
  const crossings = (data.crossings ?? []).filter((c) => (c.angle ?? 90) >= 35).map((c) => ({ ...c, ...at(c) }));

  const closestOnPolyline = (pts, x, z) => {
    let best = { dist: Infinity };
    let d = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
      const L = Math.hypot(bx - ax, bz - az);
      if (L > 1e-6) {
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (L * L)));
        const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
        const dist = Math.hypot(x - px, z - pz);
        if (dist < best.dist) best = { dist, d: d + t * L, x: px, z: pz, ux: (bx - ax) / L, uz: (bz - az) / L };
      }
      d += L;
    }
    return best;
  };

  const wallMesh = new Mesher();
  const towerAt = [];
  for (const w of walls) {
    const pts = resample(w.pts, 3);
    if (pts.length < 2) continue;
    // Cuts: gates (replaced by gatehouses), street crossings, and the Western Wall's footprint.
    const cuts = [];
    for (const g of gates) {
      const c = closestOnPolyline(w.pts, g.x, g.z);
      if (c.dist < 16) cuts.push([c.d - g.cfg.half, c.d + g.cfg.half]);
    }
    for (const c of crossings) {
      if (c.wall !== w.id) continue;
      const q = closestOnPolyline(w.pts, c.x, c.z);
      if (gates.some((g) => Math.hypot(g.x - c.x, g.z - c.z) < g.cfg.half + 2)) continue; // passes through a gatehouse
      cuts.push([q.d - c.width / 2 - 0.5, q.d + c.width / 2 + 0.5]);
    }
    if (wwBuffer) {
      let inside = null;
      for (const p of pts) {
        const inWW = pointInRings([wwBuffer.ring], p.x, p.z) || distanceToEdges([wwBuffer.ring], p.x, p.z) < 4;
        if (inWW && inside === null) inside = p.d;
        if (!inWW && inside !== null) { cuts.push([inside - 1, p.d]); inside = null; }
      }
      if (inside !== null) cuts.push([inside - 1, pts[pts.length - 1].d + 1]);
    }
    const cut = (d) => cuts.some(([a, b]) => d > a && d < b);

    // Heights per sample: bottom below the lower side, top 12 m over the outside ground (at
    // least 3.5 m over the inside), smoothed along the wall.
    const info = pts.map((p, i) => {
      const q = pts[Math.min(i + 1, pts.length - 1)], r = pts[Math.max(i - 1, 0)];
      let ux = q.x - r.x, uz = q.z - r.z;
      const l = Math.hypot(ux, uz) || 1;
      ux /= l; uz /= l;
      let nx = uz, nz = -ux;
      if ((p.x - center.x) * nx + (p.z - center.z) * nz < 0) { nx = -nx; nz = -nz; }
      const off = WALL.thick / 2 + 1.5;
      const gOut = ground(p.x + nx * off, p.z + nz * off), gIn = ground(p.x - nx * off, p.z - nz * off), gMid = ground(p.x, p.z);
      return { ux, uz, nx, nz, bottom: Math.min(gOut, gIn, gMid) - 1, top: Math.max(gOut + WALL.height, gIn + 3.5, gMid + 3.5) };
    });
    const smooth = info.map((_, i) => {
      let s = 0, n = 0;
      for (let k = Math.max(0, i - 5); k <= Math.min(info.length - 1, i + 5); k++) { s += info[k].top; n++; }
      return Math.max(s / n, info[i].bottom + 4);
    });

    const m = wallMesh;
    const T = WALL.thick / 2;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (cut((a.d + b.d) / 2)) continue;
      const A = info[i - 1], B = info[i];
      // Use the segment's own direction for both ends (keeps faces planar).
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-3) continue;
      const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
      let nx = uz, nz = -ux;
      if ((A.nx + B.nx) * nx + (A.nz + B.nz) * nz < 0) { nx = -nx; nz = -nz; }
      const yb0 = A.bottom, yb1 = B.bottom, yt0 = smooth[i - 1], yt1 = smooth[i];
      const o = (p, s) => [p.x + nx * s, p.z + nz * s];
      const [oa, ob, ia, ib] = [o(a, T), o(b, T), o(a, -T), o(b, -T)];
      const [pa, pb] = [o(a, T - WALL.parapetThick), o(b, T - WALL.parapetThick)];
      m.paint(COLOR.wall, ASHLAR.course, ASHLAR.length, STYLE.ashlar);
      m.wall(oa[0], oa[1], ob[0], ob[1], yb0, yb1, yt0 + WALL.parapet, yt1 + WALL.parapet, [nx, 0, nz]); // outer face
      m.wall(ia[0], ia[1], ib[0], ib[1], yb0, yb1, yt0, yt1, [-nx, 0, -nz]); // inner face
      m.quad([ia[0], yt0, ia[1]], [ib[0], yt1, ib[1]], [pb[0], yt1, pb[1]], [pa[0], yt0, pa[1]], [0, 1, 0]); // walkway
      m.wall(pa[0], pa[1], pb[0], pb[1], yt0, yt1, yt0 + WALL.parapet, yt1 + WALL.parapet, [-nx, 0, -nz]); // parapet back
      m.quad([pa[0], yt0 + WALL.parapet, pa[1]], [pb[0], yt1 + WALL.parapet, pb[1]], [ob[0], yt1 + WALL.parapet, ob[1]], [oa[0], yt0 + WALL.parapet, oa[1]], [0, 1, 0]);
      // End caps where the wall stops (openings, gates, ends).
      const capA = i === 1 || cut(a.d - 0.5), capB = i === pts.length - 1 || cut(b.d + 0.5);
      if (capA) m.quad([oa[0], yb0, oa[1]], [ia[0], yb0, ia[1]], [ia[0], yt0, ia[1]], [oa[0], yt0 + WALL.parapet, oa[1]], [-ux, 0, -uz]);
      if (capB) m.quad([ob[0], yb1, ob[1]], [ib[0], yb1, ib[1]], [ib[0], yt1, ib[1]], [ob[0], yt1 + WALL.parapet, ob[1]], [ux, 0, uz]);
      // Merlons on the parapet at a fixed pitch along the wall.
      const first = Math.ceil(a.d / WALL.merlonGap) * WALL.merlonGap;
      for (let d = first; d < b.d; d += WALL.merlonGap) {
        const t = (d - a.d) / (b.d - a.d);
        const mx = a.x + (b.x - a.x) * t + nx * (T - WALL.parapetThick / 2), mz = a.z + (b.z - a.z) * t + nz * (T - WALL.parapetThick / 2);
        merlon(m, mx, mz, ux, uz, yt0 + (yt1 - yt0) * t + WALL.parapet);
      }
      quadBox([oa[0], oa[1], ob[0], ob[1], ib[0], ib[1], ia[0], ia[1]], Math.min(yb0, yb1), Math.max(yt0, yt1), 'wall', w.id);
      quadBox([oa[0], oa[1], ob[0], ob[1], pb[0], pb[1], pa[0], pa[1]], Math.max(yt0, yt1), Math.max(yt0, yt1) + WALL.parapet, 'wall', w.id);
    }

    // Towers: at bends of the mapped line and every ~85 m, away from openings.
    const want = [];
    for (let i = 2; i + 2 < w.pts.length; i += 2) {
      const ax = w.pts[i] - w.pts[i - 2], az = w.pts[i + 1] - w.pts[i - 1], bx = w.pts[i + 2] - w.pts[i], bz = w.pts[i + 3] - w.pts[i + 1];
      const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
      if (turn > (25 * Math.PI) / 180) want.push(closestOnPolyline(w.pts, w.pts[i], w.pts[i + 1]).d);
    }
    const total = pts[pts.length - 1].d;
    for (let d = WALL.towerEvery / 2; d < total; d += WALL.towerEvery) if (!want.some((x) => Math.abs(x - d) < 30)) want.push(d);
    for (const d of want) {
      if (cuts.some(([a, b]) => d > a - 8 && d < b + 8)) continue;
      const i = Math.max(1, pts.findIndex((p) => p.d >= d));
      towerAt.push({ p: pts[i], info: info[i], top: smooth[i] });
    }
  }
  for (const { p, info, top } of towerAt) {
    const { ux, uz, nx, nz } = info;
    const out = WALL.thick / 2 + WALL.towerOut, inn = WALL.thick / 2 + 0.3;
    const cx = p.x + nx * (out - inn) / 2, cz = p.z + nz * (out - inn) / 2;
    const half = WALL.towerLen / 2, depth = (out + inn) / 2;
    const bottom = Math.min(ground(p.x + nx * out, p.z + nz * out), info.bottom + 1) - 1;
    const ttop = top + WALL.towerExtra;
    const m = wallMesh;
    m.paint(COLOR.wallOld, ASHLAR.course, ASHLAR.length, STYLE.ashlar);
    m.orientedBox(cx, cz, ux, uz, half, depth, bottom, ttop);
    // Parapet ring and merlons on the three outer sides.
    for (let s = -half + 0.6; s <= half - 0.6; s += WALL.merlonGap) merlon(m, cx + ux * s + nx * (depth - 0.35), cz + uz * s + nz * (depth - 0.35), ux, uz, ttop, true);
    for (const side of [-1, 1]) {
      for (let s = -depth + 1.2; s <= depth - 0.6; s += WALL.merlonGap) merlon(m, cx + ux * side * (half - 0.35) + nx * s, cz + uz * side * (half - 0.35) + nz * s, nx, nz, ttop, true);
    }
    const corners = [];
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) corners.push(cx + ux * a * half + nx * b * depth, cz + uz * a * half + nz * b * depth);
    quadBox(corners, bottom, ttop, 'wall', 'tower');
  }

  // Gatehouses.
  for (const g of gates) {
    let best = null;
    for (const w of walls) {
      const c = closestOnPolyline(w.pts, g.x, g.z);
      if (!best || c.dist < best.dist) best = c;
    }
    if (!best || best.dist > 20) continue;
    const { ux, uz } = best;
    let nx = uz, nz = -ux;
    if ((best.x - center.x) * nx + (best.z - center.z) * nz < 0) { nx = -nx; nz = -nz; }
    const cfg = g.cfg;
    const cx = best.x, cz = best.z;
    const out = WALL.thick / 2 + (g.kind === 'grand' ? 4 : 3), inn = WALL.thick / 2 + 1;
    const gOut = ground(cx + nx * (out + 2), cz + nz * (out + 2)), gIn = ground(cx - nx * (inn + 2), cz - nz * (inn + 2));
    const bottom = Math.min(gOut, gIn, ground(cx, cz)) - 1;
    const floor = Math.min(gOut, gIn); // passage floor: the lower side
    const top = Math.max(gOut + WALL.height, gIn + 3.5) + cfg.extra;
    // Passage: centred on the street where one goes through.
    const street = crossings.filter((c) => Math.hypot(c.x - cx, c.z - cz) < cfg.half + 2).sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))[0];
    let pc = street ? (street.x - cx) * ux + (street.z - cz) * uz : 0;
    pc = Math.max(-cfg.half + cfg.width / 2 + 1.5, Math.min(cfg.half - cfg.width / 2 - 1.5, pc));
    const m = new Mesher();
    m.paint(COLOR.wall, 0.5, 1.0, STYLE.ashlar);
    const depthC = (out - inn) / 2, depthH = (out + inn) / 2; // box centre offset along n, half depth
    const block = (s0, s1, y0, y1) => {
      if (s1 - s0 < 0.05 || y1 - y0 < 0.05) return;
      const mid = (s0 + s1) / 2;
      const bx = cx + ux * mid + nx * depthC, bz = cz + uz * mid + nz * depthC;
      m.orientedBox(bx, bz, ux, uz, (s1 - s0) / 2, depthH, y0, y1);
      const ring = [];
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) ring.push(bx + ux * a * (s1 - s0) / 2 + nx * b * depthH, bz + uz * a * (s1 - s0) / 2 + nz * b * depthH);
      addFootprint([ring], y0, y1, 'wall', g.name);
    };
    if (cfg.width > 0) {
      const w2 = cfg.width / 2, spring = floor + 3.6, R = cfg.width * 0.8, c0 = R - w2, rise = Math.sqrt(R * R - c0 * c0);
      const archTop = spring + rise + 0.9;
      block(-cfg.half, pc - w2, bottom, top);
      block(pc + w2, cfg.half, bottom, top);
      block(pc - w2, pc + w2, archTop, top);
      // The pointed arch, in thin slices across the passage.
      const N = 24;
      for (let k = 0; k < N; k++) {
        const s0 = -w2 + (k / N) * cfg.width, s1 = -w2 + ((k + 1) / N) * cfg.width, sm = (s0 + s1) / 2;
        const yA = spring + Math.sqrt(Math.max(0, R * R - (Math.abs(sm) + c0) ** 2));
        block(pc + s0, pc + s1, yA, archTop);
      }
      // A darker recessed frame around the arch on the outer face (the gate's decorated front).
      m.paint(COLOR.wallOld, 0.35, 0.7, STYLE.ashlar);
      m.orientedBox(cx + ux * pc + nx * (out + 0.05), cz + uz * pc + nz * (out + 0.05), ux, uz, w2 + 1.2, 0.08, archTop - 0.2, archTop + 1.4);
      // Box machicolation over the entrance.
      m.orientedBox(cx + ux * pc + nx * (out + 0.5), cz + uz * pc + nz * (out + 0.5), ux, uz, 1.3, 0.5, top - 3.2, top - 1.4);
    } else {
      // Sealed Golden Gate: solid, two blind arches drawn as frames, two domes on the roof.
      block(-cfg.half, cfg.half, bottom, top);
      m.paint(COLOR.wallOld, 0.35, 0.7, STYLE.ashlar);
      for (const s of [-cfg.half / 2, cfg.half / 2]) m.orientedBox(cx + ux * s + nx * (out + 0.1), cz + uz * s + nz * (out + 0.1), ux, uz, 2.4, 0.12, floor + 1, floor + 7.5);
      m.paint(COLOR.lead, 1, 1, STYLE.lead);
      for (const s of [-cfg.half / 2, cfg.half / 2]) m.dome(cx + ux * s + nx * depthC, cz + uz * s + nz * depthC, 3.2, top, 2.6);
    }
    // Crenellations around the top.
    m.paint(COLOR.wall, 0.5, 1.0, STYLE.ashlar);
    const big = g.kind === 'grand';
    for (let s = -cfg.half + 0.6; s <= cfg.half - 0.6; s += WALL.merlonGap * (big ? 0.8 : 1)) merlon(m, cx + ux * s + nx * (out - 0.35), cz + uz * s + nz * (out - 0.35), ux, uz, top, big);
    if (g.kind === 'grand') {
      // Damascus Gate: two flanking towers standing forward of the gate.
      for (const side of [-1, 1]) {
        const s = side * (cfg.half - 2.6);
        const tx = cx + ux * s + nx * (out + 0.8), tz = cz + uz * s + nz * (out + 0.8);
        m.paint(COLOR.wallOld, 0.5, 1.0, STYLE.ashlar);
        m.orientedBox(tx, tz, ux, uz, 2.6, 2.2, bottom, top + 2.5);
        for (let k = -1; k <= 1; k++) merlon(m, tx + ux * k * 1.6 + nx * 1.85, tz + uz * k * 1.6 + nz * 1.85, ux, uz, top + 2.5, true);
        addBox({ minX: tx - 3.4, maxX: tx + 3.4, minZ: tz - 3.4, maxZ: tz + 3.4, minY: bottom, maxY: top + 2.5 }, 'wall', g.name);
      }
    }
    finish(m, g.name, LIGHT.sodium);
  }
  finish(wallMesh, 'CityWalls', LIGHT.sodium);

  // --- Tower of David ------------------------------------------------------------------------------
  if (data.citadel) {
    const outer = project(data.citadel.outer[0]);
    const inner = data.citadel.inner[0] ? project(data.citadel.inner[0]) : null;
    let gMin = Infinity, gMax = -Infinity;
    for (let i = 0; i < outer.length; i += 2) { const h = ground(outer[i], outer[i + 1]); gMin = Math.min(gMin, h); gMax = Math.max(gMax, h); }
    const base = gMin - 1, top = gMax + 13;
    const m = new Mesher();
    m.paint(COLOR.wallOld, 0.6, 1.2, STYLE.ashlar);
    m.prism(outer, base, top, { top: false });
    if (inner) {
      // Courtyard walls face inward (reverse the ring so its "outward" points into the yard).
      const rev = [];
      for (let i = inner.length - 2; i >= 0; i -= 2) rev.push(inner[i], inner[i + 1]);
      m.prism(rev, base, top, { top: false });
    }
    m.paint(COLOR.paving, 1, 1.2, STYLE.paving);
    m.polygon(inner ? [outer, inner] : [outer], top, 1);
    m.paint(COLOR.wallOld, 0.6, 1.2, STYLE.ashlar);
    // Merlons along the outer edge.
    const pts = resample([...outer, outer[0], outer[1]], 2);
    const ccw = signedArea(outer) > 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 0.5) continue;
      const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
      let nx = uz, nz = -ux;
      if (!ccw) { nx = -nx; nz = -nz; }
      const first = Math.ceil(a.d / WALL.merlonGap) * WALL.merlonGap;
      for (let d = first; d < b.d; d += WALL.merlonGap) {
        const t = (d - a.d) / L;
        merlon(m, a.x + (b.x - a.x) * t - nx * 0.35, a.z + (b.z - a.z) * t - nz * 0.35, ux, uz, top);
      }
    }
    addFootprint(inner ? [outer, inner] : [outer], base, top, 'building', 'citadel');
    // Towers at the corners; the Phasael tower (north-east) is the massive one.
    let ne = 0;
    for (let i = 0; i < outer.length; i += 2) if (outer[i] - outer[i + 1] > outer[ne] - outer[ne + 1]) ne = i;
    const n = outer.length / 2;
    for (let i = 0; i < n; i++) {
      const p = [outer[i * 2], outer[i * 2 + 1]], a = [outer[((i - 1 + n) % n) * 2], outer[((i - 1 + n) % n) * 2 + 1]], b = [outer[((i + 1) % n) * 2], outer[((i + 1) % n) * 2 + 1]];
      const ax = p[0] - a[0], az = p[1] - a[1], bx = b[0] - p[0], bz = b[1] - p[1];
      const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
      const phasael = i * 2 === ne;
      if (!phasael && turn < (40 * Math.PI) / 180) continue;
      const size = phasael ? 7 : 3.6, extra = phasael ? 12 : 4;
      const l = Math.hypot(ax, az) || 1;
      m.paint(phasael ? COLOR.herodian : COLOR.wallOld, phasael ? 0.9 : 0.6, phasael ? 1.8 : 1.2, phasael ? STYLE.herodian : STYLE.ashlar);
      m.orientedBox(p[0], p[1], ax / l, az / l, size, size, base, top + extra);
      m.paint(COLOR.wallOld, 0.6, 1.2, STYLE.ashlar);
      for (let s = -size + 0.6; s <= size - 0.6; s += WALL.merlonGap) {
        for (const side of [-1, 1]) {
          merlon(m, p[0] + (ax / l) * s + (-az / l) * side * (size - 0.35), p[1] + (az / l) * s + (ax / l) * side * (size - 0.35), ax / l, az / l, top + extra, phasael);
          merlon(m, p[0] + (ax / l) * side * (size - 0.35) + (-az / l) * s, p[1] + (az / l) * side * (size - 0.35) + (ax / l) * s, -az / l, ax / l, top + extra, phasael);
        }
      }
      addBox({ minX: p[0] - size * 1.42, maxX: p[0] + size * 1.42, minZ: p[1] - size * 1.42, maxZ: p[1] + size * 1.42, minY: base, maxY: top + extra }, 'building', 'citadel-tower');
    }
    // The Ottoman minaret: square base, octagonal shaft, balcony, slimmer upper shaft, cap.
    if (data.citadel.minaret) {
      const q = at(data.citadel.minaret);
      const g0 = ground(q.x, q.z) - 1;
      m.paint(COLOR.wall, 0.45, 0.8, STYLE.ashlar);
      m.orientedBox(q.x, q.z, 1, 0, 2.3, 2.3, g0, top + 2);
      m.cylinder(q.x, q.z, 1.7, 1.55, top + 2, top + 15, 8);
      m.cylinder(q.x, q.z, 2.5, 2.5, top + 15, top + 15.5, 8); // balcony
      m.paint(COLOR.iron, 1, 1, STYLE.metal);
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2;
        m.orientedBox(q.x + Math.cos(ang) * 2.4, q.z + Math.sin(ang) * 2.4, -Math.sin(ang), Math.cos(ang), 0.04, 0.04, top + 15.5, top + 16.5);
      }
      m.paint(COLOR.wall, 0.45, 0.8, STYLE.ashlar);
      m.cylinder(q.x, q.z, 1.25, 1.2, top + 15.5, top + 19.5, 8);
      m.paint(COLOR.lead, 1, 1, STYLE.lead);
      m.cylinder(q.x, q.z, 1.45, 0.02, top + 19.5, top + 23.5, 8, { top: false });
      addBox({ minX: q.x - 2.4, maxX: q.x + 2.4, minZ: q.z - 2.4, maxZ: q.z + 2.4, minY: g0, maxY: top + 23.5 }, 'building', 'citadel-minaret');
    }
    finish(m, 'TowerOfDavid', LIGHT.sodium);
  }

  // --- Church of the Holy Sepulchre ----------------------------------------------------------------
  if (data.sepulchre) {
    const ring = project(data.sepulchre.ring);
    let gMin = Infinity;
    for (let i = 0; i < ring.length; i += 2) gMin = Math.min(gMin, ground(ring[i], ring[i + 1]));
    const base = gMin - 0.5;
    const m = new Mesher();
    m.paint(COLOR.wallOld, 0.5, 1.0, STYLE.ashlar);
    m.prism(ring, base - 0.5, base + 9);
    addFootprint([ring], base - 0.5, base + 9, 'building', 'holy-sepulchre');
    for (const part of data.sepulchre.parts) {
      const r = project(part.ring);
      const c = ringCenter(r), rad = ringRadius(r, c);
      const h = part.height ?? 14;
      const shape = part.roofShape;
      const roofH = shape === 'dome' ? (part.roofHeight ?? rad * 0.85) : shape === 'pyramidal' ? (part.roofHeight ?? 4) : 0;
      const wallTop = base + h - roofH, y0 = base + (part.minHeight ?? 0);
      if (wallTop > y0 + 0.05) {
        m.paint(part.tower ? COLOR.wall : COLOR.wallOld, 0.5, 1.0, STYLE.ashlar);
        m.prism(r, y0, wallTop, { top: shape === 'flat' || shape === 'dome' });
        addFootprint([r], y0, wallTop, 'building', 'holy-sepulchre');
      }
      if (shape === 'dome') {
        m.paint(COLOR.lead, 1, 1, STYLE.lead);
        m.dome(c.x, c.z, rad, wallTop, roofH, { seg: 24, rings: 7 });
        // A small lantern with a cross-less cap on the big domes.
        if (rad > 6) {
          m.paint(COLOR.wall, 0.4, 0.6, STYLE.ashlar);
          m.cylinder(c.x, c.z, 1.2, 1.2, wallTop + roofH - 0.3, wallTop + roofH + 1.6, 12);
          m.paint(COLOR.lead, 1, 1, STYLE.lead);
          m.dome(c.x, c.z, 1.3, wallTop + roofH + 1.6, 1.0, { seg: 12, rings: 3 });
        }
      } else if (shape === 'pyramidal') {
        m.paint(COLOR.lead, 1, 1, STYLE.lead);
        m.pyramid(r, wallTop, roofH);
      }
    }
    finish(m, 'HolySepulchre');
  }

  // --- Temple Mount / Haram al-Sharif buildings ---------------------------------------------------
  if (data.haram) {
    stats.haram = buildHaram(data.haram, { project, at, ground, patches: terrain.patches, addBox, addFootprint, quadBox, finish });
  }

  // --- the Knesset and the Chords Bridge -------------------------------------------------------------
  if (data.modern) stats.modern = buildModern(data, { project, at, ground, addBox, addFootprint, quadBox, finish, group, uniforms, show, materials });

  // --- the Mount of Olives and Mount Scopus -----------------------------------------------------------
  const addObject = (obj) => {
    obj.castShadow = obj.castShadow ?? true;
    group.add(obj);
    stats.meshes++;
    const tris = (obj.geometry.index ? obj.geometry.index.count : obj.geometry.getAttribute('position').count) / 3;
    stats.triangles += tris * (obj.isInstancedMesh ? obj.count : 1);
  };
  if (data.olives || data.scopus) stats.hills = buildHills(data, { project, at, ground, addBox, addFootprint, quadBox, finish, addObject, material });

  return {
    group,
    material,
    /** Every material the layer made (the stone, the Chords Bridge LEDs): for shadow setup. */
    materials,
    stats,
    /** Per frame: drives the Chords Bridge light show and the festival projections. */
    update(time) {
      show.uLmTime.value = time;
    },
    /** Festival lighting (L key): the walls become a projection screen. */
    setFestival(on) {
      show.uFestival.value = on ? 1 : 0;
    },
    get festival() {
      return show.uFestival.value > 0.5;
    },
    dispose() {
      collision?.removeGroup?.(COLLISION_GROUP);
      group.traverse((o) => o.geometry?.dispose());
      for (const m of materials) m.dispose();
      group.removeFromParent();
    },
  };
}
