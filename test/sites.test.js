import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { createProjection } from '../src/city/geo.js';
import { createTerrain } from '../src/city/terrain.js';
import { CityCollisionWorld } from '../src/city/CityCollision.js';
import { generateCityChunk, resolveHeight, FACADE_STYLES } from '../src/city/CityGenerator.js';
import { generateAwnings, createAwningGeometry } from '../src/city/Awnings.js';
import { createStreetPropGeometries } from '../src/city/StreetProps.js';
import { RoadNetwork } from '../src/city/RoadNetwork.js';
import { PedestrianSystem } from '../src/city/PedestrianSystem.js';
import { buildSites } from '../src/city/landmarks/sites.js';
import { createStallKit } from '../src/city/landmarks/stalls.js';
import { pointInRings, orientedBox } from '../src/city/footprint.js';

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));
const manifest = read('../public/data/tiles/manifest.json');
const sites = read('../public/data/sites.json');
const landmarks = read('../public/data/landmarks.json');
const hinnom = read('../public/data/hinnom.json');
const dem = { ...read('../public/data/tiles/dem_points.json'), patches: [...landmarks.patches, ...hinnom.patches] };
const projection = createProjection(manifest.worldBBox);
const terrain = createTerrain(dem, projection);
const at = (lat, lon) => projection.project(lat, lon);

const collision = new CityCollisionWorld({ cellSize: 32, groundHeightAt: terrain.heightAt });
const pg = createStreetPropGeometries();
const layer = buildSites(sites, {
  projection, terrain, collision, uniforms: { uNight: { value: 0 } }, landmarks,
  props: { material: new THREE.MeshStandardMaterial(), olive: pg.olive, cypress: pg.cypress, awningGeometry: createAwningGeometry(), awningStriped: new THREE.MeshStandardMaterial(), awningSolid: new THREE.MeshStandardMaterial() },
});
const solidAt = (x, y, z, r = 0.2) => collision.queryAABB(x - r, y - r, z - r, x + r, y + r, z + r).length > 0;

test('sites data: the whole world is tiled (the market no longer loads from the legacy file)', () => {
  const ids = new Set(manifest.tiles.map((t) => t.id));
  for (let i = 0; i < 8; i++) for (let j = 0; j < 5; j++) assert.ok(ids.has(`${i}_${j}`), `tile ${i}_${j}`);
  const mk = at(31.7847, 35.2127), b = manifest.grid;
  const i = Math.floor((31.7847 - b.south) / b.dLat), j = Math.floor((35.2127 - b.west) / b.dLon);
  assert.ok(ids.has(`${j}_${i}`), 'the market is in a tile');
  assert.ok(Number.isFinite(mk.x));
});

test('sites data: Mahane Yehuda between its two streets, the planned towers excluded', () => {
  const m = sites.market;
  assert.ok(m, 'market');
  assert.equal(m.block.id, 'w44123755');
  assert.ok(sites.replaces.includes('w44123755'));
  // The unbuilt 30-storey towers on the Etz Haim site are excluded, with the reason.
  for (const id of ['w1261829352', 'w1261829353']) {
    assert.ok(sites.replaces.includes(id));
    assert.match(sites.excludes.find((e) => e.id === id).reason, /under construction/);
  }
  assert.ok(m.blocks.length >= 5, `${m.blocks.length} shop blocks`);
  assert.ok(m.alleys.length >= 5, `${m.alleys.length} alleys`);
  // Every shop block lies between the two streets, clear of both walkways.
  const W = projection.projectFlat(m.openStreet.line), E = projection.projectFlat(m.coveredStreet.line);
  const near = (line, x, z) => { let d = Infinity; for (let i = 0; i + 3 < line.length; i += 2) { const ax = line[i], az = line[i + 1], bx = line[i + 2], bz = line[i + 3]; const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)); d = Math.min(d, Math.hypot(x - ax - dx * t, z - az - dz * t)); } return d; };
  for (const b of m.blocks) {
    const r = projection.projectFlat(b.ring);
    for (let i = 0; i < r.length; i += 2) {
      assert.ok(near(W, r[i], r[i + 1]) > m.openStreet.half - 0.3, 'block corner on the open street');
      assert.ok(near(E, r[i], r[i + 1]) > m.coveredStreet.half - 0.3, 'block corner on the covered street');
    }
  }
  assert.ok(m.openStreet.frontage.length > 40 && m.coveredStreet.frontage.length > 40);
  assert.ok(m.squares.some((s) => s.kind === 'iraqi' && s.spots.length >= 6));
  const mkArea = sites.lowRise.find((a) => a.name === 'Mahane Yehuda Market');
  assert.equal(mkArea.shops, 'all');
});

