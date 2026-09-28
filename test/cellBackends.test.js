import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerCellBackend } from '../src/world/cellBackends.js';

// A stand-in for a module worker whose script can't load (e.g. the dev server answers 403):
// the browser fires `error` on the Worker, with no message, and never answers.
function brokenWorker() {
  return {
    terminated: false,
    postMessage() {
      setTimeout(() => this.onerror?.({}), 0);
    },
    terminate() {
      this.terminated = true;
    },
  };
}

function stubWorld() {
  const generated = [];
  return {
    generated,
    manifest: { worldBBox: { south: 0, west: 0, north: 1, east: 1 } },
    dem: {},
    o: { city: {}, seed: 's' },
    loadTile: async (file) => ({ file }),
    generateCell: (cell, osm) => {
      generated.push([cell.id, osm.file]);
      return { buildings: [], roads: [], parks: [], trees: [] };
    },
  };
}

test('cell backend: a worker that fails to start falls back to the main thread', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (msg) => errors.push(String(msg)));
  const world = stubWorld();
  const worker = brokenWorker();
  const backend = new WorkerCellBackend(world, { worker, tileUrl: (f) => `http://x/${f}` });

  const data = await backend.generate({ id: '0_0', source: 'tile', tile: { file: 'osm_0_0.json' } });
  assert.ok(data, 'cell data is generated instead of failing');
  assert.deepEqual(world.generated, [['0_0', 'osm_0_0.json']]);
  assert.ok(backend.local, 'switched to the local backend');
  assert.ok(worker.terminated, 'the broken worker is terminated');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cell worker failed to start/);
});
