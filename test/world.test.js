import { test } from 'node:test';
import assert from 'node:assert/strict';

import { convertOverpass } from '../scripts/fetch_jerusalem.js';
import { createProjection } from '../src/city/geo.js';
import { ringCentroid } from '../src/city/footprint.js';
import { gridCellBBox, gridCellOf, ringVertexAverage, ownedRuns } from '../src/city/tiling.js';
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

/** Splits the synthetic city into tile files with the fetch pipeline's own rules (src/city/tiling.js). */
function makeTiles(osm = FULL) {
  const tiles = new Map();
  const tile = (i, j) => {
    const id = `${i}_${j}`;
    if (!tiles.has(id)) tiles.set(id, { ...osm, bbox: gridCellBBox(GRID, i, j), buildings: [], roads: [], roadAreas: [], parks: [], trees: [], places: [] });
    return tiles.get(id);
  };
  const byRing = (list, item) => {
    const c = ringVertexAverage(item.rings[0]);
    const { i, j } = gridCellOf(GRID, c.lat, c.lon);
    tile(i, j)[list].push(item);
  };
  for (const b of osm.buildings) byRing('buildings', b);
  for (const pk of osm.parks) byRing('parks', pk);
  for (const a of osm.roadAreas) byRing('roadAreas', a);
  for (const r of osm.roads) {
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 3; i++) {
        const runs = ownedRuns(r.points, gridCellBBox(GRID, i, j));
        runs.forEach((points, k) => tile(i, j).roads.push({ ...r, id: runs.length > 1 ? `${r.id}.${k}` : r.id, points }));
      }
    }
  }
  return tiles;
}
const TILES = makeTiles();

function makeWorld({ tiles = [], legacy = false, failing = [], options = {}, source = FULL, tileData = TILES } = {}) {
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
    return tileData.get(id) ?? { ...source, buildings: [], roads: [], roadAreas: [], parks: [], trees: [] };
  };
  const world = new TileWorld({ manifest, dem: DEM, legacy: legacy ? source : null, loadTile, options });
  world.loads = loads;
  return world;
}

/** The TileWorld constructor arguments makeWorld would use (for custom backends). */
function makeWorldArgs(opts) {
  const w = makeWorld(opts);
  return { manifest: w.manifest, dem: DEM, legacy: opts.legacy ? (opts.source ?? FULL) : null, loadTile: w.loadTile, options: opts.options ?? {} };
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
    for (const r of cell.data?.roads ?? []) if (r.points) for (let k = 0; k + 3 < r.points.length; k += 2) roads.push(r.points.slice(k, k + 4).map((v) => v.toFixed(3)).join(','));
  }
  assert.equal(new Set(buildings).size, buildings.length, 'no building twice');
  assert.equal(new Set(roads).size, roads.length, 'no road segment twice');
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

// --- Ownership on cell borders -------------------------------------------------------------------

const B_LAT = gridCellBBox(GRID, 0, 1).south; // border between rows j = 0 and j = 1
const B_LON = gridCellBBox(GRID, 1, 0).west; // border between columns i = 0 and i = 1

/**
 * A building straddling the row border: its AREA centroid is south of the border, but its
 * outer ring has many (collinear) vertices on the north edge, so its VERTEX AVERAGE (the
 * pipeline's rule) is north of it.
 */
function borderBuilding() {
  const L = GRID.west + 1.5 * GRID.dLon, s = B_LAT - 0.0004, n = B_LAT + 0.0001;
  const ring = [s, L, s, L + 0.0004];
  for (let k = 0; k <= 8; k++) ring.push(n, L + 0.0004 - k * 0.00005); // north edge, east to west
  return { id: 'w900001', tags: { building: 'yes' }, rings: [ring] };
}

test('ownership: a building on a border goes where the pipeline puts it (vertex average)', async () => {
  const b = borderBuilding();
  const proj = createProjection(WORLD);
  const avg = ringVertexAverage(b.rings[0]);
  const area = proj.unproject(ringCentroid(proj.projectFlat(b.rings[0])).x, ringCentroid(proj.projectFlat(b.rings[0])).z);
  assert.ok(avg.lat >= B_LAT && area.lat < B_LAT, 'the two centroids disagree: vertex average north, area centroid south');
  const legacy = { ...FULL, buildings: [b], roads: [], roadAreas: [], parks: [], trees: [] };
  const owner = makeTiles(legacy); // how the pipeline would tile it
  assert.equal([...owner.entries()].find(([, t]) => t.buildings.length)[0], '1_1');

  // North cell is a tile: the legacy copy must be skipped (the tile has it).
  const w1 = makeWorld({ tiles: ['1_1'], legacy: true, source: legacy, tileData: owner });
  assert.equal(w1.cells.get('1_0').legacyOsm?.buildings.length ?? 0, 0, 'not in the south legacy cell');
  assert.equal(w1.legacy.skipped, 1);
  await w1.settle({ x: 0, z: 0 });
  const found = [...w1.cells.values()].flatMap((c) => c.data?.buildings ?? []).filter((x) => x.osmId === b.id);
  assert.equal(found.length, 1, 'shown exactly once (from the tile)');
  assert.equal(found[0].id, `OSM-${b.id}`);
  assert.equal(w1.cells.get('1_1').source, 'tile');

  // South cell is a tile instead: the legacy copy stays in the north cell (the tile doesn't have it).
  const w2 = makeWorld({ tiles: ['1_0'], legacy: true, source: legacy, tileData: owner });
  assert.equal(w2.cells.get('1_1').legacyOsm.buildings.length, 1);
});

