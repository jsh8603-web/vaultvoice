const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  globalSetup: './tests/global-setup.js',
  globalTeardown: './tests/global-teardown.js',
  testDir: './tests',
  testIgnore: ['**/helpers.js', '**/global-setup.js', '**/global-teardown.js'],
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['json', {  outputFile: 'test-results.json' }]],
  use: {
    baseURL: 'http://localhost:3939',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'api-unit',
      testMatch: /api-unit|vaultvoice|calendar/,
      use: { browserName: 'chromium' },
    },
    {
      name: 'ai-integration',
      testMatch: /phase3-scenarios/,
      timeout: 60000,
      retries: 1,
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'node run-test-server.js',
    port: 3939,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
