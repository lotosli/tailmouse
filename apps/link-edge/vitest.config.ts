import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': new URL(
        './tests/cloudflare-workers.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      exclude: ['src/**/*.{test,spec}.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportOnFailure: true,
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    environment: 'node',
    passWithNoTests: true,
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
