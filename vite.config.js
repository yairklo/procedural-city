import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
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
