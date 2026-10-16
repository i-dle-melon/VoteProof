// File-backed browser components: no listener, DNS or API network access.
// The normal workerd/browser smoke configuration remains unchanged.
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./frontend-tests",
  testMatch: "campaign-category.spec.js",
  workers: 1,
  timeout: 30000,
  globalSetup: "./scripts/lib/component-browser-setup.mjs",
  outputDir: ".wrangler/campaign-component-browser",
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4173", trace: "off", screenshot: "off", video: "off" },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
    { name: "android-chrome", use: { ...devices["Pixel 7"], channel: "chrome" } },
    { name: "iphone-webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
});
