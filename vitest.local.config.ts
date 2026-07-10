import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/local/**/*.test.ts'],
    exclude: [],
    reporters: ['default', './scripts/local-test-reporter.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
    sequence: { concurrent: false },
  },
});
