import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Geliştirmede /api istekleri sunucudaki yönetim API'sine iletilir.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8090" } },
  build: { outDir: "dist", sourcemap: false },
});
