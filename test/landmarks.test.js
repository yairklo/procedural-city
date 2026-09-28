import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createProjection } from '../src/city/geo.js';
import { createTerrain } from '../src/city/terrain.js';
import { CityCollisionWorld } from '../src/city/CityCollision.js';
import { buildLandmarks } from '../src/city/landmarks/LandmarkLayer.js';
import { pointInRings, distanceToEdges } from '../src/city/footprint.js';
import * as THREE from 'three';

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));
const manifest = read('../public/data/tiles/manifest.json');
const landmarks = read('../public/data/landmarks.json');
const dem = { ...read('../public/data/tiles/dem_points.json'), patches: landmarks.patches };
const projection = createProjection(manifest.worldBBox);
const terrain = createTerrain(dem, projection);
const ASL = (y) => y + terrain.datum;
const centroid = (ring) => {
  let x = 0, z = 0;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; z += ring[i + 1]; }
  return { x: (x * 2) / ring.length, z: (z * 2) / ring.length };
};

test('landmarks: the plaza lies 19 m below the esplanade, and the Western Wall spans the drop', () => {
  const plaza = terrain.patches.find((p) => p.mode === 'lower'), esplanade = terrain.patches.find((p) => p.name === 'Temple Mount esplanade');
  const pc = centroid(plaza.rings[0]);
  assert.equal(ASL(terrain.heightAt(pc.x, pc.z)), 721.5);
  // The esplanade is at 740.5 m, the platform around the Dome of the Rock 4 m higher.
  const upper = terrain.patches.find((p) => p.name === 'Dome of the Rock platform');
  let low = 0, high = 0;
  const b = esplanade.bounds;
  for (let x = b.minX; x <= b.maxX; x += 5) {
    for (let z = b.minZ; z <= b.maxZ; z += 5) {
      if (!pointInRings(esplanade.rings, x, z) || distanceToEdges(esplanade.rings, x, z) < 3) continue;
      if (distanceToEdges(upper.rings, x, z) < 3) continue;
      const onUpper = pointInRings(upper.rings, x, z);
      assert.equal(ASL(terrain.heightAt(x, z)), onUpper ? 744.5 : 740.5);
      if (onUpper) high++; else low++;
    }
  }
  assert.ok(low > 200 && high > 200, `${low} esplanade / ${high} platform samples`);

  const collision = new CityCollisionWorld({ cellSize: 32, groundHeightAt: terrain.heightAt });
  const lm = buildLandmarks(landmarks, { projection, terrain, collision, uniforms: { uNight: { value: 0 } } });
  const ww = lm.group.getObjectByName('Landmark(WesternWall)');
  ww.geometry.computeBoundingBox();
  const { min, max } = ww.geometry.boundingBox;
  assert.ok(Math.abs(ASL(max.y) - 741.5) < 0.6, `wall top ${ASL(max.y)} m: level with the esplanade (+1 m)`);
  assert.ok(ASL(min.y) <= 721.5, 'wall foot at or below the plaza');
  assert.equal(ASL(collision.groundHeight(pc.x, pc.z, pc.y ?? 1e9)), 721.5, 'people stand on the plaza floor');
  lm.dispose();
});

test('landmarks: the plaza is flat and the ground around it rises smoothly (no cliff, no ramp)', () => {
  const plaza = terrain.patches.find((p) => p.mode === 'lower');
  assert.ok(plaza.falloff > 0, 'the plaza blends into the surroundings');
  const b = plaza.bounds, spacing = 8;
  let inside = 0, steps = 0;
  for (let x = b.minX - 70; x <= b.maxX + 70; x += 2) {
    for (let z = b.minZ - 70; z <= b.maxZ + 70; z += 2) {
      const h = terrain.heightAt(x, z);
      if (pointInRings(plaza.rings, x, z)) {
        assert.equal(h, plaza.y);
        assert.equal(terrain.meshHeightAt(x, z, spacing), plaza.y, 'the mesh is flat on the plaza too');
        inside++;
      } else if (distanceToEdges(plaza.rings, x, z) < 60) {
        // Within the falloff: never a jump of more than 3 m over 2 m (no retaining cliff).
        const n = terrain.heightAt(x + 2, z);
        if (!pointInRings(terrain.patches.find((p) => p.name === 'Temple Mount esplanade').rings, x + 2, z)) {
          assert.ok(Math.abs(n - h) < 3, `step of ${(n - h).toFixed(1)} m at ${x.toFixed(0)}, ${z.toFixed(0)}`);
        }
        steps++;
      }
    }
  }
  assert.ok(inside > 100 && steps > 100);
});

