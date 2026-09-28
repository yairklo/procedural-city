// Procedural city generator.
//
// Two stages, kept separate on purpose:
//   1. generate()  -> plain data (roads, blocks, lots, buildings, trees, colliders).
//                     Deterministic from the seed and free of GPU objects, so it can
//                     be saved, sent over the network, or used by server physics.
//   2. build(data) -> three.js objects. Every repeated shape is drawn with
//                     InstancedMesh, one mesh per spatial chunk per shape, so the
//                     whole city costs a few dozen draw calls and chunks outside the
//                     camera frustum are culled by three.js automatically.
//
// Coordinates: meters, +Y up. "ns" roads run along Z, "ew" roads run along X.

import * as THREE from 'three';
import { createRng } from './random.js';
import { createNameBank } from './names.js';
import { CityCollisionWorld } from './CityCollision.js';

export const DEFAULT_CITY_OPTIONS = Object.freeze({
  seed: 'city-001',

  // Road grid
  blocksX: 14,
  blocksZ: 14,
  blockSizeMin: 64,
  blockSizeMax: 104,
  streetWidth: 12,
  boulevardWidth: 22,
  boulevardEvery: 5, // every Nth road is a wide boulevard (0 = never)

  // Blocks and lots
  sidewalkWidth: 4,
  curbHeight: 0.18,
  lotMin: 12,
  lotMax: 34,
  lotGap: 0.6, // minimum gap between neighbouring buildings (avoids coplanar walls)
  setbackMax: 1.5,
  parkChance: 0.06,

  // Heights
  floorHeight: 3.6,
  minHeight: 8,
  maxHeight: 230,
  downtownSpread: 0.38, // gaussian falloff of the tall core, as a fraction of the city half-size
  towerChance: 0.35, // chance (scaled by downtown-ness) that a lot becomes a tower
  maxSlenderness: 9, // max height / min footprint side
  tierMinHeight: 55, // buildings taller than this may get a podium + setback tower

  // Details
  roofPropChance: 0.6,

  // Engine
  chunkSize: 256,
  collisionCellSize: 32,
});

const PALETTES = {
  masonry: [0x9a8f84, 0x8c7b6b, 0xa89f91, 0x7d6f64, 0xb3a58f, 0x8a8078, 0x96755f, 0x7a6a5c],
  modern: [0x9fa8b0, 0x8795a1, 0xb7bec4, 0x6d7b88, 0xa3a9a6, 0xc2bcb0],
  glass: [0x5f7485, 0x4d6272, 0x6c8494, 0x55697a, 0x7a8e9c, 0x4f6a6a],
};

const COLORS = {
  asphalt: 0x2b2d30,
  outerGround: 0x3a4436,
  sidewalk: 0x807e79,
  grass: 0x4f7a3a,
  roofProp: 0x8b8e91,
  trunk: 0x5a4332,
  crown: [0x3f6b34, 0x4a7a3a, 0x365e2e, 0x58813f],
  markingWhite: 0xd9d9d4,
  markingYellow: 0xd8b23a,
};

const pad = (n, len) => String(n).padStart(len, '0');

function jitterHex(hex, amount, rng) {
  const f = 1 + (rng.next() * 2 - 1) * amount;
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * f));
  const b = Math.min(255, Math.round((hex & 255) * f));
  return (r << 16) | (g << 8) | b;
}

/** Lays out alternating road / block strips along one axis, centered on 0. */
function layoutAxis(blockCount, rng, o) {
  const roads = [];
  const blocks = [];
  let cursor = 0;
  for (let i = 0; i <= blockCount; i++) {
    const major = o.boulevardEvery > 0 && i % o.boulevardEvery === 0;
    const width = major ? o.boulevardWidth : o.streetWidth;
    roads.push({ index: i, start: cursor, end: cursor + width, width, major });
    cursor += width;
    if (i < blockCount) {
      const size = Math.round(rng.range(o.blockSizeMin, o.blockSizeMax));
      blocks.push({ index: i, start: cursor, end: cursor + size });
      cursor += size;
    }
  }
  const half = cursor / 2;
  for (const s of [...roads, ...blocks]) {
    s.start -= half;
    s.end -= half;
  }
  return { roads, blocks, total: cursor };
}

