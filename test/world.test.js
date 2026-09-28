import { test } from 'node:test';
import assert from 'node:assert/strict';

import { convertOverpass } from '../scripts/fetch_jerusalem.js';
import { createProjection } from '../src/city/geo.js';
import { ringCentroid } from '../src/city/footprint.js';
import { polylineMidpoint } from '../src/city/CityGenerator.js';
import { TileWorld } from '../src/world/TileWorld.js';
import { PlayerController } from '../src/player/PlayerController.js';
import { syntheticOverpass } from './helpers/synthetic.js';

// A 3 x 2 cell world over the synthetic city (which is centred in this box).
const WORLD = { south: 31.778, west: 35.21, north: 31.788, east: 35.225 };
const GRID = { south: WORLD.south, west: WORLD.west, dLat: 0.005, dLon: 0.005 };
const FULL = convertOverpass(syntheticOverpass());

/** Synthetic DEM control points covering the world with a 2-pixel margin: a slope plus a hill. */
function syntheticDem() {
  const step = 0.0008333333333333333;
  const lattice = { north: WORLD.north + 2 * step, west: WORLD.west - 2 * step, stepLatDeg: step, stepLonDeg: step };
  const W = Math.ceil((WORLD.east - WORLD.west) / step) + 5, H = Math.ceil((WORLD.north - WORLD.south) / step) + 5;
  const values = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) values.push(760 + c * 0.9 + r * 0.4 + 15 * Math.exp(-(((c - W / 2) / 6) ** 2 + ((r - H / 2) / 5) ** 2)));
  return { format: 'dem-points-v1', attribution: 'Synthetic DEM', bbox: { ...WORLD }, lattice, width: W, height: H, values };
}
const DEM = syntheticDem();

/** Splits the synthetic city into tile files the way the fetch pipeline does (centroid / midpoint per cell). */
function makeTiles() {
  const proj = createProjection(WORLD);
  const cellOf = (x, z) => {
    const { lat, lon } = proj.unproject(x, z);
    return `${Math.floor((lon - GRID.west) / GRID.dLon)}_${Math.floor((lat - GRID.south) / GRID.dLat)}`;
  };
  const tiles = new Map();
  const tile = (id) => {
    if (!tiles.has(id)) tiles.set(id, { ...FULL, buildings: [], roads: [], roadAreas: [], parks: [], trees: [], places: [] });
    return tiles.get(id);
  };
  for (const b of FULL.buildings) { const c = ringCentroid(proj.projectFlat(b.rings[0])); tile(cellOf(c.x, c.z)).buildings.push(b); }
  for (const pk of FULL.parks) { const c = ringCentroid(proj.projectFlat(pk.rings[0])); tile(cellOf(c.x, c.z)).parks.push(pk); }
  for (const a of FULL.roadAreas) { const c = ringCentroid(proj.projectFlat(a.rings[0])); tile(cellOf(c.x, c.z)).roadAreas.push(a); }
  for (const r of FULL.roads) { const m = polylineMidpoint(proj.projectFlat(r.points)); tile(cellOf(m.x, m.z)).roads.push(r); }
  return tiles;
}
const TILES = makeTiles();

function makeWorld({ tiles = [], legacy = false, failing = [], options = {} } = {}) {
  const manifest = {
    format: 'tiles-v1',
    attribution: '© OpenStreetMap contributors',
    grid: GRID,
    worldBBox: WORLD,
    places: [],
    tiles: tiles.map((id) => {
      const [i, j] = id.split('_').map(Number);
      return { id, i, j, file: `osm_${id}.json` };
    }),
  };
  const loads = [];
  const loadTile = async (file) => {
    const id = file.slice(4, -5);
    loads.push(id);
    if (failing.includes(id)) throw new Error('HTTP 404');
    return TILES.get(id) ?? { ...FULL, buildings: [], roads: [], roadAreas: [], parks: [], trees: [] };
  };
  const world = new TileWorld({ manifest, dem: DEM, legacy: legacy ? FULL : null, loadTile, options });
  world.loads = loads;
  return world;
}

