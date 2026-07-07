import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The server serves the built client from dist/client (dist/server sits
    // beside it), so bin/sync-splat.js resolves ../client from ../server.
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    // Dev only: proxy the socket and API to the standalone server on :3011.
    // In production everything is same-origin, so there is no CORS config.
    proxy: {
      "/socket.io": {
        target: "http://localhost:3011",
        ws: true,
      },
      "/api": {
        target: "http://localhost:3011",
      },
    },
  },
});
