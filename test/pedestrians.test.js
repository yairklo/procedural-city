import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CityCollisionWorld } from '../src/city/CityCollision.js';
import { RoadNetwork } from '../src/city/RoadNetwork.js';
import { PedestrianSystem } from '../src/city/PedestrianSystem.js';

// A 6 x 6 street grid (80 m blocks, 8 m streets) with a building filling each block
// (its walls 6 m from the street centre line, i.e. 2 m of sidewalk).
function grid() {
  const roads = [];
  const collision = new CityCollisionWorld();
  for (let k = 0; k <= 6; k++) {
    const c = -240 + k * 80;
    roads.push({ id: `ns${k}`, highway: 'residential', surface: 'asphalt', width: 8, points: [c, -240, c, 240] });
    roads.push({ id: `ew${k}`, highway: 'residential', surface: 'asphalt', width: 8, points: [-240, c, 240, c] });
  }
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      const x0 = -240 + i * 80 + 6, z0 = -240 + j * 80 + 6;
      collision.add({ minX: x0, maxX: x0 + 68, minZ: z0, maxZ: z0 + 68, minY: 0, maxY: 15, kind: 'building', ref: `b${i}${j}` });
    }
  }
  return { network: RoadNetwork.fromRoads(roads), collision };
}

const inBuilding = (collision, a) => collision.queryAABB(a.x - 0.05, 0.5, a.z - 0.05, a.x + 0.05, 1.5, a.z + 0.05).some((b) => b.kind === 'building');

function run(sys, seconds, center, threat = null, each = null) {
  for (let t = 0; t < seconds; t += 1 / 30) {
    sys.update(1 / 30, center, typeof threat === 'function' ? threat(t) : threat);
    each?.(t);
  }
}

test('pedestrians: population follows the camera, stays within the radius, one draw call', () => {
  const { network, collision } = grid();
  const sys = new PedestrianSystem({ collision, options: { seed: 'p1' } });
  sys.setNetwork(network);
  const center = { x: 0, y: 0, z: 0 };
  run(sys, 3, center);
  assert.ok(sys.count > 40 && sys.count <= sys.o.maxAgents, `${sys.count} agents`);
  for (const a of sys.agents) assert.ok(Math.hypot(a.x - center.x, a.z - center.z) < sys.o.radius * 1.2);
  sys.render({ position: center }, 0);
  assert.ok(sys.mesh.count > 0 && sys.mesh.count <= sys.count, 'instances within 80 m drawn');
  // Groups: roughly 60% of spawns, pairs and clusters both present.
  const kinds = sys.groups.map((g) => g.kind);
  assert.ok(kinds.includes('pair') && kinds.includes('cluster') && kinds.includes('solo'));
  // Walk away: everyone is recycled around the new position.
  const far = { x: 200, y: 0, z: 200 };
  run(sys, 3, far);
  for (const a of sys.agents) assert.ok(Math.hypot(a.x - far.x, a.z - far.z) < sys.o.radius * 1.2);
});

test('pedestrians: nobody walks through buildings; followers replay the leader 0.5 s back', () => {
  const { network, collision } = grid();
  const sys = new PedestrianSystem({ collision, options: { seed: 'p2' } });
  sys.setNetwork(network);
  const center = { x: 0, y: 0, z: 0 };
  let checks = 0;
  run(sys, 40, center, null, (t) => {
    if (Math.round(t * 30) % 15) return;
    for (const a of sys.agents) {
      assert.ok(!inBuilding(collision, a), `${a.role} inside a building at ${a.x.toFixed(1)},${a.z.toFixed(1)}`);
      checks++;
    }
    for (const g of sys.groups) {
      for (const m of g.members) {
        if (m.role !== 'trail' || m.state !== 'walk' || g.leader.state !== 'walk') continue;
        const c = sys._crumb(g, sys.o.breadcrumbDelay * m.index);
        assert.ok(Math.hypot(m.x - c.x, m.z - c.z) < 1e-9, 'trail follower is on the breadcrumb');
      }
    }
  });
  assert.ok(checks > 1000);
});

test('pedestrians: side-by-side pairs compress to single file in a sharp turn', () => {
  // One L-shaped street: 60 m east, then a 90° corner, then 60 m north.
  const network = RoadNetwork.fromRoads([{ id: 'L', highway: 'pedestrian', surface: 'paving', width: 6, points: [-60, 0, 0, 0, 0, -60] }]);
  const sys = new PedestrianSystem({ collision: new CityCollisionWorld(), options: { seed: 'p3', groupShare: 1, pairShare: 1, maxAgents: 2, density: 1 } });
  sys.setNetwork(network);
  run(sys, 0.1, { x: 0, y: 0, z: 0 });
  const g = sys.groups[0];
  assert.equal(g.kind, 'pair');
  let maxCompress = 0, minCompress = 1;
  run(sys, 90, { x: 0, y: 0, z: 0 }, null, () => {
    maxCompress = Math.max(maxCompress, g.compress);
    minCompress = Math.min(minCompress, g.compress);
  });
  assert.ok(minCompress < 0.1, `side by side on the straight (${minCompress.toFixed(2)})`);
  assert.ok(maxCompress > 0.7, `single file around the corner / U-turn (${maxCompress.toFixed(2)})`);
});

test('pedestrians: flee from a fast landing within 4 m, then calm down and walk back', () => {
  const { network, collision } = grid();
  const sys = new PedestrianSystem({ collision, options: { seed: 'p4' } });
  sys.setNetwork(network);
  run(sys, 2, { x: 0, y: 0, z: 0 });
  const target = sys.agents[0];
  const threat = { x: target.x + 1, z: target.z, active: true };
  const d0 = Math.hypot(target.x - threat.x, target.z - threat.z);
  sys.update(1 / 30, { x: 0, y: 0, z: 0 }, threat);
  assert.equal(target.state, 'flee');
  const nearby = sys.agents.filter((a) => Math.hypot(a.x - threat.x, a.z - threat.z) < 4);
  assert.ok(nearby.every((a) => a.state === 'flee'), 'everyone within 4 m scatters');
  const x1 = target.x, z1 = target.z;
  run(sys, 1, { x: 0, y: 0, z: 0 });
  const moved = Math.hypot(target.x - x1, target.z - z1);
  assert.ok(Math.hypot(target.x - threat.x, target.z - threat.z) > d0, 'moves away from the impact');
  assert.ok(moved > target.speed * 1.4, `runs (${moved.toFixed(2)} m in 1 s at walking speed ${target.speed.toFixed(2)})`);
  run(sys, 6, { x: 0, y: 0, z: 0 });
  assert.equal(target.state, 'walk', 'calm again after 3 s and back on the sidewalk');
  assert.ok(!inBuilding(collision, target));
});

test('pedestrians: a rebuilt network keeps everyone walking', () => {
  const { network, collision } = grid();
  const roads = [...new Set(network.edges.map((e) => e.road))];
  const sys = new PedestrianSystem({ collision, options: { seed: 'p5' } });
  sys.setNetwork(network);
  run(sys, 3, { x: 0, y: 0, z: 0 });
  const n = sys.count;
  sys.setNetwork(RoadNetwork.fromRoads(roads));
  assert.equal(sys.count, n);
  for (const g of sys.groups) assert.ok(sys.network.edges.includes(g.leader.edge));
  run(sys, 2, { x: 0, y: 0, z: 0 });
});
