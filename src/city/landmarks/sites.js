// Markets and remaining landmarks, from public/data/sites.json (scripts/fetch_sites.js):
//
//   market     Mahane Yehuda. The covered block between the two market streets is cut into
//              low shop blocks by the fruit-named alleys; every face is a row of open shops
//              (dark interiors with shelves of goods, roll-up shutter boxes, signs). Etz Haim
//              Street runs under a vaulted roof of translucent sheets on steel ribs with pendant
//              lamps; the alleys under corrugated roofs. Stalls stand in front of every shop, on
//              both sides of both streets and the alleys: crates of produce tilted toward the
//              aisle, burlap sacks of nuts and spices, spice cones in steel bowls, bread, halva,
//              butchers' counters, price cards, hanging goods; awnings over the open street;
//              tables and umbrellas in the Iraqi market and the Georgian courtyard
//   souks      the Old City market streets: stone pointed vaults over the covered ones (David
//              Street, the Crusader markets, al-Qattanin, Khan al-Zeit, the covered Cardo), and
//              stalls along all of them selling what that street sells
//   cardo      the open Cardo: Byzantine columns on a stylobate
//   infill     the Old City's unmapped gaps: 2-3 storey stone houses, small arched windows,
//              flat roofs with parapets and, on some, the small plastered domes of the roofscape
//   hurva      the Hurva Synagogue: tall stone cube with arched windows, corner turrets, drum
//              and the great white dome
//   ymca       the YMCA: the long front with its arcade, two domes and the 46 m bell tower
//   kingDavid  the King David Hotel: pink limestone, rows of tall windows, arched ground floor,
//              a crowning cornice
//   mamilla    the Mamilla promenade: planters with olive trees, café umbrellas
//   esplanade  (from landmarks.json, esplanade.js) the Temple Mount's earth and trees, the riwaq
//              porticoes, the Dome of the Rock's inscription band
//
// One stone mesh per area (market, Old City, west) with the landmark material, a translucent
// roof mesh, and per-area instanced stall parts (a few draw calls, culled with the area).
// Night: the stone is floodlit warm white like the Old City (the shared lighting show); the
// esplanade's earth stays dark.

import * as THREE from 'three';
import { Mesher, STYLE, LIGHT } from './geometry.js';
import { createLandmarkMaterial } from './materials.js';
import { createKit } from './kit.js';
import { archOutline, beam } from './hinnom.js';
import { createStallKit, createGoodsMaterial, SIGNS } from './stalls.js';
import { buildEsplanade } from './esplanade.js';
import { decomposeFootprint, orientedBox, pointInRings } from '../footprint.js';

const COLLISION_GROUP = 'sites';

const C = {
  stone: 0xd6ccb8,
  stoneOld: 0xc9bea8,
  stoneWarm: 0xd8c9ae,
  pink: 0xdcc4a8, // the King David Hotel's rosy limestone
  honey: 0xd9c090, // the YMCA
  plaster: 0xe2dccd, // whitewashed domes
  dome: 0xe8e6e0,
  shopDark: 0x3a2e24,
  metal: 0x7d8286,
  metalDark: 0x4a4f53,
  sheet: 0xe9ecec, // translucent roof sheets
  opening: 0x24211d,
  lamp: 0xf2e6c0,
};

const hash = (a, b = 0) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** What a market stall sells (Mahane Yehuda weights). */
function marketKind(h) {
  if (h < 0.4) return 'produce';
  if (h < 0.52) return 'nuts';
  if (h < 0.62) return 'spice';
  if (h < 0.72) return 'bakery';
  if (h < 0.77) return 'halva';
  if (h < 0.85) return 'butcher';
  if (h < 0.95) return 'food';
  return 'fabric';
}
/** Old City souk goods: mostly the street's own, some variety. */
function soukKind(goods, h) {
  if (goods === 'gallery') return h < 0.7 ? 'gallery' : 'souvenir';
  if (h < 0.7) return goods === 'butcher' ? 'butcher' : goods === 'food' ? (h < 0.35 ? 'food' : 'spice') : goods;
  return ['souvenir', 'spice', 'fabric', 'food', 'bakery', 'nuts'][Math.floor(((h - 0.7) / 0.3) * 6) % 6];
}

/**
 * @param {object} data  parsed sites.json
 * @param {object} ctx   { projection, terrain, collision, uniforms, landmarks?, show?, props?: { material, olive, cypress, awningGeometry, awningStriped, awningSolid } }
 */
