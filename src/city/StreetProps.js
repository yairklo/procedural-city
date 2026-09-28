// Jerusalem street furniture and trees, placed per map chunk:
//   - black iron street lanterns along streets (both sides, staggered) and pedestrian ways;
//   - stone benches along pedestrian streets and in parks / plazas;
//   - bollards across the ends of pedestrian streets;
//   - Mediterranean trees: cypress and olive, from OSM natural=tree points plus a few in parks
//     and along wide pedestrian streets.
//
// Placement is pure data (runs in the cell worker) and every item gets a collision box.
// Rendering uses one merged, vertex-coloured geometry per prop type, drawn as InstancedMesh.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pointInRings, distanceToEdges, ringsBounds } from './footprint.js';

const LAMP_SPACING = 28; // m along a street, per side (the other side is staggered)
const BENCH_SPACING = 36;
const MIN_PROP_GAP = 6; // no two props of a kind closer than this (hash grid)

/**
 * @param {object} p
 * @param {Array} p.roads      chunk roads (points or rings)
 * @param {Array} p.parks      chunk parks (rings)
 * @param {Array} p.osmTrees   chunk trees from OSM ({x, z, y, ...})
 * @param {{heightAt:(x:number,z:number)=>number}} p.terrain
 * @param {ReturnType<import('./random.js').createRng>} p.rng
 * @param {import('./CityCollision.js').CityCollisionWorld} p.collision  the chunk's boxes so far (buildings); props are added to it
 */
