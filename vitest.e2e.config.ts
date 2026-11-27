import { defineConfig } from "vitest/config";

// Browser checks against the built app and a real server with the demo agents.
// Run `pnpm build` first; `pnpm e2e` runs them.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    setupFiles: ["e2e/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // A CI runner starts an agent more slowly than a laptop: a second is not always enough.
    expect: { poll: { timeout: 10_000 } },
  },
});
