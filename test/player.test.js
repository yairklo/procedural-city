import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CityCollisionWorld } from '../src/city/CityCollision.js';
import { PlayerController } from '../src/player/PlayerController.js';

const DT = 1 / 60;

/** Runs the controller for `seconds` with a constant (or per-frame function) input. */
function run(player, seconds, input) {
  const trace = [];
  for (let t = 0; t < seconds; t += DT) {
    player.update(DT, typeof input === 'function' ? input(t) : input);
    trace.push({ t, ...player.snapshot() });
  }
  return trace;
}

// Movement input is camera-relative: cameraYaw 0 = forward is north (-Z); pi/2 = west (-X).
const NORTH = 0;
const EAST = -Math.PI / 2;

test('walks up and down a slope without floating or sinking', () => {
  const slope = (x) => Math.max(0, x) * Math.tan((20 * Math.PI) / 180); // 20° ramp rising to the east
  const world = new CityCollisionWorld({ groundHeightAt: (x) => slope(x) });
  const p = new PlayerController(world, { x: -5, y: 0, z: 0 });
  const trace = run(p, 4, { moveY: 1, cameraYaw: EAST });
  for (const s of trace) {
    assert.ok(s.grounded, `grounded at t=${s.t.toFixed(2)} (${s.state})`);
    assert.ok(Math.abs(s.position.y - slope(s.position.x)) < 1e-6, `on the surface at x=${s.position.x.toFixed(2)}`);
  }
  assert.ok(p.position.x > 8, `walked uphill to x=${p.position.x.toFixed(1)}`);
  // Uphill is slower than walking on the flat.
  assert.ok(trace.at(-1).horizontalSpeed < p.o.walkSpeed - 0.1);
  // And back down: still glued to the ground.
  const down = run(p, 3, { moveY: 1, cameraYaw: -EAST });
  for (const s of down) assert.ok(s.grounded && Math.abs(s.position.y - slope(s.position.x)) < 1e-6);
});

test('slides down slopes steeper than 45 degrees', () => {
  const steep = (x) => Math.max(0, x) * Math.tan((55 * Math.PI) / 180);
  const world = new CityCollisionWorld({ groundHeightAt: (x) => steep(x) });
  const p = new PlayerController(world, { x: 6, y: steep(6), z: 0 });
  const trace = run(p, 1.5, {});
  assert.ok(trace.some((s) => s.state === 'slide'), 'enters slide');
  assert.ok(p.position.x < 3, `slid downhill to x=${p.position.x.toFixed(2)}`);
});

test('holding jump longer jumps higher (variable jump height)', () => {
  const apex = (holdSeconds) => {
    const p = new PlayerController(new CityCollisionWorld(), { x: 0, y: 0, z: 0 });
    run(p, 0.05, {});
    let top = 0;
    run(p, 1.5, (t) => ({ jump: t < holdSeconds })).forEach((s) => (top = Math.max(top, s.position.y)));
    return top;
  };
  const tap = apex(0.05), full = apex(0.6);
  assert.ok(tap > 0.3 && tap < 1.2, `tap ${tap.toFixed(2)} m`);
  assert.ok(full > tap + 0.6, `hold ${full.toFixed(2)} m vs tap ${tap.toFixed(2)} m`);
});

test('mantles onto a 2.4 m ledge when jumping toward it', () => {
  const world = new CityCollisionWorld();
  // A wall 2.4 m tall whose south face is at z = -2 (north of the player).
  world.add({ minX: -10, maxX: 10, minY: 0, maxY: 2.4, minZ: -20, maxZ: -2, kind: 'building' });
  const p = new PlayerController(world, { x: 0, y: 0, z: 0 });
  const events = [];
  p.on('mantleStart', (e) => events.push(e));
  run(p, 2.5, (t) => ({ moveY: 1, cameraYaw: NORTH, jump: t > 0.2 && t < 0.5 }));
  assert.equal(events.length, 1, 'one mantle');
  assert.equal(p.state, 'ground');
  assert.ok(Math.abs(p.position.y - 2.4) < 1e-6, `on top at y=${p.position.y}`);
  assert.ok(p.position.z < -2.3, 'standing on the ledge, not at the wall');
});