test('landmarks: city walls leave openings where streets pass and replace the generic buildings', () => {
  const collision = new CityCollisionWorld({ cellSize: 32, groundHeightAt: terrain.heightAt });
  const lm = buildLandmarks(landmarks, { projection, terrain, collision, uniforms: { uNight: { value: 0 } } });
  assert.ok(lm.stats.meshes >= 15 && lm.stats.boxes > 3000);
  // A street through a wall (e.g. Lions' Gate Street) must be passable at head height.
  const crossing = landmarks.crossings.find((c) => /Lions' Gate Street/.test(c.name ?? '')) ?? landmarks.crossings.find((c) => c.angle > 60);
  const p = projection.project(crossing.lat, crossing.lon);
  const y = terrain.heightAt(p.x, p.z);
  const blocked = collision.queryAABB(p.x - 0.3, y + 0.5, p.z - 0.3, p.x + 0.3, y + 1.8, p.z + 0.3).filter((bx) => bx.kind === 'wall');
  assert.equal(blocked.length, 0, `no wall box at the ${crossing.name ?? crossing.highway} crossing`);
  for (const id of ['w817206833', 'r136164', 'w1022672085']) assert.ok(landmarks.replaces.includes(id), `${id} is replaced by a custom model`);
  lm.dispose();
});

test('landmarks: the Haram buildings, the raised platform and its stairs', () => {
  const h = landmarks.haram;
  assert.ok(h.domeOfTheRock && h.aqsa && h.domeOfTheChain);
  assert.equal(h.arcades.length, 8);
  assert.equal(h.domes.length, 8);
  assert.equal(h.minarets.length, 4);
  for (const id of [h.domeOfTheRock.id, h.aqsa.id, h.domeOfTheChain.id, ...h.arcades.map((a) => a.id)]) assert.ok(landmarks.replaces.includes(id), `${id} replaced`);

  const collision = new CityCollisionWorld({ cellSize: 32, groundHeightAt: terrain.heightAt });
  const lm = buildLandmarks(landmarks, { projection, terrain, collision, uniforms: { uNight: { value: 0 } } });
  assert.equal(lm.stats.haram.arcades, 8);
  assert.equal(lm.stats.haram.minarets, 4);
  const upper = terrain.patches.find((p) => p.name === 'Dome of the Rock platform');
  const esplanade = terrain.patches.find((p) => p.name === 'Temple Mount esplanade');

  // The Dome of the Rock stands on the raised platform, and its gold dome tops out ~35 m above it.
  const rock = centroid(projection.projectFlat(h.domeOfTheRock.ring));
  assert.equal(ASL(terrain.heightAt(rock.x + 30, rock.z + 30)), 744.5);
  const top = collision.queryAABB(rock.x - 1, 0, rock.z - 1, rock.x + 1, 1e4, rock.z + 1).reduce((m, b) => Math.max(m, b.maxY), -Infinity);
  assert.ok(top - upper.y > 25 && top - upper.y < 40, `dome top ${(top - upper.y).toFixed(1)} m above the platform`);

  // Walking up the stairs under an arcade: from the esplanade, every step at most 0.45 m.
  const arcade = h.arcades.find((a) => a.name === 'South Arcade') ?? h.arcades[0];
  const ac = centroid(projection.projectFlat(arcade.ring));
  const upc = centroid(upper.rings[0]);
  const dx = ac.x - upc.x, dz = ac.z - upc.z, l = Math.hypot(dx, dz);
  let y = null, climbed = 0;
  for (let t = 25; t >= 0; t -= 0.1) {
    const x = ac.x + (dx / l) * t, z = ac.z + (dz / l) * t;
    const g = collision.groundHeight(x, z, (y ?? esplanade.y) + 0.45);
    if (y !== null) {
      assert.ok(g - y <= 0.46, `step of ${(g - y).toFixed(2)} m at ${t.toFixed(1)} m`);
      climbed += Math.max(0, g - y);
    }
    y = g;
  }
  assert.ok(Math.abs(y - upper.y) < 0.3, `reached the platform (${ASL(y).toFixed(2)} m)`);
  assert.ok(climbed > 3.5);
  lm.dispose();
});

test('landmarks: the roofs of the Dome of the Rock and al-Aqsa face the sky (seen from above)', () => {
  const lm = buildLandmarks(landmarks, { projection, terrain, collision: null, uniforms: { uNight: { value: 0 } } });
  const mesh = lm.group.getObjectByName('Landmark(Haram)');
  mesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const hitTop = (x, z) => {
    ray.set(new THREE.Vector3(x, 1e4, z), new THREE.Vector3(0, -1, 0));
    return ray.intersectObject(mesh)[0] ?? null; // front faces only (FrontSide material)
  };
  const h = landmarks.haram;
  // Dome of the Rock: every direction, between the drum and the octagon's parapet, hits the
  // lead roof (not the platform inside the walls).
  const ring = projection.projectFlat(h.domeOfTheRock.ring);
  const c = centroid(ring);
  const upper = terrain.patches.find((p) => p.name === 'Dome of the Rock platform');
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const hit = hitTop(c.x + Math.cos(a) * 17, c.z + Math.sin(a) * 17);
    assert.ok(hit && hit.point.y > upper.y + 12, `roof at ${k}: ${hit ? (hit.point.y - upper.y).toFixed(1) : 'nothing'} m`);
    assert.ok(hit.face.normal.y > 0.5, 'facing up');
  }
  // al-Aqsa: the nave roof is hit from above on both slopes.
  const aqsa = centroid(projection.projectFlat(h.aqsa.ring));
  let roofHits = 0;
  for (let dx = -8; dx <= 8; dx += 1) {
    const hit = hitTop(aqsa.x + dx, aqsa.z - 10);
    if (hit && hit.face.normal.y > 0.3) roofHits++;
  }
  assert.ok(roofHits >= 15, `${roofHits}/17 samples hit a roof`);
  lm.dispose();
});
