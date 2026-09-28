import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createProjection } from '../src/city/geo.js';
import { createTerrain } from '../src/city/terrain.js';
import { CityCollisionWorld } from '../src/city/CityCollision.js';
import { buildLandmarks } from '../src/city/landmarks/LandmarkLayer.js';
import { pointInRings, distanceToEdges } from '../src/city/footprint.js';

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
  const plaza = terrain.patches.find((p) => p.mode === 'lower'), esplanade = terrain.patches.find((p) => p.mode === 'raise');
  const pc = centroid(plaza.rings[0]), ec = centroid(esplanade.rings[0]);
  assert.equal(ASL(terrain.heightAt(pc.x, pc.z)), 721.5);
  assert.equal(ASL(terrain.heightAt(ec.x, ec.z)), 740.5);

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
        if (!pointInRings(terrain.patches.find((p) => p.mode === 'raise').rings, x + 2, z)) {
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
