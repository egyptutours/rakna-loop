import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // `server-only` throws outside the React Server bundle; stub it for unit tests.
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Tests must run with no external credentials (demo mode).
    env: { RAKNA_DATA_MODE: "demo", ANTHROPIC_API_KEY: "", RAKNA_DEMO_PERSIST: "off" },
  },
});