const center = (cell) => ({ x: (cell.rect.minX + cell.rect.maxX) / 2, z: (cell.rect.minZ + cell.rect.maxZ) / 2 });
const EVERYTHING_NEAR = { nearDistance: 1e5 };

test('projection: fixed origin at the world centre, unchanged by adding tiles or data', async () => {
  const a = makeWorld({ tiles: ['0_0'] });
  const b = makeWorld({ tiles: ['0_0', '1_0', '2_1'], legacy: true });
  assert.deepEqual(a.projection.origin, b.projection.origin);
  assert.deepEqual(a.projection.origin, { lat: (WORLD.south + WORLD.north) / 2, lon: (WORLD.west + WORLD.east) / 2 });
  assert.equal(a.terrain.heightAt(123, -45), b.terrain.heightAt(123, -45));
  // The same tile generates exactly the same geometry in both worlds.
  await a.settle(center(a.cells.get('0_0')));
  await b.settle(center(b.cells.get('0_0')));
  const ba = a.cells.get('0_0').data.buildings, bb = b.cells.get('0_0').data.buildings;
  assert.ok(ba.length > 0);
  assert.deepEqual(ba.map((x) => [x.id, x.centroid, x.height]), bb.map((x) => [x.id, x.centroid, x.height]));
  // Cell rectangles tile the world exactly (shared borders).
  assert.equal(a.cells.get('0_0').rect.maxX, a.cells.get('1_0').rect.minX);
  assert.equal(a.cells.get('0_0').rect.minZ, a.cells.get('0_1').rect.maxZ);
});

test('no duplicates between tiles and legacy data in the overlap', async () => {
  const world = makeWorld({ tiles: ['0_0', '1_0'], legacy: true, options: EVERYTHING_NEAR });
  await world.settle({ x: 0, z: 0 });
  const buildings = [], roads = [];
  for (const cell of world.cells.values()) {
    for (const b of cell.data?.buildings ?? []) buildings.push(b.osmId);
    for (const r of cell.data?.roads ?? []) roads.push(r.id);
  }
  assert.equal(new Set(buildings).size, buildings.length, 'no building twice');
  assert.equal(new Set(roads).size, roads.length, 'no road twice');
  // Every source building appears exactly once (tiles took their cells, legacy the rest).
  assert.deepEqual([...buildings].sort(), FULL.buildings.map((b) => b.id).sort());
  assert.equal(world.cells.get('0_0').source, 'tile');
  assert.equal(world.cells.get('2_0').source, 'legacy');
  assert.ok(world.legacy.skipped > 0, 'legacy features in tile cells were skipped');
  // Colliders: one group per near cell with data, no box registered twice.
  const refs = world.collision.boxes.filter(Boolean).filter((b) => b.kind === 'building').map((b) => `${b.group}:${b.ref}`);
  const byBuilding = new Map();
  for (const r of refs) {
    const [group, ref] = r.split(':');
    if (!byBuilding.has(ref)) byBuilding.set(ref, new Set());
    byBuilding.get(ref).add(group);
  }
  for (const [ref, groups] of byBuilding) assert.equal(groups.size, 1, `${ref} collides from one cell only`);
});

test('missing and broken tiles: terrain only, no crash, the player stands on the ground', async () => {
  const world = makeWorld({ tiles: ['0_0', '1_0'], failing: ['1_0'], options: EVERYTHING_NEAR });
  await world.settle({ x: 0, z: 0 });
  const broken = world.cells.get('1_0'), missing = world.cells.get('2_1');
  assert.equal(broken.failed, true);
  assert.equal(broken.data, null);
  assert.equal(missing.source, 'none');
  assert.equal(missing.level, 'near', 'still streamed (terrain)');
  assert.ok(missing.ground, 'has terrain');
  for (const cell of [broken, missing]) {
    const c = center(cell);
    const y = world.terrain.heightAt(c.x, c.z);
    assert.equal(world.collision.groundHeight(c.x, c.z, y + 1), y);
    const p = new PlayerController(world.collision, { x: c.x, y: y + 3, z: c.z });
    for (let t = 0; t < 2; t += 1 / 60) p.update(1 / 60, { moveY: 1, cameraYaw: 0.4 });
    assert.ok(p.snapshot().grounded, `${cell.id}: player is on the ground`);
    assert.ok(Math.abs(p.position.y - world.terrain.heightAt(p.position.x, p.position.z)) < 1e-6, `${cell.id}: on the terrain`);
  }
  // Adding the tile later needs no code change: a new manifest just includes it.
  const later = makeWorld({ tiles: ['0_0', '1_0', '2_1'], options: EVERYTHING_NEAR });
  await later.settle({ x: 0, z: 0 });
  assert.equal(later.cells.get('2_1').source, 'tile');
  assert.ok(later.loads.includes('2_1'));
});

