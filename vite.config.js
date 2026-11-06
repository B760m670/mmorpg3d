import { defineConfig } from 'vite';

// Dev serves at '/', production build is served from the GitHub Pages project
// path '/mmorpg3d/'. Override with BASE_PATH env if you deploy elsewhere.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? process.env.BASE_PATH || '/mmorpg3d/' : '/',
  server: {
    host: true, // expose on LAN so you can open it from other devices
    port: 5173,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
}));
