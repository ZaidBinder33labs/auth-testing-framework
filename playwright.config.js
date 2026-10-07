const { devices } = require('@playwright/test');

module.exports = {
  testDir: './tests',
  testMatch: /.*\.spec\.js$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: process.env.TARGET_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results.json' }],
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  maxFailures: undefined,
  timeout: 30000,
};