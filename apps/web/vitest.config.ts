import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/**/*.d.ts', 'src/**/*.{test,spec}.{ts,tsx}'],
      include: ['src/**/*.{ts,tsx}'],
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
