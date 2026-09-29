import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build also works under a sub-path (GitHub Pages project site).
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