/** Recursively splits a rectangle into building lots. */
function splitLots(rect, rng, o, out) {
  const w = rect.maxX - rect.minX;
  const d = rect.maxZ - rect.minZ;
  const longer = Math.max(w, d);
  const canSplit = longer >= o.lotMin * 2;
  const mustSplit = longer > o.lotMax;
  if (!canSplit || (!mustSplit && rng.chance(0.45))) {
    out.push(rect);
    return;
  }
  const alongX = w >= d;
  const len = alongX ? w : d;
  const cut = Math.max(o.lotMin, Math.min(len - o.lotMin, len * rng.range(0.35, 0.65)));
  if (alongX) {
    splitLots({ ...rect, maxX: rect.minX + cut }, rng, o, out);
    splitLots({ ...rect, minX: rect.minX + cut }, rng, o, out);
  } else {
    splitLots({ ...rect, maxZ: rect.minZ + cut }, rng, o, out);
    splitLots({ ...rect, minZ: rect.minZ + cut }, rng, o, out);
  }
}

const shrink = (r, m) => ({ minX: r.minX + m, maxX: r.maxX - m, minZ: r.minZ + m, maxZ: r.maxZ - m });

/** Roads (0, 1 or 2 at an intersection) whose surface contains (x, z). */
export function findRoadsAt(data, x, z) {
  return data.roads.filter((r) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ);
}

