// City generator built from real OpenStreetMap data.
//
// Two stages, kept separate on purpose:
//   1. generate()  -> plain data: projected building footprints with heights, roads,
//                     parks, trees, rooftop equipment and the AABB collision world.
//                     No GPU objects, so it can run in a worker or on a server.
//   2. build(data) -> three.js objects. Building footprints are extruded to their real
//                     shapes and merged per spatial chunk with BufferGeometryUtils (one
//                     draw call per chunk); repeated props (solar water heaters, AC
//                     units, trees) are drawn with InstancedMesh per chunk.
//
// Input is the compact JSON written by scripts/fetch_jerusalem.js.
// Coordinates: meters, +Y up, +X east, -Z north, origin at the center of the data bbox.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRng, hashString } from './random.js';
import { CityCollisionWorld } from './CityCollision.js';
import { createProjection } from './geo.js';
import { createTerrain, footprintGround, FLAT_TERRAIN } from './terrain.js';
import {
  cleanRing, orientRings, footprintArea, ringsBounds, ringCentroid, pointInRings, distanceToEdges,
  discInside, segmentDistance, decomposeFootprint, orientedBox, simplifyRing,
} from './footprint.js';

export const DEFAULT_CITY_OPTIONS = Object.freeze({
  /** Parsed contents of public/data/jerusalem_data.json (required). */
  osm: null,
  /** Parsed public/data/jerusalem_elevation.json (optional; flat ground without it). */
  elevation: null,
  /** How far building walls continue below the lowest ground point under them (hides gaps on slopes). */
  foundationDepth: 0.6,
  name: 'Jerusalem · City Center',
  /** Only drives decorative randomness (stone tint, rooftop layout, tree sizes). */
  seed: 'jerusalem',

  // Heights. Used when OSM has no height / building:levels for a building.
  floorHeight: 3.2,
  parapet: 0.6,
  defaultFloorsMin: 3,
  defaultFloorsMax: 6,
  canopyHeight: 4.2,

  // Terracotta hipped roofs: low (<= tileRoofMaxFloors) buildings OSM maps with a pitched
  // roof, small and rectangular enough for a clean hip (footprint / oriented box >= 0.8).
  tileRoofMaxArea: 450,
  tileRoofMaxFloors: 3,
  tileRoofPitchDeg: 27,
  tileRoofOverhang: 0.35,

  // Rooftops (flat roofs only)
  solarChance: 0.85, // share of roofs that carry solar water heaters
  solarPerM2: 1 / 45, // one heater per ~45 m² of roof (roughly one per apartment)
  maxSolarPerRoof: 18,
  acPerM2: 1 / 70,
  maxAcPerRoof: 10,
  minPropRoofArea: 35,

  // Engine
  chunkSize: 500,
  // Rooftop props use smaller chunks so whole chunks beyond propDrawDistance can be hidden
  // (a 1 m prop there is ~2 px). See the view's update(camera).
  propChunkSize: 250,
  propDrawDistance: 450,
  collisionCellSize: 16,
  collisionStep: 0.6, // strip width used to turn footprints into AABBs (max wall error = step / 2)
  groundMargin: 150,
});

// Jerusalem limestone, from pale "meleke" to warmer sand tones.
const STONE = [0xe4d8c8, 0xd6c5b2, 0xdfd1bf, 0xe8dccb, 0xd9c9b4, 0xcfbca3];
const TILES = [0xa0432e, 0xb33b24, 0xa8492f, 0x9c3f2a];
const COLORS = {
  ground: 0xb9ae9c, // stone-slab sidewalks between buildings
  outerGround: 0x8d8471,
  asphalt: 0x3a3b3d,
  curb: 0x808080,
  marking: 0xe8e4d8,
  paving: 0xc9bea9, // pedestrian malls, squares, footways
  park: 0x6f7f45,
  canopy: 0x9a9c98,
  solarTank: 0xf1f0ec,
  solarPanel: 0x1b202b,
  solarFrame: 0x8f9296,
  ac: 0xdad9d3,
  trunk: 0x5a4636,
  crown: [0x5d7038, 0x6a7a3f, 0x4f6533, 0x76854a], // olive / pine greens, dry Jerusalem palette
};

// Default carriageway widths (meters) when OSM has neither width nor lanes.
const ROAD_WIDTH = {
  motorway: 16, trunk: 14, primary: 13, secondary: 11, tertiary: 9.5,
  motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 6, tertiary_link: 6,
  unclassified: 7, residential: 7, living_street: 5.5, service: 4.5, road: 6, busway: 7, track: 3,
  pedestrian: 7, footway: 2.6, sidewalk: 2.4, path: 2, steps: 2.6, cycleway: 2, bridleway: 2, corridor: 2.4,
};
const ASPHALT = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link',
  'secondary_link', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'road', 'busway', 'track',
]);
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'pedestrian']);
export const MAJOR_HIGHWAYS = MAJOR;

const SMALL_TYPES = new Set(['kiosk', 'shed', 'garage', 'garages', 'hut', 'cabin', 'toilets', 'service', 'transformer_tower', 'container', 'guardhouse']);
const HOUSE_TYPES = new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'terrace']);
const CANOPY_TYPES = new Set(['roof', 'canopy', 'carport']);
const PITCHED_ROOFS = new Set(['hipped', 'gabled', 'pyramidal', 'half-hipped', 'gambrel', 'mansard']);

const ROAD_CELL = 24;