test('sites data: souks by name, infill only inside the walls and off the streets, the riwaq', () => {
  const names = new Set(sites.souks.map((s) => s.name));
  for (const n of ['David Street', 'Suq al-Lahhamin', 'Suq al-Qattanin', 'Christian Quarter Road', 'The Cardo']) assert.ok(names.has(n), n);
  assert.ok(sites.souks.filter((s) => s.covered).length >= 5);
  const b = sites.infill.boxes;
  assert.ok(b.length / 4 > 500 && b.length / 4 < 2500, `${b.length / 4} infill boxes`);
  const tm = [projection.projectFlat(landmarks.templeMount.outer[0])];
  const hull = [projection.projectFlat(landmarks.oldCity.ring)];
  for (let i = 0; i < b.length; i += 4) {
    const p = at((b[i] + b[i + 2]) / 2, (b[i + 1] + b[i + 3]) / 2);
    assert.ok(pointInRings(hull, p.x, p.z), 'infill inside the Old City');
    assert.ok(!pointInRings(tm, p.x, p.z), 'no infill on the Temple Mount');
  }
  // No infill box on a mapped Old City souk.
  for (const s of sites.souks) {
    const l = projection.projectFlat(s.line);
    for (let k = 0; k + 1 < l.length; k += 2) {
      for (let i = 0; i < b.length; i += 4) {
        const p0 = at(b[i], b[i + 1]), p1 = at(b[i + 2], b[i + 3]);
        const inside = l[k] > Math.min(p0.x, p1.x) + 0.5 && l[k] < Math.max(p0.x, p1.x) - 0.5 && l[k + 1] > Math.min(p0.z, p1.z) + 0.5 && l[k + 1] < Math.max(p0.z, p1.z) - 0.5;
        assert.ok(!inside, `infill on ${s.name}`);
      }
    }
  }
  assert.ok(sites.riwaq.length >= 3);
  for (const r of sites.riwaq) assert.ok(r.n[0] < -0.7 || r.n[1] < -0.7, 'riwaq on the west or north side');
});

test('sites geometry: finite, within budget, few draw calls, solid where it should be', () => {
  const st = layer.stats;
  let tris = 0, bad = 0;
  layer.group.traverse((o) => {
    const p = o.geometry?.getAttribute('position');
    if (!p) return;
    for (const v of p.array) if (!Number.isFinite(v)) bad++;
    tris += (p.count / 3) * (o.isInstancedMesh ? o.count : 1);
  });
  assert.equal(bad, 0);
  assert.ok(tris < 900000, `${tris} triangles`);
  assert.ok(layer.group.children.length <= 40, `${layer.group.children.length} meshes`);
  assert.ok(st.stalls > 1000, `${st.stalls} stalls`);
  assert.ok(st.goods > 20000, `${st.goods} goods`);
  assert.ok(st.hurva && st.ymca && st.kingDavid);
  assert.ok(st.esplanade.trees > 200 && st.esplanade.earthCells > 1000 && st.esplanade.riwaqBays > 20 && st.esplanade.letters > 500);
  // The Hurva, the YMCA tower and the King David Hotel are solid; the Hurva is ~25 m tall.
  const hc = orientedBox(projection.projectFlat(sites.hurva.ring));
  assert.ok(solidAt(hc.cx, terrain.heightAt(hc.cx, hc.cz) + 12, hc.cz));
  const top = Math.max(...collision.boxes.filter((b) => b?.ref === 'hurva').map((b) => b.maxY)) - terrain.heightAt(hc.cx, hc.cz);
  assert.ok(top > 20 && top < 30, `Hurva ${top.toFixed(1)} m`);
  assert.ok(collision.boxes.some((b) => b?.ref === 'ymca-tower' && b.maxY - b.minY > 40));
  // Market stalls are solid (the aisle between them is not).
  assert.ok(collision.boxes.filter((b) => b?.ref === 'market-stall').length > 300);
  const cs = projection.projectFlat(sites.market.coveredStreet.line);
  const k = Math.floor(cs.length / 4) * 2;
  assert.ok(!solidAt(cs[k], terrain.heightAt(cs[k], cs[k + 1]) + 1.2, cs[k + 1], 0.3), 'the covered street is walkable');
  assert.ok(layer.busyZones.length >= 3);
});

