import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: '/static/pollar/',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: resolve(here, '../static/pollar'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: resolve(here, 'src/main.jsx'),
      output: {
        entryFileNames: 'pollar-widget.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (a) => a.name?.endsWith('.css') ? 'pollar-widget.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
});