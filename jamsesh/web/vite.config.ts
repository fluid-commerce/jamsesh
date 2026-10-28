import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 5180,
    proxy: {
      "/api": "http://127.0.0.1:4747",
      "/renders": "http://127.0.0.1:4747",
      "/canvas": "http://127.0.0.1:4747",
      "/ws": { target: "ws://127.0.0.1:4747", ws: true },
    },
  },
});