test('stall kit: every kind yields goods; instanced parts', () => {
  const kit = createStallKit();
  for (const kind of ['produce', 'nuts', 'spice', 'bakery', 'halva', 'butcher', 'food', 'fabric', 'souvenir']) {
    const before = kit.count();
    kit.stall(0, 0, 0, 0, kind, { seed: kind.length });
    assert.ok(kit.count() - before >= 6, `${kind}: ${kit.count() - before} parts`);
  }
  const meshes = kit.build(new THREE.MeshStandardMaterial());
  assert.ok(meshes.length >= 6 && meshes.every((m) => m.isInstancedMesh));
});

test('booths are one storey without a shopfront; facade styles by area; no awnings in the Old City or in mid-air', () => {
  assert.equal(resolveHeight({ building: 'yes' }, 32, 'w1').floors, 1);
  assert.ok(resolveHeight({ building: 'yes' }, 120, 'w1').floors >= 2);
  const booths = ['w1551186905', 'w1551186906'];
  const merged = { buildings: [], roads: [], roadAreas: [], parks: [], trees: [], places: [] };
  for (const t of ['osm_4_3', 'osm_1_4', 'osm_1_3']) { const d = read(`../public/data/tiles/${t}.json`); merged.buildings.push(...d.buildings); merged.roads.push(...d.roads); }
  const areas = [{ ...landmarks.oldCity, facade: 'old' }, ...sites.lowRise];
  const chunk = generateCityChunk(merged, { projection, terrain, seed: 't', id: 's', options: { excludeBuildings: sites.replaces, lowRiseAreas: areas } });
  for (const id of booths) {
    const b = chunk.buildings.find((x) => x.osmId === id);
    assert.ok(b, id);
    assert.equal(b.floors, 1);
    assert.equal(b.facade[2] % 2, 0, `${id} has no shopfront`);
  }
  const style = (b) => Math.floor(b.facade[2] / 2 + 0.01);
  const old = [projection.projectFlat(landmarks.oldCity.ring)];
  const inOld = chunk.buildings.filter((b) => b.kind === 'building' && pointInRings(old, b.centroid.x, b.centroid.z));
  assert.ok(inOld.length > 20 && inOld.every((b) => style(b) === FACADE_STYLES.old));
  const mkRing = [projection.projectFlat(sites.lowRise.find((a) => a.name === 'Mahane Yehuda Market').ring)];
  const mk = chunk.buildings.filter((b) => pointInRings(mkRing, b.centroid.x, b.centroid.z) && b.kind === 'building');
  assert.ok(mk.length > 10 && mk.every((b) => style(b) === FACADE_STYLES.historic));
  assert.ok(mk.filter((b) => b.facade[2] % 2 === 1).length >= mk.length * 0.8, 'market streets: shops everywhere');
  // Awnings: none on the Old City's souk shops, none above a much lower sidewalk.
  const aw = generateAwnings({ buildings: chunk.buildings, roadsAt: () => [{}], ground: terrain.heightAt, rng: { chance: () => true, next: () => 0.5, pick: (a) => a[0] } });
  assert.ok(aw.length > 0);
  for (const a of aw) {
    assert.ok(!pointInRings(old, a.x, a.z), 'awning in the Old City');
    assert.ok(a.y - terrain.heightAt(a.x, a.z) < 2.62 + 0.8 + 1.5, 'awning hangs in the air');
  }
  // The planned towers are not generated.
  for (const id of ['w1261829352', 'w1261829353']) assert.ok(!chunk.buildings.some((b) => b.osmId === id));
});

test('pedestrians: a busy zone (the market) fills with people', () => {
  const merged = { buildings: [], roads: [], roadAreas: [], parks: [], trees: [], places: [] };
  for (const t of ['osm_1_3', 'osm_1_4', 'osm_2_3', 'osm_2_4']) merged.roads.push(...read(`../public/data/tiles/${t}.json`).roads);
  const chunk = generateCityChunk(merged, { projection, terrain, seed: 't', id: 'p' });
  const net = RoadNetwork.fromRoads(chunk.roads);
  const c = at(31.7847, 35.2128);
  const run = (zones) => {
    const sys = new PedestrianSystem({ collision: new CityCollisionWorld({ groundHeightAt: terrain.heightAt }), options: { seed: 'p' } });
    sys.setNetwork(net);
    sys.setBusyZones(zones);
    for (let i = 0; i < 200; i++) sys.update(1 / 30, c, null);
    return sys.count;
  };
  const plain = run([]), busy = run(layer.busyZones);
  assert.ok(busy > plain * 2, `${busy} vs ${plain}`);
});
