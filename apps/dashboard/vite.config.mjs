import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxy = {
  "/api": {
    target: "http://127.0.0.1:8792",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api/, ""),
  },
};

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local", "asus-tuf-1.tail39e2e8.ts.net"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
    proxy: apiProxy,
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local", "asus-tuf-1.tail39e2e8.ts.net"],
    proxy: apiProxy,
  },
  plugins: [react()],
});
