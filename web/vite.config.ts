import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    // The only chunk above 500 kB is the barcode generator (bwip-js), loaded on
    // demand when a barcode is printed. Every page chunk stays well below.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    // Same-origin API in development: cookies and CSRF work without CORS.
    proxy: { "/api": { target: "http://127.0.0.1:3000", changeOrigin: false } },
  },
});
