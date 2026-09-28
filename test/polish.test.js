import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paintFootfall } from '../src/city/footfall.js';
import { generateAwnings, SHOP_BAY } from '../src/city/Awnings.js';
import { createRng } from '../src/city/random.js';

test('footfall: pedestrian malls paint more than quiet streets, squares are filled', () => {
  const w = 64, h = 64, rect = { minX: 0, minZ: 0, maxX: 1024, maxZ: 1024 }; // 16 m texels
  const data = new Uint8Array(w * h * 4);
  const roads = [
    { highway: 'pedestrian', points: [100, 200, 900, 200] },
    { highway: 'residential', points: [100, 600, 900, 600] },
    { highway: 'pedestrian', rings: [[400, 800, 520, 800, 520, 900, 400, 900]] },
  ];
  assert.ok(paintFootfall(data, w, h, rect, roads) > 0);
  const at = (x, z) => data[(Math.floor(z / 16) * w + Math.floor(x / 16)) * 4 + 1];
  assert.ok(at(500, 200) > 240, `mall ${at(500, 200)}`);
  assert.ok(at(500, 600) > 50 && at(500, 600) < 110, `residential ${at(500, 600)}`);
  assert.ok(at(460, 850) > 240, 'square filled');
  assert.equal(at(500, 400), 0, 'nothing between the streets');
  assert.equal(data[0], 0, 'other channels untouched');
  // Painting the same roads again changes nothing (max, order-independent).
  assert.equal(paintFootfall(data, w, h, rect, roads), 0);
});

test('awnings: over street-facing shop bays only, on the facade shader grid', () => {
  // A 21 m x 10 m shop building; a street runs along its south side (z = 13).
  const ring = [0, 0, 21, 0, 21, 10, 0, 10]; // x east, z south
  const b = { kind: 'building', rings: [ring], facade: [0.3, 1, 1, 5], heightAboveGround: 9 };
  const quiet = { ...b, facade: [0.3, 1, 0, 5] }; // no shops
  const street = { highway: 'secondary' };
  const roadsAt = (x, z) => (z > 11 && z < 15 ? [street] : []);
  const aw = generateAwnings({ buildings: [b, quiet], roadsAt, ground: () => 5, rng: createRng('aw'), share: 1 });
  assert.ok(aw.length >= 3, `${aw.length} awnings`);
  for (const a of aw) {
    assert.ok(Math.abs(a.z - 10.04) < 1e-6, 'on the south wall, just in front of it');
    assert.ok(Math.abs(a.ry) < 1e-6, 'facing +z (the street)');
    assert.ok(Math.abs(a.y - 7.62) < 1e-6, 'just above the shop glazing');
    // Bay centres of the shader's grid along the wall axis (u = -x on a south-facing wall).
    const u = -a.x;
    assert.ok(Math.abs(((u / SHOP_BAY) % 1 + 1) % 1 - 0.5) < 1e-6, `centred on a bay (u ${u.toFixed(2)})`);
    assert.ok(a.x > 1.7 && a.x < 21 - 1.7);
  }
  // A street climbing over the shop floor: no awnings.
  assert.equal(generateAwnings({ buildings: [b], roadsAt, ground: () => 6, rng: createRng('aw'), share: 1 }).length, 0);
});
