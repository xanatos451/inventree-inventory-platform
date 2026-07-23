const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  outputDir: "../../.artifacts/playwright/test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "../../.artifacts/playwright/report" }]],
  use: {
    headless: false,
    trace: "on-first-retry",
  },
});
