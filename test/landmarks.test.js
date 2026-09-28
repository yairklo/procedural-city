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

test('landmarks: buildings along the Temple Mount walls do not tower over the esplanade', async () => {
  const { generateCityChunk } = await import('../src/city/CityGenerator.js');
  const esplanade = terrain.patches.find((p) => p.name === 'Temple Mount esplanade');
  const merged = { buildings: [], roads: [], roadAreas: [], parks: [], trees: [], places: [] };
  for (const t of ['osm_4_2', 'osm_5_2', 'osm_4_1', 'osm_5_1']) {
    let d;
    try { d = read(`../public/data/tiles/${t}.json`); } catch { continue; }
    merged.buildings.push(...d.buildings);
  }
  const chunk = generateCityChunk(merged, { projection, terrain, seed: 't', id: 'tm', options: { excludeBuildings: landmarks.replaces } });
  let near = 0;
  for (const b of chunk.buildings) {
    const ring = b.rings[0];
    let touches = false;
    for (let i = 0; i < ring.length; i += 2) if (pointInRings(esplanade.rings, ring[i], ring[i + 1]) || distanceToEdges(esplanade.rings, ring[i], ring[i + 1]) < 3) touches = true;
    const onIt = pointInRings(esplanade.rings, b.centroid.x, b.centroid.z);
    if (!touches || onIt) continue;
    // Off the platform, touching it, and standing below its retaining wall (the ground there
    // is well below the esplanade): at most a storey or so above the esplanade (it used to
    // take its roof line from the esplanade and rise 20+ m over it). Where the street is
    // higher than the esplanade (north-west corner) ordinary heights apply.
    if (b.groundY > esplanade.y - 5 || b.kind === 'canopy') continue;
    near++;
    assert.ok(b.height <= esplanade.y + 4, `${b.id} (${b.name ?? b.type}) roof ${(b.height - esplanade.y).toFixed(1)} m above the esplanade`);
  }
  assert.ok(near > 0);
  const museum = chunk.buildings.find((b) => b.osmId === 'w291836691');
  if (museum) assert.ok(museum.height - esplanade.y < 12, `museum ${(museum.height - esplanade.y).toFixed(1)} m above the esplanade`);
});

test('landmarks: the Knesset, the Chords Bridge (walkable end to end), the Mount of Olives cemetery', () => {
  const collision = new CityCollisionWorld({ cellSize: 32, groundHeightAt: terrain.heightAt });
  const lm = buildLandmarks(landmarks, { projection, terrain, collision, uniforms: { uNight: { value: 0 } } });
  const st = lm.stats;
  assert.ok(st.modern.knesset && st.modern.knessetPiers >= 40, `Knesset colonnade (${st.modern.knessetPiers} piers)`);
  assert.ok(landmarks.replaces.includes(landmarks.modern.knesset.id), 'the generic Knesset block is replaced');
  assert.equal(st.modern.cables, 66);

  // Walk the bridge deck along its centre line: no step over 0.45 m, always on the deck.
  const line = projection.projectFlat(landmarks.modern.chordsBridge.deck);
  let y = null, maxStep = 0, samples = 0;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i], az = line[i + 1], bx = line[i + 2], bz = line[i + 3];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5);
    for (let k = 0; k < n; k++) {
      const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
      const g = collision.groundHeight(x, z, (y ?? terrain.heightAt(x, z)) + 0.45);
      if (y !== null) maxStep = Math.max(maxStep, Math.abs(g - y));
      y = g;
      samples++;
    }
  }
  assert.ok(samples > 500 && maxStep <= 0.45, `deck walkable (largest step ${maxStep.toFixed(2)} m)`);

  // The pylon: ~118 m long, leaning 24 degrees, so its top is ~108 m up.
  const p = projection.project(landmarks.modern.chordsBridge.pylon.lat, landmarks.modern.chordsBridge.pylon.lon);
  const pylonTop = collision.boxes.filter((b) => b && b.ref === 'chords-pylon').reduce((mx, b) => Math.max(mx, b.maxY), -Infinity);
  const rise = pylonTop - terrain.heightAt(p.x, p.z);
  assert.ok(rise > 100 && rise < 112, `pylon rises ${rise.toFixed(0)} m`);

  // Cemetery: thousands of graves, none inside the mapped buildings on the slope.
  assert.ok(st.hills.graves > 15000, `${st.hills.graves} graves`);
  const cem = lm.group.getObjectByName('Landmark(OliveCemetery)');
  const exclude = landmarks.olives.cemetery.exclude.map((r) => projection.projectFlat(r));
  const mtx = new THREE.Matrix4(), pos = new THREE.Vector3();
  for (let i = 0; i < cem.count; i += 7) {
    cem.getMatrixAt(i, mtx);
    pos.setFromMatrixPosition(mtx);
    assert.ok(!exclude.some((r) => pointInRings([r], pos.x, pos.z)), 'no grave inside a building');
  }
  lm.dispose();
});

test('terrain: the DEM reaches Mount Scopus and the Chords Bridge (real hills beyond the tiles)', () => {
  const at = (lat, lon) => { const q = projection.project(lat, lon); return ASL(terrain.heightAt(q.x, q.z)); };
  assert.ok(at(31.7929, 35.2432) > 815, `Mount Scopus ${at(31.7929, 35.2432).toFixed(0)} m`);
  assert.ok(at(31.7784, 35.2446) > 795, `Mount of Olives ${at(31.7784, 35.2446).toFixed(0)} m`);
  // The junction under the Chords Bridge is a road cut (terrain patch), not the SRTM hump.
  const c = projection.project(31.7887, 35.2027);
  assert.ok(Math.abs(ASL(terrain.heightAt(c.x, c.z)) - 813) < 1);
});
