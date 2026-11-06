import { defineConfig } from 'vite';

// Minimal Vite config. The project is plain ES modules + three.js,
// so no framework plugins are needed yet.
export default defineConfig({
  server: {
    host: true, // expose on LAN so you can open it from other devices
    port: 5173,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
