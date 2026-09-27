import { defineConfig } from "vite";

// Pad ships as a desktop app: no dev server in production, fixed asset layout.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    assetsInlineLimit: 8192,
  },
});
