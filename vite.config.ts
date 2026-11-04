import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { target: 'es2022', outDir: 'dist/public', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/health': 'http://127.0.0.1:3000' } },
  test: { include: ['src/**/*.test.ts', 'server/**/*.test.ts'], exclude: ['server/**/*.integration.test.ts'], environment: 'node' },
});
