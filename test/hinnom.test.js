import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { createProjection } from '../src/city/geo.js';
import { createTerrain } from '../src/city/terrain.js';
import { CityCollisionWorld } from '../src/city/CityCollision.js';
import { generateCityChunk } from '../src/city/CityGenerator.js';
import { buildHinnom, archOutline } from '../src/city/landmarks/hinnom.js';
import { createStreetPropGeometries } from '../src/city/StreetProps.js';
import { orientedBox, pointInRings, distanceToEdges, footprintArea } from '../src/city/footprint.js';
import { packBits, unpackBits, convexHull, ELEVATION } from '../scripts/fetch_hinnom.js';

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));
const manifest = read('../public/data/tiles/manifest.json');
const hinnom = read('../public/data/hinnom.json');
const landmarks = read('../public/data/landmarks.json');
// As in main.js: the landmark patches, then the valley's.
const dem = { ...read('../public/data/tiles/dem_points.json'), patches: [...landmarks.patches, ...hinnom.patches] };
const projection = createProjection(manifest.worldBBox);
const terrain = createTerrain(dem, projection);
const ASL = (y) => y + terrain.datum;
const at = (lat, lon) => projection.project(lat, lon);
const hAt = (lat, lon) => { const p = at(lat, lon); return ASL(terrain.heightAt(p.x, p.z)); };

const collision = new CityCollisionWorld();
const props = createStreetPropGeometries();
const layer = buildHinnom(hinnom, { projection, terrain, collision, uniforms: { uNight: { value: 0 } }, props: { material: new THREE.MeshStandardMaterial(), olive: props.olive, cypress: props.cypress } });
const solidAt = (x, y, z, r = 0.2) => collision.queryAABB(x - r, y - r, z - r, x + r, y + r, z + r).length > 0;

test('hinnom data: Mishkenot rows, the windmill on its base, the pool and the valley, all replaced buildings named', () => {
  assert.equal(hinnom.format, 'hinnom-v1');
  assert.equal(hinnom.license, 'ODbL-1.0');
  // The long row (~110 m, ~12 m deep) and the short one behind it.
  assert.equal(hinnom.mishkenot.length, 2);
  const [long, short] = hinnom.mishkenot;
  assert.ok(long.length > 95 && long.length < 125 && long.width < 16, `long row ${long.length} x ${long.width} m`);
  assert.ok(short.length > 25 && short.length < long.length);
  // It runs roughly north-south along the slope, facing the Old City across the valley.
  const box = orientedBox(projection.projectFlat(long.ring));
  assert.ok(Math.abs(box.az) > 0.9, 'long axis north-south');
  const w = hinnom.windmill;
  assert.match(w.name, /Montefiore/);
  const c = at(w.lat, w.lon);
  assert.ok(pointInRings([projection.projectFlat(w.base.ring)], c.x, c.z), 'the mill stands on its base');
  for (const id of [long.id, short.id, w.base.id]) assert.ok(hinnom.replaces.includes(id), id);
  // Sultan's Pool: ~170-200 m long, ~60-75 m wide.
  const pb = orientedBox(projection.projectFlat(hinnom.pool.ring));
  assert.ok(pb.hl * 2 > 160 && pb.hl * 2 < 210 && pb.hw * 2 > 55 && pb.hw * 2 < 80, `pool ${(pb.hl * 2).toFixed(0)} x ${(pb.hw * 2).toFixed(0)} m`);
  assert.match(hinnom.pool.dam.road, /Hebron/);
  // The valley runs from the pool to the Kidron (east).
  const line = hinnom.valley.line;
  assert.ok(line[line.length - 1] > line[1] + 0.008, 'valley line ends east of its start');
  assert.ok(hinnom.lowRise.some((a) => a.name === 'Yemin Moshe' && a.shops === false && a.tileRoofMaxArea > 450));
  assert.ok(hinnom.lowRise.some((a) => a.name === 'Mount Zion' && a.approximate));
});

