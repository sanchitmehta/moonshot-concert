import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const storefrontApi = process.env.STOREFRONT_API_URL ?? "http://127.0.0.1:5000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    // Allows previewing the dev server through Microsoft dev tunnels.
    allowedHosts: [".devtunnels.ms"],
    proxy: { "/api": { target: storefrontApi, changeOrigin: true } },
  },
});
