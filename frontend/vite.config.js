import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// /api/auth/* goes to the shared Quarc Auth service; everything else under
// /api/* goes to this app's own backend. Mirrors how nginx splits these two
// routes in production. Shared between `dev` and `preview` (production
// build smoke-testing) so both work the same way against local containers.
const apiProxy = {
  '/api/auth': {
    target: process.env.VITE_AUTH_PROXY_TARGET || 'http://localhost:3902',
    changeOrigin: true,
  },
  '/api': {
    target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3908',
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  build: {
    // pdf.js and Excalidraw are big; one warning about it is just noise.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // pdf.js' worker is a module script, which browsers only run when the server calls it JavaScript. A web server
        // that does not know the ".mjs" extension (older nginx images) serves it as a generic download and every PDF
        // then fails to open ("Setting up fake worker failed"). So no asset keeps the ".mjs" name: same file, same hash,
        // named ".js", which every server knows. (tests/e2e.mjs, scenario `mime`, serves the build like such a server.)
        assetFileNames: (info) => {
          const name = (info.names && info.names[0]) || info.name || '';
          return /\.mjs$/i.test(name) ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
