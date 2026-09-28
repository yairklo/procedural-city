import { realpathSync } from 'node:fs';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

// Vite resolves module ids to real paths. When the project folder is a symlink or is
// redirected by the OS (e.g. Windows app-data virtualization), the real path lies outside
// the default allow list and the dev server answers 403: module workers then fail to load.
const root = process.cwd();
const allow = [...new Set([searchForWorkspaceRoot(root), realpathSync.native(root)])];

export default defineConfig({
  server: {
    port: 5173,
    fs: { allow },
  },
  worker: {
    format: 'es', // the cell worker imports modules (three.js, the city generator)
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // three.js alone is ~600 kB minified; don't warn about it.
    chunkSizeWarningLimit: 1500,
  },
});
