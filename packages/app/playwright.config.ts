import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const serverHost = process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
const command = process.env.PLAYWRIGHT_WEB_COMMAND ?? `bun run dev -- --host 0.0.0.0 --port ${port}`
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "1"
const reuse = !process.env.CI
const workers = Number(process.env.PLAYWRIGHT_WORKERS ?? (process.env.CI ? 5 : 0)) || undefined
const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL
const reporter = [["html", { outputFolder: "e2e/playwright-report", open: "never" }], ["line"]] as const
const trace = process.env.PAWWORK_PERF_TRACE === "1" ? "on" : "on-first-retry"
const video = process.env.PLAYWRIGHT_VIDEO === "off" ? "off" : "retain-on-failure"

if (process.env.PLAYWRIGHT_JUNIT_OUTPUT) {
  reporter.push(["junit", { outputFile: process.env.PLAYWRIGHT_JUNIT_OUTPUT }])
}

// PLAYWRIGHT_SNAP=1 flips the matcher so `bun run snap` only runs `*.snap.ts`,
// and the default `test:e2e` only runs `*.spec.ts` — snap and regression are
// disjoint, neither polls the other.
const snapMode = process.env.PLAYWRIGHT_SNAP === "1"

export default defineConfig({
  testDir: "./e2e",
  testMatch: snapMode ? ["**/snap/*.snap.ts"] : ["**/*.spec.ts"],
  outputDir: "./e2e/test-results",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: process.env.PLAYWRIGHT_FULLY_PARALLEL === "1",
  forbidOnly: !!process.env.CI,
  // snap is for human-reviewed PNGs; flaky retries would silently overwrite the
  // grid and mask the failure signal an agent is supposed to read.
  retries: snapMode ? 0 : process.env.CI ? 2 : 0,
  workers,
  reporter,
  webServer: skipWebServer
    ? undefined
    : {
        command,
        url: baseURL,
        reuseExistingServer: reuse,
        timeout: 120_000,
        env: {
          VITE_PAWWORK_SHELL_OS: "macos",
          VITE_OPENCODE_SERVER_HOST: serverHost,
          VITE_OPENCODE_SERVER_PORT: serverPort,
        },
      },
  use: {
    baseURL,
    trace,
    screenshot: "only-on-failure",
    video,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...(browserChannel ? { channel: browserChannel } : {}) },
    },
  ],
})
