import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // three.js alone is ~600 kB minified; don't warn about it.
    chunkSizeWarningLimit: 1500,
  },
});