/** Parses OSM length values like "12", "12.5 m", "40'" into meters. */
export function parseMeters(value) {
  if (value == null) return null;
  const s = String(value).trim().replace(',', '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/ft|'/.test(s)) n *= 0.3048;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Height model: OSM height > building:levels > typical Jerusalem heights (3–6 stories). */
export function resolveHeight(tags, area, id, o = DEFAULT_CITY_OPTIONS) {
  const fh = o.floorHeight;
  const type = tags.building;
  const levels = parseMeters(tags['building:levels']);
  const roofLevels = parseMeters(tags['roof:levels']) ?? 0;
  const minLevel = parseMeters(tags['building:min_level']);
  let base = parseMeters(tags.min_height) ?? (minLevel != null ? minLevel * fh : 0);
  let top = parseMeters(tags.height);

  if (CANOPY_TYPES.has(type)) {
    top = top ?? o.canopyHeight;
    base = base > 0 && base < top ? base : Math.max(2.4, top - 0.35);
    return { kind: 'canopy', base, top, floors: 0, source: tags.height ? 'height' : 'default' };
  }

  let floors, source;
  if (top) {
    floors = levels ? Math.round(levels) : Math.max(1, Math.round((top - base) / fh));
    source = 'height';
  } else if (levels) {
    floors = Math.round(levels);
    top = base + (levels + roofLevels) * fh + o.parapet;
    source = 'levels';
  } else {
    let lo = o.defaultFloorsMin, hi = o.defaultFloorsMax;
    if (SMALL_TYPES.has(type) || area < 30) lo = hi = 1;
    // Buildings mapped with a pitched roof are mostly the older low-rise houses (Nahlaot, Nahalat Shiva).
    else if (HOUSE_TYPES.has(type) || area < 90 || (PITCHED_ROOFS.has(tags['roof:shape']) && area <= o.tileRoofMaxArea)) { lo = 2; hi = 3; }
    const r = hashString(id) / 4294967296;
    floors = lo + Math.floor(r * (hi - lo + 1));
    top = base + floors * fh + o.parapet;
    source = 'default';
  }
  top = Math.max(top, base + 2.5);
  return { kind: 'building', base, top, floors, source };
}

function roadWidth(road) {
  const w = parseMeters(road.width);
  if (w && w < 60) return w;
  const lanes = parseMeters(road.lanes);
  if (lanes && ASPHALT.has(road.highway)) return lanes * 3.3 + 1;
  return ROAD_WIDTH[road.highway] ?? 4;
}

function mixHex(a, b, t) {
  const ch = (s) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Roads (and pedestrian areas) whose surface contains (x, z). */
export function findRoadsAt(data, x, z) {
  const cell = data.roadGrid.get(`${Math.floor(x / ROAD_CELL)},${Math.floor(z / ROAD_CELL)}`);
  if (!cell) return [];
  const found = new Set();
  for (const [ri, si] of cell) {
    const r = data.roads[ri];
    if (found.has(r)) continue;
    if (si < 0 ? pointInRings(r.rings, x, z) : segmentDistance(x, z, r.points[si], r.points[si + 1], r.points[si + 2], r.points[si + 3]) <= r.width / 2) {
      found.add(r);
    }
  }
  return [...found];
}

/** Nearest neighbourhood / quarter label to (x, z), or null. */
export function findPlaceAt(data, x, z) {
  let best = null, bestD = Infinity;
  for (const p of data.places) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/**
 * Turns one OSM data file (or part of one) into city data: projected, terrain-seated buildings
 * with heights, roofs, rooftop props and collision boxes, roads with a lookup index, parks,
 * trees and place labels. Pure data, no GPU objects.
 *
 * The projection and terrain are passed in, so every chunk of a tiled world shares the same
 * fixed origin. `include(kind, x, z)` can drop features by position (building / park / road
 * area centroid, road midpoint, tree position), e.g. where another data source takes over.
 * Collision boxes are returned in `boxes` (not added anywhere), so a streaming world can add
 * and remove them per chunk.
 *
 * @returns {{ id, buildings, buildingById, roads, roadGrid, parks, trees, places, roofProps, boxes, bounds, stats }}
 */
export function generateCityChunk(osm, { projection: proj, terrain = FLAT_TERRAIN, options = DEFAULT_CITY_OPTIONS, seed = 'city', include = null, id = 'city' }) {
  const o = { ...DEFAULT_CITY_OPTIONS, ...options };
  const keep = include ?? (() => true);
  const rng = createRng(seed);
  const styleRng = rng.fork('style');
  const propRng = rng.fork('props');
  const treeRng = rng.fork('trees');
  // Boxes are collected in a private world (tree placement and rooftop props query it).
  const collision = new CityCollisionWorld({ cellSize: o.collisionCellSize });

  const projectRings = (rings) => {
    const out = [];
    for (let i = 0; i < rings.length; i++) {
      const r = cleanRing(proj.projectFlat(rings[i]));
      if (r) out.push(r);
      else if (i === 0) return null;
    }
    return orientRings(out);
  };

  // Buildings --------------------------------------------------------------------------------
  const buildings = [];
  const solar = [];
  const ac = [];
  let heightFromOsm = 0;

  for (const src of osm.buildings ?? []) {
    const rings = projectRings(src.rings);
    if (!rings) continue;
    const area = footprintArea(rings);
    if (area < 2) continue;
    const centroid = ringCentroid(rings[0]);
    if (!keep('building', centroid.x, centroid.z)) continue;
    const tags = src.tags ?? {};
    const h = resolveHeight(tags, area, src.id, o);
    if (h.source !== 'default') heightFromOsm++;

    const box = ringsBounds(rings);
    const canopy = h.kind === 'canopy';
    // Seat the building on the terrain: floors count from the lowest ground point, the roof
    // line from the highest (so the downhill side shows an extra, partly exposed storey,
    // as on Jerusalem's slopes), and the walls continue below ground as a foundation.
    const ground = footprintGround(terrain, rings, centroid);
    const bottomY = canopy ? ground.max + h.base : ground.min - o.foundationDepth;
    const topY = canopy ? ground.max + h.top : ground.max + h.top;
    const stone = mixHex(styleRng.pick(STONE), styleRng.pick(STONE), styleRng.next());
    const shop = tags.shop || tags.amenity ? 1 : styleRng.chance(0.35) ? 1 : 0;
    const street = tags['addr:street'];
    const roof = !canopy && PITCHED_ROOFS.has(tags['roof:shape']) && area <= o.tileRoofMaxArea && h.floors <= o.tileRoofMaxFloors
      ? hipRoof(rings[0], area, topY, o, styleRng)
      : null;
    const building = {
      id: `OSM-${src.id}`,
      osmId: src.id,
      kind: h.kind,
      type: tags.building,
      name: tags['name:en'] ?? tags.name ?? null,
      address: street ? `${tags['addr:housenumber'] ? `${tags['addr:housenumber']} ` : ''}${street}` : null,
      floors: h.floors,
      base: bottomY, // world Y of the bottom of the walls
      height: topY, // world Y of the roof (eaves for tile roofs)
      groundY: ground.min,
      heightAboveGround: topY - ground.min,
      heightSource: h.source,
      // Jerusalem roofs are overwhelmingly flat; a pitched-roof tag on a large building is
      // treated as flat (with rooftop equipment) rather than trusted.
      flatRoof: !roof,
      roof,
      rings,
      area,
      centroid,
      bounds: box,
      color: canopy ? COLORS.canopy : stone,
      // Facade shader inputs: (random seed, window density, ground-floor shops, ground-floor Y).
      facade: [styleRng.next(), canopy || h.floors < 1 ? 0 : SMALL_TYPES.has(tags.building) ? 0.3 : 1, canopy ? 0 : shop, ground.min],
      boxes: decomposeFootprint(rings, { step: o.collisionStep }),
    };
    buildings.push(building);
    for (const b of building.boxes) {
      collision.add({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, minY: bottomY, maxY: topY, kind: 'building', ref: building.id });
    }
    if (roof) {
      // Two stepped tiers approximate the roof volume, so you can stand on it but not walk through it.
      for (const tier of roof.tiers) {
        for (const b of decomposeFootprint([tier.ring], { step: 1 })) {
          collision.add({ ...b, minY: tier.minY, maxY: tier.maxY, kind: 'building', ref: building.id });
        }
      }
    }
    if (!canopy && building.flatRoof && area >= o.minPropRoofArea && h.top >= 5) {
      placeRoofProps(building, propRng, o, solar, ac, collision);
    }
  }

  // Roads ------------------------------------------------------------------------------------
  const roads = [];
  const roadGrid = new Map();
  const index = (minX, minZ, maxX, maxZ, entry) => {
    for (let ix = Math.floor(minX / ROAD_CELL); ix <= Math.floor(maxX / ROAD_CELL); ix++) {
      for (let iz = Math.floor(minZ / ROAD_CELL); iz <= Math.floor(maxZ / ROAD_CELL); iz++) {
        const k = `${ix},${iz}`;
        let list = roadGrid.get(k);
        if (!list) roadGrid.set(k, (list = []));
        list.push(entry);
      }
    }
  };

  for (const src of osm.roads ?? []) {
    const pts = proj.projectFlat(src.points);
    if (pts.length < 4) continue;
    const mid = polylineMidpoint(pts);
    if (!keep('road', mid.x, mid.z)) continue;
    const width = roadWidth(src);
    const road = {
      id: `OSM-${src.id}`,
      name: src.nameEn ?? src.name ?? null,
      nameLocal: src.name ?? null,
      highway: src.highway,
      surface: ASPHALT.has(src.highway) ? 'asphalt' : 'paving',
      major: MAJOR.has(src.highway),
      width,
      points: pts,
    };
    const ri = roads.push(road) - 1;
    const hw = width / 2;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      index(Math.min(pts[i], pts[i + 2]) - hw, Math.min(pts[i + 1], pts[i + 3]) - hw, Math.max(pts[i], pts[i + 2]) + hw, Math.max(pts[i + 1], pts[i + 3]) + hw, [ri, i]);
    }
  }
  for (const src of osm.roadAreas ?? []) {
    const rings = projectRings(src.rings);
    if (!rings) continue;
    const c = ringCentroid(rings[0]);
    if (!keep('roadArea', c.x, c.z)) continue;
    const road = {
      id: `OSM-${src.id}`,
      name: src.nameEn ?? src.name ?? null,
      nameLocal: src.name ?? null,
      highway: src.highway,
      surface: ASPHALT.has(src.highway) ? 'asphalt' : 'paving',
      major: MAJOR.has(src.highway),
      width: 0,
      rings,
    };
    const ri = roads.push(road) - 1;
    const b = ringsBounds(rings);
    index(b.minX, b.minZ, b.maxX, b.maxZ, [ri, -1]);
  }

  // Parks, trees, place labels ----------------------------------------------------------------
  const parks = [];
  for (const src of osm.parks ?? []) {
    const rings = projectRings(src.rings);
    if (!rings) continue;
    const c = ringCentroid(rings[0]);
    if (keep('park', c.x, c.z)) parks.push({ id: `OSM-${src.id}`, kind: src.kind, name: src.name, rings });
  }

  const trees = [];
  const treeCoords = osm.trees ?? [];
  for (let i = 0; i + 1 < treeCoords.length; i += 2) {
    const { x, z } = proj.project(treeCoords[i], treeCoords[i + 1]);
    if (!keep('tree', x, z)) continue;
    if (collision.queryPoint(x, terrain.heightAt(x, z) + 1, z).some((b) => b.kind === 'building')) continue;
    const tree = {
      x, z, y: terrain.heightAt(x, z),
      trunkHeight: treeRng.range(2.2, 3.6),
      trunkRadius: treeRng.range(0.16, 0.26),
      crownRadius: treeRng.range(1.8, 3.2),
      color: treeRng.pick(COLORS.crown),
    };
    trees.push(tree);
    collision.add({
      minX: x - tree.trunkRadius, maxX: x + tree.trunkRadius, minZ: z - tree.trunkRadius, maxZ: z + tree.trunkRadius,
      minY: tree.y, maxY: tree.y + tree.trunkHeight + tree.crownRadius, kind: 'tree', ref: null,
    });
  }

  const places = (osm.places ?? []).map((p) => ({ ...proj.project(p.lat, p.lon), id: p.id, name: p.nameEn ?? p.name, nameLocal: p.name, place: p.place }));

  // Extent of everything in the chunk (buildings, roads, parks), for culling and lookups.
  const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  const grow = (b) => {
    bounds.minX = Math.min(bounds.minX, b.minX); bounds.maxX = Math.max(bounds.maxX, b.maxX);
    bounds.minZ = Math.min(bounds.minZ, b.minZ); bounds.maxZ = Math.max(bounds.maxZ, b.maxZ);
  };
  for (const b of buildings) grow(b.bounds);
  for (const r of roads) {
    if (r.rings) grow(ringsBounds(r.rings));
    else {
      const hw = r.width / 2 + CURB_WIDTH;
      const rb = ringsBounds([r.points]);
      grow({ minX: rb.minX - hw, maxX: rb.maxX + hw, minZ: rb.minZ - hw, maxZ: rb.maxZ + hw });
    }
  }
  for (const pk of parks) grow(ringsBounds(pk.rings));

  return {
    id,
    buildings,
    buildingById: new Map(buildings.map((b) => [b.id, b])),
    roads,
    roadGrid,
    parks,
    trees,
    places,
    roofProps: { solar, ac },
    boxes: collision.boxes.filter(Boolean),
    bounds,
    stats: {
      buildings: buildings.length,
      buildingsWithOsmHeight: heightFromOsm,
      canopies: buildings.filter((b) => b.kind === 'canopy').length,
      tileRoofs: buildings.filter((b) => b.roof).length,
      tallest: buildings.reduce((mx, b) => Math.max(mx, b.heightAboveGround), 0),
      roads: roads.length,
      parks: parks.length,
      trees: trees.length,
      solarHeaters: solar.length,
      acUnits: ac.length,
      colliders: collision.count,
    },
  };
}

/** Point halfway along a flat [x, z, ...] polyline (by length). */
export function polylineMidpoint(pts) {
  let total = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) total += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  let half = total / 2;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const len = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    if (len >= half && len > 0) {
      const t = half / len;
      return { x: pts[i] + (pts[i + 2] - pts[i]) * t, z: pts[i + 1] + (pts[i + 3] - pts[i + 1]) * t };
    }
    half -= len;
  }
  return { x: pts[0], z: pts[1] };
}

