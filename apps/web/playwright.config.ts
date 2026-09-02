import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  ...(process.env.CI ? { workers: 1 } : {}),
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: true,
  outputDir: '../../test-results/playwright',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 15'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
  ],
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  retries: process.env.CI ? 2 : 0,
  testDir: '../../tests/e2e',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    serviceWorkers: 'block',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort',
    cwd: import.meta.dirname,
    reuseExistingServer: false,
    url: 'http://127.0.0.1:4173',
  },
});
