import { defineConfig } from "vitest/config";

// Published-product test surface: identical to the research repo's config
// (env-pins setup, forks pool, timeouts) with two deltas — no eval/ trees
// here, and the adversarial-generator suite lives with bench/ (research).
// NTK_SKIP_BENCH guards the one bench-coupled test in content-gate.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/adv-gen.test.ts", "**/node_modules/**", "**/dist/**"],
    setupFiles: ["./test/env-pins.ts"],
    env: { NTK_SKIP_BENCH: "1" },
    pool: "forks",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
