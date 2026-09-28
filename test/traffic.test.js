import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CityCollisionWorld } from '../src/city/CityCollision.js';
import { RoadNetwork } from '../src/city/RoadNetwork.js';
import { TrafficSystem, jaffaPath } from '../src/city/TrafficSystem.js';

const uniforms = { uNight: { value: 0 } };

function town() {
  const roads = [];
  for (let k = 0; k <= 5; k++) {
    const c = -250 + k * 100;
    roads.push({ id: `ns${k}`, name: `North ${k}`, highway: 'residential', surface: 'asphalt', width: 8, oneway: 0, points: [c, -250, c, 250] });
    roads.push({ id: `ew${k}`, name: `East ${k}`, highway: k === 2 ? 'secondary' : 'residential', surface: 'asphalt', width: 10, oneway: k === 4 ? 1 : 0, points: [-250, c, 250, c] });
  }
  // Jaffa Road: a diagonal pedestrian mall made of three pieces (as tile / cell cuts leave it).
  roads.push({ id: 'j1', name: 'Jaffa', highway: 'pedestrian', surface: 'paving', width: 12, oneway: 0, points: [-240, 240, -100, 100] });
  roads.push({ id: 'j2', name: 'Jaffa', highway: 'pedestrian', surface: 'paving', width: 12, oneway: 0, points: [-100, 100, 0, 0, 60, -60] });
  roads.push({ id: 'j3', nameLocal: 'יפו', highway: 'pedestrian', surface: 'paving', width: 12, oneway: 0, points: [60, -60, 240, -240] });
  return { network: RoadNetwork.fromRoads(roads), roads };
}

test('traffic: vehicles stay on drivable lanes, keep distance, respect one-way streets', () => {
  const { network } = town();
  const collision = new CityCollisionWorld();
  const sys = new TrafficSystem({ collision, uniforms, options: { seed: 't1', maxVehicles: 40 } });
  sys.setNetwork(network);
  const center = { x: 0, y: 0, z: 0 };
  let minGap = Infinity;
  for (let t = 0; t < 60; t += 1 / 30) {
    sys.update(1 / 30, center, null);
    for (const v of sys.vehicles) {
      assert.equal(v.edge.road.surface, 'asphalt', 'only on asphalt');
      if (v.edge.road.oneway) assert.equal(v.forward, v.edge.road.oneway > 0, 'with the one-way direction');
    }
    const lanes = new Map();
    for (const v of sys.vehicles) {
      const k = `${v.edge.id}:${v.forward}`;
      if (!lanes.has(k)) lanes.set(k, []);
      lanes.get(k).push(v);
    }
    for (const list of lanes.values()) {
      list.sort((a, b) => a.s - b.s);
      for (let i = 1; i < list.length; i++) minGap = Math.min(minGap, list[i].s - list[i - 1].s - list[i].length);
    }
  }
  assert.ok(sys.count > 10, `${sys.count} vehicles`);
  assert.ok(minGap > 0, `no overlaps in a lane (min gap ${minGap.toFixed(2)} m)`);
  // They actually move.
  const v = sys.vehicles[0];
  const x0 = v.x, z0 = v.z;
  for (let t = 0; t < 3; t += 1 / 30) sys.update(1 / 30, center, null);
  assert.ok(Math.hypot(v.x - x0, v.z - z0) > 3 || !sys.vehicles.includes(v));
});

test('traffic: cars stop for the player standing in the lane', () => {
  const network = RoadNetwork.fromRoads([{ id: 'r', highway: 'residential', surface: 'asphalt', width: 8, oneway: 1, points: [0, 0, 0, -400] }]);
  const sys = new TrafficSystem({ collision: new CityCollisionWorld(), uniforms, options: { seed: 't2', maxVehicles: 1, density: 1 } });
  sys.setNetwork(network);
  sys.update(1 / 30, { x: 0, y: 0, z: -200 }, null);
  const car = sys.vehicles[0];
  car.s = 50;
  const player = { x: 0, y: 0, z: -90 }; // 40 m ahead of the car
  for (let t = 0; t < 20; t += 1 / 30) sys.update(1 / 30, { x: 0, y: 0, z: -200 }, player);
  assert.ok(car.speed < 0.05, 'stopped');
  assert.ok(car.z > player.z + 3, `stopped short of the player (car at ${car.z.toFixed(1)}, player at ${player.z})`);
});

