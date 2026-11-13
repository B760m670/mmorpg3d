import { defineConfig } from 'vite';

// Dev serves at '/', production build is served from the GitHub Pages project
// path '/mmorpg3d/'. Override with BASE_PATH env if you deploy elsewhere.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? process.env.BASE_PATH || '/mmorpg3d/' : '/',
  // terrain grids (gzip'd binary, see tools/build_terrain.py)
  assetsInclude: ['**/*.dat'],
  server: {
    host: true, // expose on LAN so you can open it from other devices
    port: 5173,
  },
  build: {
    target: 'es2022',   // top-level await (terrain data); Safari 15+
    outDir: 'dist',
    // INLINE_ASSETS=1 embeds models as data URLs for the single-file page.
    assetsInlineLimit: process.env.INLINE_ASSETS ? 16 * 1024 * 1024 : 4096,
  },
}));