/** The block containing (x, z), or null when on a road. */
export function findBlockAt(data, x, z) {
  return data.blocks.find((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) ?? null;
}

export class CityGenerator {
  /** @param {Partial<typeof DEFAULT_CITY_OPTIONS>} [options] */
  constructor(options = {}) {
    this.options = { ...DEFAULT_CITY_OPTIONS, ...options };
    const o = this.options;
    if (o.blocksX < 1 || o.blocksZ < 1) throw new Error('CityGenerator: blocksX / blocksZ must be >= 1');
    if (o.lotMax < o.lotMin * 2) throw new Error('CityGenerator: lotMax must be at least 2 * lotMin');
    if (o.blockSizeMin <= o.sidewalkWidth * 2 + o.lotMin) throw new Error('CityGenerator: blockSizeMin too small for sidewalks + one lot');
  }

  /** Generates data and meshes in one call. */
  create() {
    const t0 = performance.now();
    const data = this.generate();
    const t1 = performance.now();
    const view = this.build(data);
    const t2 = performance.now();
    data.stats.generateMs = Math.round(t1 - t0);
    data.stats.buildMs = Math.round(t2 - t1);
    return { data, collision: data.collision, ...view };
  }

  // ---------------------------------------------------------------------------------------------
  // Stage 1: data
  // ---------------------------------------------------------------------------------------------

  generate() {
    const o = this.options;
    const rng = createRng(o.seed);
    const layoutRng = rng.fork('layout');
    const lotRng = rng.fork('lots');
    const heightRng = rng.fork('heights');
    const styleRng = rng.fork('style');
    const propRng = rng.fork('props');
    const names = createNameBank(rng.fork('names'));

    const xAxis = layoutAxis(o.blocksX, layoutRng, o);
    const zAxis = layoutAxis(o.blocksZ, layoutRng, o);
    const bounds = { minX: -xAxis.total / 2, maxX: xAxis.total / 2, minZ: -zAxis.total / 2, maxZ: zAxis.total / 2 };
    const halfX = xAxis.total / 2, halfZ = zAxis.total / 2;

    // Roads. "ns" roads are placed along X and run the full Z extent; "ew" the other way round.
    const nsRoads = xAxis.roads.map((r) => ({
      id: `RD-NS-${pad(r.index, 2)}`,
      name: names.road('ns', r.major),
      orientation: 'ns',
      major: r.major,
      width: r.width,
      minX: r.start, maxX: r.end,
      minZ: bounds.minZ, maxZ: bounds.maxZ,
    }));
    const ewRoads = zAxis.roads.map((r) => ({
      id: `RD-EW-${pad(r.index, 2)}`,
      name: names.road('ew', r.major),
      orientation: 'ew',
      major: r.major,
      width: r.width,
      minX: bounds.minX, maxX: bounds.maxX,
      minZ: r.start, maxZ: r.end,
    }));

    // Districts: a coarse 3x3 zoning grid over the blocks.
    const DISTRICT_GRID = 3;
    const districts = [];
    for (let i = 0; i < DISTRICT_GRID * DISTRICT_GRID; i++) districts.push(names.district());
    const districtOf = (bx, bz) =>
      districts[Math.min(DISTRICT_GRID - 1, Math.floor((bz / o.blocksZ) * DISTRICT_GRID)) * DISTRICT_GRID +
        Math.min(DISTRICT_GRID - 1, Math.floor((bx / o.blocksX) * DISTRICT_GRID))];

    // The tall "downtown" core sits near, but not exactly at, the center.
    const core = { x: layoutRng.range(-0.15, 0.15) * halfX, z: layoutRng.range(-0.15, 0.15) * halfZ };

    const collision = new CityCollisionWorld({ cellSize: o.collisionCellSize });
    const blocks = [];
    const buildings = [];
    const trees = [];
    const roofProps = [];
    const curb = o.curbHeight;

    for (let bz = 0; bz < o.blocksZ; bz++) {
      for (let bx = 0; bx < o.blocksX; bx++) {
        const xs = xAxis.blocks[bx], zs = zAxis.blocks[bz];
        const cx = (xs.start + xs.end) / 2, cz = (zs.start + zs.end) / 2;
        const nd = Math.hypot((cx - core.x) / halfX, (cz - core.z) / halfZ);
        const downtown = Math.exp(-(nd * nd) / (2 * o.downtownSpread * o.downtownSpread));

        const block = {
          id: `BLK-${pad(bx, 2)}-${pad(bz, 2)}`,
          gridX: bx, gridZ: bz,
          minX: xs.start, maxX: xs.end, minZ: zs.start, maxZ: zs.end,
          district: districtOf(bx, bz),
          kind: lotRng.chance(o.parkChance * (1 - 0.7 * downtown)) ? 'park' : 'urban',
          downtown,
          buildingIds: [],
        };
        blocks.push(block);
        collision.add({ minX: block.minX, maxX: block.maxX, minY: 0, maxY: curb, minZ: block.minZ, maxZ: block.maxZ, kind: 'sidewalk', ref: block.id });

        const inner = shrink(block, o.sidewalkWidth);

        if (block.kind === 'park') {
          collision.add({ ...inner, minY: 0, maxY: curb + 0.03, kind: 'park', ref: block.id });
          const grove = shrink(inner, 3);
          for (let x = grove.minX + 3; x < grove.maxX - 1; x += 8) {
            for (let z = grove.minZ + 3; z < grove.maxZ - 1; z += 8) {
              if (!propRng.chance(0.65)) continue;
              const tree = {
                x: Math.min(grove.maxX, Math.max(grove.minX, x + propRng.range(-2.5, 2.5))),
                z: Math.min(grove.maxZ, Math.max(grove.minZ, z + propRng.range(-2.5, 2.5))),
                y: curb + 0.03,
                trunkHeight: propRng.range(2.4, 3.8),
                trunkRadius: propRng.range(0.18, 0.28),
                crownRadius: propRng.range(2.2, 3.6),
                color: propRng.pick(COLORS.crown),
              };
              trees.push(tree);
              collision.add({
                minX: tree.x - tree.trunkRadius, maxX: tree.x + tree.trunkRadius,
                minZ: tree.z - tree.trunkRadius, maxZ: tree.z + tree.trunkRadius,
                minY: tree.y, maxY: tree.y + tree.trunkHeight + tree.crownRadius,
                kind: 'tree', ref: block.id,
              });
            }
          }
          continue;
        }

        const lots = [];
        splitLots(inner, lotRng, o, lots);

        for (const lot of lots) {
          const fp = shrink(lot, o.lotGap / 2 + lotRng.range(0, o.setbackMax));
          const w = fp.maxX - fp.minX, d = fp.maxZ - fp.minZ;
          if (w < 5 || d < 5) continue;
          const lx = (fp.minX + fp.maxX) / 2, lz = (fp.minZ + fp.maxZ) / 2;

          // Height: low-rise noise everywhere, plus a downtown boost that falls off with distance.
          let h = o.minHeight + heightRng.next() * 16 + downtown * Math.pow(heightRng.next(), 1.5) * o.maxHeight * 0.55;
          if (heightRng.chance(o.towerChance * downtown * downtown)) {
            h = Math.max(h, o.maxHeight * heightRng.range(0.45, 1) * (0.5 + 0.5 * downtown));
          }
          h = Math.min(h, Math.max(20, Math.min(w, d) * o.maxSlenderness));
          const floors = Math.max(2, Math.round(h / o.floorHeight));
          h = floors * o.floorHeight;

          const style = h > 70 ? (styleRng.chance(0.75) ? 'glass' : 'modern') : h > 30 ? (styleRng.chance(0.6) ? 'modern' : 'masonry') : 'masonry';
          const glass = style === 'glass' ? styleRng.range(0.75, 1) : style === 'modern' ? styleRng.range(0.3, 0.6) : styleRng.range(0, 0.15);
          const color = jitterHex(styleRng.pick(PALETTES[style]), 0.08, styleRng);

          // Massing: a single box, or a podium with one or two setback tiers above it.
          const parts = [];
          const top = curb + h;
          if (h >= o.tierMinHeight && Math.min(w, d) >= 18 && heightRng.chance(0.6)) {
            let base = curb;
            let rect = fp;
            const podiumTop = curb + heightRng.int(3, 7) * o.floorHeight;
            parts.push({ ...rect, minY: base, maxY: podiumTop });
            base = podiumTop;
            const tiers = h > o.tierMinHeight * 2 && heightRng.chance(0.5) ? 2 : 1;
            for (let t = 0; t < tiers; t++) {
              const s = heightRng.range(0.6, 0.82);
              const rw = (rect.maxX - rect.minX) * s, rd = (rect.maxZ - rect.minZ) * s;
              const rcx = (rect.minX + rect.maxX) / 2 + heightRng.range(-0.3, 0.3) * ((rect.maxX - rect.minX) - rw);
              const rcz = (rect.minZ + rect.maxZ) / 2 + heightRng.range(-0.3, 0.3) * ((rect.maxZ - rect.minZ) - rd);
              rect = { minX: rcx - rw / 2, maxX: rcx + rw / 2, minZ: rcz - rd / 2, maxZ: rcz + rd / 2 };
              const midTop = base + Math.round(((top - base) * heightRng.range(0.55, 0.75)) / o.floorHeight) * o.floorHeight;
              const tierTop = t === tiers - 1 ? top : Math.min(top - o.floorHeight, Math.max(base + o.floorHeight, midTop));
              parts.push({ ...rect, minY: base, maxY: tierTop });
              base = tierTop;
            }
          } else {
            parts.push({ ...fp, minY: curb, maxY: top });
          }

          // Street address from the nearest block edge (and so the nearest road).
          const edges = [
            { dist: lx - block.minX, road: nsRoads[bx], along: lz - bounds.minZ, odd: false },
            { dist: block.maxX - lx, road: nsRoads[bx + 1], along: lz - bounds.minZ, odd: true },
            { dist: lz - block.minZ, road: ewRoads[bz], along: lx - bounds.minX, odd: false },
            { dist: block.maxZ - lz, road: ewRoads[bz + 1], along: lx - bounds.minX, odd: true },
          ];
          const front = edges.reduce((a, b) => (b.dist < a.dist ? b : a));
          const number = Math.max(1, Math.round(front.along / 5) * 2 + (front.odd ? 1 : 0));

          const building = {
            id: `BLD-${pad(buildings.length + 1, 5)}`,
            address: `${number} ${front.road.name}`,
            blockId: block.id,
            district: block.district,
            style,
            glass,
            floors,
            height: h,
            color,
            facadeSeed: styleRng.next(),
            footprint: fp,
            parts,
          };
          buildings.push(building);
          block.buildingIds.push(building.id);
          for (const p of parts) collision.add({ ...p, kind: 'building', ref: building.id });

          // Rooftop equipment on the top part.
          const roof = parts[parts.length - 1];
          const rw = roof.maxX - roof.minX, rd = roof.maxZ - roof.minZ;
          if (rw > 8 && rd > 8 && propRng.chance(o.roofPropChance)) {
            const n = propRng.int(1, 3);
            for (let i = 0; i < n; i++) {
              const sx = propRng.range(1.5, Math.min(5, rw / 3));
              const sz = propRng.range(1.5, Math.min(5, rd / 3));
              const sy = propRng.range(1.2, 3.2);
              const px = propRng.range(roof.minX + 1.5 + sx / 2, roof.maxX - 1.5 - sx / 2);
              const pz = propRng.range(roof.minZ + 1.5 + sz / 2, roof.maxZ - 1.5 - sz / 2);
              const prop = { minX: px - sx / 2, maxX: px + sx / 2, minZ: pz - sz / 2, maxZ: pz + sz / 2, minY: roof.maxY, maxY: roof.maxY + sy };
              roofProps.push({ ...prop, buildingId: building.id });
              collision.add({ ...prop, kind: 'roof-prop', ref: building.id });
            }
          }
        }
      }
    }

    const roads = [...nsRoads, ...ewRoads];
    const midNs = nsRoads[Math.floor(nsRoads.length / 2)];
    const midEw = ewRoads[Math.floor(ewRoads.length / 2)];

    return {
      seed: o.seed,
      name: names.cityName,
      options: { ...o },
      bounds,
      core,
      districts,
      roads,
      blocks,
      buildings,
      buildingById: new Map(buildings.map((b) => [b.id, b])),
      trees,
      roofProps,
      spawn: { x: (midNs.minX + midNs.maxX) / 2, y: 0, z: (midEw.minZ + midEw.maxZ) / 2 },
      collision,
      stats: {
        roads: roads.length,
        blocks: blocks.length,
        parks: blocks.filter((b) => b.kind === 'park').length,
        buildings: buildings.length,
        buildingParts: buildings.reduce((n, b) => n + b.parts.length, 0),
        tallest: buildings.reduce((m, b) => Math.max(m, b.height), 0),
        trees: trees.length,
        roofProps: roofProps.length,
        colliders: collision.boxes.length,
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Stage 2: meshes
  // ---------------------------------------------------------------------------------------------

  /**
   * @returns {{ group: THREE.Group, uniforms: {uNight:{value:number}}, setNight(v:number):void, dispose():void }}
   */
  build(data) {
    const o = this.options;
    const group = new THREE.Group();
    group.name = `City(${data.seed})`;
    const disposables = new Set();
    const track = (x) => (disposables.add(x), x);
    const uniforms = { uNight: { value: 0 } };
    const addAll = ({ meshes, geometries }) => {
      for (const m of meshes) group.add(m);
      for (const g of geometries) disposables.add(g);
      return meshes;
    };

    const { bounds } = data;
    const width = bounds.maxX - bounds.minX, depth = bounds.maxZ - bounds.minZ;

    // Ground: one asphalt plane for the whole road network, plus land around the city.
    const asphalt = new THREE.Mesh(
      track(new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2)),
      track(new THREE.MeshStandardMaterial({ color: COLORS.asphalt, roughness: 0.95 })),
    );
    asphalt.name = 'Asphalt';
    asphalt.receiveShadow = true;
    group.add(asphalt);

    const outer = new THREE.Mesh(
      track(new THREE.PlaneGeometry(width + 4000, depth + 4000).rotateX(-Math.PI / 2)),
      track(new THREE.MeshStandardMaterial({ color: COLORS.outerGround, roughness: 1 })),
    );
    outer.name = 'OuterGround';
    outer.position.y = -0.5;
    outer.receiveShadow = true;
    group.add(outer);

    // Shared unit geometries (origin at the bottom center so scale.y == height).
    const unitBox = track(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
    const boxItem = (r, minY, maxY, color, extra) => ({
      x: (r.minX + r.maxX) / 2, y: minY, z: (r.minZ + r.maxZ) / 2,
      sx: r.maxX - r.minX, sy: maxY - minY, sz: r.maxZ - r.minZ,
      color, ...extra,
    });

    // Sidewalk slabs + park lawns.
    const groundItems = [];
    for (const b of data.blocks) {
      groundItems.push(boxItem(b, 0, o.curbHeight, COLORS.sidewalk));
      if (b.kind === 'park') groundItems.push(boxItem(shrink(b, o.sidewalkWidth), 0, o.curbHeight + 0.03, COLORS.grass));
    }
    addAll(buildChunkedInstances(groundItems, {
      name: 'Blocks', geometry: unitBox, chunkSize: o.chunkSize, receiveShadow: true,
      material: track(new THREE.MeshStandardMaterial({ roughness: 0.9 })),
    }));

    // Buildings: one instance per massing part, with a procedural facade shader.
    const buildingItems = [];
    for (const b of data.buildings) {
      for (const p of b.parts) buildingItems.push(boxItem(p, p.minY, p.maxY, b.color, { facade: [b.facadeSeed, b.glass] }));
    }
    addAll(buildChunkedInstances(buildingItems, {
      name: 'Buildings', geometry: unitBox, chunkSize: o.chunkSize, castShadow: true, receiveShadow: true,
      material: track(createFacadeMaterial(uniforms, o.floorHeight, o.curbHeight)),
      facadeAttribute: true,
    }));

    // Rooftop equipment.
    addAll(buildChunkedInstances(data.roofProps.map((p) => boxItem(p, p.minY, p.maxY, COLORS.roofProp)), {
      name: 'RoofProps', geometry: unitBox, chunkSize: o.chunkSize, castShadow: true, receiveShadow: true,
      material: track(new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.3 })),
    }));

    // Trees.
    const trunkGeo = track(new THREE.CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0));
    const crownGeo = track(new THREE.IcosahedronGeometry(1, 1));
    addAll(buildChunkedInstances(data.trees.map((t) => ({
      x: t.x, y: t.y, z: t.z, sx: t.trunkRadius, sy: t.trunkHeight + t.crownRadius * 0.5, sz: t.trunkRadius, color: COLORS.trunk,
    })), {
      name: 'TreeTrunks', geometry: trunkGeo, chunkSize: o.chunkSize, castShadow: true,
      material: track(new THREE.MeshStandardMaterial({ roughness: 1 })),
    }));
    addAll(buildChunkedInstances(data.trees.map((t) => ({
      x: t.x, y: t.y + t.trunkHeight + t.crownRadius * 0.6, z: t.z,
      sx: t.crownRadius, sy: t.crownRadius * 0.85, sz: t.crownRadius, color: t.color,
    })), {
      name: 'TreeCrowns', geometry: crownGeo, chunkSize: o.chunkSize, castShadow: true, receiveShadow: true,
      material: track(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true })),
    }));

    // Road markings: flat quads, polygon-offset above the asphalt to avoid z-fighting.
    const markingGeo = track(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    addAll(buildChunkedInstances(buildRoadMarkings(data), {
      name: 'Markings', geometry: markingGeo, chunkSize: o.chunkSize, receiveShadow: true,
      material: track(new THREE.MeshStandardMaterial({ roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 })),
    }));

    // Everything is static: freeze world matrices once.
    group.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
    });
    group.updateMatrixWorld(true);

    return {
      group,
      uniforms,
      setNight(v) {
        uniforms.uNight.value = v;
      },
      dispose() {
        for (const d of disposables) d.dispose();
        disposables.clear();
        group.traverse((obj) => {
          if (obj.isInstancedMesh) obj.dispose();
        });
        group.clear();
      },
    };
  }
}