export class CityGenerator {
  /** @param {Partial<typeof DEFAULT_CITY_OPTIONS>} [options] */
  constructor(options = {}) {
    this.options = { ...DEFAULT_CITY_OPTIONS, ...options };
    const osm = this.options.osm;
    if (!osm || !osm.bbox || !Array.isArray(osm.buildings)) {
      throw new Error('CityGenerator: options.osm must be the JSON written by scripts/fetch_jerusalem.js');
    }
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
    const osm = o.osm;
    const proj = createProjection(osm.bbox);
    const bounds = proj.bounds;
    const terrain = o.elevation ? createTerrain(o.elevation, proj) : FLAT_TERRAIN;
    const collision = new CityCollisionWorld({ cellSize: o.collisionCellSize, groundHeightAt: terrain.flat ? null : terrain.heightAt });
    const m = o.groundMargin;
    const chunk = generateCityChunk(osm, {
      projection: proj,
      terrain,
      options: o,
      seed: o.seed,
      include: (kind, x, z) => kind !== 'tree' || (x >= bounds.minX - m && x <= bounds.maxX + m && z >= bounds.minZ - m && z <= bounds.maxZ + m),
    });
    for (const box of chunk.boxes) collision.add(box);

    const data = {
      seed: o.seed,
      name: o.name,
      source: { attribution: osm.attribution, license: osm.license, fetchedAt: osm.fetchedAt, bbox: osm.bbox },
      options: { ...o, osm: undefined },
      projection: proj,
      terrain,
      bounds,
      ...chunk,
      collision,
      spawn: null,
      stats: {
        ...chunk.stats,
        terrain: terrain.flat ? 'flat' : `${terrain.datum.toFixed(0)}–${(terrain.datum + terrain.maxHeight).toFixed(0)} m ASL`,
        colliders: collision.count,
      },
    };
    data.spawn = findSpawn(data);
    return data;
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
    group.name = `City(${data.name})`;
    const disposables = new Set();
    const track = (x) => (disposables.add(x), x);
    const uniforms = { uNight: { value: 0 } };
    const add = (mesh) => {
      group.add(mesh);
      return mesh;
    };
    const addAll = ({ meshes, geometries }) => {
      for (const mm of meshes) group.add(mm);
      for (const g of geometries) disposables.add(g);
    };
    const { bounds } = data;
    const origin = {
      x: bounds.minX, z: bounds.minZ,
      nx: Math.max(1, Math.round((bounds.maxX - bounds.minX) / o.chunkSize)),
      nz: Math.max(1, Math.round((bounds.maxZ - bounds.minZ) / o.chunkSize)),
    };
    const margin = o.groundMargin;
    const width = bounds.maxX - bounds.minX + margin * 2, depth = bounds.maxZ - bounds.minZ + margin * 2;
    const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;

    // Ground: a detailed terrain grid (8 m) with stone paving over the data area + margin,
    // and a coarse one (32 m) for the surroundings, with the rest of the city's lights. The
    // coarse grid runs under the detailed one, 0.3 m lower, so there is no seam to stitch.
    // It extends past the heightmap far enough for the terrain to ease back to its mean edge
    // height, where a large flat plane takes over to the horizon.
    const { terrain } = data;
    const inner = { minX: bounds.minX - margin, maxX: bounds.maxX + margin, minZ: bounds.minZ - margin, maxZ: bounds.maxZ + margin };
    const reach = terrain.flat ? 200 : 700;
    const terrainMesh = add(new THREE.Mesh(
      track(terrainGeometry(terrain, inner, terrain.flat ? 50 : 8, 0)),
      track(createSurfaceMaterial('paving', COLORS.ground, { roughness: 0.9, uniforms })),
    ));
    terrainMesh.name = 'Terrain';
    terrainMesh.receiveShadow = true;
    const surroundingsMesh = add(new THREE.Mesh(
      track(terrainGeometry(terrain, {
        minX: inner.minX - reach, maxX: inner.maxX + reach, minZ: inner.minZ - reach, maxZ: inner.maxZ + reach,
      }, terrain.flat ? 200 : 32, -0.3)),
      track(createOuterGroundMaterial(uniforms, bounds)),
    ));
    surroundingsMesh.name = 'TerrainSurroundings';
    surroundingsMesh.receiveShadow = true;
    const outer = add(new THREE.Mesh(
      track(new THREE.PlaneGeometry(width + 8000, depth + 8000).rotateX(-Math.PI / 2).translate(cx, terrain.meanEdge - 0.4, cz)),
      track(createOuterGroundMaterial(uniforms, bounds)),
    ));
    outer.name = 'OuterGround';
    outer.receiveShadow = true;

    // Flat ground layers, draped over the terrain (subdivided so they follow it) and ordered
    // with a small lift plus polygon offset: parks < paving < curb stones < asphalt < markings.
    const layer = (name, geometries, material, lift) => {
      if (!geometries.length) return;
      const merged = mergeGeometries(geometries, false);
      for (const g of geometries) g.dispose();
      const geo = track(drapeGeometry(merged, terrain, lift, 6));
      merged.dispose();
      const mesh = add(new THREE.Mesh(geo, track(material)));
      mesh.name = name;
      mesh.receiveShadow = true;
    };
    layer('Parks', data.parks.map((p) => flatPolygonGeometry(p.rings, 0)), createSurfaceMaterial('grass', COLORS.park, { offset: -3 }), 0.02);
    const geos = { asphalt: [], paving: [], curb: [], marking: [] };
    for (const r of data.roads) {
      geos[r.surface].push(r.rings ? flatPolygonGeometry(r.rings, 0) : ribbonGeometry(r.points, r.width / 2, 0));
      if (r.surface !== 'asphalt' || !r.points) continue;
      // A curb-stone band just outside the carriageway, and a dashed center line on wider roads.
      geos.curb.push(curbGeometry(r.points, r.width / 2, CURB_WIDTH));
      if (r.width >= 8) geos.marking.push(dashedLineGeometry(r.points, 0.07, 3, 4));
    }
    layer('Paving', geos.paving, createSurfaceMaterial('paving', COLORS.paving, { offset: -7, uniforms }), 0.04);
    layer('Curbs', geos.curb, createSurfaceMaterial('curb', COLORS.curb, { roughness: 0.85, offset: -11, uniforms }), 0.05);
    layer('Roads', geos.asphalt, createSurfaceMaterial('asphalt', COLORS.asphalt, { roughness: 0.93, offset: -15, uniforms }), 0.06);
    layer('Markings', geos.marking, createSurfaceMaterial('marking', COLORS.marking, { roughness: 0.7, offset: -19, uniforms }), 0.08);

    // Buildings: real footprints extruded, merged per chunk with BufferGeometryUtils.
    const chunks = new Map();
    for (const b of data.buildings) {
      const key = chunkKey(b.centroid.x, b.centroid.z, origin, o.chunkSize);
      let list = chunks.get(key);
      if (!list) chunks.set(key, (list = []));
      list.push(extrudeBuilding(b));
    }
    const stoneMat = track(createStoneMaterial(uniforms, o.floorHeight));
    for (const [key, geos] of chunks) {
      const geo = track(mergeGeometries(geos, false));
      for (const g of geos) g.dispose();
      geo.computeBoundingSphere();
      const mesh = add(new THREE.Mesh(geo, stoneMat));
      mesh.name = `Buildings[${key}]`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }

    // Rooftop details: "dud shemesh" solar water heaters (white tank + tilted collector) and AC units.
    const { solar, ac } = data.roofProps;
    const inst = (items, opts) => addAll(buildChunkedInstances(items, { origin, chunkSize: o.chunkSize, castShadow: true, receiveShadow: true, ...opts }));
    const boxBottom = track(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
    // Rooftop props are tagged userData.detail: they are hidden per chunk beyond
    // propDrawDistance, and the renderer may skip them in far shadow cascades (they are ~95%
    // of all shadow-casting triangles, and invisible there anyway).
    const propOrigin = {
      x: bounds.minX, z: bounds.minZ,
      nx: Math.max(1, Math.round((bounds.maxX - bounds.minX) / o.propChunkSize)),
      nz: Math.max(1, Math.round((bounds.maxZ - bounds.minZ) / o.propChunkSize)),
    };
    const detailOpts = { detail: true, origin: propOrigin, chunkSize: o.propChunkSize };
    inst(solar.map((s) => ({ x: s.x, y: s.y, z: s.z, sx: 1, sy: 1, sz: 1, color: 0xffffff })), {
      name: 'SolarHeaters', geometry: track(solarHeaterGeometry()), ...detailOpts,
      material: track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 })),
    });
    inst(ac.map((a) => ({ x: a.x, y: a.y, z: a.z, sx: a.w, sy: a.h, sz: a.d, ry: a.yaw, color: COLORS.ac })), {
      name: 'AcUnits', geometry: boxBottom, ...detailOpts,
      material: track(new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2 })),
    });

    // Trees (OSM natural=tree).
    const trunkGeo = track(new THREE.CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0));
    const crownGeo = track(new THREE.IcosahedronGeometry(1, 1));
    inst(data.trees.map((t) => ({ x: t.x, y: t.y, z: t.z, sx: t.trunkRadius, sy: t.trunkHeight + t.crownRadius * 0.5, sz: t.trunkRadius, color: COLORS.trunk })), {
      name: 'TreeTrunks', geometry: trunkGeo, receiveShadow: false,
      material: track(new THREE.MeshStandardMaterial({ roughness: 1 })),
    });
    inst(data.trees.map((t) => ({ x: t.x, y: t.y + t.trunkHeight + t.crownRadius * 0.6, z: t.z, sx: t.crownRadius, sy: t.crownRadius * 0.85, sz: t.crownRadius, color: t.color })), {
      name: 'TreeCrowns', geometry: crownGeo,
      material: track(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true })),
    });

    // Everything is static: freeze world matrices once.
    group.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
    });
    group.updateMatrixWorld(true);

    const detailMeshes = [];
    group.traverse((obj) => obj.userData.detail && detailMeshes.push(obj));
    const drawDist2 = o.propDrawDistance * o.propDrawDistance;

    return {
      group,
      uniforms,
      setNight(v) {
        uniforms.uNight.value = v;
      },
      /** Per frame: hides rooftop-prop chunks farther than propDrawDistance from the camera. */
      update(camera) {
        const p = camera.position;
        for (const m of detailMeshes) m.visible = m.boundingBox.distanceToPoint(p) ** 2 < drawDist2;
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
// Rooftops
// -----------------------------------------------------------------------------------------------

const SOLAR_TILT = (40 * Math.PI) / 180;

/**
 * One "dud shemesh" as a single merged geometry (so one InstancedMesh draws the whole unit),
 * facing south (+Z), anchored at roof level: white 6-sided tank at the back, a dark collector
 * tilted 40° in front of it, and a gray frame under the collector. Colors are per vertex.
 */
function solarHeaterGeometry() {
  const part = (geo, hex) => {
    const g = geo.toNonIndexed();
    geo.dispose();
    g.deleteAttribute('uv');
    const c = new THREE.Color(hex);
    const col = new Float32Array(g.getAttribute('position').count * 3);
    for (let i = 0; i < col.length; i += 3) { col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };
  const tank = part(new THREE.CylinderGeometry(0.33, 0.33, 1.95, 6, 1, false).translate(0, 0.975, -0.75), COLORS.solarTank);
  const panel = part(new THREE.BoxGeometry(0.95, 0.05, 1.6).rotateX(SOLAR_TILT).translate(0, 0.35 + Math.sin(SOLAR_TILT) * 0.8, 0.3), COLORS.solarPanel);
  const frame = part(new THREE.BoxGeometry(0.85, 0.35, 1.1).translate(0, 0.175, 0.3), COLORS.solarFrame);
  const merged = mergeGeometries([tank, panel, frame], false);
  for (const g of [tank, panel, frame]) g.dispose();
  return merged;
}
// Footprint of one solar water heater relative to its anchor (tank behind, collector in front,
// facing south = +Z). Used for placement and as its collision box.
const SOLAR_BOX = { minX: -0.5, maxX: 0.5, minZ: -1.1, maxZ: 0.95, height: 1.95 };
const AC_SIZE = { w: 0.9, h: 0.65, d: 0.38 };

/** Direction (radians, around +Y) of the longest outline edge, used to align AC units with the walls. */
function mainAngle(ring) {
  let best = 0, angle = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const dx = ring[i] - ring[j], dz = ring[i + 1] - ring[j + 1];
    const l = dx * dx + dz * dz;
    if (l > best) { best = l; angle = Math.atan2(dx, dz); }
  }
  return angle;
}

const overlaps = (a, list, pad = 0.2) =>
  list.some((b) => a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minZ < b.maxZ + pad && a.maxZ > b.minZ - pad);

function boxInside(rings, b, margin) {
  const pts = [b.minX, b.minZ, b.maxX, b.minZ, b.maxX, b.maxZ, b.minX, b.maxZ, (b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
  for (let i = 0; i < pts.length; i += 2) {
    if (!pointInRings(rings, pts[i], pts[i + 1]) || distanceToEdges(rings, pts[i], pts[i + 1]) < margin) return false;
  }
  return true;
}

function placeRoofProps(building, rng, o, solarOut, acOut, collision) {
  const { rings, bounds, area } = building;
  const y = building.height;
  const placed = [];
  const MARGIN = 0.45; // keep clear of the parapet

  // Solar water heaters: a tight south-facing cluster, like the rows on real Jerusalem roofs.
  if (rng.chance(o.solarChance)) {
    const want = Math.min(o.maxSolarPerRoof, Math.max(1, Math.round(area * o.solarPerM2)));
    const SX = 1.3, SZ = 2.75;
    const cells = [];
    for (let x = bounds.minX + 0.6; x <= bounds.maxX - 0.6; x += SX) {
      for (let z = bounds.minZ + 1.2; z <= bounds.maxZ - 1.2; z += SZ) {
        const b = { minX: x + SOLAR_BOX.minX, maxX: x + SOLAR_BOX.maxX, minZ: z + SOLAR_BOX.minZ, maxZ: z + SOLAR_BOX.maxZ };
        if (boxInside(rings, b, MARGIN)) cells.push({ x, z, b });
      }
    }
    if (cells.length) {
      const anchor = rng.pick(cells);
      // Rows are wider than deep: weight Z distance so the cluster grows along X first.
      cells.sort((p, q) => Math.hypot(p.x - anchor.x, (p.z - anchor.z) * 1.6) - Math.hypot(q.x - anchor.x, (q.z - anchor.z) * 1.6));
      for (const c of cells.slice(0, want)) {
        solarOut.push({ x: c.x, y, z: c.z, buildingId: building.id });
        placed.push(c.b);
        collision.add({ ...c.b, minY: y, maxY: y + SOLAR_BOX.height, kind: 'roof-prop', ref: building.id });
      }
    }
  }

  // AC compressors, aligned with the building's walls.
  const count = Math.min(o.maxAcPerRoof, Math.round(area * o.acPerM2 * rng.range(0.5, 1.5)));
  const angle = mainAngle(rings[0]);
  for (let tries = 0, n = 0; n < count && tries < count * 8; tries++) {
    const x = rng.range(bounds.minX, bounds.maxX), z = rng.range(bounds.minZ, bounds.maxZ);
    if (!discInside(rings, x, z, 0.6 + MARGIN)) continue;
    const yaw = angle + rng.int(0, 3) * (Math.PI / 2);
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    const hx = (AC_SIZE.w * c + AC_SIZE.d * s) / 2, hz = (AC_SIZE.w * s + AC_SIZE.d * c) / 2;
    const b = { minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz };
    if (overlaps(b, placed)) continue;
    placed.push(b);
    acOut.push({ x, y, z, yaw, ...AC_SIZE, buildingId: building.id });
    collision.add({ ...b, minY: y, maxY: y + AC_SIZE.h, kind: 'roof-prop', ref: building.id });
    n++;
  }
}

// -----------------------------------------------------------------------------------------------
// Tile roofs
// -----------------------------------------------------------------------------------------------

/** A hipped roof over the footprint's oriented box, or null if the footprint isn't rectangular enough. */
function hipRoof(ring, area, eaveY, o, rng) {
  const obb = orientedBox(ring);
  if (!obb || area / obb.area < 0.8 || obb.hw < 2) return null;
  const hl = obb.hl + o.tileRoofOverhang, hw = obb.hw + o.tileRoofOverhang;
  const rise = hw * Math.tan((o.tileRoofPitchDeg * Math.PI) / 180);
  const ridge = hl - hw; // hips meet at a point when the footprint is square
  const at = (l, w) => [obb.cx + obb.ax * l - obb.az * w, obb.cz + obb.az * l + obb.ax * w];
  const rect = (l, w) => [...at(-l, -w), ...at(l, -w), ...at(l, w), ...at(-l, w)];
  return {
    ...obb,
    eaveY,
    rise,
    ridge,
    color: mixHex(rng.pick(TILES), rng.pick(TILES), rng.next()),
    // Faces as [x, y, z] triangles: two trapezoids along the long sides, two hip triangles.
    eaves: [at(-hl, -hw), at(hl, -hw), at(hl, hw), at(-hl, hw)],
    ridgeEnds: [at(-ridge, 0), at(ridge, 0)],
    tiers: [
      { ring: rect(obb.hl - obb.hw * 0.1, obb.hw * 0.66), minY: eaveY, maxY: eaveY + rise * 0.4 },
      { ring: rect(Math.max(0.5, obb.hl - obb.hw * 0.55), obb.hw * 0.3), minY: eaveY + rise * 0.4, maxY: eaveY + rise * 0.75 },
    ],
  };
}

// -----------------------------------------------------------------------------------------------
// Spawn
// -----------------------------------------------------------------------------------------------

/**
 * A point on a real street at ground level with nothing around it: prefers Jaffa Road,
 * then other major streets, closest to the center of the area.
 */
function findSpawn(data) {
  const { collision, bounds } = data;
  const CLEAR = 0.8;
  const free = (x, z) => {
    if (!(x > bounds.minX + 5 && x < bounds.maxX - 5 && z > bounds.minZ + 5 && z < bounds.maxZ - 5)) return false;
    const y = collision.terrainHeight(x, z);
    return collision.queryAABB(x - CLEAR, y + 0.01, z - CLEAR, x + CLEAR, y + 2.2, z + CLEAR).length === 0;
  };

  const samples = [];
  for (const r of data.roads) {
    if (!r.points) continue;
    const jaffa = /jaffa|yafo|יפו/i.test(`${r.name} ${r.nameLocal}`);
    const penalty = jaffa ? 0 : r.major ? 250 : 600;
    const p = r.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
      for (let t = 0; t <= len; t += 4) {
        const x = p[i] + ((p[i + 2] - p[i]) * t) / (len || 1), z = p[i + 1] + ((p[i + 3] - p[i + 1]) * t) / (len || 1);
        samples.push({ x, z, score: Math.hypot(x, z) + penalty, road: r, dir: Math.atan2(p[i + 2] - p[i], p[i + 3] - p[i + 1]) });
      }
    }
  }
  samples.sort((a, b) => a.score - b.score);
  for (const s of samples) {
    if (free(s.x, s.z)) return { x: s.x, y: collision.terrainHeight(s.x, s.z), z: s.z, heading: s.dir, roadId: s.road.id };
  }
  // No usable street: spiral out from the center.
  for (let r = 0; r < 800; r += 2) {
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (free(x, z)) return { x, y: collision.terrainHeight(x, z), z, heading: 0, roadId: null };
    }
  }
  return { x: 0, y: collision.groundHeight(0, 0), z: 0, heading: 0, roadId: null };
}

// -----------------------------------------------------------------------------------------------
// Geometry helpers
// -----------------------------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _c = new THREE.Color();

// Chunk index, clamped to the data area: stray buildings just outside the bbox join the
// edge chunk instead of creating extra (draw-call-costing) chunks of their own.
const chunkKey = (x, z, origin, size) =>
  `${Math.min(origin.nx - 1, Math.max(0, Math.floor((x - origin.x) / size)))},${Math.min(origin.nz - 1, Math.max(0, Math.floor((z - origin.z) / size)))}`;

/**
 * Groups items into square chunks and emits one InstancedMesh per chunk.
 * Each chunk gets a tight bounding sphere, so three.js frustum-culls whole chunks
 * (and skips them in the shadow pass) with zero per-instance CPU cost.
 *
 * Item shape: { x, y, z, sx, sy, sz, color, rx?, ry? } (rx = pitch, ry = yaw, radians)
 */
function buildChunkedInstances(items, { geometry, material, chunkSize, origin, name, castShadow = false, receiveShadow = false, detail = false }) {
  const chunks = new Map();
  for (const it of items) {
    const key = chunkKey(it.x, it.z, origin, chunkSize);
    let list = chunks.get(key);
    if (!list) chunks.set(key, (list = []));
    list.push(it);
  }
  const meshes = [];
  for (const [key, list] of chunks) {
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    mesh.name = `${name}[${key}]`;
    list.forEach((it, i) => {
      _p.set(it.x, it.y, it.z);
      _s.set(it.sx, it.sy, it.sz);
      _q.setFromEuler(_e.set(it.rx ?? 0, it.ry ?? 0, 0));
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
    mesh.userData.detail = detail;
    meshes.push(mesh);
  }
  return { meshes, geometries: [] };
}

/** Collects non-indexed triangles, flipping each so its winding matches the intended normal. */
class TriangleSink {
  constructor(extra = null) {
    this.pos = [];
    this.nrm = [];
    this.extra = extra; // { color: [r,g,b], facade: [a,b,c] } per vertex, optional
    this.col = [];
    this.fac = [];
  }

  tri(a, b, c, n) {
    // (b - a) x (c - a) must point along n, otherwise swap b and c.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const dot = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
    if (dot < 0) [b, c] = [c, b];
    this.pos.push(...a, ...b, ...c);
    this.nrm.push(...n, ...n, ...n);
    if (this.extra) {
      for (let i = 0; i < 3; i++) {
        this.col.push(...this.extra.color);
        this.fac.push(...this.extra.facade);
      }
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (this.extra) {
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
      g.setAttribute('aFacade', new THREE.Float32BufferAttribute(this.fac, 4));
    }
    return g;
  }
}

const UP = [0, 1, 0];
const DOWN = [0, -1, 0];

/** Triangulates a footprint (outline + holes) at height y. */
function capTriangles(rings, y, n, sink) {
  const toV2 = (r) => {
    const out = [];
    for (let i = 0; i < r.length; i += 2) out.push(new THREE.Vector2(r[i], r[i + 1]));
    return out;
  };
  const contour = toV2(rings[0]);
  const holes = rings.slice(1).map(toV2);
  const all = contour.concat(...holes);
  for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
    sink.tri([all[i].x, y, all[i].y], [all[j].x, y, all[j].y], [all[k].x, y, all[k].y], n);
  }
}

function flatPolygonGeometry(rings, y) {
  const sink = new TriangleSink();
  capTriangles(rings, y, UP, sink);
  return sink.geometry();
}

/** A flat strip of half-width `hw` along a polyline, with round joins and caps. */
function ribbonGeometry(points, hw, y) {
  const sink = new TriangleSink();
  const n = points.length / 2;
  for (let i = 0; i < n - 1; i++) {
    const ax = points[i * 2], az = points[i * 2 + 1], bx = points[i * 2 + 2], bz = points[i * 2 + 3];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) continue;
    const ox = (-(bz - az) / len) * hw, oz = ((bx - ax) / len) * hw;
    const a0 = [ax + ox, y, az + oz], a1 = [ax - ox, y, az - oz], b0 = [bx + ox, y, bz + oz], b1 = [bx - ox, y, bz - oz];
    sink.tri(a0, a1, b1, UP);
    sink.tri(a0, b1, b0, UP);
  }
  const SEG = hw > 3 ? 12 : 8;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2], z = points[i * 2 + 1];
    for (let k = 0; k < SEG; k++) {
      const t0 = (k / SEG) * Math.PI * 2, t1 = ((k + 1) / SEG) * Math.PI * 2;
      sink.tri([x, y, z], [x + Math.cos(t0) * hw, y, z + Math.sin(t0) * hw], [x + Math.cos(t1) * hw, y, z + Math.sin(t1) * hw], UP);
    }
  }
  return sink.geometry();
}

const CURB_WIDTH = 0.3;

/**
 * Regular grid over `rect` following the terrain (+ yOffset), with smooth terrain normals.
 * With `skirt` > 0 each edge also gets a strip hanging `skirt` meters straight down, which
 * hides the cracks where neighbouring grids of different resolution meet.
 */
export function terrainGeometry(terrain, rect, spacing, yOffset = 0, skirt = 0) {
  const nx = Math.max(1, Math.round((rect.maxX - rect.minX) / spacing));
  const nz = Math.max(1, Math.round((rect.maxZ - rect.minZ) / spacing));
  const sx = (rect.maxX - rect.minX) / nx, sz = (rect.maxZ - rect.minZ) / nz;
  const gridVerts = (nx + 1) * (nz + 1);
  // Perimeter, counter-clockwise seen from above: south edge (z = max) west->east, then east, north, west.
  const perimeter = [];
  if (skirt > 0) {
    for (let i = 0; i < nx; i++) perimeter.push(nz * (nx + 1) + i);
    for (let j = nz; j > 0; j--) perimeter.push(j * (nx + 1) + nx);
    for (let i = nx; i > 0; i--) perimeter.push(i);
    for (let j = 0; j < nz; j++) perimeter.push(j * (nx + 1));
  }
  const totalVerts = gridVerts + perimeter.length;
  const pos = new Float32Array(totalVerts * 3);
  const nrm = new Float32Array(pos.length);
  for (let j = 0, k = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++, k += 3) {
      const x = rect.minX + i * sx, z = rect.minZ + j * sz;
      pos[k] = x;
      pos[k + 1] = terrain.heightAt(x, z) + yOffset;
      pos[k + 2] = z;
      const n = terrainNormal(terrain, x, z);
      nrm[k] = n[0]; nrm[k + 1] = n[1]; nrm[k + 2] = n[2];
    }
  }
  // Skirt vertices: copies of the perimeter, lowered (same normal, so they shade like the ground).
  perimeter.forEach((v, p) => {
    const k = (gridVerts + p) * 3;
    pos[k] = pos[v * 3]; pos[k + 1] = pos[v * 3 + 1] - skirt; pos[k + 2] = pos[v * 3 + 2];
    nrm[k] = nrm[v * 3]; nrm[k + 1] = nrm[v * 3 + 1]; nrm[k + 2] = nrm[v * 3 + 2];
  });
  const index = new (totalVerts > 65535 ? Uint32Array : Uint16Array)(nx * nz * 6 + perimeter.length * 12);
  let k = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++, k += 6) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      index[k] = a; index[k + 1] = c; index[k + 2] = b; // counter-clockwise seen from above
      index[k + 3] = b; index[k + 4] = c; index[k + 5] = d;
    }
  }
  for (let p = 0; p < perimeter.length; p++, k += 12) {
    const a = perimeter[p], b = perimeter[(p + 1) % perimeter.length];
    const a2 = gridVerts + p, b2 = gridVerts + ((p + 1) % perimeter.length);
    // Both windings: the strip is seen from either side depending on which neighbour is lower.
    index[k] = a; index[k + 1] = a2; index[k + 2] = b;
    index[k + 3] = b; index[k + 4] = a2; index[k + 5] = b2;
    index[k + 6] = a; index[k + 7] = b; index[k + 8] = a2;
    index[k + 9] = b; index[k + 10] = b2; index[k + 11] = a2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

function terrainNormal(terrain, x, z, e = 1) {
  const nx = terrain.heightAt(x - e, z) - terrain.heightAt(x + e, z);
  const nz = terrain.heightAt(x, z - e) - terrain.heightAt(x, z + e);
  const l = Math.hypot(nx, 2 * e, nz);
  return [nx / l, (2 * e) / l, nz / l];
}

/**
 * Lays a flat (y = 0, non-indexed) geometry onto the terrain: splits triangles until no edge
 * is longer than `maxEdge`, then sets every vertex to terrain height + `lift` with the
 * terrain's normal.
 */
function drapeGeometry(geometry, terrain, lift, maxEdge) {
  const src = geometry.getAttribute('position').array;
  const out = [];
  const max2 = maxEdge * maxEdge;
  const split = (ax, az, bx, bz, cx, cz, depth) => {
    const ab = (ax - bx) ** 2 + (az - bz) ** 2, bc = (bx - cx) ** 2 + (bz - cz) ** 2, ca = (cx - ax) ** 2 + (cz - az) ** 2;
    const m = Math.max(ab, bc, ca);
    if (terrain.flat || m <= max2 || depth > 12) {
      out.push(ax, az, bx, bz, cx, cz);
      return;
    }
    // Bisect the longest edge (keeps winding).
    if (m === ab) {
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      split(ax, az, mx, mz, cx, cz, depth + 1);
      split(mx, mz, bx, bz, cx, cz, depth + 1);
    } else if (m === bc) {
      const mx = (bx + cx) / 2, mz = (bz + cz) / 2;
      split(ax, az, bx, bz, mx, mz, depth + 1);
      split(ax, az, mx, mz, cx, cz, depth + 1);
    } else {
      const mx = (cx + ax) / 2, mz = (cz + az) / 2;
      split(ax, az, bx, bz, mx, mz, depth + 1);
      split(mx, mz, bx, bz, cx, cz, depth + 1);
    }
  };
  for (let i = 0; i < src.length; i += 9) split(src[i], src[i + 2], src[i + 3], src[i + 5], src[i + 6], src[i + 8], 0);

  const n = out.length / 2;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const x = out[v * 2], z = out[v * 2 + 1];
    pos[v * 3] = x;
    pos[v * 3 + 1] = terrain.heightAt(x, z) + lift;
    pos[v * 3 + 2] = z;
    const t = terrain.flat ? [0, 1, 0] : terrainNormal(terrain, x, z);
    nrm[v * 3] = t[0]; nrm[v * 3 + 1] = t[1]; nrm[v * 3 + 2] = t[2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.computeBoundingSphere();
  return g;
}

/**
 * Curb stones: two thin bands along the outer edges of a carriageway of half-width `hw`,
 * with ring segments around each vertex so corners and ends stay closed. Only the band is
 * built (the carriageway itself is drawn by the road ribbon on top).
 */
function curbGeometry(points, hw, w) {
  const sink = new TriangleSink();
  const n = points.length / 2;
  const r0 = hw, r1 = hw + w;
  for (let i = 0; i < n - 1; i++) {
    const ax = points[i * 2], az = points[i * 2 + 1], bx = points[i * 2 + 2], bz = points[i * 2 + 3];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) continue;
    const px = -(bz - az) / len, pz = (bx - ax) / len;
    for (const side of [1, -1]) {
      const i0 = [ax + px * r0 * side, 0, az + pz * r0 * side], o0 = [ax + px * r1 * side, 0, az + pz * r1 * side];
      const i1 = [bx + px * r0 * side, 0, bz + pz * r0 * side], o1 = [bx + px * r1 * side, 0, bz + pz * r1 * side];
      sink.tri(i0, o0, o1, UP);
      sink.tri(i0, o1, i1, UP);
    }
  }
  const SEG = 10;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2], z = points[i * 2 + 1];
    for (let k = 0; k < SEG; k++) {
      const t0 = (k / SEG) * Math.PI * 2, t1 = ((k + 1) / SEG) * Math.PI * 2;
      const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      const a = [x + c0 * r0, 0, z + s0 * r0], b = [x + c0 * r1, 0, z + s0 * r1];
      const c = [x + c1 * r1, 0, z + s1 * r1], d = [x + c1 * r0, 0, z + s1 * r0];
      sink.tri(a, b, c, UP);
      sink.tri(a, c, d, UP);
    }
  }
  return sink.geometry();
}

