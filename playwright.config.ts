import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke tests. These build the app and run the real server, then
 * drive it in a browser — covering the flows unit tests can't (initial
 * connection + history, sending, upload, reconnect). Run with `pnpm test:e2e`;
 * not part of the default vitest run or CI's `pnpm test`.
 */
const PORT = 3099;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `node bin/sync-splat.js --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/info`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
