import { defineConfig } from 'vitest/config';

/**
 * `pnpm pen-test:probe`: the pen-test probes that need the pen-test deployment (E1), which
 * `pnpm pen-test:up` and `pnpm pen-test:seed` start. Never part of `pnpm test`.
 */
export default defineConfig({
  test: {
    name: 'pen-test-probes',
    root: import.meta.dirname,
    include: ['src/pen-test/probes/**/*.probe.ts'],
    environment: 'node',
    // One deployment, one shared limiter and one set of fixtures: run the files in order.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
