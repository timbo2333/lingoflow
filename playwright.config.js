const { defineConfig } = require("@playwright/test");

const baseURL = "http://127.0.0.1:4173";

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  reporter: "list",
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" }
    }
  ],
  webServer: {
    command: "python3 -m http.server 4173 --bind 127.0.0.1",
    cwd: __dirname,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 10_000,
    gracefulShutdown: {
      signal: "SIGINT",
      timeout: 500
    }
  }
});
