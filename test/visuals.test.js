import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertOverpass, JERUSALEM_BBOX } from '../scripts/fetch_jerusalem.js';
import { createProjection } from '../src/city/geo.js';
import { generateCityChunk, buildChunkParts } from '../src/city/CityGenerator.js';
import { createPedestrianMesh } from '../src/city/PedestrianSystem.js';
import { createStreetPropGeometries } from '../src/city/StreetProps.js';
import { railGeometry } from '../src/city/TrafficSystem.js';
import { syntheticOverpass } from './helpers/synthetic.js';

const chunk = generateCityChunk(convertOverpass(syntheticOverpass()), { projection: createProjection(JERUSALEM_BBOX), seed: 'visuals' });
const near = buildChunkParts(chunk, { level: 'near' }); // flat terrain

const segDist = (x, z, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
};

test('curbs: raised solid stones that stop at junctions instead of crossing carriageways', () => {
  const curbs = near.find((p) => p.name === 'Curbs');
  assert.ok(curbs, 'near level has curbs');
  const pos = curbs.geometry.getAttribute('position').array, nrm = curbs.geometry.getAttribute('normal').array;
  let minY = Infinity, maxY = -Infinity, walls = 0;
  for (let i = 0; i < pos.length; i += 3) {
    minY = Math.min(minY, pos[i + 1]);
    maxY = Math.max(maxY, pos[i + 1]);
    if (Math.abs(nrm[i + 1]) < 0.1) walls++;
  }
  assert.ok(Math.abs(minY - 0.04) < 1e-4 && Math.abs(maxY - 0.18) < 1e-4, `curb spans paving (0.04) to 12 cm over asphalt (0.18): ${minY}..${maxY}`);
  assert.ok(walls > pos.length / 3 / 3, 'has vertical faces, not just a flat band');

  // No curb vertex may stand well inside any carriageway (e.g. across a crossing street).
  const asphalt = chunk.roads.filter((r) => r.surface === 'asphalt' && r.points);
  let worst = Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], z = pos[i + 2];
    for (const r of asphalt) {
      const p = r.points;
      for (let k = 0; k + 3 < p.length; k += 2) worst = Math.min(worst, segDist(x, z, p[k], p[k + 1], p[k + 2], p[k + 3]) - r.width / 2);
    }
  }
  assert.ok(worst > -0.4, `curb reaches ${(-worst).toFixed(2)} m into a carriageway`);
});

test('rails: solid 1435 mm gauge bars standing 4.5 cm above the asphalt', () => {
  const path = { points: [0, 0, 20, 0, 40, 10] };
  const g = railGeometry(path, () => 0);
  const pos = g.getAttribute('position').array, nrm = g.getAttribute('normal').array;
  let minY = Infinity, maxY = -Infinity, up = 0, side = 0, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    minY = Math.min(minY, pos[i + 1]);
    maxY = Math.max(maxY, pos[i + 1]);
    if (pos[i] < 19) { minZ = Math.min(minZ, pos[i + 2]); maxZ = Math.max(maxZ, pos[i + 2]); }
    if (nrm[i + 1] > 0.99) up++;
    else if (Math.abs(nrm[i + 1]) < 0.01) side++;
  }
  assert.ok(Math.abs(minY - 0.055) < 1e-6 && Math.abs(maxY - 0.1) < 1e-6, `${minY}..${maxY}`);
  assert.ok(up > 0 && side === 2 * up, 'a top and two sides per piece');
  assert.ok(Math.abs(maxZ - minZ - (1.435 + 0.072)) < 1e-3, `outer width ${(maxZ - minZ).toFixed(3)} m`);
});

test('pedestrians: faceted mannequin with clothing zones and a shadow that follows the limbs', () => {
  const mesh = createPedestrianMesh(4);
  const g = mesh.geometry;
  const zones = new Set(g.getAttribute('aZone').array);
  assert.deepEqual([...zones].sort(), [0, 1, 2, 3, 4], 'top, bottoms, skin, shoes, hair');
  const parts = new Set(g.getAttribute('aPart').array);
  assert.deepEqual([...parts].sort(), [0, 1, 2, 3, 4], 'body, two legs, two arms');
  assert.ok(g.getAttribute('position').count / 3 < 600, 'stays low-poly');
  assert.equal(mesh.material.roughness, 0.7);
  assert.equal(mesh.material.flatShading, true);
  assert.ok(mesh.customDepthMaterial, 'shadow pass uses the animated depth material');
  assert.equal(g.getAttribute('aLook').itemSize, 4);
});

test('trees: slender faceted cypress and olive with separate foliage clouds, matte leaves', () => {
  const { cypress, olive } = createStreetPropGeometries();
  for (const [name, g] of [['cypress', cypress], ['olive', olive]]) {
    g.computeBoundingBox();
    const surf = g.getAttribute('aSurf').array, nrm = g.getAttribute('normal').array;
    let leafTris = 0, flat = 0;
    for (let t = 0; t < surf.length / 3; t += 3) {
      if (surf[t * 3 + 2] !== 1) continue;
      leafTris++;
      assert.ok(Math.abs(surf[t * 3] - 0.95) < 1e-6, `${name}: matte foliage`);
      const n0 = [nrm[t * 3], nrm[t * 3 + 1], nrm[t * 3 + 2]], n1 = [nrm[t * 3 + 3], nrm[t * 3 + 4], nrm[t * 3 + 5]];
      if (Math.hypot(n0[0] - n1[0], n0[1] - n1[1], n0[2] - n1[2]) < 1e-5) flat++;
    }
    assert.ok(leafTris > 50, `${name}: has foliage`);
    assert.equal(flat, leafTris, `${name}: every leaf face is flat-shaded (faceted, not a smooth sphere)`);
  }
  const c = cypress.boundingBox, o = olive.boundingBox;
  assert.ok(c.max.y > 8.5 && c.max.x - c.min.x < 2.2, 'cypress: tall and slender');
  assert.ok(o.max.y < 5 && o.max.x - o.min.x > 3, 'olive: low and wide');
});
