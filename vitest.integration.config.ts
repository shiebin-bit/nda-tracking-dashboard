import { defineConfig } from 'vitest/config';
export default defineConfig({ test:{ include:['server/**/*.integration.test.ts'], environment:'node', testTimeout:30_000, hookTimeout:30_000, fileParallelism:false } });
