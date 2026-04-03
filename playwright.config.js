const { defineConfig } = require('@playwright/test');
const path = require('path');

// e2e-realenv 실행 시 TUNNEL_URL 환경변수로 감지 — 로컬 webServer 불필요
const tunnelUrl = process.env.TUNNEL_URL;
const isRealEnv = !!tunnelUrl;

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
      testMatch: /api-unit|vaultvoice|calendar|stage2-3/,
      use: { browserName: 'chromium' },
    },
    {
      name: 'ai-integration',
      testMatch: /phase3-scenarios|stage2-3/,
      timeout: 60000,
      retries: 1,
      use: { browserName: 'chromium' },
    },
    {
      name: 'e2e-realenv',
      testMatch: /e2e-realenv|e2e-ui/,
      // SR D5 ACCEPT: 20건×8초(rate limit)+AI대기(5~10분) = 총 5~10분 필요 → 300s
      timeout: 300000,
      retries: 1,
      use: {
        browserName: 'chromium',
        baseURL: tunnelUrl || 'https://saturn-survivors-impossible-lecture.trycloudflare.com',
      },
    },
  ],
  // e2e-realenv는 GCP 운영 서버에 직접 연결 — 로컬 webServer 불필요
  webServer: isRealEnv ? undefined : {
    command: 'node run-test-server.js',
    port: 3939,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
