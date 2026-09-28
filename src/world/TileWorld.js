// Tiled, streamed Jerusalem.
//
// The world is the grid from public/data/tiles/manifest.json (tiles-v1). Every grid cell
// (i, j) is a streaming unit whose city data comes from, in order:
//   1. its manifest tile file (osm_<i>_<j>.json), when the manifest lists one;
//   2. otherwise the legacy city-centre file (jerusalem_data.json): the legacy features whose
//      centroid (buildings, parks, road areas) / midpoint (roads) / position (trees) falls in
//      this cell. Legacy features in cells that have a manifest tile are skipped, so the
//      overlap never shows duplicates, and a tile added later simply takes over its cell;
//   3. otherwise nothing: terrain only.
//
// Everything is projected with ONE projection, createProjection(manifest.worldBBox), whose
// origin is fixed at the world centre, and seated on one terrain from dem_points.json. Adding
// tiles therefore never moves anything, and chunks line up exactly at cell borders.
//
// Levels of detail, by distance from the player to the cell (with hysteresis):
//   near    full detail + collision (boxes are added to / removed from the shared world)
//   medium  simplified buildings, roads, no props, no collision
//   far     building silhouettes only
//   none    unloaded (city data stays cached; meshes and collision are freed)
// The terrain itself is always there (per-cell grids, finer when near), so the player never
// falls, whatever is loaded.

import * as THREE from 'three';
import { createProjection } from '../city/geo.js';
import { createTerrain } from '../city/terrain.js';
import { CityCollisionWorld } from '../city/CityCollision.js';
import { gridCellBBox, gridCellOf, ringVertexAverage, ownedRuns, inBBox } from '../city/tiling.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  generateCityChunk, assembleChunk, createCityMaterials, createGroundMaterial, createOuterMaterial,
  terrainGeometry, findRoadsAt, MAJOR_HIGHWAYS, DEFAULT_CITY_OPTIONS,
} from '../city/CityGenerator.js';
import { LocalCellBackend } from './cellBackends.js';

export const LEVELS = ['none', 'far', 'medium', 'near'];
const RANK = { none: 0, far: 1, medium: 2, near: 3 };

export const DEFAULT_WORLD_OPTIONS = Object.freeze({
  name: 'Jerusalem',
  seed: 'jerusalem',
  nearDistance: 500, // player-to-cell distance (m) for full detail + collision
  mediumDistance: 1200,
  farDistance: 2600,
  hysteresis: 120, // a cell drops a level only this far beyond the threshold
  maxBuildsPerUpdate: 1, // mesh (re)builds started per update() call
  maxConcurrentBuilds: 2,
  maxConcurrentLoads: 2,
  terrainSpacing: { near: 8, medium: 16, far: 32, none: 32 },
  terrainSkirt: 4,
  surroundReach: 900, // coarse terrain around the world, easing to the mean edge height
  maskResolution: 16, // meters per texel of the city/hillside ground mask
  propDrawDistance: 450,
  city: {}, // overrides for DEFAULT_CITY_OPTIONS
});

const JAFFA = /jaffa|yafo|יפו/i;

