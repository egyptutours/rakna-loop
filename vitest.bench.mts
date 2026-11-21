import { defineConfig } from "vitest/config";
import path from "path";

/** Benchmarks (npm run bench). Separate from the unit suite: slow and machine-dependent. */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["bench/**/*.bench.test.ts"],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    env: { RAKNA_DATA_MODE: "demo", ANTHROPIC_API_KEY: "", RAKNA_DEMO_PERSIST: "off" },
  },
});