export function buildSites(data, { projection, terrain, collision, uniforms, props = null, landmarks = null, show = undefined }) {
  const material = createLandmarkMaterial(uniforms, show);
  const goodsMaterial = createGoodsMaterial(uniforms);
  const group = new THREE.Group();
  group.name = 'Sites';
  const ground = (x, z) => terrain.heightAt(x, z);
  const project = (flat) => projection.projectFlat(flat);
  const at = (lat, lon) => projection.project(lat, lon);
  const stats = { meshes: 0, triangles: 0, boxes: 0, stalls: 0, goods: 0, infill: 0, vaultSections: 0 };
  const disposables = [];

  const addBox = (b, kind = 'building', ref = 'sites') => {
    if (!(b.maxX > b.minX && b.maxY > b.minY && b.maxZ > b.minZ)) return;
    collision?.add({ ...b, kind, ref }, COLLISION_GROUP);
    stats.boxes++;
  };
  const addFootprint = (rings, minY, maxY, kind, ref) => {
    for (const b of decomposeFootprint(rings, { step: 0.6 })) addBox({ ...b, minY, maxY }, kind, ref);
  };
  const quadBox = (corners, minY, maxY, kind, ref) => {
    const xs = corners.filter((_, i) => i % 2 === 0), zs = corners.filter((_, i) => i % 2 === 1);
    addBox({ minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), minY, maxY }, kind, ref);
  };
  const finish = (mesher, name, { cast = true, mat = material, profile = LIGHT.warm } = {}) => {
    if (mesher.empty) return null;
    const mesh = new THREE.Mesh(mesher.geometry(ground, profile), mat);
    mesh.name = `Sites(${name})`;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(mesh.geometry);
    stats.meshes++;
    stats.triangles += mesh.geometry.getAttribute('position').count / 3;
    return mesh;
  };
  const finishKit = (kit, name) => {
    for (const mesh of kit.build(goodsMaterial)) {
      mesh.name = `Sites(${name}:${mesh.name})`;
      group.add(mesh);
      disposables.push(mesh.geometry);
      stats.meshes++;
      stats.goods += mesh.count;
      stats.triangles += mesh.count * (mesh.geometry.getAttribute('position').count / 3);
    }
  };
  // Awnings (the city's instanced awning, striped and solid).
  const awnings = { striped: [], solid: [] };
  const awning = (x, y, z, ry, w, d, striped, color) => awnings[striped ? 'striped' : 'solid'].push({ x, y, z, ry, w, d, color });
  const finishAwnings = (name) => {
    if (!props?.awningGeometry) return;
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    for (const [k, list] of Object.entries(awnings)) {
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(props.awningGeometry, k === 'striped' ? props.awningStriped : props.awningSolid, list.length);
      mesh.name = `Sites(${name}:awnings-${k})`;
      list.forEach((a, i) => {
        mesh.setMatrixAt(i, M.compose(p.set(a.x, a.y, a.z), q.setFromEuler(e.set(0, a.ry, 0)), s.set(a.w, 1, a.d)));
        mesh.setColorAt(i, col.setHex(a.color));
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      stats.meshes++;
      list.length = 0;
    }
  };
  /** A stall's counter as a collision box (the aisle stays walkable). */
  const stallBox = (x, y, z, ry, w, d = 0.9, h = 0.95, ref = 'stall') => {
    const c = Math.cos(ry), s = Math.sin(ry);
    const pts = [];
    for (const [u, v] of [[-w / 2, 0], [w / 2, 0], [w / 2, d], [-w / 2, d]]) pts.push(x + c * u + s * v, z - s * u + c * v);
    quadBox(pts, y, y + h, 'prop', ref);
  };

  /**
   * A row of open shops along a face from (ax, az) to (bx, bz), outward normal (nx, nz), floor
   * y0: dark interiors in 3.2 m bays, a sign board and a roll-up shutter box over each, shelves
   * of goods inside. Returns the bay centres (for stalls).
   */
  const shopfronts = (m, kit, ax, az, bx, bz, nx, nz, y0, { top = 2.9, bay = 3.2, seed = 0 } = {}) => {
    const L = Math.hypot(bx - ax, bz - az);
    const out = [];
    if (L < 2.2) return out;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    const n = Math.max(1, Math.floor(L / bay));
    const w = L / n;
    for (let i = 0; i < n; i++) {
      const s0 = i * w + 0.22, s1 = (i + 1) * w - 0.22;
      const P = (s, y, off) => [ax + ux * s + nx * off, y, az + uz * s + nz * off];
      m.paint(C.shopDark, 1, 1, STYLE.plain);
      m.quad(P(s0, y0, 0.02), P(s1, y0, 0.02), P(s1, y0 + top, 0.02), P(s0, y0 + top, 0.02), [nx, 0, nz]);
      // Roll-up shutter box and the sign board above.
      m.paint(C.metal, 1, 1, STYLE.metal);
      m.orientedBox(ax + ux * (s0 + s1) / 2 + nx * 0.14, az + uz * (s0 + s1) / 2 + nz * 0.14, ux, uz, (s1 - s0) / 2, 0.14, y0 + top, y0 + top + 0.32);
      const h = hash(seed + i * 1.7, ax + az);
      const ry = Math.atan2(nx, nz);
      const [sx, , sz] = P((s0 + s1) / 2, 0, 0.3);
      kit.put('panel', sx, y0 + top + 0.36, sz, ry, (s1 - s0) * (0.7 + h * 0.3), 0.55 + h * 0.2, 1, SIGNS[Math.floor(h * SIGNS.length)]);
      // Shelves of goods inside (three rows of small coloured blocks just proud of the dark panel).
      for (let row = 0; row < 3; row++) {
        const cols = Math.max(2, Math.floor((s1 - s0) / 0.4));
        for (let c = 0; c < cols; c++) {
          const hh = hash(seed + i * 13 + row * 3 + c, az);
          if (hh < 0.15) continue;
          const [gx, , gz] = P(s0 + ((c + 0.5) * (s1 - s0)) / cols, 0, 0.08);
          kit.put('panel', gx, y0 + 0.9 + row * 0.62, gz, ry, (s1 - s0) / cols - 0.05, 0.22 + hh * 0.2, 1, [0xc8321e, 0xe8d23a, 0x2a5a8a, 0xe8e2d4, 0x3f7a2a, 0xb58a5a, 0x8a2a24, 0xe07a2a][Math.floor(hh * 8)]);
        }
      }
      out.push({ x: ax + ux * (s0 + s1) / 2, z: az + uz * (s0 + s1) / 2, s: (s0 + s1) / 2, w: s1 - s0 });
    }
    return out;
  };

  // --- Mahane Yehuda ------------------------------------------------------------------------------
  if (data.market) {
    const mk = data.market;
    const m = new Mesher(), roof = new Mesher();
    const kit = createStallKit();
    const blockFaces = []; // [ax, az, bx, bz, nx, nz, y0]
    for (const [bi, b] of mk.blocks.entries()) {
      const ring = project(b.ring);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < ring.length; i += 2) { const g = ground(ring[i], ring[i + 1]); lo = Math.min(lo, g); hi = Math.max(hi, g); }
      const H = 4.6 + hash(bi, 3) * 2.2;
      m.paint(bi % 2 ? C.stone : C.stoneOld, 0.42, 0.9, STYLE.ashlar);
      m.prism(ring, lo - 0.6, hi + H, { top: false });
      // Roof: corrugated metal patches and a parapet line.
      m.paint(0x8f9296, 1, 1, STYLE.lead);
      m.polygon([ring], hi + H - 0.3, 1);
      addFootprint([ring], lo - 0.6, hi + H, 'building', 'market-block');
      // Faces (outward), their floor at the street in front.
      const n = ring.length / 2;
      let area = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) area += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
      for (let i = 0; i < n; i++) {
        const k = (i + 1) % n;
        const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[k * 2], bz = ring[k * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 2.5) continue;
        let nx = (bz - az) / L, nz = -(bx - ax) / L;
        if (area < 0) { nx = -nx; nz = -nz; }
        blockFaces.push([ax, az, bx, bz, nx, nz]);
      }
    }
    // Where the covered street's far side has no mapped building (its southern half), a row of
    // shops 10 m deep closes it: the street is a continuous double row of shops.
    {
      const fr = mk.coveredStreet.frontage;
      const D0 = 3.2, D1 = 13;
      for (let k = 0; k + 1 < fr.length; k++) {
        const a = fr[k], b = fr[k + 1];
        if (a.right !== null || b.right !== null) continue;
        const pa = at(a.lat, a.lon), pb = at(b.lat, b.lon);
        const na = [Math.cos(a.dir), Math.sin(a.dir)], nb = [Math.cos(b.dir), Math.sin(b.dir)]; // right normal = (cos dir, sin dir)
        const ring = [pa.x + na[0] * D0, pa.z + na[1] * D0, pb.x + nb[0] * D0, pb.z + nb[1] * D0, pb.x + nb[0] * D1, pb.z + nb[1] * D1, pa.x + na[0] * D1, pa.z + na[1] * D1];
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < 8; i += 2) { const g = ground(ring[i], ring[i + 1]); lo = Math.min(lo, g); hi = Math.max(hi, g); }
        const H = 5 + hash(k, 17) * 2.5;
        m.paint(k % 3 ? C.stone : C.stoneOld, 0.42, 0.9, STYLE.ashlar);
        m.prism(ring, lo - 0.6, hi + H, { top: false });
        m.paint(0x8f9296, 1, 1, STYLE.lead);
        m.polygon([ring], hi + H - 0.3, 1);
        addFootprint([ring], lo - 0.6, hi + H, 'building', 'market-block');
        // The face toward the street: from b back to a (outward = toward the street, -right).
        blockFaces.push([ring[2], ring[3], ring[0], ring[1], -(na[0] + nb[0]) / 2, -(na[1] + nb[1]) / 2]);
      }
    }
    // Shopfronts and stalls along every block face.
    let seed = 0;
    for (const [ax, az, bx, bz, nx, nz] of blockFaces) {
      const g0 = Math.min(ground(ax + nx, az + nz), ground(bx + nx, bz + nz));
      const bays = shopfronts(m, kit, ax, az, bx, bz, nx, nz, g0, { seed: seed++ * 31 });
      for (const b of bays) {
        const h = hash(b.x * 0.37, b.z * 0.73);
        const ry = Math.atan2(nx, nz);
        const x = b.x + nx * 0.05, z = b.z + nz * 0.05, y = ground(x + nx, z + nz);
        kit.stall(x, y, z, ry, marketKind(h), { width: Math.min(2.9, b.w - 0.2), seed: b.x * 3.1 + b.z });
        stallBox(x, y, z, ry, Math.min(2.9, b.w - 0.2), 0.95, 0.95, 'market-stall');
        stats.stalls++;
      }
    }
    // Stalls on the far side of both streets (the city's shopfronts), and awnings on the open street.
    for (const [street, open] of [[mk.openStreet, true], [mk.coveredStreet, false]]) {
      for (const [k, f] of street.frontage.entries()) {
        const c = at(f.lat, f.lon);
        const tx = Math.sin(f.dir), tz = -Math.cos(f.dir); // along the street
        for (const side of ['left', 'right']) {
          const d = f[side];
          if (d === null || d > (open ? 7 : 6) || d < street.half - 0.5) continue; // the block side is done above
          const sg = side === 'left' ? 1 : -1;
          const nx = tz * sg, nz = -tx * sg; // toward the face
          const x = c.x + nx * (d - 0.05), z = c.z + nz * (d - 0.05);
          const ry = Math.atan2(-nx, -nz);
          const y = ground(c.x + nx * (d - 1.2), c.z + nz * (d - 1.2));
          const h = hash(x * 0.51, z * 0.29);
          if (h < 0.1) { kit.table(c.x + nx * (d - 1.6), y, c.z + nz * (d - 1.6), ry, k); continue; }
          kit.stall(x, y, z, ry, marketKind(h), { width: 2.9, seed: x + z * 1.3 });
          stallBox(x, y, z, ry, 2.9, 0.95, 0.95, 'market-stall');
          stats.stalls++;
          if (open) awning(x, y + 2.75, z, ry, 3.2, 1.6 + hash(k, 5) * 0.6, hash(k, side.length) < 0.5, [0x8e2a24, 0x1f5a3a, 0x2a3e63, 0xb5562f, 0xd9c9a3][Math.floor(hash(x, z) * 5)]);
        }
        // The block side of the open street gets awnings too (over the block's stalls).
        if (open) {
          const nx = -tz, nz = tx; // right side (east, the block)
          const x = c.x + nx * street.half, z = c.z + nz * street.half;
          awning(x, ground(x, z) + 2.75, z, Math.atan2(-nx, -nz), 3.2, 1.8, hash(k, 9) < 0.5, [0x8e2a24, 0x1f5a3a, 0x2a3e63, 0xb5562f, 0xd9c9a3][Math.floor(hash(k, 11) * 5)]);
        }
      }
    }
    // Etz Haim Street's vault: translucent sheets on steel ribs, spanning from the block face to
    // the buildings opposite, springing at 5 m; pendant lamps along the middle.
    {
      const line = project(mk.coveredStreet.line);
      const secs = [];
      for (let i = 0; i + 3 < line.length; i += 2) {
        const ax = line[i], az = line[i + 1], bx = line[i + 2], bz = line[i + 3];
        const L = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.ceil(L / 3));
        for (let k = 0; k < n + (i + 4 >= line.length ? 1 : 0); k++) secs.push({ x: ax + ((bx - ax) * k) / n, z: az + ((bz - az) * k) / n, tx: (bx - ax) / L, tz: (bz - az) / L });
      }
      const fr = mk.coveredStreet.frontage;
      const eastAt = (x, z) => {
        let best = null, bd = Infinity;
        for (const f of fr) { const c = at(f.lat, f.lon); const d = Math.hypot(c.x - x, c.z - z); if (d < bd) { bd = d; best = f; } }
        const r = best?.right;
        return r !== null && r !== undefined && r < 8 ? r : 3.2;
      };
      const ARCH = 9;
      const prof = secs.map((sc) => {
        const nx = -sc.tz, nz = sc.tx; // right (east)
        const west = -mk.coveredStreet.half, east = eastAt(sc.x, sc.z);
        const y0 = ground(sc.x, sc.z) + 5.0, span = east - west, rise = Math.min(2.4, span * 0.35);
        const pts = [];
        for (let a = 0; a <= ARCH; a++) {
          const t = a / ARCH, o = west + span * t;
          pts.push([sc.x + nx * o, y0 + Math.sin(Math.PI * t) * rise, sc.z + nz * o]);
        }
        return { pts, nx, nz, y0, west, east, sc };
      });
      for (let i = 0; i + 1 < prof.length; i++) {
        const A = prof[i].pts, B = prof[i + 1].pts;
        roof.paint(C.sheet, 1, 1, STYLE.plain);
        for (let a = 0; a < ARCH; a++) {
          roof.quad(A[a], A[a + 1], B[a + 1], B[a], null);
          roof.quad(A[a], B[a], B[a + 1], A[a + 1], null); // both sides (seen from below and above)
        }
        stats.vaultSections++;
      }
      for (const [i, p] of prof.entries()) {
        m.paint(C.metalDark, 1, 1, STYLE.metal);
        for (let a = 0; a < ARCH; a++) beam(m, p.pts[a], p.pts[a + 1], 0.05, 0.07);
        // Wall brackets down to the shopfronts.
        beam(m, p.pts[0], [p.pts[0][0], p.y0 - 0.6, p.pts[0][2]], 0.05, 0.05, [1, 0, 0]);
        beam(m, p.pts[ARCH], [p.pts[ARCH][0], p.y0 - 0.6, p.pts[ARCH][2]], 0.05, 0.05, [1, 0, 0]);
        if (i % 2 === 0) {
          const mid = p.pts[Math.floor(ARCH / 2)];
          beam(m, [mid[0], mid[1] - 0.1, mid[2]], [mid[0], mid[1] - 1.4, mid[2]], 0.01, 0.01, [1, 0, 0]);
          m.paint(C.lamp, 1, 1, STYLE.gold);
          m.cylinder(mid[0], mid[2], 0.28, 0.08, mid[1] - 1.75, mid[1] - 1.4, 8);
        }
        // Now and then a big photo banner hanging across the street (the market's gallery).
        if (i % 16 === 8) {
          const mid = p.pts[Math.floor(ARCH / 2)];
          m.paint(0x2a2622, 1, 1, STYLE.plain);
          m.orientedBox(mid[0], mid[2], p.nx, p.nz, 1.6, 0.03, mid[1] - 2.6, mid[1] - 0.6);
          for (const sg of [1, -1]) kit.put('panel', mid[0] - p.sc.tx * 0.04 * sg, mid[1] - 2.45, mid[2] - p.sc.tz * 0.04 * sg, Math.atan2(-p.sc.tx * sg, -p.sc.tz * sg), 3.0, 1.7, 1, [0xd8a040, 0x8a5a3a, 0x3a5a7a][i % 3]);
        }
        // Collision: the roof as a lid (you can stand on it, not jump through it).
        if (i + 1 < prof.length) {
          const q = prof[i + 1];
          quadBox([p.pts[0][0], p.pts[0][2], p.pts[ARCH][0], p.pts[ARCH][2], q.pts[ARCH][0], q.pts[ARCH][2], q.pts[0][0], q.pts[0][2]], p.y0 + 0.4, p.y0 + 0.7, 'roof', 'market-roof');
        }
      }
    }
    // The alleys: corrugated roofs between the blocks, with a skylight strip.
    for (const al of mk.alleys) {
      const q = project(al.line);
      const ax = q[0], az = q[1], bx = q[2], bz = q[3];
      const L = Math.hypot(bx - ax, bz - az);
      const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux, hw = al.width / 2 + 0.25;
      const y = Math.max(ground(ax, az), ground(bx, bz)) + 4.6;
      const P = (s, o, dy = 0) => [ax + ux * s + nx * o, y + dy, az + uz * s + nz * o];
      roof.paint(C.sheet, 1, 1, STYLE.plain);
      roof.quad(P(0, -0.4, 0.25), P(L, -0.4, 0.25), P(L, 0.4, 0.25), P(0, 0.4, 0.25), [0, 1, 0]);
      roof.quad(P(0, -0.4, 0.25), P(0, 0.4, 0.25), P(L, 0.4, 0.25), P(L, -0.4, 0.25), [0, -1, 0]);
      m.paint(0x8f9296, 1, 1, STYLE.lead);
      for (const sg of [-1, 1]) {
        m.quad(P(0, sg * hw, 0), P(L, sg * hw, 0), P(L, sg * 0.4, 0.25), P(0, sg * 0.4, 0.25), null);
        m.quad(P(0, sg * hw, 0), P(0, sg * 0.4, 0.25), P(L, sg * 0.4, 0.25), P(L, sg * hw, 0), null);
      }
      m.paint(C.metalDark, 1, 1, STYLE.metal);
      for (let s = 0; s <= L; s += 3) beam(m, P(s, -hw, -0.05), P(s, hw, -0.05), 0.04, 0.05);
    }
    // The squares: stalls on the edges, tables and umbrellas in the middle.
    for (const sq of mk.squares) {
      for (let i = 0; i + 1 < sq.spots.length; i += 2) {
        const p = at(sq.spots[i], sq.spots[i + 1]);
        const h = hash(p.x * 0.7, p.z * 0.3);
        const y = ground(p.x, p.z);
        const ry = Math.floor(h * 4) * (Math.PI / 2);
        if (sq.kind === 'iraqi' && h < 0.45) {
          kit.table(p.x, y, p.z, ry, i);
          if (h < 0.25) kit.umbrella(p.x + 0.6, y, p.z + 0.6, [0xe8e2d4, 0x8e2a24, 0x2a4a8a, 0x1f5a3a][Math.floor(h * 16) % 4]);
        } else {
          kit.stall(p.x, y, p.z, ry, marketKind(h), { width: 2.4, seed: p.x + p.z });
          stallBox(p.x, y, p.z, ry, 2.4, 0.95, 0.95, 'market-stall');
          stats.stalls++;
        }
      }
    }
    finish(m, 'Market');
    const r = finish(roof, 'MarketRoof', { cast: false });
    if (r) r.userData.translucent = true;
    finishKit(kit, 'Market');
    finishAwnings('Market');
  }

  // --- Old City souks, the Cardo, the infill ----------------------------------------------------------
  const old = new Mesher();
  const oldKit = createStallKit();
  const kitOld = createKit(old, { addBox, quadBox });
  for (const sk of data.souks ?? []) {
    const fr = sk.frontage ?? [];
    // Vault sections from the facades on either side (default 2.2 m each way).
    const prof = [];
    for (const [k, f] of fr.entries()) {
      const c = at(f.lat, f.lon);
      const tx = Math.sin(f.dir), tz = -Math.cos(f.dir);
      const nx = tz, nz = -tx; // left
      const L = f.left !== null && f.left < 5 ? f.left : 2.3, R = f.right !== null && f.right < 5 ? f.right : 2.3;
      const y = ground(c.x, c.z);
      // Stalls / goods on both sides (not on stairs).
      if (!sk.steps) {
        for (const [d, sg] of [[L, 1], [R, -1]]) {
          const h = hash(c.x * 0.41 + sg, c.z * 0.17);
          if (h < 0.18) continue;
          const kind = soukKind(sk.goods, h);
          const x = c.x + nx * sg * (d - 0.05), z = c.z + nz * sg * (d - 0.05);
          const ry = Math.atan2(-nx * sg, -nz * sg);
          if (kind === 'gallery') {
            // A lit shop window instead of a stall.
            oldKit.put('panel', x - nx * sg * 0.05, y + 0.5, z - nz * sg * 0.05, ry, 2.2, 1.9, 1, [0xe8d8a8, 0xd8c890, 0xf0e0b8][Math.floor(h * 3)]);
            continue;
          }
          const w = Math.min(2.4, (L + R) * 0.55);
          oldKit.stall(x, y, z, ry, kind, { width: w, seed: x + z * 0.7, counter: (L + R) > 4.2 });
          if ((L + R) > 4.2) stallBox(x, y, z, ry, w, 0.9, 0.95, 'souk-stall');
          stats.stalls++;
        }
      }
      if (sk.covered) prof.push({ c, nx, nz, L, R, y, tx, tz });
    }
    if (sk.covered) {
      const ARCH = 8;
      const secs = prof.map((p) => {
        const span = p.L + p.R, ys = p.y + 4.2, rise = span * 0.45;
        const pts = [];
        for (let a = 0; a <= ARCH; a++) {
          const t = a / ARCH, o = p.L - span * t;
          // Pointed barrel vault: two arcs meeting at the crown.
          const hgt = rise * Math.sqrt(Math.max(0, 1 - (2 * Math.abs(t - 0.5)) ** 1.6));
          pts.push([p.c.x + p.nx * o, ys + hgt, p.c.z + p.nz * o]);
        }
        return { pts, ys, p };
      });
      for (let i = 0; i + 1 < secs.length; i++) {
        const A = secs[i].pts, B = secs[i + 1].pts;
        const gap = Math.hypot(secs[i].p.c.x - secs[i + 1].p.c.x, secs[i].p.c.z - secs[i + 1].p.c.z);
        if (gap > 6) continue; // a bend in the street: leave it open
        old.paint(i % 7 === 3 ? C.stoneOld : C.stone, 0.45, 0.8, STYLE.ashlar);
        for (let a = 0; a < ARCH; a++) {
          // A light well every ~20 m (the souks' roof openings).
          if (i % 6 === 5 && a >= ARCH / 2 - 1 && a <= ARCH / 2) continue;
          old.quad(A[a], A[a + 1], B[a + 1], B[a], null);
          old.quad(A[a], B[a], B[a + 1], A[a + 1], null);
        }
        // Transverse arch ribs every other section.
        if (i % 2 === 0) {
          old.paint(C.stoneOld, 0.5, 0.9, STYLE.ashlar);
          for (let a = 0; a < ARCH; a++) beam(old, [A[a][0], A[a][1] - 0.18, A[a][2]], [A[a + 1][0], A[a + 1][1] - 0.18, A[a + 1][2]], 0.25, 0.18);
        }
        stats.vaultSections++;
        const q = secs[i + 1];
        quadBox([A[0][0], A[0][2], A[ARCH][0], A[ARCH][2], B[ARCH][0], B[ARCH][2], B[0][0], B[0][2]], secs[i].ys + 1.2, secs[i].ys + 1.6, 'roof', 'souk-vault');
        void q;
      }
    }
  }

  // The open Cardo: Byzantine columns on a stylobate along both sides.
  if (data.cardo) {
    const line = project(data.cardo.line);
    for (let i = 0; i + 3 < line.length; i += 2) {
      const ax = line[i], az = line[i + 1], bx = line[i + 2], bz = line[i + 3];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux;
      for (let s = 1.5; s < L; s += 3.4) {
        for (const sg of [-1, 1]) {
          const x = ax + ux * s + nx * sg * 3.6, z = az + uz * s + nz * sg * 3.6, g = ground(x, z);
          old.paint(C.stoneWarm, 0.3, 0.6, STYLE.ashlar);
          old.orientedBox(x, z, ux, uz, 0.55, 0.55, g - 0.3, g + 0.35);
          old.paint(0xd8d0c0, 1, 1, STYLE.marble);
          old.cylinder(x, z, 0.3, 0.26, g + 0.35, g + 4.8, 10);
          old.paint(C.stoneWarm, 0.3, 0.6, STYLE.ashlar);
          old.orientedBox(x, z, ux, uz, 0.42, 0.42, g + 4.8, g + 5.25);
          addBox({ minX: x - 0.35, maxX: x + 0.35, minZ: z - 0.35, maxZ: z + 0.35, minY: g - 0.3, maxY: g + 5.25 }, 'building', 'cardo-column');
        }
      }
    }
  }

  // Infill: the Old City's unmapped houses.
  if (data.infill?.boxes?.length) {
    const b = data.infill.boxes;
    const TONES = [C.stone, C.stoneOld, C.stoneWarm, 0xcfc4ae];
    for (let i = 0; i + 3 < b.length; i += 4) {
      const p0 = at(b[i], b[i + 1]), p1 = at(b[i + 2], b[i + 3]);
      const x0 = Math.min(p0.x, p1.x), x1 = Math.max(p0.x, p1.x), z0 = Math.min(p0.z, p1.z), z1 = Math.max(p0.z, p1.z);
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hw = (x1 - x0) / 2, hd = (z1 - z0) / 2;
      let lo = Infinity, hi = -Infinity;
      for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [cx, cz]]) { const g = ground(x, z); lo = Math.min(lo, g); hi = Math.max(hi, g); }
      const h = hash(cx * 0.13, cz * 0.29);
      const H = (h < 0.45 ? 6.6 : 9.8) + h * 1.2;
      old.paint(TONES[Math.floor(hash(cz, cx) * TONES.length)], 0.42, 0.9, STYLE.ashlar);
      old.orientedBox(cx, cz, 1, 0, hw, hd, lo - 0.6, hi + H, { top: false });
      old.paint(0xbdb5a4, 1, 1, STYLE.paving);
      old.polygon([[x0, z0, x1, z0, x1, z1, x0, z1]], hi + H - 0.45, 1);
      // Parapet: a low rim on top.
      old.paint(C.stoneOld, 0.3, 0.8, STYLE.ashlar);
      for (const [ax, az, bx, bz] of [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]]) {
        const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
        old.orientedBox((ax + bx) / 2, (az + bz) / 2, ux, uz, L / 2, 0.12, hi + H - 0.45, hi + H + 0.25);
        // A few small arched windows on the upper floor.
        const nx = uz, nz = -ux; // outward for this winding (x0,z0)->(x1,z0)->... is clockwise in x-east/z-south? checked below
        const out = ((ax + bx) / 2 - cx) * nx + ((az + bz) / 2 - cz) * nz > 0 ? 1 : -1;
        for (let s = 1.6; s < L - 1; s += 3.6) {
          if (hash(ax + s, az - s) < 0.45) continue;
          kitOld.window(ax + ux * s + nx * out * 0.01, hi + H - 3.2, az + uz * s + nz * out * 0.01, ux, uz, nx * out, nz * out, 0.75, 1.4);
        }
      }
      // A small plastered dome on some roofs.
      if (hw > 2.4 && hd > 2.4 && h > 0.62) {
        const r = Math.min(hw, hd) * 0.62;
        old.paint(C.plaster, 0.5, 1, STYLE.plain);
        kitOld.revolve(cx, cz, kitOld.domeProfile(r, hi + H - 0.45, r * 0.75), 12);
      }
      addBox({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, minY: lo - 0.6, maxY: hi + H }, 'building', 'old-city-infill');
      stats.infill++;
    }
  }

  // --- Hurva Synagogue -----------------------------------------------------------------------------
  if (data.hurva) {
    const ring = project(data.hurva.ring);
    const box = orientedBox(ring);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < ring.length; i += 2) { const g = ground(ring[i], ring[i + 1]); lo = Math.min(lo, g); hi = Math.max(hi, g); }
    const { cx, cz, ax, az } = box;
    // The mapped outline takes in an annex on one side: the dome is sized by the short side.
    const half = Math.min(box.hl, box.hw);
    const px = -az, pz = ax;
    const H = 15.5, top = hi + H;
    old.paint(C.stone, 0.5, 1.1, STYLE.ashlar);
    old.orientedBox(cx, cz, ax, az, box.hl, box.hw, lo - 0.5, top);
    old.paint(C.stoneOld, 0.4, 0.9, STYLE.ashlar);
    old.orientedBox(cx, cz, ax, az, box.hl + 0.25, box.hw + 0.25, top - 0.6, top);
    // Three tall arched windows on each face, and the entrance arch on the front.
    for (const [ux, uz, nx, nz, hl] of [[ax, az, px, pz, box.hl], [ax, az, -px, -pz, box.hl], [px, pz, ax, az, box.hw], [px, pz, -ax, -az, box.hw]]) {
      const d = ux === ax && uz === az ? box.hw : box.hl;
      for (const s of [-hl * 0.55, 0, hl * 0.55]) kitOld.window(cx + ux * s + nx * d, hi + 6.5, cz + uz * s + nz * d, ux, uz, nx, nz, 2.0, 6.2);
      kitOld.window(cx + nx * d, hi, cz + nz * d, ux, uz, nx, nz, 2.6, 4.4);
    }
    // Corner turrets with small domes.
    for (const [sa, sb] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = cx + ax * box.hl * sa + px * box.hw * sb, z = cz + az * box.hl * sa + pz * box.hw * sb;
      old.paint(C.stone, 0.45, 1, STYLE.ashlar);
      old.orientedBox(x, z, ax, az, 1.3, 1.3, top - 1, top + 3.2);
      old.paint(C.dome, 0.5, 1, STYLE.plain);
      kitOld.revolve(x, z, kitOld.domeProfile(1.2, top + 3.2, 1.1), 10);
    }
    // Drum with windows, the great dome.
    const R = half * 0.62;
    old.paint(C.stone, 0.45, 1, STYLE.ashlar);
    old.cylinder(cx, cz, R, R, top - 0.5, top + 3.4, 24, { top: false });
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, nx = Math.cos(a), nz = Math.sin(a);
      kitOld.window(cx + nx * R, top + 0.6, cz + nz * R, -nz, nx, nx, nz, 1.0, 2.4);
    }
    old.paint(C.dome, 0.5, 1, STYLE.plain);
    kitOld.revolve(cx, cz, kitOld.domeProfile(R + 0.2, top + 3.4, R * 0.95), 28);
    old.paint(C.metalDark, 1, 1, STYLE.metal);
    old.cylinder(cx, cz, 0.12, 0.05, top + 3.4 + R * 0.95, top + 3.4 + R * 0.95 + 1.2, 6);
    addFootprint([ring], lo - 0.5, top, 'building', 'hurva');
    kitOld.domeBoxes(cx, cz, R, top + 3.4, R * 0.95, 'hurva');
    stats.hurva = true;
  }
  finish(old, 'OldCity');
  finishKit(oldKit, 'OldCity');

  // --- the Temple Mount esplanade ----------------------------------------------------------------------
  const esTrees = [];
  if (landmarks) {
    const esp = new Mesher();
    const kitE = createKit(esp, { addBox, quadBox });
    const r = buildEsplanade(landmarks, data, { project, ground, quadBox, m: esp, kit: kitE });
    finish(esp, 'Esplanade');
    esTrees.push(...r.trees);
    Object.assign(stats, { esplanade: r.stats });
  }

  // --- YMCA, King David Hotel, Mamilla ----------------------------------------------------------------
  const west = new Mesher();
  const westKit = createStallKit();
  const kitW = createKit(west, { addBox, quadBox });
  let kd = null;
  if (data.kingDavid) {
    const ring = project(data.kingDavid.ring);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < ring.length; i += 2) { const g = ground(ring[i], ring[i + 1]); lo = Math.min(lo, g); hi = Math.max(hi, g); }
    const H = data.kingDavid.height ?? 36;
    const top = lo + H;
    west.paint(C.pink, 0.5, 1.1, STYLE.ashlar);
    west.prism(ring, lo - 0.6, top);
    // Windows: tall pairs on every floor, an arched ground floor, a crowning cornice.
    const n = ring.length / 2;
    let area = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) area += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
    for (let i = 0; i < n; i++) {
      const k = (i + 1) % n;
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[k * 2], bz = ring[k * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 4) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      let nx = uz, nz = -ux;
      if (area < 0) { nx = -nx; nz = -nz; }
      const g = Math.min(ground(ax, az), ground(bx, bz));
      for (let s = 2; s < L - 1.5; s += 3.3) {
        kitW.window(ax + ux * s, g + 0.2, az + uz * s, ux, uz, nx, nz, 2.0, 3.8);
        for (let f = 1; g + 4.6 + f * 3.4 < top - 2; f++) {
          const y = g + 1.4 + f * 3.4;
          west.paint(C.opening, 1, 1, STYLE.plain);
          const P = (o, yy) => [ax + ux * (s + o) + nx * 0.02, yy, az + uz * (s + o) + nz * 0.02];
          west.quad(P(-0.55, y), P(0.55, y), P(0.55, y + 1.9), P(-0.55, y + 1.9), [nx, 0, nz]);
        }
      }
      west.paint(C.stoneWarm, 0.3, 0.7, STYLE.ashlar);
      west.orientedBox((ax + bx) / 2 + nx * 0.3, (az + bz) / 2 + nz * 0.3, ux, uz, L / 2 + 0.3, 0.35, top - 1.4, top - 0.8);
    }
    addFootprint([ring], lo - 0.6, top, 'building', 'king-david-hotel');
    kd = ringCenterOf(ring);
    stats.kingDavid = true;
  }
  if (data.ymca) {
    const ring = project(data.ymca.ring);
    const box = orientedBox(ring);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < ring.length; i += 2) { const g = ground(ring[i], ring[i + 1]); lo = Math.min(lo, g); hi = Math.max(hi, g); }
    const top = hi + 13;
    west.paint(C.honey, 0.5, 1.1, STYLE.ashlar);
    west.prism(ring, lo - 0.6, top);
    addFootprint([ring], lo - 0.6, top, 'building', 'ymca');
    // The front: the outline's edge that faces the King David Hotel across the street (outward
    // normal toward it, weighted by length). The tower rises from its middle.
    const { cx, cz } = box;
    const n = ring.length / 2;
    let area = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) area += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
    let front = null;
    for (let i = 0; i < n; i++) {
      const k = (i + 1) % n;
      const ex0 = ring[i * 2], ez0 = ring[i * 2 + 1], ex1 = ring[k * 2], ez1 = ring[k * 2 + 1];
      const L = Math.hypot(ex1 - ex0, ez1 - ez0);
      if (L < 6) continue;
      let nx = (ez1 - ez0) / L, nz = -(ex1 - ex0) / L;
      if (area < 0) { nx = -nx; nz = -nz; }
      const mx = (ex0 + ex1) / 2, mz = (ez0 + ez1) / 2;
      const to = kd ? [kd.x - mx, kd.z - mz] : [nx, nz];
      const tl = Math.hypot(...to) || 1;
      const score = ((nx * to[0] + nz * to[1]) / tl) * Math.min(L, 40);
      if (!front || score > front.score) front = { score, mx, mz, ux: (ex1 - ex0) / L, uz: (ez1 - ez0) / L, nx, nz, L };
    }
    const ax = front.ux, az = front.uz, px = front.nx, pz = front.nz;
    const fx = front.mx, fz = front.mz; // middle of the front
    const bays = Math.max(3, Math.min(9, Math.floor((front.L - 12) / 3.6)));
    // Arcade along the front, either side of the tower.
    for (let k = -Math.floor(bays / 2); k <= Math.floor(bays / 2); k++) {
      if (Math.abs(k) < 1) continue;
      kitW.window(fx + ax * k * 3.6 + px * 0.05, lo, fz + az * k * 3.6 + pz * 0.05, ax, az, px, pz, 2.4, 4.6);
    }
    // Upper windows.
    for (let k = -Math.floor(front.L / 6); k <= Math.floor(front.L / 6); k++) if (Math.abs(k) > 1) kitW.window(fx + ax * k * 3 + px * 0.05, lo + 6.5, fz + az * k * 3 + pz * 0.05, ax, az, px, pz, 1.1, 2.6);
    // The tower (46 m): square shaft set into the front, belfry with arches, small dome.
    const tx = fx - px * 3, tz = fz - pz * 3, TW = 3.6;
    west.paint(C.honey, 0.5, 1.1, STYLE.ashlar);
    west.orientedBox(tx, tz, ax, az, TW, TW, lo - 0.5, lo + 38);
    for (const [ux, uz, nx, nz] of [[ax, az, px, pz], [ax, az, -px, -pz], [px, pz, ax, az], [px, pz, -ax, -az]]) {
      for (const y of [lo + 16, lo + 24]) kitW.window(tx + nx * TW, y, tz + nz * TW, ux, uz, nx, nz, 0.9, 3.2);
      for (const s of [-1.5, 1.5]) kitW.window(tx + ux * s + nx * TW, lo + 31, tz + uz * s + nz * TW, ux, uz, nx, nz, 1.3, 5.4);
    }
    west.paint(C.stoneWarm, 0.35, 0.8, STYLE.ashlar);
    west.orientedBox(tx, tz, ax, az, TW + 0.35, TW + 0.35, lo + 37.4, lo + 38.2);
    west.orientedBox(tx, tz, ax, az, TW * 0.72, TW * 0.72, lo + 38.2, lo + 42);
    west.paint(C.honey, 0.5, 1, STYLE.plain);
    kitW.revolve(tx, tz, kitW.domeProfile(TW * 0.7, lo + 42, 3.2, 0.2), 16);
    addBox({ minX: tx - TW, maxX: tx + TW, minZ: tz - TW, maxZ: tz + TW, minY: lo - 0.5, maxY: lo + 45 }, 'building', 'ymca-tower');
    // Two domes on the wings (along the front, set back 9 m), where they fall on the building.
    for (const sg of [-1, 1]) {
      const r = Math.min(6, front.L * 0.14);
      const x = fx + ax * sg * front.L * 0.3 - px * 9, z = fz + az * sg * front.L * 0.3 - pz * 9;
      if (!pointInRings([ring], x, z)) continue;
      west.paint(C.honey, 0.45, 1, STYLE.ashlar);
      west.cylinder(x, z, r, r, top - 0.2, top + 1.6, 20, { top: false });
      west.paint(C.dome, 0.5, 1, STYLE.plain);
      kitW.revolve(x, z, kitW.domeProfile(r, top + 1.6, r * 0.8), 20);
      kitW.domeBoxes(x, z, r, top + 1.6, r * 0.8, 'ymca-dome');
    }
    stats.ymca = true;
  }
  // Mamilla: planters with olive trees and café umbrellas along the promenade.
  const trees = [];
  for (const pr of data.mamilla?.promenade ?? []) {
    if (pr.steps) continue;
    for (const [k, f] of (pr.frontage ?? []).entries()) {
      if (k % 3 !== 1) continue;
      const c = at(f.lat, f.lon), y = ground(c.x, c.z);
      west.paint(C.stoneWarm, 0.3, 0.7, STYLE.ashlar);
      west.cylinder(c.x, c.z, 1.1, 1.1, y - 0.2, y + 0.55, 12);
      west.paint(0x5a4a38, 1, 1, STYLE.foliage);
      west.cylinder(c.x, c.z, 1.0, 1.0, y + 0.5, y + 0.52, 12);
      addBox({ minX: c.x - 1, maxX: c.x + 1, minZ: c.z - 1, maxZ: c.z + 1, minY: y - 0.2, maxY: y + 0.55 }, 'prop', 'mamilla-planter');
      trees.push({ x: c.x, y: y + 0.52, z: c.z, s: 0.9 + hash(k, 3) * 0.3, ry: hash(k, 7) * 6.28 });
      const tx = Math.sin(f.dir), tz = -Math.cos(f.dir);
      for (const sg of [-1, 1]) {
        const d = sg > 0 ? f.left : f.right;
        if (d === null || d < 4) continue;
        const x = c.x + tz * sg * (d - 2.2), z = c.z - tx * sg * (d - 2.2);
        westKit.table(x, ground(x, z), z, Math.atan2(tx, tz), k + sg);
        westKit.umbrella(x, ground(x, z), z, [0xe8e2d4, 0x2a3e63, 0xd9c9a3][(k + (sg > 0 ? 1 : 0)) % 3]);
      }
    }
  }
  finish(west, 'West');
  finishKit(westKit, 'West');
  // Trees: Mamilla's olives; the esplanade's olives, cypresses and pines (darker, larger olives).
  const plant = (name, geo, list, tint) => {
    if (!list.length || !geo || !props?.material) return;
    const im = new THREE.InstancedMesh(geo, props.material, list.length);
    im.name = `Sites(${name})`;
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    list.forEach((t, i) => {
      im.setMatrixAt(i, M.compose(p.set(t.x, t.y, t.z), q.setFromEuler(e.set(0, t.ry, 0)), s.setScalar(t.s)));
      im.setColorAt(i, col.setHex(t.tint ?? tint));
      addBox({ minX: t.x - 0.3 * t.s, maxX: t.x + 0.3 * t.s, minZ: t.z - 0.3 * t.s, maxZ: t.z + 0.3 * t.s, minY: t.y, maxY: t.y + 2 * t.s }, 'tree', name);
    });
    im.computeBoundingSphere();
    im.castShadow = true;
    im.receiveShadow = true;
    group.add(im);
    stats.meshes++;
  };
  plant('Mamilla:olives', props?.olive, trees, 0xe8eee0);
  plant('Esplanade:olives', props?.olive, esTrees.filter((t) => t.kind !== 'cypress').map((t) => (t.kind === 'pine' ? { ...t, s: t.s * 1.5, tint: 0x9aa890 } : t)), 0xe8eee0);
  plant('Esplanade:cypresses', props?.cypress, esTrees.filter((t) => t.kind === 'cypress'), 0xffffff);

  // Busy zones for the pedestrians: the market, the souks, Mamilla, downtown.
  const busyZones = [];
  const zone = (pts, r, factor) => {
    if (!pts.length) return;
    let x = 0, z = 0;
    for (const p of pts) { x += p.x; z += p.z; }
    busyZones.push({ x: x / pts.length, z: z / pts.length, r, factor });
  };
  if (data.market) zone([at(...data.market.block.ring.slice(0, 2)), ...[mkCenter(data.market, at)]], 150, 3.2);
  const soukPts = (data.souks ?? []).flatMap((sk) => { const l = sk.line; return [at(l[0], l[1])]; });
  if (soukPts.length) zone(soukPts, 280, 2.2);
  if (data.mamilla?.promenade?.length) zone(data.mamilla.promenade.map((p) => at(p.line[0], p.line[1])), 130, 2);
  for (const a of data.lowRise ?? []) if (a.facade === 'downtown') { const pts = []; for (let i = 0; i < a.ring.length; i += 2) pts.push(at(a.ring[i], a.ring[i + 1])); zone(pts, 260, 1.8); }

  return {
    group,
    material,
    goodsMaterial,
    stats,
    busyZones,
    dispose() {
      collision?.removeGroup?.(COLLISION_GROUP);
      for (const g of disposables) g.dispose();
      group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
      material.dispose();
      goodsMaterial.dispose();
      group.removeFromParent();
    },
  };
}

/** The market's middle (the covered street's midpoint). */
function mkCenter(mk, at) {
  const l = mk.coveredStreet.line, k = Math.floor(l.length / 4) * 2;
  return at(l[k], l[k + 1]);
}

function ringCenterOf(ring) {
  let x = 0, z = 0;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return { x: (x * 2) / ring.length, z: (z * 2) / ring.length };
}

export { pointInRings };
