import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

import { CityCollisionWorld } from '../src/city/CityCollision.js';
import { RoadNetwork } from '../src/city/RoadNetwork.js';
import { PedestrianSystem } from '../src/city/PedestrianSystem.js';
import { RiggedPedestrians } from '../src/city/RiggedPedestrians.js';

const MODEL = fileURLToPath(new URL('../public/models/pedestrians_pilot.glb', import.meta.url));

async function loadModel() {
  const buf = readFileSync(MODEL);
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise((res, rej) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(data, '', res, rej));
  return { source: gltf.scene.getObjectByName('ped_rig'), clips: gltf.animations };
}

const agent = (x, z, o = {}) => ({ x, y: 0, z, yaw: 0, scale: 1, moving: 1.3, rigged: true, ...o });

test('rigged pedestrians: the nearest eligible agents get a model, with hysteresis', async () => {
  const rigged = new RiggedPedestrians({ ...(await loadModel()), options: { max: 2, radius: 20, release: 25 } });
  const cam = { position: { x: 0, y: 0, z: 0 } };
  const near = agent(5, 0), mid = agent(10, 0), far = agent(30, 0);
  const child = agent(2, 0, { scale: 0.7 }), plain = agent(1, 0, { rigged: false });

  let got = rigged.assign([far, mid, child, plain, near], cam);
  assert.deepEqual([...got].sort((a, b) => a.x - b.x), [near, mid], 'two nearest eligible adults');
  assert.ok(!got.has(child) && !got.has(plain), 'children and non-Haredi agents stay mannequins');

  mid.x = 22; // beyond radius, within release: keeps its model
  got = rigged.assign([far, mid, near], cam);
  assert.ok(got.has(mid));
  mid.x = 26; // beyond release: hands it back
  got = rigged.assign([far, mid, near], cam);
  assert.ok(!got.has(mid) && got.has(near));

  rigged.update(0);
  rigged.update(0.5);
  const shown = rigged.slots.filter((s) => s.obj.visible);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].obj.position.x, near.x, 'model stands on its agent');
  rigged.dispose();
});

test('rigged pedestrians: every visible pedestrian is drawn exactly once', async () => {
  const roads = [];
  for (let k = 0; k <= 4; k++) {
    const c = -160 + k * 80;
    roads.push({ id: `ns${k}`, highway: 'residential', surface: 'asphalt', width: 8, points: [c, -160, c, 160] });
    roads.push({ id: `ew${k}`, highway: 'residential', surface: 'asphalt', width: 8, points: [-160, c, 160, c] });
  }
  const sys = new PedestrianSystem({ collision: new CityCollisionWorld(), options: { seed: 'rig' } });
  sys.setNetwork(RoadNetwork.fromRoads(roads));
  const rigged = new RiggedPedestrians({ ...(await loadModel()), options: { max: 6, radius: 79, release: 85 } }); // new people spawn near the 80 m edge
  sys.attachRigged(rigged);
  const center = { x: 0, y: 0, z: 0 };
  for (let t = 0; t < 3; t += 1 / 30) sys.update(1 / 30, center, null);
  sys.render({ position: center }, 3);

  const eligible = sys.agents.filter((a) => rigged.isEligible(a) && Math.hypot(a.x, a.z) < 79).length;
  assert.ok(eligible > 0, 'some Haredi pedestrians near the camera');
  assert.equal(rigged.visible, Math.min(6, eligible), 'the pool fills up to its size');
  const drawnInstanced = sys.mesh.count;
  const inRadius = sys.agents.filter((a) => Math.hypot(a.x, a.z) <= sys.o.radius).length;
  assert.equal(drawnInstanced + rigged.visible, inRadius, 'no one drawn twice, no one missing');
  assert.ok(sys.agents.some((a) => !a.rigged), 'most people stay instanced mannequins');
  rigged.dispose();
});

test('pedestrians face the way they walk (mannequins and rigged models)', async () => {
  const THREE = await import('three');
  const roads = [];
  for (let k = 0; k <= 4; k++) {
    const c = -160 + k * 80;
    roads.push({ id: `ns${k}`, highway: 'residential', surface: 'asphalt', width: 8, points: [c, -160, c, 160] });
    roads.push({ id: `ew${k}`, highway: 'residential', surface: 'asphalt', width: 8, points: [-160, c, 160, c] });
  }
  const sys = new PedestrianSystem({ collision: new CityCollisionWorld(), options: { seed: 'facing' } });
  sys.setNetwork(RoadNetwork.fromRoads(roads));
  const rigged = new RiggedPedestrians({ ...(await loadModel()), options: { max: 4, radius: 79, release: 85 } });
  sys.attachRigged(rigged);
  const center = { x: 0, y: 0, z: 0 };
  for (let t = 0; t < 2; t += 1 / 30) sys.update(1 / 30, center, null);
  const before = new Map(sys.agents.map((a) => [a, [a.x, a.z]]));
  sys.update(1 / 30, center, null);
  sys.update(1 / 30, center, null);
  sys.render({ position: center }, 2.1);

  // Models face +Z in their own space; after placement that axis must point along the walk.
  const agrees = (a, forward) => {
    const [x0, z0] = before.get(a);
    const dx = a.x - x0, dz = a.z - z0, len = Math.hypot(dx, dz);
    return len < 1e-3 ? null : (forward.x * dx + forward.z * dz) / len > 0.5;
  };
  const m = new THREE.Matrix4(), fwd = new THREE.Vector3();
  let checked = 0, i = 0;
  const drawn = new Set(rigged.slots.filter((s) => s.agent).map((s) => s.agent));
  for (const a of sys.agents) {
    if (Math.hypot(a.x, a.z) > sys.o.radius) continue;
    if (drawn.has(a)) continue;
    sys.mesh.getMatrixAt(i++, m);
    fwd.set(0, 0, 1).transformDirection(m);
    const ok = agrees(a, fwd);
    if (ok !== null) { assert.ok(ok, 'mannequin walks forwards'); checked++; }
  }
  for (const s of rigged.slots.filter((x) => x.agent)) {
    s.obj.updateMatrixWorld(true);
    fwd.set(0, 0, 1).transformDirection(s.obj.matrixWorld);
    const ok = agrees(s.agent, fwd);
    if (ok !== null) { assert.ok(ok, 'rigged model walks forwards'); checked++; }
  }
  assert.ok(checked > 5, `checked ${checked} walkers`);
  rigged.dispose();
});
