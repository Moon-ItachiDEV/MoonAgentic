import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = process.env.MOONAGENTIC_PORT ?? "4747";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      "/api": `http://127.0.0.1:${serverPort}`,
    },
  },
});