export class TileWorld {
  /**
   * @param {object} p
   * @param {object} p.manifest      tiles-v1 manifest
   * @param {object} p.dem           dem-points-v1 elevation for the whole world
   * @param {object|null} [p.legacy] osm-city-v1 legacy city centre (optional)
   * @param {(file:string) => Promise<object>} p.loadTile  fetches a tile file listed in the manifest
   * @param {Partial<typeof DEFAULT_WORLD_OPTIONS>} [p.options]
   * @param {(world: TileWorld) => object} [p.backend]  where cells are generated and built
   *   (default: LocalCellBackend, same thread; the game uses WorkerCellBackend)
   */
  constructor({ manifest, dem, legacy = null, loadTile, options = {}, backend = null }) {
    if (manifest?.format !== 'tiles-v1') throw new Error('TileWorld: manifest must be tiles-v1');
    this.o = { ...DEFAULT_WORLD_OPTIONS, ...options, terrainSpacing: { ...DEFAULT_WORLD_OPTIONS.terrainSpacing, ...options.terrainSpacing } };
    this.cityOptions = { ...DEFAULT_CITY_OPTIONS, ...this.o.city };
    this.manifest = manifest;
    this.loadTile = loadTile;
    this.name = this.o.name;

    // One projection and one terrain for everything.
    this.projection = createProjection(manifest.worldBBox);
    this.bounds = this.projection.bounds;
    this.dem = dem;
    this.terrain = createTerrain(dem, this.projection);
    this.collision = new CityCollisionWorld({ cellSize: this.cityOptions.collisionCellSize, groundHeightAt: this.terrain.heightAt });
    this.attribution = [manifest.attribution ?? '© OpenStreetMap contributors', dem.attribution].filter(Boolean).join(' · ');

    this.uniforms = { uNight: { value: 0 } };
    this.materials = createCityMaterials(this.uniforms, this.cityOptions);
    this.group = new THREE.Group();
    this.group.name = 'TileWorld';
    this.onChunkBuilt = null; // (group) => void, e.g. to set up shadows on new meshes

    this._buildGrid();
    this.legacy = legacy ? this._partitionLegacy(legacy) : null;
    this.places = this._collectPlaces(legacy);
    this._buildGround();
    this.spawn = null;
    this._inflight = new Set();
    this._builds = new Set();
    this.backend = backend ? backend(this) : new LocalCellBackend(this);
  }

  // ------------------------------------------------------------------------------------------
  // Grid
  // ------------------------------------------------------------------------------------------

