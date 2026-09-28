import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { convertOverpass, stitchRings, JERUSALEM_BBOX } from '../scripts/fetch_jerusalem.js';
import { createProjection } from '../src/city/geo.js';
import { decomposeFootprint, orientRings, pointInRings, distanceToEdges, ringArea } from '../src/city/footprint.js';
import { CityGenerator, resolveHeight, extrudeBuilding, findRoadsAt, DEFAULT_CITY_OPTIONS } from '../src/city/CityGenerator.js';
import { syntheticOverpass } from './helpers/synthetic.js';

const REAL_DATA = fileURLToPath(new URL('../public/data/jerusalem_data.json', import.meta.url));
const STEP = DEFAULT_CITY_OPTIONS.collisionStep;
const PLAYER = { radius: 0.4, height: 1.8, step: 0.45 };

const synthetic = convertOverpass(syntheticOverpass());
const city = new CityGenerator({ osm: synthetic }).create();
const { data, collision } = city;

const rotatedRect = (cx, cz, w, d, angle) => {
  const c = Math.cos(angle), s = Math.sin(angle);
  const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  return pts.flatMap(([u, v]) => [cx + u * c - v * s, cz + u * s + v * c]);
};

test('projection: bbox is centered, ~1.4 km x 1.1 km, and round-trips', () => {
  const p = createProjection(JERUSALEM_BBOX);
  const { bounds } = p;
  assert.ok(Math.abs(bounds.minX + bounds.maxX) < 1e-6 && Math.abs(bounds.minZ + bounds.maxZ) < 1e-6);
  assert.ok(Math.abs(bounds.maxX - bounds.minX - 1422) < 5, `width ${bounds.maxX - bounds.minX}`);
  assert.ok(Math.abs(bounds.maxZ - bounds.minZ - 1109) < 5, `depth ${bounds.maxZ - bounds.minZ}`);
  const north = p.project(JERUSALEM_BBOX.north, p.origin.lon);
  assert.ok(north.z < 0, 'north is -Z');
  const back = p.unproject(123.4, -567.8);
  const again = p.project(back.lat, back.lon);
  assert.ok(Math.hypot(again.x - 123.4, again.z + 567.8) < 1e-6);
});

test('converter: stitches multipolygon rings, keeps holes, clips roads', () => {
  const rings = stitchRings([
    [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }],
    [{ lat: 1, lon: 1 }, { lat: 0, lon: 1 }], // reversed piece
    [{ lat: 1, lon: 1 }, { lat: 1, lon: 0 }, { lat: 0, lon: 0 }],
  ]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 8);

  const courtyards = synthetic.buildings.filter((b) => b.rings.length > 1);
  assert.ok(courtyards.length > 0, 'courtyard buildings keep their inner ring');
  const m = 0.0006;
  for (const r of synthetic.roads) {
    for (let i = 0; i < r.points.length; i += 2) {
      assert.ok(r.points[i] > JERUSALEM_BBOX.south - m && r.points[i] < JERUSALEM_BBOX.north + m, 'road clipped to bbox');
    }
  }
  assert.equal(synthetic.license, 'ODbL-1.0');
});

test('footprint decomposition: axis-aligned rectangle is one box', () => {
  const boxes = decomposeFootprint([[0, 0, 10, 0, 10, 20, 0, 20]], { step: STEP });
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0], { minX: 0, maxX: 10, minZ: 0, maxZ: 20 });
});