test('streaming: levels, collision and meshes follow the player distance', async () => {
  const world = makeWorld({ tiles: ['0_0', '1_0', '2_0', '0_1', '1_1', '2_1'], options: { nearDistance: 150, mediumDistance: 450, farDistance: 700, hysteresis: 50 } });
  const a = world.cells.get('0_0'), far = world.cells.get('2_1');
  await world.settle(center(a));
  assert.equal(a.level, 'near');
  assert.ok(world.collision.hasGroup('0_0'), 'near cell has collision');
  assert.ok(a.view && a.view.group.parent === world.group, 'near cell has meshes');
  assert.ok(RANK(far.level) < RANK('near'));
  assert.equal(world.collision.hasGroup(far.id), false, 'no collision outside near cells');
  for (const cell of world.cells.values()) {
    if (cell.level !== 'near') assert.equal(world.collision.hasGroup(cell.id), false, `${cell.id} (${cell.level}) has no colliders`);
  }
  const collidersNear = world.collision.count;
  assert.ok(collidersNear > 0);

  // Walk far away: everything unloads, collision and meshes are freed.
  await world.settle({ x: a.rect.minX - 5000, z: a.rect.minZ - 5000 });
  for (const cell of world.cells.values()) {
    assert.equal(cell.level, 'none');
    assert.equal(cell.view, null);
  }
  assert.equal(world.collision.count, 0);
  assert.equal(world.collision.cells.size, 0, 'spatial hash emptied');

  // Come back: reloads from the cache (no new tile fetches) and collision returns.
  const fetched = world.loads.length;
  await world.settle(center(a));
  assert.equal(a.level, 'near');
  assert.equal(world.collision.count, collidersNear);
  assert.equal(world.loads.length, fetched, 'tile data cached');
});

test('streaming: hysteresis keeps a cell from flickering at the threshold', async () => {
  const world = makeWorld({ tiles: ['0_0'], options: { nearDistance: 150, mediumDistance: 450, farDistance: 700, hysteresis: 50 } });
  const a = world.cells.get('0_0');
  const edge = { x: a.rect.maxX + 120, z: center(a).z };
  await world.settle(edge);
  assert.equal(a.level, 'near');
  await world.settle({ x: a.rect.maxX + 180, z: edge.z }); // past 150 but within 150 + 50
  assert.equal(a.level, 'near');
  await world.settle({ x: a.rect.maxX + 230, z: edge.z });
  assert.equal(a.level, 'medium');
});

test('spawn: on Jaffa Road when the legacy data is loaded, else on a street in a tile', async () => {
  const withLegacy = makeWorld({ tiles: ['0_0'], legacy: true });
  const s = await withLegacy.findSpawn();
  assert.ok(withLegacy.findRoadsAt(s.x, s.z).some((r) => /jaffa/i.test(r.name)), 'on Jaffa Road');
  assert.ok(Math.abs(s.y - withLegacy.terrain.heightAt(s.x, s.z)) < 1e-9);
  assert.equal(withLegacy.collision.queryAABB(s.x - 0.4, s.y + 0.01, s.z - 0.4, s.x + 0.4, s.y + 1.8, s.z + 0.4).length, 0);

  const tilesOnly = makeWorld({ tiles: ['0_0', '1_0'] });
  const t = await tilesOnly.findSpawn();
  const cell = tilesOnly.cellAt(t.x, t.z);
  assert.equal(cell.source, 'tile');
  assert.ok(tilesOnly.findRoadsAt(t.x, t.z).length > 0, 'on a street');
});

function RANK(level) {
  return ['none', 'far', 'medium', 'near'].indexOf(level);
}