  _buildGrid() {
    const g = this.manifest.grid, wb = this.manifest.worldBBox;
    this.nx = Math.round((wb.east - g.west) / g.dLon);
    this.ny = Math.round((wb.north - g.south) / g.dLat);
    const tiles = new Map((this.manifest.tiles ?? []).map((t) => [`${t.i}_${t.j}`, t]));
    this.cells = new Map();
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const id = `${i}_${j}`;
        const bbox = gridCellBBox(g, i, j); // same rounded, half-open bounds as the tile files
        const nw = this.projection.project(bbox.north, bbox.west), se = this.projection.project(bbox.south, bbox.east);
        this.cells.set(id, {
          id, i, j, bbox,
          rect: { minX: nw.x, maxX: se.x, minZ: nw.z, maxZ: se.z },
          tile: tiles.get(id) ?? null,
          legacyOsm: null,
          source: tiles.has(id) ? 'tile' : 'none',
          level: 'none',
          data: null,
          loading: null,
          failed: false,
          view: null,
          target: 'none',
          building: null,
          ground: null,
          coarseGround: null,
          groundLevel: null,
          collision: false,
        });
      }
    }
  }

  /** Grid cell containing (x, z), or null outside the world. */
  cellAt(x, z) {
    const { lat, lon } = this.projection.unproject(x, z);
    return this.cellAtLatLon(lat, lon);
  }

  /** Grid cell owning (lat, lon) with the tiles' half-open bounds, or null outside the world. */
  cellAtLatLon(lat, lon) {
    const { i, j } = gridCellOf(this.manifest.grid, lat, lon);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return null;
    return this.cells.get(`${i}_${j}`);
  }

  /**
   * Splits the legacy file by cell with exactly the tile pipeline's ownership rules
   * (src/city/tiling.js): buildings, parks and road areas by the vertex average of the outer
   * ring, trees by position (half-open cell bounds), and roads cut at every cell border
   * (Liang-Barsky, new vertex on the border). Whatever falls in a cell that has a manifest
   * tile, or outside the world, is dropped: those cells are the tile's alone, so a feature on
   * a border and a road running into a tile are never shown twice and never leave a gap.
   */
  _partitionLegacy(legacy) {
    const sub = new Map();
    const target = (cell) => {
      if (!cell || cell.tile) return null;
      if (!sub.has(cell.id)) sub.set(cell.id, { ...legacy, buildings: [], roads: [], roadAreas: [], parks: [], trees: [], places: [] });
      return sub.get(cell.id);
    };
    let kept = 0, skipped = 0;
    const byRing = (list, item) => {
      const c = ringVertexAverage(item.rings[0]);
      const s = target(this.cellAtLatLon(c.lat, c.lon));
      if (s) { s[list].push(item); kept++; } else skipped++;
    };
    for (const b of legacy.buildings ?? []) byRing('buildings', b);
    for (const pk of legacy.parks ?? []) byRing('parks', pk);
    for (const a of legacy.roadAreas ?? []) byRing('roadAreas', a);

    for (const road of legacy.roads ?? []) {
      // Cells the road's bounding box touches; each keeps the runs it owns.
      let s0 = Infinity, n0 = -Infinity, w0 = Infinity, e0 = -Infinity;
      for (let k = 0; k < road.points.length; k += 2) {
        s0 = Math.min(s0, road.points[k]); n0 = Math.max(n0, road.points[k]);
        w0 = Math.min(w0, road.points[k + 1]); e0 = Math.max(e0, road.points[k + 1]);
      }
      const lo = gridCellOf(this.manifest.grid, s0, w0), hi = gridCellOf(this.manifest.grid, n0, e0);
      const pieces = [];
      for (let j = Math.max(0, lo.j); j <= Math.min(this.ny - 1, hi.j); j++) {
        for (let i = Math.max(0, lo.i); i <= Math.min(this.nx - 1, hi.i); i++) {
          const cell = this.cells.get(`${i}_${j}`);
          for (const points of ownedRuns(road.points, cell.bbox)) pieces.push({ cell, points });
        }
      }
      pieces.forEach(({ cell, points }, k) => {
        const s = target(cell);
        if (s) { s.roads.push({ ...road, id: pieces.length > 1 ? `${road.id}.${k}` : road.id, points }); kept++; } else skipped++;
      });
    }

    const t = legacy.trees ?? [];
    for (let k = 0; k + 1 < t.length; k += 2) {
      const s = target(this.cellAtLatLon(t[k], t[k + 1]));
      if (s) s.trees.push(t[k], t[k + 1]);
    }
    for (const [id, osm] of sub) {
      const cell = this.cells.get(id);
      cell.legacyOsm = osm;
      cell.source = 'legacy';
    }
    const bb = legacy.bbox;
    return { kept, skipped, bbox: bb, center: this.projection.project((bb.north + bb.south) / 2, (bb.east + bb.west) / 2), raw: legacy };
  }

  _collectPlaces(legacy) {
    const seen = new Set();
    const out = [];
    for (const p of [...(this.manifest.places ?? []), ...(legacy?.places ?? [])]) {
      const key = p.id ?? `${p.name}@${p.lat},${p.lon}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...this.projection.project(p.lat, p.lon), id: p.id, name: p.nameEn ?? p.name, nameLocal: p.name, place: p.place });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Ground
  // ------------------------------------------------------------------------------------------

  /** A mask over the world: 1 where there is city data (a manifest tile or legacy features). */
  _cityMask() {
    const b = this.bounds, res = this.o.maskResolution;
    const w = Math.max(2, Math.ceil((b.maxX - b.minX) / res)), h = Math.max(2, Math.ceil((b.maxZ - b.minZ) / res));
    const data = new Uint8Array(w * h * 4);
    const legacyRect = this.legacy ? this._latLonRect(this.legacy.bbox) : null;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = b.minX + ((x + 0.5) / w) * (b.maxX - b.minX), pz = b.minZ + ((y + 0.5) / h) * (b.maxZ - b.minZ);
        const cell = this.cellAt(px, pz);
        const inLegacy = legacyRect && cell?.source === 'legacy' && px >= legacyRect.minX && px <= legacyRect.maxX && pz >= legacyRect.minZ && pz <= legacyRect.maxZ;
        const v = cell && (cell.source === 'tile' || inLegacy) ? 255 : 0;
        data.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  _latLonRect(bb) {
    const nw = this.projection.project(bb.north, bb.west), se = this.projection.project(bb.south, bb.east);
    return { minX: nw.x, maxX: se.x, minZ: nw.z, maxZ: se.z };
  }

  _buildGround() {
    const b = this.bounds, t = this.terrain;
    this.groundMask = this._cityMask();
    this.groundMaterial = createGroundMaterial(this.uniforms, { mask: this.groundMask, maskRect: b });
    this.outerMaterial = createOuterMaterial(this.uniforms, b);
    this.groundGroup = new THREE.Group();
    this.groundGroup.name = 'Ground';
    this.group.add(this.groundGroup);
    // Coarse terrain around the whole world (runs under the cells, 0.3 m lower).
    const r = this.o.surroundReach;
    const surround = new THREE.Mesh(
      terrainGeometry(t, { minX: b.minX - r, maxX: b.maxX + r, minZ: b.minZ - r, maxZ: b.maxZ + r }, 48, -0.3),
      this.outerMaterial,
    );
    surround.name = 'TerrainSurroundings';
    surround.receiveShadow = true;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(b.maxX - b.minX + 2 * r + 8000, b.maxZ - b.minZ + 2 * r + 8000).rotateX(-Math.PI / 2).translate(0, t.meanEdge - 0.4, 0),
      this.outerMaterial,
    );
    plane.name = 'OuterGround';
    plane.receiveShadow = true;
    this.groundGroup.add(surround, plane);
    // Far and unloaded cells share one merged coarse mesh (one draw call); near and medium
    // cells get their own finer grids.
    this.farGround = new THREE.Mesh(new THREE.BufferGeometry(), this.groundMaterial);
    this.farGround.name = 'TerrainFar';
    this.farGround.receiveShadow = true;
    this.groundGroup.add(this.farGround);
    for (const cell of this.cells.values()) this._setGroundLevel(cell, 'none');
    this._rebuildFarGround();
  }

  _setGroundLevel(cell, level) {
    const spacing = this.o.terrainSpacing[level];
    if (cell.groundLevel === spacing) return;
    const coarse = spacing >= this.o.terrainSpacing.far;
    if (coarse) {
      if (cell.ground) {
        this.groundGroup.remove(cell.ground);
        cell.ground.geometry.dispose();
        cell.ground = null;
      }
    } else {
      const geo = terrainGeometry(this.terrain, cell.rect, spacing, 0, this.o.terrainSkirt);
      if (cell.ground) {
        cell.ground.geometry.dispose();
        cell.ground.geometry = geo;
      } else {
        cell.ground = new THREE.Mesh(geo, this.groundMaterial);
        cell.ground.name = `Terrain[${cell.id}]`;
        cell.ground.receiveShadow = true;
        this.groundGroup.add(cell.ground);
      }
    }
    if (coarse !== (cell.groundLevel != null && cell.groundLevel >= this.o.terrainSpacing.far)) this._groundDirty = true;
    cell.groundLevel = spacing;
  }

  /** Re-merges the coarse terrain of all far / unloaded cells (only when that set changed). */
  _rebuildFarGround() {
    this._groundDirty = false;
    const far = this.o.terrainSpacing.far;
    const geos = [];
    for (const cell of this.cells.values()) {
      if (cell.groundLevel < far) continue;
      cell.coarseGround ??= terrainGeometry(this.terrain, cell.rect, far, 0, this.o.terrainSkirt);
      geos.push(cell.coarseGround);
    }
    this.farGround.geometry.dispose();
    this.farGround.geometry = geos.length ? mergeGeometries(geos, false) : new THREE.BufferGeometry();
    this.farGround.visible = geos.length > 0;
  }

  // ------------------------------------------------------------------------------------------
  // Streaming
  // ------------------------------------------------------------------------------------------

  distanceToCell(cell, x, z) {
    const r = cell.rect;
    return Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));
  }

  /** Wanted level for a cell at distance d, given its current level (hysteresis when dropping). */
  targetLevel(cell, d) {
    const o = this.o;
    const thresholds = [['near', o.nearDistance], ['medium', o.mediumDistance], ['far', o.farDistance]];
    for (const [level, dist] of thresholds) {
      const keep = RANK[cell.level] >= RANK[level] ? o.hysteresis : 0;
      if (d <= dist + keep) return level;
    }
    return 'none';
  }

  /**
   * Call every frame with the player position. Starts data loads and mesh builds (both run
   * on the backend, off the main thread with WorkerCellBackend) and applies finished builds.
   * Cells that drop to 'none' are freed right away. Returns true when everything is at its
   * target level and nothing is in flight.
   */
  update(pos) {
    const order = [...this.cells.values()]
      .map((cell) => ({ cell, d: this.distanceToCell(cell, pos.x, pos.z) }))
      .sort((a, b) => a.d - b.d);
    let builds = 0, settled = true;
    for (const { cell, d } of order) {
      const target = this.targetLevel(cell, d);
      cell.target = target;
      if (target === cell.level) continue;
      settled = false;
      if (target === 'none') {
        this._applyLevel(cell, 'none', null);
        continue;
      }
      if (!this._hasData(cell)) {
        this._startLoad(cell);
        continue;
      }
      if (!this._hasContent(cell)) {
        this._applyLevel(cell, target, null); // terrain only: nothing to build
        continue;
      }
      if (cell.building || builds >= this.o.maxBuildsPerUpdate || this._builds.size >= this.o.maxConcurrentBuilds) continue;
      this._startBuild(cell, target);
      builds++;
    }
    if (this._groundDirty) this._rebuildFarGround();
    return settled && !this._builds.size && !this._inflight.size;
  }

  /** Loads and builds everything around `pos` right away (spawning, tests, teleports). */
  async settle(pos, { maxRounds = 500 } = {}) {
    const saved = [this.o.maxBuildsPerUpdate, this.o.maxConcurrentBuilds];
    this.o.maxBuildsPerUpdate = this.o.maxConcurrentBuilds = Infinity;
    try {
      for (let round = 0; round < maxRounds; round++) {
        if (this.update(pos)) return;
        await Promise.all([...this._inflight, ...this._builds]);
      }
    } finally {
      [this.o.maxBuildsPerUpdate, this.o.maxConcurrentBuilds] = saved;
    }
  }

  _hasData(cell) {
    return cell.source === 'none' || cell.failed || cell.data !== null;
  }

  _hasContent(cell) {
    const d = cell.data;
    return !!d && (d.buildings.length > 0 || d.roads.length > 0 || d.parks.length > 0 || (d.trees?.length ?? d.trees) > 0);
  }

  _startLoad(cell) {
    if (cell.loading || this._inflight.size >= this.o.maxConcurrentLoads) return;
    const task = (async () => {
      await null; // always settle asynchronously, after `task` is registered below
      try {
        cell.data = await this.backend.generate(cell);
      } catch (err) {
        // A tile listed in the manifest but missing or broken: show terrain only, keep going.
        cell.failed = true;
        console.warn(`[world] tile ${cell.id} unavailable: ${err.message}`);
      } finally {
        cell.loading = null;
        this._inflight.delete(task);
      }
    })();
    cell.loading = task;
    this._inflight.add(task);
  }

  _startBuild(cell, level) {
    const task = (async () => {
      await null;
      let parts = null;
      try {
        parts = await this.backend.build(cell, level);
        if (!this._disposed && cell.target === level && cell.data) {
          this._applyLevel(cell, level, parts);
          parts = null;
        }
      } catch (err) {
        console.warn(`[world] building ${cell.id} (${level}) failed: ${err.message}`);
      } finally {
        for (const part of parts ?? []) if (part.type === 'mesh') part.geometry.dispose(); // arrived too late
        cell.building = null;
        this._builds.delete(task);
      }
    })();
    cell.building = task;
    this._builds.add(task);
  }

  /** City data for one cell, in world coordinates (shared projection and terrain). */
  generateCell(cell, osm) {
    return generateCityChunk(osm, {
      projection: this.projection,
      terrain: this.terrain,
      options: this.cityOptions,
      seed: `${this.o.seed}/${cell.id}`,
      id: cell.id,
    });
  }

  /** Switches a cell to `level`: collision (near only), meshes from `parts`, terrain grid. */
  _applyLevel(cell, level, parts) {
    if (level === 'near' && !cell.collision && cell.data) {
      for (const box of cell.data.boxes) this.collision.add(box, cell.id);
      cell.collision = true;
    } else if (level !== 'near' && cell.collision) {
      this.collision.removeGroup(cell.id);
      cell.collision = false;
    }
    if (cell.view) {
      this.group.remove(cell.view.group);
      cell.view.dispose();
      cell.view = null;
    }
    if (parts?.length) {
      cell.view = assembleChunk(parts, this.materials, `Chunk(${cell.id}:${level})`);
      this.group.add(cell.view.group);
      this.onChunkBuilt?.(cell.view.group, cell);
    }
    this._setGroundLevel(cell, level);
    cell.level = level;
  }

  /** Per frame, after the camera moved: hides rooftop props far from the camera. */
  updateCamera(camera) {
    const p = camera.position;
    const d2 = this.o.propDrawDistance ** 2;
    for (const cell of this.cells.values()) {
      for (const m of cell.view?.detailMeshes ?? []) m.visible = m.boundingBox.distanceToPoint(p) ** 2 < d2;
    }
  }

  setNight(v) {
    this.uniforms.uNight.value = v;
  }

  // ------------------------------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------------------------------

  /** Roads under (x, z) in loaded cells. Roads may extend past their cell, so neighbours are checked too. */
  findRoadsAt(x, z) {
    const out = [];
    for (const cell of this.cells.values()) {
      const d = cell.data;
      if (!d) continue;
      const b = d.bounds;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      out.push(...findRoadsAt(d, x, z));
    }
    return out;
  }

  findPlaceAt(x, z) {
    let best = null, bestD = Infinity;
    for (const p of this.places) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  buildingById(id) {
    for (const cell of this.cells.values()) {
      const b = cell.data?.buildingById.get(id);
      if (b) return b;
    }
    return null;
  }

  stats() {
    const levels = { near: 0, medium: 0, far: 0, none: 0 };
    let buildings = 0;
    for (const cell of this.cells.values()) {
      levels[cell.level]++;
      if (cell.level !== 'none') buildings += cell.data?.buildings.length ?? 0;
    }
    return { cells: this.cells.size, levels, buildings, colliders: this.collision.count, loading: this._inflight.size + this._builds.size };
  }

  // ------------------------------------------------------------------------------------------
  // Spawn
  // ------------------------------------------------------------------------------------------

  /**
   * A clear spot on a street at ground level. With legacy data: Jaffa Road near the old city
   * centre, as before. Otherwise: a major street near the middle of the loaded tiles.
   */
  async findSpawn() {
    const proj = this.projection;
    const candidates = [];
    const addRoads = (roads, center, preferJaffa) => {
      for (const r of roads) {
        const pts = proj.projectFlat(r.points);
        const penalty = preferJaffa && JAFFA.test(`${r.nameEn ?? ''} ${r.name ?? ''}`) ? 0 : MAJOR_HIGHWAYS.has(r.highway) ? 250 : 600;
        for (let i = 0; i + 3 < pts.length; i += 2) {
          const len = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
          for (let t = 0; t <= len; t += 4) {
            const x = pts[i] + ((pts[i + 2] - pts[i]) * t) / (len || 1), z = pts[i + 1] + ((pts[i + 3] - pts[i + 1]) * t) / (len || 1);
            candidates.push({ x, z, score: Math.hypot(x - center.x, z - center.z) + penalty, heading: Math.atan2(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]) });
          }
        }
      }
    };
    const CLEAR = 0.8;
    const free = (x, z) => {
      const y = this.collision.terrainHeight(x, z);
      return this.collision.queryAABB(x - CLEAR, y + 0.01, z - CLEAR, x + CLEAR, y + 2.2, z + CLEAR).length === 0;
    };
    const tryCandidates = async () => {
      candidates.sort((a, b) => a.score - b.score);
      let settledAt = null;
      for (const c of candidates.slice(0, 4000)) {
        const cell = this.cellAt(c.x, c.z);
        if (!cell || cell.source === 'none' || cell.failed) continue; // only on streets of cells with city data
        if (settledAt !== cell.id) {
          await this.settle(c);
          settledAt = cell.id;
        }
        if (free(c.x, c.z)) return { x: c.x, y: this.collision.terrainHeight(c.x, c.z), z: c.z, heading: c.heading };
      }
      candidates.length = 0;
      return null;
    };

    if (this.legacy) {
      const roads = [...this.cells.values()].filter((c) => c.legacyOsm).flatMap((c) => c.legacyOsm.roads);
      addRoads(roads, this.legacy.center, true);
      this.spawn = await tryCandidates();
      if (this.spawn) return this.spawn;
    }
    // Tiles nearest the middle of the mapped area, a few at a time.
    const tiles = [...this.cells.values()].filter((c) => c.source === 'tile');
    const mid = tiles.length
      ? { x: tiles.reduce((a, c) => a + (c.rect.minX + c.rect.maxX) / 2, 0) / tiles.length, z: tiles.reduce((a, c) => a + (c.rect.minZ + c.rect.maxZ) / 2, 0) / tiles.length }
      : { x: 0, z: 0 };
    const byDistance = (cells) => cells.sort((a, b) => this.distanceToCell(a, mid.x, mid.z) - this.distanceToCell(b, mid.x, mid.z));
    for (const cell of byDistance(tiles).slice(0, 6)) {
      try {
        const osm = await this.loadTile(cell.tile.file);
        addRoads(osm.roads ?? [], mid, false);
      } catch { continue; }
      this.spawn = await tryCandidates();
      if (this.spawn) return this.spawn;
    }
    // No usable street: the middle of the nearest cell with data (or the world centre).
    const withData = byDistance([...this.cells.values()].filter((c) => c.source !== 'none' && !c.failed));
    const at = withData.length ? { x: (withData[0].rect.minX + withData[0].rect.maxX) / 2, z: (withData[0].rect.minZ + withData[0].rect.maxZ) / 2 } : { x: 0, z: 0 };
    await this.settle(at);
    this.spawn = { x: at.x, y: this.collision.groundHeight(at.x, at.z), z: at.z, heading: 0 };
    return this.spawn;
  }

  dispose() {
    this._disposed = true;
    this.backend.dispose?.();
    for (const cell of this.cells.values()) {
      cell.view?.dispose();
      cell.ground?.geometry.dispose();
      cell.coarseGround?.dispose();
    }
    this.groundGroup.traverse((o) => o.isMesh && o.geometry.dispose());
    this.groundMaterial.dispose();
    this.outerMaterial.dispose();
    this.groundMask.dispose();
    this.materials.dispose();
    this.group.clear();
  }
}