test('does not mantle onto a wall beyond reach', () => {
  const world = new CityCollisionWorld();
  world.add({ minX: -10, maxX: 10, minY: 0, maxY: 6, minZ: -20, maxZ: -2, kind: 'building' });
  const p = new PlayerController(world, { x: 0, y: 0, z: 0 });
  run(p, 2.5, (t) => ({ moveY: 1, cameraYaw: NORTH, jump: t > 0.2 && t < 0.5 }));
  assert.equal(p.position.y, 0);
  assert.ok(p.position.z > -2 - 1e-6 + 0 - p.o.radius - 1e-3, 'stopped at the wall');
});

test('tallit glide: slower sink and much farther than falling, diving builds speed', () => {
  const roof = () => {
    const world = new CityCollisionWorld();
    world.add({ minX: -10, maxX: 10, minY: 0, maxY: 60, minZ: -10, maxZ: 10, kind: 'building' });
    return new PlayerController(world, { x: 0, y: 60, z: 8 });
  };
  // Run south off the roof edge (z = 10), then either fall or hold jump to glide.
  const flight = (input) => {
    const p = roof();
    const trace = run(p, 60, (t) => ({ moveY: 1, cameraYaw: Math.PI, sprint: true, ...(t > 0.6 ? input : {}) }));
    const landed = trace.findIndex((s, i) => i > 60 && s.grounded);
    return { p, trace, landed };
  };
  const fall = flight({});
  const glide = flight({ jump: true, moveY: 0 });
  assert.ok(glide.trace.some((s) => s.state === 'glide'), 'glides');
  assert.ok(glide.landed > fall.landed * 2, `airborne ${glide.landed} vs ${fall.landed} frames`);
  const dist = (r) => r.trace[r.landed].position.z - 10;
  assert.ok(dist(glide) > dist(fall) * 4, `glide ${dist(glide).toFixed(0)} m vs fall ${dist(fall).toFixed(0)} m`);
  // Level glide sinks slowly.
  const mid = glide.trace.filter((s) => s.state === 'glide' && s.timeInState > 2);
  assert.ok(mid.length && mid.every((s) => s.velocity.y > -4), 'level sink rate under 4 m/s');
  // Diving (W) is faster than level flight.
  const dive = flight({ jump: true, moveY: 1 });
  const vmax = (r) => Math.max(...r.trace.filter((s) => s.state === 'glide').map((s) => s.speed));
  assert.ok(vmax(dive) > vmax(glide) + 5, `dive ${vmax(dive).toFixed(1)} vs level ${vmax(glide).toFixed(1)} m/s`);
  assert.equal(glide.trace[glide.landed].state, 'ground', 'lands back on the ground');
});

test('glide steers with A/D', () => {
  const world = new CityCollisionWorld();
  world.add({ minX: -10, maxX: 10, minY: 0, maxY: 60, minZ: -10, maxZ: 10, kind: 'building' });
  const p = new PlayerController(world, { x: 0, y: 60, z: 8 });
  run(p, 0.6, { moveY: 1, cameraYaw: Math.PI, sprint: true });
  run(p, 3, { jump: true, moveX: 1, cameraYaw: Math.PI }); // D: turn right (heading south -> west)
  assert.ok(p.position.x < -5, `turned right (x=${p.position.x.toFixed(1)})`);
});

test('snapshot is plain data', () => {
  const p = new PlayerController(new CityCollisionWorld(), { x: 1, y: 2, z: 3 });
  const s = p.snapshot();
  assert.deepEqual(s.position, { x: 1, y: 2, z: 3 });
  assert.equal(JSON.parse(JSON.stringify(s)).state, 'ground');
});
