import { defineConfig, devices } from "@playwright/test";

/**
 * E2E + keyboard-a11y smoke against the OFFLINE MockProvider (no Blockfrost key, no
 * wallet) — the read-only surfaces + a11y affordances that the unit/component suites
 * can't exercise end-to-end. `DATA_PROVIDER=mock` forces the mock even under a
 * production `next start` (the seam otherwise refuses mock-in-prod).
 *
 * Full wallet/post/reclaim flows need an injected CIP-30 provider and are deliberately
 * NOT covered here (a documented gap) — they live in the Vitest component suite.
 *
 * Run with `npm run e2e`. Excluded from the tsc/lint gates (Playwright type-checks its
 * own specs); validated by running.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // A single `next start` serves all workers; cap concurrency so a cold-load stampede on
  // the heavy MeshJS pages doesn't starve the assertion timeout.
  workers: process.env.CI ? 2 : 4,
  // First load of the swap / pool pages pulls in the MeshJS bundle — give assertions
  // room beyond the 5s default so a slow cold render isn't a flaky failure.
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      // Desktop viewport so the (sm:flex) header nav is visible.
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Self-contained: build then serve. `reuseExistingServer` skips this locally when a
    // dev/prod server is already up on :3000.
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    env: { DATA_PROVIDER: "mock", NEXT_TELEMETRY_DISABLED: "1" },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