test('hinnom terrain: the valley falls ~110 m to the Kidron, far below the Old City; the pool is sunk below the dam road', () => {
  const line = hinnom.valley.line;
  const top = hAt(line[0], line[1]), bottom = hAt(line[line.length - 2], line[line.length - 1]);
  assert.ok(top > 715 && top < 740, `valley head ${top.toFixed(0)} m`);
  assert.ok(bottom < 640, `valley mouth ${bottom.toFixed(0)} m`);
  // Descends all the way (allowing for DEM wobble on a flat stretch).
  let prev = Infinity;
  for (let i = 0; i < line.length; i += 2) {
    const h = hAt(line[i], line[i + 1]);
    assert.ok(h < prev + 2, `valley climbs at point ${i / 2}`);
    prev = h;
  }
  // Mid-valley floor vs Jaffa Gate and Mount Zion (Dormition).
  const mid = hAt(line[10], line[11]);
  assert.ok(hAt(31.7767, 35.228) - mid > 60 && hAt(31.7719, 35.2289) - mid > 60);
  // Pool floors (patches) and the road on the dam above the stage.
  const [north, south] = hinnom.patches;
  assert.equal(north.elevation, ELEVATION.poolNorth);
  assert.equal(south.elevation, ELEVATION.poolSouth);
  const pc = (ring) => { let a = 0, b = 0; for (let i = 0; i < ring.length; i += 2) { a += ring[i]; b += ring[i + 1]; } return [a / (ring.length / 2), b / (ring.length / 2)]; };
  assert.equal(hAt(...pc(south.rings[0])), ELEVATION.poolSouth);
  assert.equal(hAt(...pc(north.rings[0])), ELEVATION.poolNorth);
  const d = hinnom.pool.dam.line;
  const road = hAt(d[4], d[5]);
  assert.ok(road - ELEVATION.poolSouth > 5, `dam road ${road.toFixed(1)} m, ${(road - ELEVATION.poolSouth).toFixed(1)} m above the stage`);
});

test('hinnom slopes mask: packed bits round-trip, and no open cell lies in a replaced building or the pool', () => {
  const bits = Array.from({ length: 77 }, (_, i) => (i * 7) % 3 === 0);
  assert.deepEqual(unpackBits(packBits(bits), 77).map(Boolean), bits);
  assert.deepEqual(convexHull([0, 0, 0, 2, 2, 2, 2, 0, 1, 1]).length, 8);
  const S = hinnom.slopes;
  const cells = unpackBits(S.bits, S.cols * S.rows);
  assert.equal(cells.filter(Boolean).length, S.free);
  assert.ok(S.free > 1500, `${S.free} open cells`);
  const o = at(S.origin.lat, S.origin.lon);
  const blocked = [hinnom.pool.ring, ...hinnom.mishkenot.map((m) => m.ring)].map((r) => [projection.projectFlat(r)]);
  for (let r = 0; r < S.rows; r++) {
    for (let c = 0; c < S.cols; c++) {
      if (!cells[r * S.cols + c]) continue;
      const x = o.x + (c + 0.5) * S.cell, z = o.z + (r + 0.5) * S.cell;
      for (const rings of blocked) assert.ok(!pointInRings(rings, x, z), `open cell ${c},${r} inside a blocked outline`);
    }
  }
});