/** Thin dashes centered on a polyline (lane markings). */
function dashedLineGeometry(points, hw, dash, gap) {
  const sink = new TriangleSink();
  let phase = 0;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = points[i], az = points[i + 1], bx = points[i + 2], bz = points[i + 3];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) continue;
    const dx = (bx - ax) / len, dz = (bz - az) / len, ox = -dz * hw, oz = dx * hw;
    for (let t = -phase; t < len; t += dash + gap) {
      const t0 = Math.max(0, t), t1 = Math.min(len, t + dash);
      if (t1 <= t0) continue;
      const p0 = [ax + dx * t0, az + dz * t0], p1 = [ax + dx * t1, az + dz * t1];
      sink.tri([p0[0] + ox, 0, p0[1] + oz], [p0[0] - ox, 0, p0[1] - oz], [p1[0] - ox, 0, p1[1] - oz], UP);
      sink.tri([p0[0] + ox, 0, p0[1] + oz], [p1[0] - ox, 0, p1[1] - oz], [p1[0] + ox, 0, p1[1] + oz], UP);
    }
    phase = (phase + len) % (dash + gap);
  }
  return sink.geometry();
}

const _lin = new THREE.Color();

/** Walls + flat roof (and underside for canopies) for one building, with facade attributes. */
export function extrudeBuilding(b) {
  _lin.setHex(b.color); // converted to linear, like material colors
  const sink = new TriangleSink({ color: [_lin.r, _lin.g, _lin.b], facade: b.facade });
  const y0 = b.base, y1 = b.height;
  // Rings are oriented (outline CCW / positive area, holes CW), so the solid is always
  // on the left of each edge and the outward normal is the edge direction turned right.
  for (const r of b.rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const ax = r[j], az = r[j + 1], bx = r[i], bz = r[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-4) continue;
      const n = [(bz - az) / len, 0, -(bx - ax) / len];
      sink.tri([ax, y0, az], [bx, y0, bz], [bx, y1, bz], n);
      sink.tri([ax, y0, az], [bx, y1, bz], [ax, y1, az], n);
    }
  }
  if (b.roof) {
    addHipRoof(b.roof, sink);
  } else {
    capTriangles(b.rings, y1, UP, sink);
  }
  if (b.kind === 'canopy') capTriangles(b.rings, y0, DOWN, sink);
  return sink.geometry();
}

