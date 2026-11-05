// @ts-check
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
    testDir: "./tests",
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 60000,
    expect: { timeout: 10000 },
    reporter: [["list"]],
    outputDir: "test-results",
    use: {
        actionTimeout: 15000,
        trace: "retain-on-failure"
    },
    projects: [
        { name: "chromium", use: { ...devices["Desktop Chrome"] } }
    ]
});