test('ownership: a legacy road crossing into a tile cell is cut on the border, no gap, no double', async () => {
  const lat = GRID.south + 0.3 * GRID.dLat;
  const road = { id: 'w900002', highway: 'residential', name: 'Border St', nameEn: 'Border Street', points: [lat, GRID.west + 0.4 * GRID.dLon, lat + 0.0003, GRID.west + 1.6 * GRID.dLon] };
  const legacy = { ...FULL, buildings: [], roads: [road], roadAreas: [], parks: [], trees: [] };
  const owner = makeTiles(legacy);
  const west = owner.get('0_0').roads[0].points, east = owner.get('1_0').roads[0].points;
  assert.deepEqual(west.slice(-2), east.slice(0, 2), 'the pipeline cuts at a shared border vertex');
  assert.equal(west.at(-1), B_LON);

  // East cell is a tile: legacy keeps only the western piece, ending exactly on the border.
  const w = makeWorld({ tiles: ['1_0'], legacy: true, source: legacy, tileData: owner });
  const pieces = w.cells.get('0_0').legacyOsm.roads;
  assert.equal(pieces.length, 1);
  assert.deepEqual(pieces[0].points, west, 'same piece as the pipeline would make');
  assert.equal(w.cells.get('1_0').legacyOsm, null);
  await w.settle({ x: 0, z: 0 });
  const a = w.cells.get('0_0').data.roads[0].points, b = w.cells.get('1_0').data.roads[0].points;
  assert.deepEqual([a.at(-2), a.at(-1)], [b[0], b[1]], 'legacy piece and tile piece meet at one vertex');

  // No tile at all: both legacy pieces, meeting on the border.
  const w0 = makeWorld({ legacy: true, source: legacy });
  assert.deepEqual(w0.cells.get('0_0').legacyOsm.roads[0].points, west);
  assert.deepEqual(w0.cells.get('1_0').legacyOsm.roads[0].points, east);
});

// --- Worker path and merged terrain --------------------------------------------------------------

import { chunkLookup, buildChunkParts, packChunkParts, unpackChunkParts } from '../src/city/CityGenerator.js';

/** A backend that behaves like WorkerCellBackend: data and geometry cross a structured clone. */
function cloneBackend(world) {
  const chunks = new Map();
  return {
    async generate(cell) {
      const osm = cell.source === 'tile' ? await world.loadTile(cell.tile.file) : cell.legacyOsm;
      if (!osm) return null;
      const chunk = world.generateCell(cell, structuredClone(osm));
      chunks.set(cell.id, chunk);
      return structuredClone(chunkLookup(chunk));
    },
    async build(cell, level) {
      const { parts } = packChunkParts(buildChunkParts(chunks.get(cell.id), { terrain: world.terrain, level }));
      return unpackChunkParts(structuredClone(parts));
    },
  };
}

test('worker path: light lookup data + transferred geometry give the same world', async () => {
  const opts = { tiles: ['0_0', '1_0'], legacy: true, options: EVERYTHING_NEAR };
  const local = makeWorld(opts);
  const viaClone = new TileWorld({ ...makeWorldArgs(opts), backend: cloneBackend });
  const s1 = await local.findSpawn(), s2 = await viaClone.findSpawn();
  assert.deepEqual(s2, s1, 'same spawn');
  await local.settle({ x: 0, z: 0 });
  await viaClone.settle({ x: 0, z: 0 });
  assert.equal(viaClone.collision.count, local.collision.count, 'same colliders');
  assert.deepEqual(viaClone.findRoadsAt(s1.x, s1.z).map((r) => r.id), local.findRoadsAt(s1.x, s1.z).map((r) => r.id));
  const tris = (w) => {
    let n = 0;
    w.group.traverse((o) => { if (o.isMesh && o.parent?.name?.startsWith('Chunk')) n += (o.geometry.index?.count ?? o.geometry.getAttribute('position').count) / 3 * (o.isInstancedMesh ? o.count : 1); });
    return n;
  };
  assert.ok(tris(local) > 0);
  assert.equal(tris(viaClone), tris(local), 'same geometry');
  const b = viaClone.cells.get('1_0').data.buildings[0];
  assert.equal(viaClone.buildingById(b.id).heightSource, local.buildingById(b.id).heightSource);
});

test('terrain: far and unloaded cells share one merged mesh; near and medium get their own', async () => {
  const world = makeWorld({ tiles: ['0_0'], options: { nearDistance: 150, mediumDistance: 450, farDistance: 700, hysteresis: 50 } });
  await world.settle(center(world.cells.get('0_0')));
  const own = world.groundGroup.children.filter((o) => o.name.startsWith('Terrain['));
  const fine = [...world.cells.values()].filter((c) => c.level === 'near' || c.level === 'medium');
  assert.equal(own.length, fine.length, 'one mesh per near / medium cell');
  assert.ok(fine.length < world.cells.size, 'some cells are far / unloaded');
  assert.ok(world.farGround.visible && world.farGround.geometry.getAttribute('position').count > 0, 'merged coarse mesh');
  // Everything far: a single merged terrain mesh.
  await world.settle({ x: 1e5, z: 1e5 });
  assert.equal(world.groundGroup.children.filter((o) => o.name.startsWith('Terrain[')).length, 0);
});
