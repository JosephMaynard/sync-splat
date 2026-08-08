import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "qr/**/*.test.ts",
      "server/**/*.test.ts",
      "bin/**/*.test.ts",
      "src/**/*.test.ts",
    ],
    // Playwright specs live under e2e/ and run via `pnpm test:e2e`, not vitest.
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
