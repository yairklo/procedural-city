import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { chooseClip } from '../src/player/CharacterModel.js';

const snap = (state, { vy = 0, h = 0 } = {}) => ({ state, velocity: { x: 0, y: vy, z: 0 }, horizontalSpeed: h });

test('character: clip per controller state', () => {
  assert.equal(chooseClip(snap('ground')), 'idle');
  assert.equal(chooseClip(snap('ground', { h: 6 })), 'run');
  assert.equal(chooseClip(snap('slide', { h: 3 })), 'run');
  assert.equal(chooseClip(snap('glide', { vy: -3 })), 'glide');
  assert.equal(chooseClip(snap('air', { vy: 5 }), { sinceJump: 0.2 }), 'jump');
  assert.equal(chooseClip(snap('air', { vy: -12 }), { sinceJump: 0.9 }), 'fall', 'dropping fast after a jump');
  assert.equal(chooseClip(snap('air', { vy: -2 })), 'fall', 'walked off an edge');
  assert.equal(chooseClip(snap('air', { vy: 20 })), 'jump', 'launched upward without a jump (boost)');
  assert.equal(chooseClip(snap('mantle')), 'jump');
});

test('character: the model file has the five clips and meshopt compression', () => {
  const b = readFileSync(new URL('../public/models/character.glb', import.meta.url));
  assert.equal(b.toString('ascii', 0, 4), 'glTF');
  const json = JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12)));
  assert.deepEqual(json.animations.map((a) => a.name).sort(), ['fall', 'glide', 'idle', 'jump', 'run']);
  assert.ok(json.extensionsRequired.includes('EXT_meshopt_compression'));
});
