import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  define: {
    __TAILMOUSE_TAILCAT_ASSETS__: JSON.stringify({
      runtime: './tailcat/wasm_exec-testhash.js',
      wasm: './tailcat/tailcat-web-testhash.wasm',
      wasmBytes: 8,
    }),
    __TAILMOUSE_RESOURCE_ASSETS__: JSON.stringify({
      runtime: '/tailcat/wasm_exec-testhash.js',
      wasm: '/tailcat/resource-testhash.wasm',
      bytes: 8,
    }),
    __TAILMOUSE_BUILD__: JSON.stringify({
      version: '0.0.0-test',
      tailcatRevision: '1'.repeat(40),
      protocols: { escape: 1, leash: 2, resource: 2 },
    }),
  },
  test: {
    attachmentsDir: '../../test-results/components/attachments',
    coverage: {
      exclude: ['src/**/*.d.ts', 'src/**/*.{test,spec}.{ts,tsx}'],
      include: ['src/**/*.{ts,tsx}', 'worker.ts', 'content/*.ts'],
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
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['src/**/*.browser.{test,spec}.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'components',
          include: ['src/**/*.browser.{test,spec}.{ts,tsx}'],
          browser: {
            enabled: true,
            headless: true,
            screenshotDirectory: '../../test-results/components',
            provider: playwright({
              contextOptions: { hasTouch: true },
              launchOptions: {
                chromiumSandbox: process.env.TAILMOUSE_TEST_NO_SANDBOX !== '1',
              },
            }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
