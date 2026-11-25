import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    // Database tests each create their own temporary SQLite file.
    testTimeout: 20_000,
  },
});
