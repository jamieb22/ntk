import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "eval/**/*.eval.ts", "eval/**/*.test.ts"],
    pool: "forks",
    setupFiles: ["./test/env-pins.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