export function generateStreetProps({ roads, parks, osmTrees = [], terrain, rng, collision }) {
  const lamps = [], benches = [], bollards = [], trees = [];
  const taken = new Map(); // "kind:ix,iz" -> true, keeps props of a kind apart
  const free = (kind, x, z, r) => {
    const key = `${kind}:${Math.floor(x / MIN_PROP_GAP)},${Math.floor(z / MIN_PROP_GAP)}`;
    if (taken.has(key)) return false;
    const y = terrain.heightAt(x, z);
    if (collision.queryAABB(x - r, y + 0.2, z - r, x + r, y + 2.5, z + r).length) return false; // wall, tree, other prop
    taken.set(key, true);
    return true;
  };
  const addBox = (x, z, hx, hz, h, kind) => {
    const y = terrain.heightAt(x, z);
    collision.add({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, minY: y, maxY: y + h, kind, ref: null });
    return y;
  };

  // Walks a polyline, calling fn(x, z, ux, uz) every `spacing` meters starting at `start`.
  const along = (pts, spacing, start, fn) => {
    let next = start;
    let walked = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i], az = pts[i + 1], dx = pts[i + 2] - ax, dz = pts[i + 3] - az;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      while (next <= walked + len) {
        const t = (next - walked) / len;
        fn(ax + dx * t, az + dz * t, dx / len, dz / len);
        next += spacing;
      }
      walked += len;
    }
  };

  for (const r of roads) {
    if (!r.points) continue;
    const hw = r.width / 2;
    const vehicular = r.surface === 'asphalt' && r.highway !== 'service' && r.highway !== 'track' && r.width >= 6;
    const pedestrian = r.highway === 'pedestrian' || r.highway === 'living_street';
    if (vehicular || (pedestrian && r.width >= 4)) {
      // Lanterns: just outside the curb (vehicular) or inside the edge (pedestrian), staggered.
      const off = vehicular ? hw + 0.55 : Math.max(0.8, hw - 0.7);
      for (const side of [1, -1]) {
        along(r.points, LAMP_SPACING, side > 0 ? rng.range(2, 8) : LAMP_SPACING / 2 + rng.range(2, 8), (x, z, ux, uz) => {
          const px = x - uz * off * side, pz = z + ux * off * side;
          if (!free('lamp', px, pz, 0.35)) return;
          const y = addBox(px, pz, 0.15, 0.15, 4.2, 'prop');
          lamps.push({ x: px, y, z: pz, ry: Math.atan2(-uz * side, ux * side) + Math.PI / 2, s: rng.range(0.95, 1.05) });
        });
      }
    }
    if (pedestrian && r.width >= 5) {
      // Benches facing the street, and a few olive trees.
      const off = Math.max(1, hw - 1.4);
      along(r.points, BENCH_SPACING, rng.range(5, 15), (x, z, ux, uz) => {
        const side = rng.chance(0.5) ? 1 : -1;
        const px = x - uz * off * side, pz = z + ux * off * side;
        if (!free('bench', px, pz, 1.1)) return;
        const ry = Math.atan2(ux, uz) + (side > 0 ? 0 : Math.PI); // seat faces the street centre
        const y = addBox(px, pz, 0.9, 0.9, 0.5, 'prop');
        benches.push({ x: px, y, z: pz, ry, s: 1 });
      });
      along(r.points, 22, rng.range(8, 18), (x, z, ux, uz) => {
        if (!rng.chance(0.55)) return;
        const side = rng.chance(0.5) ? 1 : -1, off2 = Math.max(1.2, hw - 1);
        const px = x - uz * off2 * side, pz = z + ux * off2 * side;
        if (!free('tree', px, pz, 1.2)) return;
        const y = addBox(px, pz, 0.25, 0.25, 3, 'tree');
        trees.push({ x: px, y, z: pz, species: 'olive', s: rng.range(0.8, 1.15), ry: rng.range(0, Math.PI * 2) });
      });
      // Bollards across both ends of the street.
      const p = r.points, n = p.length;
      for (const [k, j] of [[0, 2], [n - 2, n - 4]]) {
        const ux0 = p[j] - p[k], uz0 = p[j + 1] - p[k + 1], l = Math.hypot(ux0, uz0) || 1;
        const ux = ux0 / l, uz = uz0 / l;
        const cx = p[k] + ux * 1.5, cz = p[k + 1] + uz * 1.5;
        const count = Math.max(2, Math.floor((r.width - 1) / 1.6));
        for (let b = 0; b < count; b++) {
          const o = (b - (count - 1) / 2) * 1.6;
          const bx = cx - uz * o, bz = cz + ux * o;
          const y = terrain.heightAt(bx, bz);
          if (collision.queryAABB(bx - 0.2, y + 0.2, bz - 0.2, bx + 0.2, y + 1, bz + 0.2).length) continue;
          addBox(bx, bz, 0.13, 0.13, 0.9, 'prop');
          bollards.push({ x: bx, y, z: bz, ry: 0, s: 1 });
        }
      }
    }
  }

  // Parks: cypress rows along the edges feel very Jerusalem; olives inside; a couple of benches.
  for (const pk of parks) {
    const b = ringsBounds(pk.rings);
    const area = (b.maxX - b.minX) * (b.maxZ - b.minZ);
    const n = Math.min(40, Math.floor(area / 180));
    for (let k = 0; k < n; k++) {
      const x = rng.range(b.minX, b.maxX), z = rng.range(b.minZ, b.maxZ);
      if (!pointInRings(pk.rings, x, z)) continue;
      const edge = distanceToEdges(pk.rings, x, z);
      if (edge < 1.5) continue;
      if (k % 9 === 0 && free('bench', x, z, 1.1)) {
        const y = addBox(x, z, 0.9, 0.9, 0.5, 'prop');
        benches.push({ x, y, z, ry: rng.range(0, Math.PI * 2), s: 1 });
        continue;
      }
      if (!free('tree', x, z, 1.5)) continue;
      const species = edge < 5 && rng.chance(0.7) ? 'cypress' : 'olive';
      const y = addBox(x, z, 0.25, 0.25, 3, 'tree');
      trees.push({ x, y, z, species, s: rng.range(0.8, 1.2), ry: rng.range(0, Math.PI * 2) });
    }
  }

  // OSM street trees: olive or cypress (their collision boxes already exist).
  for (const t of osmTrees) {
    trees.push({ x: t.x, y: t.y, z: t.z, species: rng.chance(0.35) ? 'cypress' : 'olive', s: t.crownRadius / 2.5, ry: rng.range(0, Math.PI * 2) });
  }

  return { lamps, benches, bollards, trees };
}

// -----------------------------------------------------------------------------------------------
// Geometry and materials
// -----------------------------------------------------------------------------------------------

/**
 * Paints a geometry with one color (linear), non-indexed, without UVs. Per-vertex surface:
 * aSurf = (roughness, metalness, leaf). `facet` recomputes normals per face (low-poly look);
 * `leaf` marks foliage (matte, lit a little from behind, see createStreetPropMaterial);
 * `jitter` varies the brightness per face (mottled foliage).
 */
function paint(geo, hex, glow = 0, { rough = 0.75, metal = 0.1, leaf = 0, facet = false, jitter = 0 } = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.deleteAttribute('uv');
  if (facet) g.computeVertexNormals();
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3), gl = new Float32Array(n), surf = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const f = jitter ? 1 + jitter * (hash1(Math.floor(i / 3) * 7.13 + hex) * 2 - 1) : 1;
    col[i * 3] = c.r * f; col[i * 3 + 1] = c.g * f; col[i * 3 + 2] = c.b * f;
    gl[i] = glow;
    surf[i * 3] = rough; surf[i * 3 + 1] = metal; surf[i * 3 + 2] = leaf;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aGlow', new THREE.BufferAttribute(gl, 1));
  g.setAttribute('aSurf', new THREE.BufferAttribute(surf, 3));
  return g;
}

