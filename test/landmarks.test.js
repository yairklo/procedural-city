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

test('landmarks: terrain meshes keep patch ramps off the plaza and in front of no wall', () => {
  const plaza = terrain.patches.find((p) => p.mode === 'lower');
  const b = plaza.bounds, spacing = 8;
  // Sample points inside the plaza, and just outside it (within one mesh spacing): the mesh
  // must stay at plaza level there, so its ramp starts beyond the terraces' face.
  let checked = 0;
  for (let x = b.minX - spacing; x <= b.maxX + spacing; x += 2) {
    for (let z = b.minZ - spacing; z <= b.maxZ + spacing; z += 2) {
      const inside = pointInRings(plaza.rings, x, z), near = distanceToEdges(plaza.rings, x, z) < spacing;
      if (!inside && !near) continue;
      assert.equal(terrain.meshHeightAt(x, z, spacing), plaza.y);
      checked++;
    }
  }
  assert.ok(checked > 100);
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