// -----------------------------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();

/**
 * Groups items into square chunks and emits one InstancedMesh per chunk.
 * Each chunk gets a tight bounding sphere, so three.js frustum-culls whole chunks
 * (and skips them in the shadow pass) with zero per-instance CPU cost.
 *
 * Item shape: { x, y, z, sx, sy, sz, color, facade?: [seed, glass] }
 */
function buildChunkedInstances(items, { geometry, material, chunkSize, name, castShadow = false, receiveShadow = false, facadeAttribute = false }) {
  const chunks = new Map();
  for (const it of items) {
    const key = `${Math.floor(it.x / chunkSize)},${Math.floor(it.z / chunkSize)}`;
    let list = chunks.get(key);
    if (!list) chunks.set(key, (list = []));
    list.push(it);
  }

  const meshes = [];
  const geometries = [];
  for (const [key, list] of chunks) {
    let geo = geometry;
    if (facadeAttribute) {
      // Per-instance facade parameters live on a per-chunk clone of the (tiny) box geometry.
      geo = geometry.clone();
      const arr = new Float32Array(list.length * 2);
      list.forEach((it, i) => {
        arr[i * 2] = it.facade[0];
        arr[i * 2 + 1] = it.facade[1];
      });
      geo.setAttribute('aFacade', new THREE.InstancedBufferAttribute(arr, 2));
      geometries.push(geo);
    }

    const mesh = new THREE.InstancedMesh(geo, material, list.length);
    mesh.name = `${name}[${key}]`;
    list.forEach((it, i) => {
      _p.set(it.x, it.y, it.z);
      _s.set(it.sx, it.sy, it.sz);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      mesh.setColorAt(i, _c.setHex(it.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    meshes.push(mesh);
  }
  return { meshes, geometries };
}

/** Lane lines, boulevard center lines and crosswalks for every road segment between intersections. */
function buildRoadMarkings(data) {
  const out = [];
  const Y = 0.01;
  const WHITE = COLORS.markingWhite, YELLOW = COLORS.markingYellow;
  const ns = data.roads.filter((r) => r.orientation === 'ns');
  const ew = data.roads.filter((r) => r.orientation === 'ew');
  const CROSSWALK = 3.2, LINE = 0.14, DASH = 3, GAP = 3;

  const segment = (road, a0, a1) => {
    const isNs = road.orientation === 'ns';
    const c = isNs ? (road.minX + road.maxX) / 2 : (road.minZ + road.maxZ) / 2;
    const w = road.width;
    // along = position along the road, across = offset from its center line
    const put = (along, across, lenAlong, lenAcross, color) =>
      out.push(isNs
        ? { x: c + across, y: Y, z: along, sx: lenAcross, sy: 1, sz: lenAlong, color }
        : { x: along, y: Y, z: c + across, sx: lenAlong, sy: 1, sz: lenAcross, color });

    // Zebra crosswalks at both ends of the segment.
    for (const mid of [a0 + 0.8 + CROSSWALK / 2, a1 - 0.8 - CROSSWALK / 2]) {
      for (let q = -w / 2 + 1; q <= w / 2 - 1; q += 1.2) put(mid, q, CROSSWALK, 0.6, WHITE);
    }

    const l0 = a0 + CROSSWALK + 3, l1 = a1 - CROSSWALK - 3;
    if (l1 <= l0) return;
    const dashes = (across) => {
      for (let t = l0; t + DASH <= l1; t += DASH + GAP) put(t + DASH / 2, across, DASH, LINE, WHITE);
    };
    if (road.major) {
      put((l0 + l1) / 2, -0.2, l1 - l0, LINE, YELLOW);
      put((l0 + l1) / 2, 0.2, l1 - l0, LINE, YELLOW);
      dashes(-w / 4);
      dashes(w / 4);
    } else {
      dashes(0);
    }
  };

  for (const r of ns) for (let j = 0; j < ew.length - 1; j++) segment(r, ew[j].maxZ, ew[j + 1].minZ);
  for (const r of ew) for (let j = 0; j < ns.length - 1; j++) segment(r, ns[j].maxX, ns[j + 1].minX);
  return out;
}

/**
 * MeshStandardMaterial extended with a procedural facade: window grid, storefront
 * band, roof tone and night-time lit windows, all computed in world space so any
 * box size tiles correctly without UVs or textures.
 *
 * Per-instance input: aFacade = (seed, glassiness 0..1). Instance color = wall tint.
 */
function createFacadeMaterial(uniforms, floorHeight, baseY) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.05 });
  mat.customProgramCacheKey = () => 'city-facade-v1';

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uFloorHeight = { value: floorHeight };
    shader.uniforms.uBaseY = { value: baseY };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec2 aFacade;
varying vec3 vCityWorldPos;
varying vec3 vCityWorldNormal;
varying vec2 vCityFacade;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
  mat4 cityModel = modelMatrix * instanceMatrix;
#else
  mat4 cityModel = modelMatrix;
#endif
  vCityWorldPos = (cityModel * vec4(transformed, 1.0)).xyz;
  vCityWorldNormal = normalize(mat3(cityModel) * objectNormal);
  vCityFacade = aFacade;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform float uNight;
uniform float uFloorHeight;
uniform float uBaseY;
varying vec3 vCityWorldPos;
varying vec3 vCityWorldNormal;
varying vec2 vCityFacade;
float cityHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
float cityWin = 0.0;
float cityLit = 0.0;
{
  vec3 n = normalize(vCityWorldNormal);
  float glass = vCityFacade.y;
  if (n.y > 0.5) {
    // Flat roof: grey membrane with faint patchiness.
    float roofNoise = cityHash(vec3(floor(vCityWorldPos.xz * 0.25), 7.0));
    diffuseColor.rgb = mix(vec3(0.06, 0.06, 0.065), vec3(0.1, 0.098, 0.095), roofNoise);
  } else if (n.y > -0.5) {
    float u = abs(n.x) > 0.5 ? vCityWorldPos.z : vCityWorldPos.x;
    float y = vCityWorldPos.y - uBaseY;
    float bay = mix(3.2, 1.7, glass);
    vec2 cell = vec2(u / bay, y / uFloorHeight);
    vec2 f = fract(cell);
    vec2 id = floor(cell);
    vec2 size = mix(vec2(0.48, 0.52), vec2(0.9, 0.8), glass);
    vec2 aa = fwidth(cell) + 1e-4;
    vec2 edge = abs(f - 0.5) - size * 0.5;
    vec2 m = 1.0 - smoothstep(-aa, aa, edge);
    cityWin = m.x * m.y;

    // Ground floor: tall storefront glazing with mullions every 4 m.
    if (y < uFloorHeight * 1.15) {
      float mullion = 1.0 - smoothstep(0.44, 0.5, abs(fract(u / 4.0) - 0.5));
      float band = smoothstep(0.5, 0.6, y) * (1.0 - smoothstep(uFloorHeight * 0.95, uFloorHeight, y));
      cityWin = band * mullion;
      id.y = -1.0;
    }

    // Far away the grid is sub-pixel: blend to its average coverage to avoid moire.
    float fade = smoothstep(0.25, 0.6, max(aa.x, aa.y));
    cityWin = mix(cityWin, size.x * size.y, fade);

    float face = n.x * 3.0 + n.z * 5.0;
    float r = cityHash(vec3(id, face + vCityFacade.x * 97.0));
    float lit = step(0.58, r);
    cityLit = mix(cityWin * lit, cityWin * 0.42, fade);

    vec3 glassCol = mix(vec3(0.035, 0.045, 0.06), vec3(0.12, 0.17, 0.22), glass * 0.7 + 0.3 * cityHash(vec3(id, 3.0)));
    diffuseColor.rgb = mix(diffuseColor.rgb, glassCol, cityWin);
  }
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.1, cityWin);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.4, cityWin * vCityFacade.y);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
{
  float tint = cityHash(vec3(floor(vCityWorldPos.y / uFloorHeight), vCityFacade.x * 53.0, 1.0));
  vec3 warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.78, 0.86, 1.0), step(0.8, tint));
  totalEmissiveRadiance += cityLit * uNight * warm * 1.4;
}`,
      );
  };
  return mat;
}
