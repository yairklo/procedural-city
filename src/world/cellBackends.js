// Where a TileWorld's cells are generated and built.
//
//   LocalCellBackend   same thread (node tests, fallback). Keeps the full chunk as cell data.
//   WorkerCellBackend  a web worker (src/world/cellWorker.js): data generation and geometry
//                      building run off the main thread; cell data is the light chunkLookup().
//
// Interface: generate(cell) -> Promise<data>, build(cell, level) -> Promise<parts>, dispose().

import { buildChunkParts, unpackChunkParts } from '../city/CityGenerator.js';

export class LocalCellBackend {
  constructor(world) {
    this.world = world;
  }

  async generate(cell) {
    const osm = cell.source === 'tile' ? await this.world.loadTile(cell.tile.file) : cell.legacyOsm;
    if (!osm) return null;
    return this.world.generateCell(cell, osm);
  }

  async build(cell, level) {
    return buildChunkParts(cell.data, { terrain: this.world.terrain, level });
  }

  dispose() {}
}

export class WorkerCellBackend {
  /**
   * @param {import('./TileWorld.js').TileWorld} world
   * @param {{ worker: Worker, tileUrl: (file:string) => string }} o  tileUrl must be absolute (the worker fetches it)
   */
  constructor(world, { worker, tileUrl }) {
    this.world = world;
    this.worker = worker;
    this.tileUrl = tileUrl;
    this.pending = new Map();
    this.nextId = 1;
    worker.onmessage = (event) => {
      const { id, error, ...result } = event.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
    worker.onerror = (event) => {
      for (const p of this.pending.values()) p.reject(new Error(event.message || 'cell worker failed'));
      this.pending.clear();
    };
    // If the worker can't start (script blocked or failing to load, init error), build on the
    // main thread instead of leaving every cell empty. Decided once, before any cell is
    // generated, so all cell data comes from one backend.
    this.local = null;
    this.ready = this._call({ type: 'init', worldBBox: world.manifest.worldBBox, dem: world.dem, cityOptions: world.o.city, seed: world.o.seed })
      .catch((err) => {
        console.error(`[world] cell worker failed to start (${err.message}); building cells on the main thread instead`);
        this.worker.terminate();
        this.local = new LocalCellBackend(world);
      });
  }

  _call(message, transfer) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer ?? []);
    });
  }

  async generate(cell) {
    await this.ready;
    if (this.local) return this.local.generate(cell);
    const message = { type: 'generate', cellId: cell.id };
    if (cell.source === 'tile') message.url = this.tileUrl(cell.tile.file);
    else if (cell.legacyOsm) message.osm = cell.legacyOsm;
    else return null;
    return (await this._call(message)).data;
  }

  async build(cell, level) {
    await this.ready;
    if (this.local) return this.local.build(cell, level);
    const { parts } = await this._call({ type: 'build', cellId: cell.id, level });
    return unpackChunkParts(parts);
  }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
  }
}
