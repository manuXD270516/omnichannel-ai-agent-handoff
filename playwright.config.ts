import { defineConfig, devices } from "@playwright/test";

const PORT = 8791;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm exec tsx src/node.ts",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DB_PATH: "memory", LLM_PROVIDER: "scripted" },
  },
});
