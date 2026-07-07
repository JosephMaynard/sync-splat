import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["qr/**/*.test.ts", "server/**/*.test.ts"],
  },
});