test('hinnom geometry: one stone mesh plus two tree instances, within budget, finite, and solid where it should be', () => {
  const meshes = layer.group.children;
  assert.equal(meshes.filter((m) => !m.isInstancedMesh).length, 1, 'one stone mesh (one draw call per pass)');
  assert.ok(meshes.filter((m) => m.isInstancedMesh).length <= 2);
  const stone = meshes.find((m) => !m.isInstancedMesh);
  const pos = stone.geometry.getAttribute('position');
  assert.ok(pos.count / 3 < 80000, `${pos.count / 3} stone triangles`);
  for (const v of pos.array) assert.ok(Number.isFinite(v));
  assert.ok(layer.stats.olives > 300 && layer.stats.olives < 1200, `${layer.stats.olives} olives`);
  assert.ok(layer.stats.terraceSegments > 1000);
  assert.equal(layer.stats.mishkenot, 2);
  // Mishkenot: solid in the middle of the long row at head height; the windmill's tower too.
  const long = orientedBox(projection.projectFlat(hinnom.mishkenot[0].ring));
  assert.ok(solidAt(long.cx, terrain.heightAt(long.cx, long.cz) + 2, long.cz));
  const mill = at(hinnom.windmill.lat, hinnom.windmill.lon);
  assert.ok(solidAt(mill.x, terrain.heightAt(mill.x, mill.z) + 6, mill.z));
  // The seating: the top rows reach the level of the pool's north floor.
  const tiers = collision.boxes.filter((b) => b?.ref === 'sultans-pool-tiers');
  assert.ok(tiers.length > 10);
  const top = Math.max(...tiers.map((b) => b.maxY));
  assert.ok(Math.abs(ASL(top) - ELEVATION.poolNorth) < 0.3, `top tier at ${ASL(top).toFixed(2)} m`);
  assert.ok(layer.stats.pool.rows > 40);
});

test('archOutline: a convex, symmetric pointed arch', () => {
  const pts = archOutline(1.2, 0, 2, 6);
  const apex = pts.reduce((a, p) => (p[1] > a[1] ? p : a));
  assert.ok(Math.abs(apex[0] - 0.6) < 1e-9);
  assert.ok(apex[1] > 2.5 && apex[1] < 3.2);
  for (const [s, y] of pts) {
    const mirror = pts.find(([s2, y2]) => Math.abs(s2 - (1.2 - s)) < 1e-9 && Math.abs(y2 - y) < 1e-9);
    assert.ok(mirror, `no mirror for ${s},${y}`);
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
    assert.ok((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) >= -1e-9, 'convex (counter-clockwise)');
  }
});

test('hinnom city options: Yemin Moshe houses are 2-3 storeys with tile roofs; the replaced buildings are gone', () => {
  const merged = { buildings: [], roads: [], roadAreas: [], parks: [], trees: [], places: [] };
  for (const t of ['osm_3_1', 'osm_3_0']) merged.buildings.push(...read(`../public/data/tiles/${t}.json`).buildings);
  const chunk = generateCityChunk(merged, { projection, terrain, seed: 't', id: 'ym', options: { excludeBuildings: hinnom.replaces, lowRiseAreas: hinnom.lowRise } });
  const ym = [projection.projectFlat(hinnom.yeminMoshe.ring)];
  const inside = chunk.buildings.filter((b) => pointInRings(ym, b.centroid.x, b.centroid.z) && b.heightSource === 'default');
  assert.ok(inside.length > 10);
  for (const b of inside) assert.ok(b.floors >= 1 && b.floors <= 3, `${b.id}: ${b.floors} floors`);
  // Blocks mapped with a hipped roof get one, even the large row-house blocks (> 450 m²).
  const hipped = inside.filter((b) => merged.buildings.find((s) => `OSM-${s.id}` === b.id)?.tags?.['roof:shape'] === 'hipped');
  assert.ok(hipped.filter((b) => b.roof).length >= hipped.length * 0.6, `${hipped.filter((b) => b.roof).length}/${hipped.length} tile roofs`);
  assert.ok(hipped.some((b) => b.roof && b.area > 450), 'a large block with a tile roof');
  for (const id of hinnom.replaces) assert.ok(!chunk.buildings.some((b) => b.osmId === id), `${id} still generated`);
  assert.ok(footprintArea([projection.projectFlat(hinnom.mishkenot[0].ring)]) > 900);
  assert.ok(distanceToEdges(ym, 0, 0) >= 0);
});