const hash1 = (x) => {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

/** Moves every vertex radially (around the Y axis) by a deterministic amount: irregular silhouettes. */
function roughen(geo, amount, seed) {
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // Hash the rounded position so coincident vertices move together (no cracks).
    const k = 1 + amount * (hash1(Math.round(x * 97) * 3.1 + Math.round(y * 97) * 5.7 + Math.round(z * 97) * 7.3 + seed) * 2 - 1);
    pos.setXYZ(i, x * k, y, z * k);
  }
  return geo;
}

const merge = (parts) => {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
};

/**
 * Merged geometries, origin at ground level, facing +Z:
 *   lamp     classic black iron Jerusalem lantern: fluted base, slim post, crossbar and a
 *            four-sided lantern with a pointed cap (glass glows at night), ~4.2 m
 *   bench    Jerusalem-stone block bench, 1.8 m
 *   bollard  short black iron post with a stone base
 *   cypress  tall slender Italian cypress, faceted dark-green flame, ~9.3 m
 *   olive    twisted low-poly trunk forking into limbs under 4 silvery-green clouds, ~4.5 m
 */
export function createStreetPropGeometries() {
  const IRON = 0x121212, GLASS = 0xffe2a8, STONE = 0xcdbfa8, STONE_DARK = 0xb4a58d;
  const lamp = merge([
    paint(new THREE.CylinderGeometry(0.16, 0.22, 0.7, 8).translate(0, 0.35, 0), IRON),
    paint(new THREE.CylinderGeometry(0.06, 0.08, 3.1, 6).translate(0, 2.2, 0), IRON),
    paint(new THREE.BoxGeometry(0.5, 0.05, 0.05).translate(0, 3.55, 0), IRON),
    paint(new THREE.CylinderGeometry(0.2, 0.13, 0.45, 4, 1).rotateY(Math.PI / 4).translate(0, 3.85, 0), GLASS, 1),
    paint(new THREE.ConeGeometry(0.26, 0.3, 4).rotateY(Math.PI / 4).translate(0, 4.22, 0), IRON),
    paint(new THREE.SphereGeometry(0.05, 6, 4).translate(0, 4.4, 0), IRON),
  ]);
  const bench = merge([
    paint(new THREE.BoxGeometry(1.8, 0.12, 0.55).translate(0, 0.44, 0), STONE),
    paint(new THREE.BoxGeometry(0.35, 0.38, 0.45).translate(-0.62, 0.19, 0), STONE_DARK),
    paint(new THREE.BoxGeometry(0.35, 0.38, 0.45).translate(0.62, 0.19, 0), STONE_DARK),
  ]);
  const bollard = merge([
    paint(new THREE.CylinderGeometry(0.14, 0.16, 0.12, 8).translate(0, 0.06, 0), STONE),
    paint(new THREE.CylinderGeometry(0.09, 0.11, 0.75, 8).translate(0, 0.49, 0), IRON),
    paint(new THREE.SphereGeometry(0.1, 8, 4).translate(0, 0.88, 0), IRON),
  ]);
  const cypress = cypressGeometry();
  const olive = oliveGeometry();
  return { lamp, bench, bollard, cypress, olive, pool: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2) };
}

// Foliage greens (sRGB): deep cypress greens; silvery olive greens.
const CYPRESS_GREENS = [0x1d3a1c, 0x234320, 0x1a3319];
const OLIVE_GREENS = [0x8e9982, 0x7f8a72, 0x9ca58f, 0x737e68]; // grey-green: the silvery underside of olive leaves
const LEAF = { rough: 0.95, metal: 0, leaf: 1, facet: true, jitter: 0.12 };

/**
 * Italian cypress: a short trunk and a tall, slender flame of foliage. The body is a stack
 * of 7-sided frustums (widest a quarter of the way up, tapering to a point), roughened so
 * the silhouette isn't a perfect cone, plus a second, slightly turned lobe for depth.
 */
