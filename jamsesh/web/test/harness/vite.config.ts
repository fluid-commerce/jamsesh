import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const hub = process.env.HUB_PORT ?? "4850";
const proxy = { "/api": `http://127.0.0.1:${hub}`, "/ws": { target: `ws://127.0.0.1:${hub}`, ws: true } };
export default defineConfig({
  root: __dirname,
  publicDir: "../../public",
  plugins: [react()],
  build: { outDir: process.env.HARNESS_OUT ?? "/tmp/jam-harness-dist", emptyOutDir: true },
  server: { port: 5190, proxy },
  preview: { port: 5190, proxy },
});
