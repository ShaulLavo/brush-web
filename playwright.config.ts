import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4198",
    viewport: { width: 1200, height: 800 },
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--disable-vulkan-surface"],
    },
  },
  webServer: {
    command: "npm run serve",
    env: { PORT: "4198" },
    url: "http://127.0.0.1:4198",
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