function addHipRoof(roof, sink) {
  _lin.setHex(roof.color);
  sink.extra = { color: [_lin.r, _lin.g, _lin.b], facade: [sink.extra.facade[0], 0, 0, sink.extra.facade[3]] };
  const y0 = roof.eaveY, y1 = roof.eaveY + roof.rise;
  const [e0, e1, e2, e3] = roof.eaves.map(([x, z]) => [x, y0, z]);
  const [r0, r1] = roof.ridgeEnds.map(([x, z]) => [x, y1, z]);
  const face = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(...n) || 1;
    n = n.map((v) => v / l);
    if (n[1] < 0) n = n.map((v) => -v);
    sink.tri(a, b, c, n);
  };
  // Long sides (e0-e1 and e2-e3 run along the ridge), then the two hip ends.
  face(e0, e1, r1); face(e0, r1, r0);
  face(e2, e3, r0); face(e2, r0, r1);
  face(e1, e2, r1);
  face(e3, e0, r0);
  // Eave soffit, facing down.
  sink.tri(e0, e1, e2, DOWN);
  sink.tri(e0, e2, e3, DOWN);
}

// -----------------------------------------------------------------------------------------------
// Materials
// -----------------------------------------------------------------------------------------------

// Shared GLSL helpers (hash, value noise, anti-aliased rectangle).
const GLSL_COMMON = /* glsl */ `
float cityHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float cityNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = cityHash(vec3(i, 0.0)), b = cityHash(vec3(i + vec2(1.0, 0.0), 0.0));
  float c = cityHash(vec3(i + vec2(0.0, 1.0), 0.0)), d = cityHash(vec3(i + vec2(1.0, 1.0), 0.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float cityFbm(vec2 p) {
  return 0.55 * cityNoise(p) + 0.3 * cityNoise(p * 2.13 + 7.1) + 0.15 * cityNoise(p * 4.37 + 3.3);
}
// 1 inside the centered box of half-size h (meters), anti-aliased over aa.
float cityBox(vec2 p, vec2 h, float aa) {
  vec2 m = 1.0 - smoothstep(-aa, aa, abs(p) - h);
  return m.x * m.y;
}
// Street lamps jittered on a 30 m grid (70% lit): bulbs plus soft light pools, summed over the
// neighbouring cells so pools are round. Far away (aa = meters per pixel) it fades to the average.
float cityLamps(vec2 p, float aa) {
  vec2 base = floor(p / 30.0);
  float light = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 c = base + vec2(float(dx), float(dy));
      if (cityHash(vec3(c, 3.0)) < 0.3) continue;
      vec2 lamp = (c + 0.2 + 0.6 * vec2(cityHash(vec3(c, 1.0)), cityHash(vec3(c, 2.0)))) * 30.0;
      float d = length(p - lamp);
      light += 4.0 * (1.0 - smoothstep(0.5, 0.5 + aa * 1.5, d)) + 0.45 * exp(-d * d / 110.0);
    }
  }
  return mix(light, 0.15, smoothstep(1.0, 6.0, aa));
}`;

// Bevel profile: tilt of a stone face toward the nearest joint (d0 / d1 = distance to each
// joint in cell units, jw = mortar half-width, bw = bevel width).
const GLSL_BEVEL = /* glsl */ `
float cityBevel(float d0, float d1, float jw, float bw) {
  return (1.0 - smoothstep(jw, bw, d0)) - (1.0 - smoothstep(jw, bw, d1));
}`;

