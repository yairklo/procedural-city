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
import {
  cleanRing, orientRings, footprintArea, ringsBounds, ringCentroid, pointInRings, distanceToEdges,
  discInside, segmentDistance, decomposeFootprint,
} from './footprint.js';

export const DEFAULT_CITY_OPTIONS = Object.freeze({
  /** Parsed contents of public/data/jerusalem_data.json (required). */
  osm: null,
  name: 'Jerusalem · City Center',
  /** Only drives decorative randomness (stone tint, rooftop layout, tree sizes). */
  seed: 'jerusalem',

  // Heights. Used when OSM has no height / building:levels for a building.
  floorHeight: 3.2,
  parapet: 0.6,
  defaultFloorsMin: 3,
  defaultFloorsMax: 6,
  canopyHeight: 4.2,

  // Rooftops (flat roofs only)
  solarChance: 0.85, // share of roofs that carry solar water heaters
  solarPerM2: 1 / 45, // one heater per ~45 m² of roof (roughly one per apartment)
  maxSolarPerRoof: 18,
  acPerM2: 1 / 70,
  maxAcPerRoof: 10,
  minPropRoofArea: 35,

  // Engine
  chunkSize: 500,
  collisionCellSize: 16,
  collisionStep: 0.6, // strip width used to turn footprints into AABBs (max wall error = step / 2)
  groundMargin: 150,
});

