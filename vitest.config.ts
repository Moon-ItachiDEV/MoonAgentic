import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.test.ts", "apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    // Server tests start real agent processes and git, which take seconds on Windows runners.
    // Those runners also have slow spells of a minute or two, in which a test of 3 to 5 s took
    // more than 15 (CI, 2026-11-27: four runs of seven, main among them). Several files had
    // been given 40 s one by one, git.test.ts after such a red run: on Windows every test now
    // has them.
    testTimeout: process.platform === "win32" ? 40_000 : 15_000,
  },
});