/**
 * Jerusalem stone: MeshStandardMaterial (matte limestone, roughness 0.85) extended in the
 * shader with, all in world space so any footprint works without UVs:
 *   - ashlar masonry: 36 cm courses, staggered blocks, mortar joints, bevelled edges and a
 *     chiselled ("tobza") surface as normal perturbation, per-block tone, street-level grime;
 *   - recessed windows (rectangular or arched) with stone surround, sill, shadowed reveal,
 *     dark glass or curtains, and green / blue / wooden shutters, open or closed;
 *   - ground-floor shops: glazed fronts or roll-down metal shutters under colored sign bands;
 *   - pale flat roofs, terracotta tile roofs (sloped faces) and warm lit windows at night.
 *
 * Vertex inputs: color = stone (or tile) tint, aFacade = (seed, window density 0..1, shops 0/1).
 */
function createStoneMaterial(uniforms, floorHeight) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85, metalness: 0 });
  mat.customProgramCacheKey = () => 'jerusalem-stone-v2';

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uFloorHeight = { value: floorHeight };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec4 aFacade;
varying vec3 vCityWorldPos;
varying vec3 vCityWorldNormal;
varying vec4 vCityFacade;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
  vCityWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vCityWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
  vCityFacade = aFacade;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform float uNight;
uniform float uFloorHeight;
varying vec3 vCityWorldPos;
varying vec3 vCityWorldNormal;
varying vec4 vCityFacade;
${GLSL_COMMON}
${GLSL_BEVEL}`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
float cityWin = 0.0;    // glass coverage (drives roughness + night lights)
float cityLit = 0.0;    // lit share at night
float cityWash = 0.0;   // street-lamp light on the lower facade at night
// Night in Jerusalem: most apartments dark or behind closed shutters, shops shuttered.
float cityLitRate = 0.03 + 0.2 * pow(cityHash(vec3(vCityFacade.x, 12.0, 3.0)), 2.0);
float cityRough = 0.0;  // roughness offset
float cityMetal = 0.0;
vec2 cityBump = vec2(0.0); // normal tilt along (cityT, up)
vec3 cityT = vec3(1.0, 0.0, 0.0);
{
  vec3 n = normalize(vCityWorldNormal);
  vec3 P = vCityWorldPos;
  float seed = vCityFacade.x;

  if (n.y > 0.97) {
    // Flat roof: pale concrete / bitumen, stains and patched membrane.
    float stain = cityFbm(P.xz * 0.35 + seed * 40.0);
    float patchy = smoothstep(0.7, 0.8, cityNoise(P.xz * 0.2 + seed * 13.0));
    vec3 roof = mix(vec3(0.42, 0.40, 0.36), vec3(0.5, 0.48, 0.43), stain);
    diffuseColor.rgb = mix(roof, vec3(0.34, 0.33, 0.31), patchy * 0.35);
    cityRough = 0.08;
  } else if (n.y > 0.25) {
    // Terracotta tiles: horizontal courses, staggered barrel tiles, shadowed overlaps.
    vec2 th = normalize(vec2(-n.z, n.x));
    float u = dot(P.xz, th);
    float rows = P.y / 0.1;
    float row = floor(rows);
    float cu = u / 0.23 + 0.5 * mod(row, 2.0);
    vec2 f = fract(vec2(cu, rows));
    vec2 aa = fwidth(vec2(cu, rows)) + 1e-4;
    float fade = smoothstep(0.3, 0.7, max(aa.x, aa.y));
    float tone = cityHash(vec3(floor(cu), row, 13.0));
    float lap = smoothstep(0.0, 0.3 + aa.y, f.y);
    float barrel = 0.72 + 0.28 * sin(f.x * 3.14159);
    float weather = cityFbm(P.xz * 0.5 + 3.0);
    vec3 base = diffuseColor.rgb * mix(0.8, 1.1, tone) * mix(0.8, 1.05, weather);
    vec3 tiles = base * mix(0.5, 1.0, lap) * barrel;
    diffuseColor.rgb = mix(tiles, diffuseColor.rgb * 0.9, fade);
    cityT = vec3(th.x, 0.0, th.y);
    cityBump = vec2(cos(f.x * 3.14159) * 0.35, (1.0 - lap) * 0.5) * (1.0 - fade);
    cityRough = -0.1;
  } else if (n.y > -0.5) {
    vec2 t2 = normalize(vec2(-n.z, n.x));
    cityT = vec3(t2.x, 0.0, t2.y);
    float u = dot(P.xz, t2);
    float y = P.y - vCityFacade.w; // height above this building's ground floor

    // --- Ashlar masonry ---
    float cy = y / 0.36;
    float row = floor(cy);
    float blockLen = 0.55 + 0.4 * cityHash(vec3(row, seed * 17.0, 2.0));
    float cu = u / blockLen + cityHash(vec3(row, 5.0, seed));
    vec2 sc = vec2(cu, cy);
    vec2 sf = fract(sc);
    vec2 saa = fwidth(sc) + 1e-4;
    float stoneFade = smoothstep(0.12, 0.4, max(saa.x, saa.y));
    vec2 jw = vec2(0.007 / blockLen, 0.009 / 0.36);
    vec2 bw = vec2(0.04 / blockLen, 0.04 / 0.36);
    vec2 dmin = min(sf, 1.0 - sf);
    float mortar = max(1.0 - smoothstep(jw.x, jw.x + saa.x, dmin.x), 1.0 - smoothstep(jw.y, jw.y + saa.y, dmin.y));
    vec2 slope = vec2(cityBevel(sf.x, 1.0 - sf.x, jw.x, bw.x), cityBevel(sf.y, 1.0 - sf.y, jw.y, bw.y));
    vec2 chisel = floor(vec2(u, y) * 24.0);
    cityBump = (-slope * 0.7 + (vec2(cityHash(vec3(chisel, 1.0)), cityHash(vec3(chisel, 2.0))) - 0.5) * 0.22) * (1.0 - stoneFade);

    float tone = cityHash(vec3(floor(cu), row, seed * 31.0));
    float patina = cityFbm(vec2(u * 0.15, y * 0.25) + seed * 11.0);
    vec3 base = diffuseColor.rgb * mix(0.9, 1.04, patina);
    vec3 stone = base * mix(0.88, 1.08, tone);
    stone = mix(stone, base * vec3(0.72, 0.71, 0.69), mortar);
    diffuseColor.rgb = mix(stone, base * 0.98, stoneFade);
    diffuseColor.rgb *= mix(0.8, 1.0, smoothstep(0.0, 1.3, y)); // street grime
    // Sodium street lamps every ~28 m wash the stone orange, fading up the facade.
    float pool = 0.5 + 0.5 * cos(u * 6.2832 / 28.0 + seed * 6.0);
    cityWash = (1.0 - smoothstep(1.5, 12.0, y)) * (0.25 + 0.75 * pool * pool);
    cityRough = mortar * 0.1;

    float density = vCityFacade.y;
    bool shopFloor = vCityFacade.z > 0.5 && y < uFloorHeight * 1.05;
    if (density > 0.0 && shopFloor) {
      // --- Ground-floor shops ---
      float sb = 4.2;
      float su = u / sb;
      float sid = floor(su);
      vec2 sp = vec2((fract(su) - 0.5) * sb, y);
      float aam = fwidth(u) + 1e-4;
      float front = cityBox(vec2(sp.x, sp.y - 1.45), vec2(1.55, 1.15), aam);
      float surround = cityBox(vec2(sp.x, sp.y - 1.45), vec2(1.7, 1.25), aam) - front;
      float signBand = cityBox(vec2(sp.x, sp.y - 2.95), vec2(1.75, 0.22), aam);
      float h1 = cityHash(vec3(sid, seed, 4.0));
      vec3 signCol = h1 < 0.25 ? vec3(0.45, 0.06, 0.05) : h1 < 0.5 ? vec3(0.05, 0.16, 0.35) : h1 < 0.7 ? vec3(0.07, 0.25, 0.12) : h1 < 0.85 ? vec3(0.6, 0.45, 0.08) : vec3(0.85, 0.83, 0.78);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.8, surround);
      diffuseColor.rgb = mix(diffuseColor.rgb, signCol, signBand);
      cityBump *= 1.0 - max(front, signBand);
      float shut = step(mix(0.55, 0.12, uNight), cityHash(vec3(sid, seed, 5.0))); // most shops close at night
      float ridges = 0.8 + 0.2 * step(0.5, fract(sp.y * 12.0));
      vec3 shutter = vec3(0.42, 0.43, 0.44) * ridges;
      vec3 glass = mix(vec3(0.03, 0.035, 0.04), vec3(0.13, 0.1, 0.07), cityHash(vec3(sid, 2.0, seed)));
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(glass, shutter, shut), front);
      cityWin = front * (1.0 - shut);
      cityMetal = front * shut * 0.6;
      cityLit = cityWin * step(0.4, cityHash(vec3(sid, 6.0, seed)));
    } else if (density > 0.0) {
      // --- Windows ---
      float bay = mix(4.4, 3.2, density);
      vec2 cell = vec2(u / bay, y / uFloorHeight);
      vec2 id = floor(cell);
      vec2 f = fract(cell) - 0.5;
      vec2 aa = fwidth(cell) + 1e-4;
      float aam = max(aa.x * bay, aa.y * uFloorHeight);
      vec2 pm = vec2(f.x * bay, (f.y + 0.04) * uFloorHeight);
      vec2 hs = vec2(0.55, 0.8);
      bool arched = cityHash(vec3(seed, 3.0, 9.0)) > 0.55;
      vec2 q = abs(pm) - hs;
      float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
      float springY = hs.y - hs.x;
      if (arched && pm.y > springY) d = length(vec2(pm.x, pm.y - springY)) - hs.x;
      float present = step(0.1, cityHash(vec3(id, seed * 7.0)));
      float opening = (1.0 - smoothstep(-aam, aam, d)) * present;
      float surround = (1.0 - smoothstep(-aam, aam, d - 0.1)) * present - opening;
      float sill = cityBox(vec2(pm.x, pm.y + hs.y + 0.05), vec2(hs.x + 0.12, 0.05), aam) * present;

      // Shutters: this building's color, open beside the window or closed over it.
      float sh = cityHash(vec3(seed, 8.0, 1.0));
      bool hasShutters = sh > 0.4 && !arched;
      vec3 shutterCol = sh > 0.8 ? vec3(0.1, 0.2, 0.13) : sh > 0.62 ? vec3(0.13, 0.2, 0.28) : vec3(0.22, 0.13, 0.07);
      float louver = 0.75 + 0.25 * step(0.4, fract(pm.y * 14.0));
      float closed = hasShutters ? step(cityHash(vec3(id, seed + 2.0)), mix(0.25, 0.6, uNight)) : 0.0;
      float leaves = hasShutters ? cityBox(vec2(abs(pm.x) - hs.x * 1.5 - 0.12, pm.y), vec2(hs.x * 0.5, hs.y), aam) * present * (1.0 - closed) : 0.0;

      // Recess: the reveal shades the top and one side of the glass.
      float reveal = max(smoothstep(hs.y - 0.3, hs.y, pm.y), smoothstep(hs.x - 0.2, hs.x, -pm.x));
      float curtain = step(0.8, cityHash(vec3(id, seed + 9.0)));
      vec3 glass = mix(vec3(0.035, 0.04, 0.045), vec3(0.3, 0.26, 0.2), curtain) * mix(1.0, 0.45, reveal);

      float fade = smoothstep(0.25, 0.6, max(aa.x, aa.y));
      float avg = (2.0 * hs.x / bay) * (2.0 * hs.y / uFloorHeight) * 0.9;
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.06, (surround + sill) * (1.0 - fade));
      diffuseColor.rgb = mix(diffuseColor.rgb, shutterCol * louver, leaves * (1.0 - fade));
      vec3 inOpening = mix(glass, shutterCol * louver, closed);
      float cover = mix(opening, avg, fade);
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(inOpening, glass, fade), cover);
      cityWin = cover * (1.0 - closed);
      cityBump *= 1.0 - max(opening, leaves);
      float lit = step(1.0 - cityLitRate, cityHash(vec3(id, n.x * 3.0 + n.z * 5.0 + seed * 97.0)));
      cityLit = mix(opening * (1.0 - closed) * lit, avg * cityLitRate * 0.6, fade);
    }
  }
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + cityRough, 0.0, 1.0);
roughnessFactor = mix(roughnessFactor, 0.12, cityWin);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `#include <metalnessmap_fragment>
metalnessFactor = max(metalnessFactor, cityMetal);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
{
  vec3 tV = normalize((viewMatrix * vec4(cityT, 0.0)).xyz);
  vec3 uV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  normal = normalize(normal + tV * cityBump.x + uV * cityBump.y);
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
{
  float tint = cityHash(vec3(floor(vCityWorldPos.y / uFloorHeight), vCityFacade.x * 53.0, 1.0));
  // Mostly warm incandescent-looking light, the odd cool fluorescent kitchen.
  vec3 warm = mix(vec3(1.0, 0.64, 0.32), vec3(0.85, 0.9, 1.0), step(0.9, tint));
  totalEmissiveRadiance += cityLit * uNight * warm * mix(0.8, 1.4, tint);
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.55, 0.22) * cityWash * uNight * 0.55;
}`,
      );
  };
  return mat;
}

/**
 * Land around the modelled area. At night it fills with the rest of the city's street
 * lights (jittered lamps every ~30 m with orange pools), so the edge doesn't end in darkness.
 */
function createOuterGroundMaterial(uniforms, bounds) {
  const mat = new THREE.MeshStandardMaterial({ color: COLORS.outerGround, roughness: 1 });
  mat.customProgramCacheKey = () => 'city-outer-ground';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uArea = { value: new THREE.Vector4(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vOuterPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vOuterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vOuterPos;\nuniform float uNight;\nuniform vec4 uArea;\n${GLSL_COMMON}`)
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
{
  vec2 p = vOuterPos.xz;
  vec2 out2 = max(max(uArea.xy - p, p - uArea.zw), 0.0);
  float outside = smoothstep(20.0, 120.0, length(out2));
  float glow = cityLamps(p, length(fwidth(p)));
  float district = 0.6 + 0.4 * cityNoise(p / 400.0);
  totalEmissiveRadiance += vec3(1.0, 0.55, 0.22) * uNight * outside * district * (glow * 0.35 + 0.02);
}`,
      );
  };
  return mat;
}

/**
 * Ground surfaces, all procedural in world space:
 *   'paving'  Jerusalem stone slabs in running bond (sidewalks, squares, pedestrian streets)
 *   'asphalt' worn dark-gray asphalt: grain, mottling, patched repairs, lighter wheel tracks
 *   'curb'    gray curb stones
 *   'grass'   dry Mediterranean lawn
 *   'marking' worn white paint
 */
function createSurfaceMaterial(kind, color, { roughness = 0.92, offset = 0, uniforms = null } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color, roughness, metalness: 0,
    polygonOffset: offset !== 0, polygonOffsetFactor: offset !== 0 ? -1 : 0, polygonOffsetUnits: offset,
  });
  mat.customProgramCacheKey = () => `city-surface-${kind}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms?.uNight ?? { value: 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurfPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSurfPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vSurfPos;\nuniform float uNight;\n#define SURF_${kind.toUpperCase()}\n${GLSL_COMMON}\n${GLSL_BEVEL}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
vec2 surfBump = vec2(0.0);
float surfRough = 0.0;
{
  vec2 p = vSurfPos.xz;
  vec3 base = diffuseColor.rgb;
#if defined(SURF_PAVING)
  // 60 x 40 cm slabs, running bond.
  vec2 cell = vec2(p.x / 0.8, p.y / 0.5);
  cell.x += 0.5 * mod(floor(cell.y), 2.0);
  vec2 f = fract(cell);
  vec2 aa = fwidth(cell) + 1e-4;
  float fade = smoothstep(0.15, 0.45, max(aa.x, aa.y));
  vec2 dmin = min(f, 1.0 - f);
  float joint = max(1.0 - smoothstep(0.012, 0.012 + aa.x, dmin.x), 1.0 - smoothstep(0.018, 0.018 + aa.y, dmin.y));
  float tone = cityHash(vec3(floor(cell), 4.0));
  float dirt = cityFbm(p * 0.25);
  vec3 slab = base * mix(0.95, 1.04, tone) * mix(0.9, 1.02, dirt);
  diffuseColor.rgb = mix(mix(slab, base * 0.82, joint), base * mix(0.93, 1.0, dirt), fade);
  surfBump = vec2(cityBevel(f.x, 1.0 - f.x, 0.012, 0.05), cityBevel(f.y, 1.0 - f.y, 0.018, 0.07)) * -0.3 * (1.0 - fade);
#elif defined(SURF_ASPHALT)
  float grain = cityHash(vec3(floor(p * 30.0), 1.0));
  float mottle = cityFbm(p * 0.08);
  float fine = cityFbm(p * 1.3);
  float patched = step(0.78, cityNoise(p * 0.05 + 17.0)) * step(0.35, cityNoise(p * 0.4));
  vec2 gaa = fwidth(p * 30.0);
  float gfade = smoothstep(0.5, 1.5, max(gaa.x, gaa.y));
  vec3 a = base * mix(0.8, 1.25, mottle) * mix(0.9, 1.08, fine);
  a *= mix(mix(0.85, 1.15, grain), 1.0, gfade);
  a = mix(a, base * 0.7, patched);
  diffuseColor.rgb = a;
  surfBump = (vec2(grain, cityHash(vec3(floor(p * 30.0), 2.0))) - 0.5) * 0.25 * (1.0 - gfade);
  surfRough = -0.1 * mottle;
#elif defined(SURF_CURB)
  float seg = fract((p.x + p.y) / 0.9);
  float joint = 1.0 - smoothstep(0.0, 0.03 + fwidth((p.x + p.y) / 0.9), min(seg, 1.0 - seg));
  diffuseColor.rgb = base * mix(0.92, 1.05, cityHash(vec3(floor((p.x + p.y) / 0.9), 3.0, 1.0))) * mix(1.0, 0.6, joint);
#elif defined(SURF_GRASS)
  float g = cityFbm(p * 0.3);
  float blades = cityHash(vec3(floor(p * 12.0), 5.0));
  diffuseColor.rgb = base * mix(0.75, 1.15, g) * mix(0.9, 1.05, blades);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.36, 0.22), smoothstep(0.6, 0.85, cityNoise(p * 0.15 + 5.0)) * 0.6);