test('light rail: chained Jaffa path, articulated tram stays on the track and is solid', () => {
  const { network } = town();
  const path = jaffaPath(network);
  assert.ok(path && Math.abs(path.length - Math.hypot(480, 480)) < 1, `one path along all three pieces (${path?.length.toFixed(1)} m)`);
  const collision = new CityCollisionWorld();
  const sys = new TrafficSystem({ collision, uniforms, options: { seed: 't3', maxVehicles: 0 } });
  sys.setNetwork(network);
  const rail = sys.rail;
  assert.ok(rail);
  let maxSpeed = 0, stops = 0, reversed = false, wasStopped = false;
  const dir0 = rail.dir;
  for (let t = 0; t < 400; t += 1 / 30) {
    sys.update(1 / 30, { x: 0, y: 0, z: 0 }, null);
    maxSpeed = Math.max(maxSpeed, rail.speed);
    if (rail.dwell > 0 && !wasStopped) stops++;
    wasStopped = rail.dwell > 0;
    if (rail.dir !== dir0) reversed = true;
    for (const p of rail.poses) {
      // Every module centre is on the diagonal track (x = -z) within a few cm.
      assert.ok(Math.abs(p.x + p.z) < 0.1, `module on the track (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
      assert.ok(Math.abs(p.x) <= 240.01);
    }
  }
  assert.ok(maxSpeed > 8 && maxSpeed <= 11.01, `cruises up to 40 km/h (${maxSpeed.toFixed(1)} m/s)`);
  assert.ok(stops >= 2, `stops at stations (${stops})`);
  assert.ok(reversed, 'reverses at the terminus');
  assert.equal(collision.groups.get('tram').length, 5, 'five solid modules');
});

test('traffic: a rebuilt network keeps the vehicles and the tram where they were', () => {
  const { roads } = town();
  const collision = new CityCollisionWorld();
  const sys = new TrafficSystem({ collision, uniforms, options: { seed: 't4', maxVehicles: 30 } });
  sys.setNetwork(RoadNetwork.fromRoads(roads));
  for (let t = 0; t < 20; t += 1 / 30) sys.update(1 / 30, { x: 0, y: 0, z: 0 }, null);
  const before = sys.vehicles.map((v) => ({ v, x: v.x, z: v.z }));
  const tram = sys.rail.at(sys.rail.s), tramDir = sys.rail.dir;
  // Same roads, new graph (as when a cell streams in elsewhere).
  sys.setNetwork(RoadNetwork.fromRoads(roads));
  assert.equal(sys.vehicles.length, before.length, 'nobody vanished');
  for (const { v } of before) assert.ok(sys.network.edges.includes(v.edge), 'on the new graph');
  sys.update(1 / 30, { x: 0, y: 0, z: 0 }, null);
  for (const { v, x, z } of before) if (sys.vehicles.includes(v)) assert.ok(Math.hypot(v.x - x, v.z - z) < 1.5, 'no jump');
  const now = sys.rail.at(sys.rail.s);
  assert.ok(Math.hypot(now.x - tram.x, now.z - tram.z) < 1.5 && sys.rail.dir === tramDir, 'the tram carries on');
  // Dropping a road removes only the vehicles on it.
  sys.setNetwork(RoadNetwork.fromRoads(roads.filter((r) => r.id !== 'ew2')));
  assert.ok(sys.vehicles.every((v) => v.edge.road.id !== 'ew2'));
});

test('light rail: the tram stops for the player on the track', () => {
  const { network } = town();
  const sys = new TrafficSystem({ collision: new CityCollisionWorld(), uniforms, options: { seed: 't5', maxVehicles: 0 } });
  sys.setNetwork(network);
  const rail = sys.rail;
  rail.dwell = 0;
  // Stand on the track 80 m ahead of the train (between stations).
  const d = rail.s + rail.dir * 80;
  const p = rail.at(d);
  rail.stops = [];
  const player = { x: p.x, y: 0, z: p.z };
  for (let t = 0; t < 40; t += 1 / 30) sys.update(1 / 30, { x: 0, y: 0, z: 0 }, player);
  const head = rail.project(player.x, player.z).d;
  const gap = rail.dir > 0 ? head - rail.s : rail.s - head;
  assert.ok(rail.speed < 0.05, `stopped (${rail.speed.toFixed(2)} m/s)`);
  assert.ok(gap > 1 && gap < 12, `just short of the player (${gap.toFixed(1)} m)`);
});
