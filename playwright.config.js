import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./frontend-tests", fullyParallel: false, workers: 1, timeout: 30000,
  outputDir: ".wrangler/frontend-test-results", reporter: "list",
  use: { baseURL: "http://127.0.0.1:4173", trace: "off", screenshot: "off", video: "off" },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
    { name: "android-chrome", use: { ...devices["Pixel 7"], channel: "chrome" } },
    { name: "iphone-webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
  webServer: { command: "node scripts/frontend-test-server.mjs", url: "http://127.0.0.1:4173", reuseExistingServer: false },
});