const STONE = [0xe3dac9, 0xd4c5b9, 0xdcd0bd, 0xe6dccb, 0xcfc0ad];
const COLORS = {
  ground: 0xa99f90, // stone dust / sidewalks between buildings
  outerGround: 0x8d8471,
  asphalt: 0x34363a,
  paving: 0xc9bea9, // pedestrian malls, squares, footways
  park: 0x76834c,
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

const SMALL_TYPES = new Set(['kiosk', 'shed', 'garage', 'garages', 'hut', 'cabin', 'toilets', 'service', 'transformer_tower', 'container', 'guardhouse']);
const HOUSE_TYPES = new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'terrace']);
const CANOPY_TYPES = new Set(['roof', 'canopy', 'carport']);
const FLAT_ROOFS = new Set([undefined, 'flat']);

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
    else if (HOUSE_TYPES.has(type) || area < 90) { lo = 2; hi = 3; }
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
    const rng = createRng(o.seed);
    const styleRng = rng.fork('style');
    const propRng = rng.fork('props');
    const treeRng = rng.fork('trees');
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

    // Buildings ------------------------------------------------------------------------------
    const buildings = [];
    const solar = [];
    const ac = [];
    let heightFromOsm = 0;

    for (const src of osm.buildings) {
      const rings = projectRings(src.rings);
      if (!rings) continue;
      const area = footprintArea(rings);
      if (area < 2) continue;
      const tags = src.tags ?? {};
      const h = resolveHeight(tags, area, src.id, o);
      if (h.source !== 'default') heightFromOsm++;

      const box = ringsBounds(rings);
      const centroid = ringCentroid(rings[0]);
      const canopy = h.kind === 'canopy';
      const stone = mixHex(styleRng.pick(STONE), styleRng.pick(STONE), styleRng.next());
      const shop = tags.shop || tags.amenity ? 1 : styleRng.chance(0.35) ? 1 : 0;
      const street = tags['addr:street'];
      const building = {
        id: `OSM-${src.id}`,
        osmId: src.id,
        kind: h.kind,
        type: tags.building,
        name: tags['name:en'] ?? tags.name ?? null,
        address: street ? `${tags['addr:housenumber'] ? `${tags['addr:housenumber']} ` : ''}${street}` : null,
        floors: h.floors,
        base: h.base,
        height: h.top,
        heightSource: h.source,
        flatRoof: FLAT_ROOFS.has(tags['roof:shape']),
        rings,
        area,
        centroid,
        bounds: box,
        color: canopy ? COLORS.canopy : stone,
        // Facade shader inputs: (random seed, window density, ground-floor shops).
        facade: [styleRng.next(), canopy || h.floors < 1 ? 0 : SMALL_TYPES.has(tags.building) ? 0.3 : 1, canopy ? 0 : shop],
        boxes: decomposeFootprint(rings, { step: o.collisionStep }),
      };
      buildings.push(building);
      for (const b of building.boxes) {
        collision.add({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, minY: h.base, maxY: h.top, kind: 'building', ref: building.id });
      }
      if (!canopy && building.flatRoof && area >= o.minPropRoofArea && h.top >= 5) {
        placeRoofProps(building, propRng, o, solar, ac, collision);
      }
    }

    // Roads ----------------------------------------------------------------------------------
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

    // Parks, trees, place labels --------------------------------------------------------------
    const parks = [];
    for (const src of osm.parks ?? []) {
      const rings = projectRings(src.rings);
      if (rings) parks.push({ id: `OSM-${src.id}`, kind: src.kind, name: src.name, rings });
    }

    const trees = [];
    const m = o.groundMargin;
    const treeCoords = osm.trees ?? [];
    for (let i = 0; i + 1 < treeCoords.length; i += 2) {
      const { x, z } = proj.project(treeCoords[i], treeCoords[i + 1]);
      if (x < bounds.minX - m || x > bounds.maxX + m || z < bounds.minZ - m || z > bounds.maxZ + m) continue;
      if (collision.queryPoint(x, 1, z).some((b) => b.kind === 'building')) continue;
      const tree = {
        x, z, y: 0,
        trunkHeight: treeRng.range(2.2, 3.6),
        trunkRadius: treeRng.range(0.16, 0.26),
        crownRadius: treeRng.range(1.8, 3.2),
        color: treeRng.pick(COLORS.crown),
      };
      trees.push(tree);
      collision.add({
        minX: x - tree.trunkRadius, maxX: x + tree.trunkRadius, minZ: z - tree.trunkRadius, maxZ: z + tree.trunkRadius,
        minY: 0, maxY: tree.trunkHeight + tree.crownRadius, kind: 'tree', ref: null,
      });
    }

    const places = (osm.places ?? []).map((p) => ({ ...proj.project(p.lat, p.lon), name: p.nameEn ?? p.name, nameLocal: p.name, place: p.place }));

    const data = {
      seed: o.seed,
      name: o.name,
      source: { attribution: osm.attribution, license: osm.license, fetchedAt: osm.fetchedAt, bbox: osm.bbox },
      options: { ...o, osm: undefined },
      projection: proj,
      bounds,
      buildings,
      buildingById: new Map(buildings.map((b) => [b.id, b])),
      roads,
      roadGrid,
      parks,
      trees,
      places,
      roofProps: { solar, ac },
      collision,
      spawn: null,
      stats: {
        buildings: buildings.length,
        buildingsWithOsmHeight: heightFromOsm,
        canopies: buildings.filter((b) => b.kind === 'canopy').length,
        tallest: buildings.reduce((mx, b) => Math.max(mx, b.height), 0),
        roads: roads.length,
        parks: parks.length,
        trees: trees.length,
        solarHeaters: solar.length,
        acUnits: ac.length,
        colliders: collision.boxes.length,
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
    const origin = { x: bounds.minX, z: bounds.minZ };
    const margin = o.groundMargin;
    const width = bounds.maxX - bounds.minX + margin * 2, depth = bounds.maxZ - bounds.minZ + margin * 2;
    const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;

    // Ground: stone-dust plane under the data area, darker land beyond it.
    const ground = add(new THREE.Mesh(
      track(new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2).translate(cx, 0, cz)),
      track(new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 0.95 })),
    ));
    ground.name = 'Ground';
    ground.receiveShadow = true;
    const outer = add(new THREE.Mesh(
      track(new THREE.PlaneGeometry(width + 6000, depth + 6000).rotateX(-Math.PI / 2).translate(cx, -0.4, cz)),
      track(new THREE.MeshStandardMaterial({ color: COLORS.outerGround, roughness: 1 })),
    ));
    outer.name = 'OuterGround';
    outer.receiveShadow = true;

    // Flat ground layers, drawn coplanar with the ground and separated with polygon offset.
    const layer = (name, geometries, color, offset) => {
      if (!geometries.length) return;
      const geo = track(mergeGeometries(geometries, false));
      for (const g of geometries) g.dispose();
      const mesh = add(new THREE.Mesh(geo, track(new THREE.MeshStandardMaterial({
        color, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: offset,
      }))));
      mesh.name = name;
      mesh.receiveShadow = true;
    };
    layer('Parks', data.parks.map((p) => flatPolygonGeometry(p.rings, 0)), COLORS.park, -2);
    const roadGeos = { asphalt: [], paving: [] };
    for (const r of data.roads) {
      roadGeos[r.surface].push(r.rings ? flatPolygonGeometry(r.rings, 0) : ribbonGeometry(r.points, r.width / 2, 0));
    }
    layer('Paving', roadGeos.paving, COLORS.paving, -4);
    layer('Roads', roadGeos.asphalt, COLORS.asphalt, -6);

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
    const tankGeo = track(new THREE.CylinderGeometry(1, 1, 1, 10).translate(0, 0.5, 0));
    const boxBottom = track(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
    const boxCenter = track(new THREE.BoxGeometry(1, 1, 1));
    inst(solar.map((s) => ({ x: s.x, y: s.y, z: s.z - 0.75, sx: 0.33, sy: 1.95, sz: 0.33, color: COLORS.solarTank })), {
      name: 'SolarTanks', geometry: tankGeo,
      material: track(new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 })),
    });
    inst(solar.map((s) => ({ x: s.x, y: s.y + 0.35 + Math.sin(SOLAR_TILT) * 0.8, z: s.z + 0.3, sx: 0.95, sy: 0.05, sz: 1.6, rx: SOLAR_TILT, color: COLORS.solarPanel })), {
      name: 'SolarPanels', geometry: boxCenter,
      material: track(new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.6 })),
    });
    inst(solar.map((s) => ({ x: s.x, y: s.y, z: s.z + 0.3, sx: 0.85, sy: 0.35, sz: 1.1, color: COLORS.solarFrame })), {
      name: 'SolarFrames', geometry: boxBottom,
      material: track(new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.4 })),
    });
    inst(ac.map((a) => ({ x: a.x, y: a.y, z: a.z, sx: a.w, sy: a.h, sz: a.d, ry: a.yaw, color: COLORS.ac })), {
      name: 'AcUnits', geometry: boxBottom,
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
// Rooftops
// -----------------------------------------------------------------------------------------------

const SOLAR_TILT = (40 * Math.PI) / 180;
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
// Spawn
// -----------------------------------------------------------------------------------------------

/**
 * A point on a real street at ground level with nothing around it: prefers Jaffa Road,
 * then other major streets, closest to the center of the area.
 */
function findSpawn(data) {
  const { collision, bounds } = data;
  const CLEAR = 0.8;
  const free = (x, z) =>
    x > bounds.minX + 5 && x < bounds.maxX - 5 && z > bounds.minZ + 5 && z < bounds.maxZ - 5 &&
    collision.queryAABB(x - CLEAR, 0.01, z - CLEAR, x + CLEAR, 2.2, z + CLEAR).length === 0;

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
    if (free(s.x, s.z)) return { x: s.x, y: 0, z: s.z, heading: s.dir, roadId: s.road.id };
  }
  // No usable street: spiral out from the center.
  for (let r = 0; r < 800; r += 2) {
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (free(x, z)) return { x, y: 0, z, heading: 0, roadId: null };
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

const chunkKey = (x, z, origin, size) => `${Math.floor((x - origin.x) / size)},${Math.floor((z - origin.z) / size)}`;

/**
 * Groups items into square chunks and emits one InstancedMesh per chunk.
 * Each chunk gets a tight bounding sphere, so three.js frustum-culls whole chunks
 * (and skips them in the shadow pass) with zero per-instance CPU cost.
 *
 * Item shape: { x, y, z, sx, sy, sz, color, rx?, ry? } (rx = pitch, ry = yaw, radians)
 */
function buildChunkedInstances(items, { geometry, material, chunkSize, origin, name, castShadow = false, receiveShadow = false }) {
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
      g.setAttribute('aFacade', new THREE.Float32BufferAttribute(this.fac, 3));
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
  capTriangles(b.rings, y1, UP, sink);
  if (y0 > 0.01) capTriangles(b.rings, y0, DOWN, sink);
  return sink.geometry();
}

/**
 * Jerusalem stone: MeshStandardMaterial (matte limestone, roughness 0.85) extended with a
 * procedural ashlar pattern (courses, staggered blocks, per-block tone), deep-set windows
 * with arched tops on some buildings, ground-floor shopfronts, pale flat roofs and warm lit
 * windows at night. All computed in world space, so any footprint shape works without UVs.
 *
 * Vertex inputs: color = stone tint, aFacade = (seed, window density 0..1, shopfronts 0/1).
 */
function createStoneMaterial(uniforms, floorHeight) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85, metalness: 0 });
  mat.customProgramCacheKey = () => 'jerusalem-stone-v1';

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uFloorHeight = { value: floorHeight };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec3 aFacade;
varying vec3 vCityWorldPos;
varying vec3 vCityWorldNormal;
varying vec3 vCityFacade;`,
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
varying vec3 vCityFacade;
float cityHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
// 1 inside a centered box of half-size h (in cell units), anti-aliased.
float cityRect(vec2 p, vec2 h, vec2 aa) {
  vec2 m = 1.0 - smoothstep(-aa, aa, abs(p) - h);
  return m.x * m.y;
}`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
float cityWin = 0.0;
float cityLit = 0.0;
float cityJoint = 0.0;
{
  vec3 n = normalize(vCityWorldNormal);
  float seed = vCityFacade.x;
  if (n.y > 0.5) {
    // Flat roof: pale concrete / whitewash with stains.
    float k = cityHash(vec3(floor(vCityWorldPos.xz * 0.5), 7.0));
    float big = cityHash(vec3(floor(vCityWorldPos.xz * 0.12), 11.0));
    diffuseColor.rgb = mix(vec3(0.35, 0.34, 0.32), vec3(0.37, 0.36, 0.34), k) * mix(0.88, 1.0, big);
  } else if (n.y > -0.5) {
    // Horizontal coordinate along the wall, whatever its direction.
    vec2 t = normalize(vec2(-n.z, n.x));
    float u = dot(vCityWorldPos.xz, t);
    float y = vCityWorldPos.y;

    // Ashlar: 34 cm courses, staggered blocks, per-block tone.
    float cy = y / 0.34;
    float row = floor(cy);
    float cu = u / (0.62 + 0.18 * cityHash(vec3(row, seed * 17.0, 2.0))) + cityHash(vec3(row, 5.0, seed));
    vec2 sc = vec2(cu, cy);
    vec2 sf = fract(sc);
    vec2 saa = fwidth(sc) + 1e-4;
    vec2 jd = min(sf, 1.0 - sf);
    float joint = max(1.0 - smoothstep(0.0, 0.035 + saa.x, jd.x), 1.0 - smoothstep(0.0, 0.05 + saa.y, jd.y));
    float tone = cityHash(vec3(floor(cu), row, seed * 31.0));
    float stoneFade = smoothstep(0.2, 0.55, max(saa.x, saa.y));
    vec3 base = diffuseColor.rgb;
    vec3 stone = base * mix(0.9, 1.06, tone);
    stone = mix(stone, base * 0.78, joint * 0.7);
    diffuseColor.rgb = mix(stone, base * 0.97, stoneFade);
    cityJoint = joint * (1.0 - stoneFade);

    // Windows: narrow, deep-set, some buildings with arched tops.
    float density = vCityFacade.y;
    if (density > 0.0) {
      float bay = mix(4.6, 3.3, density);
      vec2 cell = vec2(u / bay, y / uFloorHeight);
      vec2 id = floor(cell);
      vec2 f = fract(cell) - 0.5;
      vec2 aa = fwidth(cell) + 1e-4;
      vec2 hs = vec2(0.55 / bay, 0.27); // half-size: 1.1 m wide, ~1.7 m tall
      vec2 p = vec2(f.x, f.y + 0.04);
      float win = cityRect(p, hs, aa);
      if (cityHash(vec3(seed, 3.0, 9.0)) > 0.55) {
        // Arch: replace the top of the opening with a semicircle.
        float r = hs.x * bay; // meters
        vec2 pm = vec2(p.x * bay, p.y * uFloorHeight);
        float topY = hs.y * uFloorHeight - r;
        if (pm.y > topY) {
          float d = length(vec2(pm.x, pm.y - topY)) - r;
          win = 1.0 - smoothstep(-aa.x * bay, aa.x * bay, d);
        }
      }
      // A few blind bays, and random missing windows per building.
      win *= step(0.12, cityHash(vec3(id, seed * 7.0)));
      float frame = cityRect(p, hs + vec2(0.1 / bay, 0.035), aa) - win;

      // Ground floor: shopfronts with metal shutters.
      bool ground = y < uFloorHeight * 1.05;
      if (ground) {
        if (vCityFacade.z > 0.5) {
          vec2 sp = vec2(fract(u / 4.2) - 0.5, y);
          float shop = cityRect(vec2(sp.x, sp.y - 1.55), vec2(0.4, 1.2), vec2(fwidth(u / 4.2), fwidth(y)) + 1e-4);
          win = shop;
          frame = 0.0;
          id = vec2(floor(u / 4.2), -1.0);
        } else {
          win *= 0.0;
          frame *= 0.0;
        }
      }
      float fade = smoothstep(0.25, 0.6, max(aa.x, aa.y));
      float avg = (2.0 * hs.x) * (2.0 * hs.y) * 0.9;
      cityWin = mix(win, avg, fade);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.08, frame * (1.0 - fade));
      float lit = step(0.6, cityHash(vec3(id, n.x * 3.0 + n.z * 5.0 + seed * 97.0)));
      cityLit = mix(win * lit, avg * 0.4, fade);
      vec3 glass = mix(vec3(0.03, 0.035, 0.04), vec3(0.09, 0.11, 0.12), cityHash(vec3(id, 3.0)));
      diffuseColor.rgb = mix(diffuseColor.rgb, glass, cityWin);
    }
  }
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.95, cityJoint);
roughnessFactor = mix(roughnessFactor, 0.15, cityWin);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
{
  float tint = cityHash(vec3(floor(vCityWorldPos.y / uFloorHeight), vCityFacade.x * 53.0, 1.0));
  vec3 warm = mix(vec3(1.0, 0.7, 0.4), vec3(0.8, 0.87, 1.0), step(0.8, tint));
  totalEmissiveRadiance += cityLit * uNight * warm * 1.4;
}`,
      );
  };
  return mat;
}
