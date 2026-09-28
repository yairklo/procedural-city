import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertOverpass } from '../scripts/fetch_jerusalem.js';
import { TILE_GRID, WORLD_BBOX, PHASES, tileBBox, convertTile, ownedRuns } from '../scripts/fetch_tiles.js';
import { syntheticOverpass } from './helpers/synthetic.js';

// Tiles that cover the synthetic fixture (centred on the original bbox) with room to spare.
const TILES = [];
for (let j = 0; j <= 6; j++) for (let i = -1; i <= 5; i++) TILES.push([i, j]);

const metersLen = (pts) => {
  let len = 0;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const dz = (pts[k + 2] - pts[k]) * 110900;
    const dx = (pts[k + 3] - pts[k + 1]) * 94600;
    len += Math.hypot(dx, dz);
  }
  return len;
};

test('tiles: grid is contiguous and phases fit inside the world bbox', () => {
  const a = tileBBox(0, 0), right = tileBBox(1, 0), up = tileBBox(0, 1);
  assert.equal(a.east, right.west);
  assert.equal(a.north, up.south);
  for (const p of Object.values(PHASES)) {
    const lo = tileBBox(p.i[0], p.j[0]), hi = tileBBox(p.i[1], p.j[1]);
    assert.ok(lo.south >= WORLD_BBOX.south - 1e-9 && lo.west >= WORLD_BBOX.west - 1e-9);
    assert.ok(hi.north <= WORLD_BBOX.north + 1e-9 && hi.east <= WORLD_BBOX.east + 1e-9);
  }
  assert.equal(TILE_GRID.south, WORLD_BBOX.south);
  assert.equal(TILE_GRID.west, WORLD_BBOX.west);
});

test('tiles: a segment crossing several tiles is cut exactly at the borders', () => {
  const b0 = tileBBox(0, 0), b2 = tileBBox(2, 0);
  const lat = (b0.south + b0.north) / 2;
  const line = [lat, b0.west + 0.001, lat, b2.east - 0.001]; // one segment through tiles 0, 1, 2
  const pieces = [0, 1, 2].map((i) => ownedRuns(line, tileBBox(i, 0)));
  for (const runs of pieces) assert.equal(runs.length, 1);
  assert.equal(pieces[0][0][3], tileBBox(0, 0).east); // ends on the border...
  assert.equal(pieces[1][0][1], tileBBox(1, 0).west); // ...where the next piece starts
  const total = pieces.reduce((s, r) => s + metersLen(r[0]), 0);
  assert.ok(Math.abs(total - metersLen(line)) < 0.05, `length ${total} vs ${metersLen(line)}`);
});

test('tiles: every building, park and tree lands in exactly one tile; roads keep their length', () => {
  const raw = syntheticOverpass();
  const whole = convertOverpass(raw, { south: 31.7, west: 35.1, north: 31.9, east: 35.3 });

  const buildingOwner = new Map();
  let trees = 0, roadLen = 0;
  for (const [i, j] of TILES) {
    const { doc } = convertTile(raw, i, j);
    const b = doc.bbox;
    for (const x of doc.buildings) {
      assert.ok(!buildingOwner.has(x.id), `building ${x.id} in two tiles`);
      buildingOwner.set(x.id, doc.tile.id);
    }
    trees += doc.trees.length / 2;
    for (const road of doc.roads) {
      for (let k = 0; k < road.points.length; k += 2) {
        const [la, lo] = [road.points[k], road.points[k + 1]];
        assert.ok(la >= b.south - 1e-7 && la <= b.north + 1e-7 && lo >= b.west - 1e-7 && lo <= b.east + 1e-7, `road ${road.id} leaves tile ${doc.tile.id}`);
      }
      roadLen += metersLen(road.points);
    }
  }
  assert.equal(buildingOwner.size, whole.buildings.length);
  assert.equal(trees, whole.trees.length / 2);
  const wholeLen = whole.roads.reduce((s, r) => s + metersLen(r.points), 0);
  assert.ok(Math.abs(roadLen - wholeLen) < 0.5, `road length ${roadLen.toFixed(2)} vs ${wholeLen.toFixed(2)} m`);
});
