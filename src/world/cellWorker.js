// Web worker: generates city data for grid cells and builds their geometry, so the main thread
// only wraps ready-made buffers in meshes when a cell streams in.
//
// Messages (each carries an `id`, answered with { id, ...result } or { id, error }):
//   init      { worldBBox, dem, cityOptions, seed }      projection + terrain (same as main thread)
//   generate  { cellId, url? , osm? }                    -> { data: chunkLookup(chunk) }; keeps the chunk
//   build     { cellId, level }                          -> { parts } (buffers transferred)
//   forget    { cellId }                                 drops a cached chunk

import { createProjection } from '../city/geo.js';
import { createTerrain } from '../city/terrain.js';
import { generateCityChunk, buildChunkParts, packChunkParts, chunkLookup, DEFAULT_CITY_OPTIONS } from '../city/CityGenerator.js';

let state = null;
const chunks = new Map();

self.onmessage = async (event) => {
  const m = event.data;
  try {
    if (m.type === 'init') {
      const projection = createProjection(m.worldBBox);
      state = { projection, terrain: createTerrain(m.dem, projection), options: { ...DEFAULT_CITY_OPTIONS, ...m.cityOptions }, seed: m.seed };
      self.postMessage({ id: m.id, ok: true });
    } else if (m.type === 'generate') {
      let osm = m.osm;
      if (m.url) {
        const res = await fetch(m.url);
        if (!res.ok) throw new Error(`${m.url}: HTTP ${res.status}`);
        osm = await res.json();
      }
      const chunk = generateCityChunk(osm, { projection: state.projection, terrain: state.terrain, options: state.options, seed: `${state.seed}/${m.cellId}`, id: m.cellId });
      chunks.set(m.cellId, chunk);
      self.postMessage({ id: m.id, data: chunkLookup(chunk) });
    } else if (m.type === 'build') {
      const chunk = chunks.get(m.cellId);
      if (!chunk) throw new Error(`cell ${m.cellId} not generated`);
      const { parts, transfer } = packChunkParts(buildChunkParts(chunk, { terrain: state.terrain, level: m.level }));
      self.postMessage({ id: m.id, parts }, transfer);
    } else if (m.type === 'forget') {
      chunks.delete(m.cellId);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: err.message });
  }
};
