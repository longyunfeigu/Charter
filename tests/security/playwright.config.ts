import { defineConfig } from '@playwright/test';

/** Renderer-level security matrix (§16.4) against the real Electron shell. */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts', // unit/ belongs to the vitest half of test:security
  timeout: 120000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '../../test-results/security-report.json' }]],
  use: {
    trace: 'retain-on-failure',
  },
});