function cypressGeometry() {
  const parts = [paint(new THREE.CylinderGeometry(0.1, 0.16, 1.1, 5).translate(0, 0.55, 0), 0x4a3a2c, 0, { rough: 0.95, metal: 0, facet: true })];
  const profile = [[0.8, 0.32], [1.6, 0.74], [2.7, 0.92], [4.0, 0.88], [5.3, 0.74], [6.5, 0.56], [7.6, 0.36], [8.6, 0.15], [9.3, 0]];
  for (const [lobe, scale, turn] of [[0, 1, 0], [1, 0.86, Math.PI / 7]]) {
    for (let i = 0; i < profile.length - 1; i++) {
      const [y0, r0] = profile[i], [y1, r1] = profile[i + 1];
      const band = new THREE.CylinderGeometry(r1 * scale, r0 * scale, y1 - y0, 7, 1, i > 0)
        .rotateY(turn)
        .translate(lobe * 0.08, (y0 + y1) / 2 + lobe * 0.15, lobe * -0.06);
      parts.push(paint(roughen(band, 0.14, i * 13 + lobe * 71), CYPRESS_GREENS[(i + lobe) % CYPRESS_GREENS.length], 0, LEAF));
    }
  }
  return merge(parts);
}

/**
 * Olive tree: a gnarled trunk leaning one way then the other, forking into three limbs,
 * each ending in a lumpy low-poly cloud of silvery-green leaves, plus one on top (4 clouds).
 */
function oliveGeometry() {
  const BARK = 0x6a5c4c;
  const barkOpts = { rough: 0.95, metal: 0, facet: true };
  const Y = new THREE.Vector3(0, 1, 0);
  // A limb starting at `from`, tilted by `tilt` (around Z) then turned to `heading` (around Y).
  const limb = (from, len, r0, r1, tilt, heading) => {
    const g = new THREE.CylinderGeometry(r1, r0, len, 6).translate(0, len / 2, 0).rotateZ(tilt).rotateY(heading).translate(from.x, from.y, from.z);
    const tip = new THREE.Vector3(0, len, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), tilt).applyAxisAngle(Y, heading).add(from);
    return { g: paint(roughen(g, 0.1, len * 31), BARK, 0, barkOpts), tip };
  };
  const trunk = limb(new THREE.Vector3(0, 0, 0), 1.05, 0.3, 0.21, 0.2, 0);
  const upper = limb(trunk.tip, 0.8, 0.21, 0.16, -0.38, 0.4);
  const forks = [
    limb(upper.tip, 1.1, 0.13, 0.07, 0.75, 0.3),
    limb(upper.tip, 1.0, 0.12, 0.07, 0.7, 2.4),
    limb(upper.tip, 0.9, 0.11, 0.06, 0.55, 4.3),
  ];
  const parts = [trunk.g, upper.g, ...forks.map((f) => f.g)];
  const clouds = [
    [forks[0].tip, 1.15], [forks[1].tip, 1.05], [forks[2].tip, 0.95],
    [upper.tip.clone().add(new THREE.Vector3(0, 1.25, 0)), 1.0], // crown top
  ];
  clouds.forEach(([c, r], i) => {
    const g = roughen(new THREE.IcosahedronGeometry(r, 0).scale(1.3, 0.75, 1.3), 0.18, i * 17 + 5).translate(c.x, c.y + 0.25, c.z);
    parts.push(paint(g, OLIVE_GREENS[i % OLIVE_GREENS.length], 0, LEAF));
  });
  return merge(parts);
}

/** Vertex-coloured props; parts flagged aGlow light up warm at night (lantern glass). */
export function createStreetPropMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1 });
  mat.customProgramCacheKey = () => 'street-props-v2';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute vec3 aSurf;\nvarying float vGlow;\nvarying vec3 vSurf;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = aGlow;\n  vSurf = aSurf;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vGlow;\nvarying vec3 vSurf;')
      // Per-part surface: matte foliage and stone, satin iron.
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = vSurf.x;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = vSurf.y;')
      .replace('#include <emissivemap_fragment>', [
        '#include <emissivemap_fragment>',
        '  totalEmissiveRadiance += vec3(1.0, 0.78, 0.45) * vGlow * (0.15 + 3.0 * uNight);',
        '  // Foliage lets some daylight through: shaded leaves keep a little of their colour',
        '  // instead of going flat black (a cheap stand-in for subsurface scattering).',
        '  totalEmissiveRadiance += diffuseColor.rgb * vSurf.z * 0.14 * (1.0 - 0.85 * uNight);',
      ].join('\n'));
  };
  return mat;
}

/**
 * Soft light pools on the ground (street lamps, headlights): additive quads with a radial
 * falloff, visible at night only. Instance color = light color, instance scale = size.
 */
export function createLightPoolMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { uNight: uniforms.uNight },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -30,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vTint;
      void main() {
        vUv = uv;
        vTint = instanceColor;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      varying vec2 vUv;
      varying vec3 vTint;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - d), 2.2) * uNight;
        if (a < 0.003) discard;
        gl_FragColor = vec4(vTint * a * 0.55, 1.0);
      }`,
  });
}
