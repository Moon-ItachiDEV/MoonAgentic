import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const serverPort = process.env.MOONAGENTIC_PORT ?? "4747";

/**
 * Marks each build in the app's page, so the server can tell an open tab that a newer one
 * is served (see src/update.ts). The dev server gets no mark: it reloads by itself.
 */
const buildId = (): Plugin => {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: "moonagentic-build-id",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { name: "moonagentic-build", content: id }, injectTo: "head" },
    ],
  };
};

export default defineConfig({
  plugins: [react(), buildId()],
  build: {
    rolldownOptions: {
      output: {
        // Third-party code goes in its own chunks, so the app chunk stays small and
        // a change to the app does not invalidate the cached libraries.
        codeSplitting: {
          groups: [
            { name: "react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "vendor", test: /[\\/]node_modules[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    // Like the server, the dev page stays on this machine unless asked otherwise.
    host: process.env.MOONAGENTIC_DEV_HOST ?? "127.0.0.1",
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      "/api": `http://127.0.0.1:${serverPort}`,
    },
  },
});
