import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed dev port and doesn't want vite clearing the console.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // The only browser this ever runs in is the bundled webview (WebView2 /
    // WKWebView / WebKitGTK), all of which are evergreen — so skip the
    // downlevelling and ship less, faster-to-parse JavaScript.
    target: "esnext",
    // Sourcemaps are useless in a release bundle and cost build time; the dev
    // server serves its own regardless.
    sourcemap: false,
    rollupOptions: {
      output: {
        // React barely changes between releases, so keeping it in its own
        // chunk keeps the app chunk small and the two parse in parallel.
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client"],
        },
      },
    },
  },
});
