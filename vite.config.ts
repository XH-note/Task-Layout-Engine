import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    watch: {
      // The file-edit tool writes through hidden atomic temp directories; watching
      // them makes chokidar throw EBUSY on Windows and kills the dev server.
      ignored: ['**/.*.tmpdir/**', '**/.tmp*/**'],
    },
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
