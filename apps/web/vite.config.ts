import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = process.env.MOONAGENTIC_PORT ?? "4747";

export default defineConfig({
  plugins: [react()],
  server: {
    // Like the server, the dev page stays on this machine unless asked otherwise.
    host: process.env.MOONAGENTIC_DEV_HOST ?? "127.0.0.1",
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      "/api": `http://127.0.0.1:${serverPort}`,
    },
  },
});