#elif defined(SURF_MARKING)
  diffuseColor.rgb = base * mix(0.55, 1.0, smoothstep(0.25, 0.7, cityFbm(p * 2.0)));
#endif
}`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + surfRough, 0.0, 1.0);')
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
#if !defined(SURF_GRASS)
  // Sodium street lighting: uneven orange pools on streets and sidewalks at night.
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.55, 0.22) * uNight * 0.3 * mix(0.5, 1.0, cityFbm(vSurfPos.xz / 9.0));
#endif`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
normal = normalize(normal + normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz) * surfBump.x + normalize((viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz) * surfBump.y);`,
      );
  };
  return mat;
}

// -----------------------------------------------------------------------------------------------
// Streaming building blocks (used by src/world/TileWorld.js)
// -----------------------------------------------------------------------------------------------

/**
 * Materials and geometries shared by every city chunk, created once: each shader compiles
 * once, CSM is set up once, and all chunks follow the same day/night uniforms.
 */
export function createCityMaterials(uniforms, options = {}) {
  const o = { ...DEFAULT_CITY_OPTIONS, ...options };
  const materials = {
    stone: createStoneMaterial(uniforms, o.floorHeight),
    silhouette: new THREE.MeshLambertMaterial({ vertexColors: true }),
    park: createSurfaceMaterial('grass', COLORS.park, { offset: -3 }),
    paving: createSurfaceMaterial('paving', COLORS.paving, { offset: -7, uniforms }),
    curb: createSurfaceMaterial('curb', COLORS.curb, { roughness: 0.85, offset: -11, uniforms }),
    asphalt: createSurfaceMaterial('asphalt', COLORS.asphalt, { roughness: 0.93, offset: -15, uniforms }),
    marking: createSurfaceMaterial('marking', COLORS.marking, { roughness: 0.7, offset: -19, uniforms }),
    solar: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 }),
    ac: new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2 }),
    trunk: new THREE.MeshStandardMaterial({ roughness: 1 }),
    crown: new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }),
  };
  const geometries = {
    solar: solarHeaterGeometry(),
    box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    trunk: new THREE.CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0),
    crown: new THREE.IcosahedronGeometry(1, 1),
  };
  return {
    ...materials,
    geometries,
    list: Object.values(materials),
    dispose() {
      for (const m of Object.values(materials)) m.dispose();
      for (const g of Object.values(geometries)) g.dispose();
    },
  };
}

/** A lighter copy of a building for distant levels: simplified outline, optionally no holes / roof. */
function simplifiedBuilding(b, tolerance, { keepHoles = true, keepRoof = true } = {}) {
  const outer = simplifyRing(b.rings[0], tolerance);
  return { ...b, rings: keepHoles ? [outer, ...b.rings.slice(1)] : [outer], roof: keepRoof ? b.roof : null };
}

/**
 * Geometry for one chunk of city data at a level of detail, as plain "parts" (no materials,
 * no scene objects), so it can be computed in a web worker and transferred:
 *   near    everything: parks, paving, curbs, asphalt, markings, full buildings (tile roofs,
 *           facades), rooftop props (detail: true) and trees
 *   medium  parks, paving and asphalt; buildings with simplified outlines; no props or trees
 *   far     building silhouettes only (simplified, no courtyards)
 * Terrain is not part of a chunk (the world draws it once).
 *
 * Parts: { type: 'mesh', name, material, geometry: BufferGeometry, cast, receive }
 *        { type: 'instances', name, material, geometry: <shared geometry key>, count,
 *          matrices: Float32Array(16n), colors: Float32Array(3n), cast, receive, detail }
 * `material` / `geometry` keys refer to createCityMaterials().
 */
export function buildChunkParts(chunk, { terrain = FLAT_TERRAIN, level = 'near' }) {
  const parts = [];
  const mesh = (name, material, geometry, cast = false, receive = true) => parts.push({ type: 'mesh', name, material, geometry, cast, receive });
  const layer = (name, geometries, material, lift) => {
    if (!geometries.length) return;
    const merged = mergeGeometries(geometries, false);
    for (const g of geometries) g.dispose();
    mesh(name, material, drapeGeometry(merged, terrain, lift, 6));
    merged.dispose();
  };

  if (level !== 'far') {
    layer('Parks', chunk.parks.map((p) => flatPolygonGeometry(p.rings, 0)), 'park', 0.02);
    const geos = { asphalt: [], paving: [], curb: [], marking: [] };
    for (const r of chunk.roads) {
      geos[r.surface].push(r.rings ? flatPolygonGeometry(r.rings, 0) : ribbonGeometry(r.points, r.width / 2, 0));
      if (level !== 'near' || r.surface !== 'asphalt' || !r.points) continue;
      geos.curb.push(curbGeometry(r.points, r.width / 2, CURB_WIDTH));
      if (r.width >= 8) geos.marking.push(dashedLineGeometry(r.points, 0.07, 3, 4));
    }
    layer('Paving', geos.paving, 'paving', 0.04);
    if (level === 'near') layer('Curbs', geos.curb, 'curb', 0.05);
    layer('Roads', geos.asphalt, 'asphalt', 0.06);
    if (level === 'near') layer('Markings', geos.marking, 'marking', 0.08);
  }

  // Buildings, merged into one mesh (one draw call per chunk).
  const source = level === 'near' ? chunk.buildings
    : level === 'medium' ? chunk.buildings.map((b) => simplifiedBuilding(b, 1))
    : chunk.buildings.filter((b) => b.area >= 40 && b.kind === 'building').map((b) => simplifiedBuilding(b, 3, { keepHoles: false, keepRoof: false }));
  if (source.length) {
    const geos = source.map((b) => extrudeBuilding(b));
    const geo = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    mesh('Buildings', level === 'far' ? 'silhouette' : 'stone', geo, level !== 'far', level !== 'far');
  }

  if (level === 'near') {
    const inst = (name, material, geometry, items, { cast = true, receive = true, detail = false } = {}) => {
      if (!items.length) return;
      const matrices = new Float32Array(items.length * 16), colors = new Float32Array(items.length * 3);
      items.forEach((it, i) => {
        _p.set(it.x, it.y, it.z);
        _s.set(it.sx, it.sy, it.sz);
        _q.setFromEuler(_e.set(it.rx ?? 0, it.ry ?? 0, 0));
        _m.compose(_p, _q, _s).toArray(matrices, i * 16);
        _c.setHex(it.color).toArray(colors, i * 3);
      });
      parts.push({ type: 'instances', name, material, geometry, count: items.length, matrices, colors, cast, receive, detail });
    };
    const { solar, ac } = chunk.roofProps;
    inst('SolarHeaters', 'solar', 'solar', solar.map((s) => ({ x: s.x, y: s.y, z: s.z, sx: 1, sy: 1, sz: 1, color: 0xffffff })), { detail: true });
    inst('AcUnits', 'ac', 'box', ac.map((a) => ({ x: a.x, y: a.y, z: a.z, sx: a.w, sy: a.h, sz: a.d, ry: a.yaw, color: COLORS.ac })), { detail: true });
    inst('TreeTrunks', 'trunk', 'trunk', chunk.trees.map((t) => ({ x: t.x, y: t.y, z: t.z, sx: t.trunkRadius, sy: t.trunkHeight + t.crownRadius * 0.5, sz: t.trunkRadius, color: COLORS.trunk })), { receive: false });
    inst('TreeCrowns', 'crown', 'crown', chunk.trees.map((t) => ({ x: t.x, y: t.y + t.trunkHeight + t.crownRadius * 0.6, z: t.z, sx: t.crownRadius, sy: t.crownRadius * 0.85, sz: t.crownRadius, color: t.color })));
  }
  return parts;
}

/** Turns chunk parts into a group of meshes with the shared materials. */
export function assembleChunk(parts, M, name = 'Chunk') {
  const group = new THREE.Group();
  group.name = name;
  const owned = [];
  const detailMeshes = [];
  for (const part of parts) {
    let obj;
    if (part.type === 'mesh') {
      owned.push(part.geometry);
      part.geometry.computeBoundingSphere();
      obj = new THREE.Mesh(part.geometry, M[part.material]);
    } else {
      obj = new THREE.InstancedMesh(M.geometries[part.geometry], M[part.material], part.count);
      obj.instanceMatrix.array.set(part.matrices);
      obj.instanceMatrix.needsUpdate = true;
      obj.instanceColor = new THREE.InstancedBufferAttribute(part.colors, 3);
      obj.computeBoundingBox();
      obj.computeBoundingSphere();
      obj.userData.detail = part.detail;
      if (part.detail) detailMeshes.push(obj);
    }
    obj.name = part.name;
    obj.castShadow = part.cast;
    obj.receiveShadow = part.receive;
    group.add(obj);
  }
  group.traverse((obj) => {
    obj.matrixAutoUpdate = false;
    obj.updateMatrix();
  });
  group.updateMatrixWorld(true);
  return {
    group,
    detailMeshes,
    dispose() {
      for (const g of owned) g.dispose();
      group.traverse((obj) => obj.isInstancedMesh && obj.dispose());
      group.clear();
    },
  };
}

/** buildChunkParts + assembleChunk in one call (same thread). */
export function buildCityChunk(chunk, { terrain = FLAT_TERRAIN, materials, level = 'near' }) {
  const view = assembleChunk(buildChunkParts(chunk, { terrain, level }), materials, `Chunk(${chunk.id}:${level})`);
  return { ...view, level };
}

/** The parts of a chunk as transferable buffers (for postMessage from a worker). */
export function packChunkParts(parts) {
  const transfer = [];
  const packed = parts.map((part) => {
    if (part.type !== 'mesh') {
      transfer.push(part.matrices.buffer, part.colors.buffer);
      return part;
    }
    const g = part.geometry;
    const attributes = {};
    for (const [key, attr] of Object.entries(g.attributes)) {
      attributes[key] = { array: attr.array, itemSize: attr.itemSize };
      transfer.push(attr.array.buffer);
    }
    const index = g.index ? g.index.array : null;
    if (index) transfer.push(index.buffer);
    return { ...part, geometry: { attributes, index } };
  });
  return { parts: packed, transfer: [...new Set(transfer)] };
}

/** Inverse of packChunkParts: rebuilds BufferGeometries from transferred buffers. */
export function unpackChunkParts(parts) {
  return parts.map((part) => {
    if (part.type !== 'mesh') return part;
    const g = new THREE.BufferGeometry();
    for (const [key, a] of Object.entries(part.geometry.attributes)) g.setAttribute(key, new THREE.BufferAttribute(a.array, a.itemSize));
    if (part.geometry.index) g.setIndex(new THREE.BufferAttribute(part.geometry.index, 1));
    return { ...part, geometry: g };
  });
}

/**
 * Ground for a tiled world: stone-slab paving where there is city data, natural hillside
 * (dry grass, terra rossa, limestone outcrops on slopes) elsewhere, blended by a mask texture
 * over `maskRect` (minX, minZ, maxX, maxZ). At night the city gets an orange street-light
 * glow, the rest scattered lamps (the unmapped city is still a city).
 */
export function createGroundMaterial(uniforms, { mask, maskRect }) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  mat.customProgramCacheKey = () => 'world-ground-v1';
  const paving = new THREE.Color(COLORS.ground);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uCityMask = { value: mask };
    shader.uniforms.uMaskRect = { value: new THREE.Vector4(maskRect.minX, maskRect.minZ, maskRect.maxX, maskRect.maxZ) };
    shader.uniforms.uPaving = { value: paving };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGPos;\nvarying float vGUp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vGUp = normalize(mat3(modelMatrix) * objectNormal).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vGPos;
varying float vGUp;
uniform float uNight;
uniform sampler2D uCityMask;
uniform vec4 uMaskRect;
uniform vec3 uPaving;
${GLSL_COMMON}
${GLSL_BEVEL}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
float groundCity = 0.0;
vec2 groundBump = vec2(0.0);
{
  vec2 p = vGPos.xz;
  vec2 muv = (p - uMaskRect.xy) / (uMaskRect.zw - uMaskRect.xy);
  if (muv.x >= 0.0 && muv.y >= 0.0 && muv.x <= 1.0 && muv.y <= 1.0) groundCity = texture2D(uCityMask, muv).r;

  // Paving: 80 x 50 cm slabs in running bond.
  vec2 cell = vec2(p.x / 0.8, p.y / 0.5);
  cell.x += 0.5 * mod(floor(cell.y), 2.0);
  vec2 f = fract(cell);
  vec2 aa = fwidth(cell) + 1e-4;
  float fade = smoothstep(0.15, 0.45, max(aa.x, aa.y));
  vec2 dmin = min(f, 1.0 - f);
  float joint = max(1.0 - smoothstep(0.012, 0.012 + aa.x, dmin.x), 1.0 - smoothstep(0.018, 0.018 + aa.y, dmin.y));
  float dirt = cityFbm(p * 0.25);
  vec3 slab = uPaving * mix(0.95, 1.04, cityHash(vec3(floor(cell), 4.0))) * mix(0.9, 1.02, dirt);
  vec3 pave = mix(mix(slab, uPaving * 0.82, joint), uPaving * mix(0.93, 1.0, dirt), fade);

  // Hillside: dry grass and terra rossa, limestone showing through on steeper slopes.
  float n1 = cityFbm(p * 0.012), n2 = cityFbm(p * 0.09 + 7.0), n3 = cityHash(vec3(floor(p * 2.0), 9.0));
  vec3 grass = vec3(0.26, 0.24, 0.13), earth = vec3(0.33, 0.2, 0.12), rock = vec3(0.44, 0.42, 0.37);
  vec3 nat = mix(grass, earth, smoothstep(0.4, 0.75, n1));
  float slope = 1.0 - smoothstep(0.88, 0.97, vGUp);
  nat = mix(nat, rock, clamp(smoothstep(0.64, 0.82, n2) * 0.3 + slope * 0.7, 0.0, 1.0));
  nat *= mix(0.9, 1.06, n3 * (1.0 - fade));

  diffuseColor.rgb = mix(nat, pave, groundCity);
  groundBump = vec2(cityBevel(f.x, 1.0 - f.x, 0.012, 0.05), cityBevel(f.y, 1.0 - f.y, 0.018, 0.07)) * -0.3 * (1.0 - fade) * groundCity;
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
normal = normalize(normal + normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz) * groundBump.x + normalize((viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz) * groundBump.y);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
{
  vec2 p = vGPos.xz;
  // City: sodium street light on the paving.
  vec3 sodium = vec3(1.0, 0.55, 0.22);
  float cityGlow = 0.3 * mix(0.5, 1.0, cityFbm(p / 9.0));
  // Unmapped areas: scattered lamps (jittered every ~30 m) with orange pools.
  float lampLight = cityLamps(p, length(fwidth(p))) * (0.6 + 0.4 * cityNoise(p / 400.0));
  vec3 unmapped = sodium * (lampLight * 0.35 + 0.02);
  vec3 streets = diffuseColor.rgb * sodium * cityGlow;
  totalEmissiveRadiance += mix(unmapped, streets, groundCity) * uNight;
}`,
      );
  };
  return mat;
}

/** The outer-ground material (land beyond the world), exported for the streaming world. */
export function createOuterMaterial(uniforms, bounds) {
  return createOuterGroundMaterial(uniforms, bounds);
}

/**
 * What the main thread needs from a chunk when the heavy work (geometry) happens elsewhere:
 * collision boxes, roads with their lookup grid (HUD street names), light building records
 * (HUD, lookups) and bounds. Structured-clone friendly.
 */
export function chunkLookup(chunk) {
  const buildings = chunk.buildings.map((b) => ({
    id: b.id, osmId: b.osmId, kind: b.kind, name: b.name, address: b.address, floors: b.floors,
    height: b.height, heightAboveGround: b.heightAboveGround, heightSource: b.heightSource, centroid: b.centroid,
  }));
  return {
    id: chunk.id,
    buildings,
    buildingById: new Map(buildings.map((b) => [b.id, b])),
    roads: chunk.roads,
    roadGrid: chunk.roadGrid,
    parks: chunk.parks.map((p) => ({ id: p.id, name: p.name })),
    trees: chunk.trees.length,
    boxes: chunk.boxes,
    bounds: chunk.bounds,
    stats: chunk.stats,
  };
}
