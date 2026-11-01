import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const serviceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4175",
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE === undefined ? {} : {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
  },
  webServer: {
    command: "pnpm exec vite preview --host 127.0.0.1 --port 4175 --strictPort",
    cwd: serviceRoot,
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
  },
});
