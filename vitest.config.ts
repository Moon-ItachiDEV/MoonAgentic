import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.test.ts", "apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    // Server tests start real agent processes and git, which take seconds on Windows runners.
    testTimeout: 15_000,
  },
});