test('footprint decomposition: rotated shapes and courtyards match the polygon within step/2', () => {
  const outer = rotatedRect(5, -3, 30, 18, 0.49);
  const hole = rotatedRect(5, -3, 12, 6, 0.49);
  const rings = orientRings([outer, hole]);
  assert.ok(ringArea(rings[0]) > 0 && ringArea(rings[1]) < 0);
  const boxes = decomposeFootprint(rings, { step: STEP });
  const covered = (x, z) => boxes.some((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ);
  let checked = 0;
  for (let x = -20; x <= 30; x += 0.37) {
    for (let z = -25; z <= 20; z += 0.41) {
      const d = distanceToEdges(rings, x, z);
      if (d <= STEP / 2 + 1e-3) continue; // inside the tolerance band either answer is fine
      assert.equal(covered(x, z), pointInRings(rings, x, z), `(${x.toFixed(2)}, ${z.toFixed(2)}) d=${d.toFixed(2)}`);
      checked++;
    }
  }
  assert.ok(checked > 5000);
  assert.ok(boxes.length < 120, `${boxes.length} boxes`);
});

test('heights: OSM height > levels > 3–6 story Jerusalem default; canopies float', () => {
  assert.equal(resolveHeight({ building: 'yes', height: '23.5 m' }, 200, 'w1').top, 23.5);
  const lv = resolveHeight({ building: 'yes', 'building:levels': '4' }, 200, 'w2');
  assert.equal(lv.floors, 4);
  assert.ok(Math.abs(lv.top - (4 * 3.2 + 0.6)) < 1e-9);
  for (let i = 0; i < 200; i++) {
    const h = resolveHeight({ building: 'yes' }, 300, `w${i}`);
    assert.ok(h.floors >= 3 && h.floors <= 6, `floors ${h.floors}`);
    assert.ok(h.top >= 10 && h.top <= 20, `height ${h.top}`);
  }
  const roof = resolveHeight({ building: 'roof' }, 300, 'w9');
  assert.equal(roof.kind, 'canopy');
  assert.ok(roof.base > 2.2 && roof.top > roof.base);
});

test('extrusion: walls face outward, roof faces up, triangle winding matches normals', () => {
  const b = data.buildings.find((x) => x.rings.length > 1) ?? data.buildings[0];
  const g = extrudeBuilding(b);
  const pos = g.getAttribute('position').array, nrm = g.getAttribute('normal').array;
  assert.equal(g.getAttribute('aFacade').itemSize, 3);
  let walls = 0;
  for (let t = 0; t < pos.length; t += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.slice(t, t + 9);
    const n = [nrm[t], nrm[t + 1], nrm[t + 2]];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const face = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    assert.ok(face[0] * n[0] + face[1] * n[1] + face[2] * n[2] > 0, 'front face matches normal');
    if (Math.abs(n[1]) < 0.5) {
      walls++;
      const mx = (ax + bx + cx) / 3 + n[0] * 0.05, mz = (az + bz + cz) / 3 + n[2] * 0.05;
      assert.ok(!pointInRings(b.rings, mx, mz), 'wall normal points out of the solid');
    }
  }
  assert.ok(walls > 0);
});

test('collision: every building is registered with boxes of its real height', () => {
  const byRef = new Map();
  for (const box of collision.boxes) {
    assert.ok(box.maxX > box.minX && box.maxY > box.minY && box.maxZ > box.minZ);
    if (box.kind === 'building') byRef.set(box.ref, (byRef.get(box.ref) ?? 0) + 1);
  }
  for (const b of data.buildings) {
    assert.ok(byRef.get(b.id) > 0, `${b.id} has colliders`);
    const c = b.centroid;
    if (pointInRings(b.rings, c.x, c.z) && distanceToEdges(b.rings, c.x, c.z) > STEP) {
      const hit = collision.raycast({ x: c.x, y: 200, z: c.z }, { x: 0, y: -1, z: 0 }, 500, { filter: (x) => x.kind === 'building' });
      assert.ok(hit && Math.abs(hit.point.y - b.height) < 1e-6, `${b.id} roof at ${b.height}`);
    }
  }
});

test('collision: capsule walking into a rotated wall stops one radius away (± step/2)', () => {
  let tested = 0;
  for (const b of data.buildings.filter((x) => x.kind === 'building')) {
    const r = b.rings[0];
    for (let i = 0; i < r.length && tested < 60; i += 2) {
      const j = (i + 2) % r.length;
      const ax = r[i], az = r[i + 1], bx = r[j], bz = r[j + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 6) continue;
      const nx = (bz - az) / len, nz = -(bx - ax) / len; // outward
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const feet = { x: mx + nx * 4, y: 0, z: mz + nz * 4 };
      // Skip edges with something else in front of them (neighbouring buildings, props).
      if (collision.queryAABB(feet.x - 4.5, 0.5, feet.z - 4.5, feet.x + 4.5, 2, feet.z + 4.5).some((x) => x.ref !== b.id)) continue;
      for (let k = 0; k < 200; k++) {
        feet.x -= nx * 0.05;
        feet.z -= nz * 0.05;
        collision.resolveCapsule(feet, PLAYER.radius, PLAYER.height, PLAYER.step);
      }
      const dist = (feet.x - mx) * nx + (feet.z - mz) * nz;
      assert.ok(Math.abs(dist - PLAYER.radius) <= STEP / 2 + 0.02, `${b.id}: stopped ${dist.toFixed(3)} m from the wall`);
      tested++;
    }
  }
  assert.ok(tested >= 20, `tested ${tested} walls`);
});

test('spawn: on a real street at y = 0 with a clear capsule', () => {
  const s = data.spawn;
  assert.equal(s.y, 0);
  assert.ok(findRoadsAt(data, s.x, s.z).length > 0, 'spawn is on a road');
  assert.equal(collision.queryAABB(s.x - PLAYER.radius, 0.01, s.z - PLAYER.radius, s.x + PLAYER.radius, PLAYER.height, s.z + PLAYER.radius).length, 0);
  assert.equal(collision.groundHeight(s.x, s.z, s.y + PLAYER.step), 0);
  const feet = { ...s };
  const res = collision.resolveCapsule(feet, PLAYER.radius, PLAYER.height, PLAYER.step);
  assert.equal(res.collided, false);
});

test('rooftops: solar heaters and AC units sit on flat roofs inside the footprint', () => {
  const { solar, ac } = data.roofProps;
  assert.ok(solar.length > 0 && ac.length > 0);
  for (const p of [...solar, ...ac]) {
    const b = data.buildingById.get(p.buildingId);
    assert.equal(p.y, b.height);
    assert.ok(pointInRings(b.rings, p.x, p.z));
  }
  assert.ok(data.buildings.filter((b) => b.kind === 'canopy').every((b) => !solar.some((s) => s.buildingId === b.id)));
});

test('tile roofs: low pitched-roof houses get a hipped terracotta roof you can stand on', () => {
  const osm = convertOverpass(syntheticOverpass());
  // Tag a few small rectangular buildings as hipped, like much of Nahlaot in OSM.
  const small = osm.buildings.filter((b) => b.rings.length === 1 && b.rings[0].length === 8 && !b.tags.height && !b.tags['building:levels']).slice(0, 6);
  for (const b of small) b.tags['roof:shape'] = 'hipped';
  const gen = new CityGenerator({ osm, tileRoofMaxArea: 2000 });
  const d = gen.generate();
  const roofed = d.buildings.filter((b) => b.roof);
  assert.ok(roofed.length > 0, 'some hipped roofs');
  for (const b of roofed) {
    assert.ok(b.floors <= 3, 'only low-rise buildings');
    assert.equal(b.flatRoof, false);
    assert.ok(!d.roofProps.solar.some((s) => s.buildingId === b.id), 'no solar heaters on tiles');
    // Standing on the roof near the ridge is higher than the eaves.
    const top = d.collision.groundHeight(b.roof.cx, b.roof.cz);
    assert.ok(top > b.height + b.roof.rise * 0.5 && top <= b.height + b.roof.rise + 1e-6, `ridge ${top} vs eaves ${b.height}`);
    // Roof faces point up and the winding matches.
    const g = extrudeBuilding(b);
    const pos = g.getAttribute('position').array, nrm = g.getAttribute('normal').array;
    let sloped = 0;
    for (let t = 0; t < pos.length; t += 9) {
      if (nrm[t + 1] > 0.3 && nrm[t + 1] < 0.97) sloped++;
    }
    assert.ok(sloped >= 6, 'hip roof has sloped faces');
  }
});

test('render: static geometry is merged, well under 100 draw calls', () => {
  let meshes = 0;
  city.group.traverse((o) => {
    if (o.isMesh) meshes++;
  });
  assert.ok(meshes < 100, `${meshes} meshes`);
  const buildingMeshes = city.group.children.filter((o) => o.name.startsWith('Buildings['));
  assert.ok(buildingMeshes.length > 0 && buildingMeshes.length <= 16);
  city.dispose();
});

test('real Jerusalem data (public/data/jerusalem_data.json)', { skip: !existsSync(REAL_DATA) && 'not fetched yet: run npm run fetch-data' }, () => {
  const osm = JSON.parse(readFileSync(REAL_DATA, 'utf8'));
  assert.equal(osm.format, 'osm-city-v1');
  assert.ok(osm.buildings.length > 300, `${osm.buildings.length} buildings`);
  assert.ok(osm.roads.length > 100, `${osm.roads.length} roads`);
  const real = new CityGenerator({ osm }).create();
  const s = real.data.spawn;
  assert.equal(s.y, 0);
  assert.ok(findRoadsAt(real.data, s.x, s.z).length > 0);
  assert.equal(real.collision.queryAABB(s.x - 0.4, 0.01, s.z - 0.4, s.x + 0.4, 1.8, s.z + 0.4).length, 0);
  let meshes = 0;
  real.group.traverse((o) => {
    if (o.isMesh) meshes++;
  });
  assert.ok(meshes < 100, `${meshes} meshes`);
  console.log('[real data]', real.data.stats, `${meshes} meshes`);
  real.dispose();
});
