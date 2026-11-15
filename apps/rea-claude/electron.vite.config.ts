import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

const shared = { "@shared": resolve(__dirname, "src/shared") };

/**
 * The renderer's CSP (src/renderer/index.html) is strict: `script-src 'self'`.
 * The dev server injects an inline React-refresh preamble and talks HMR over a
 * websocket, so in `electron-vite dev` only, allow inline scripts and ws:.
 * Production builds keep the strict policy untouched.
 */
function devCsp(): Plugin {
  return {
    name: "rea-claude:dev-csp",
    apply: "serve",
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("font-src 'self' data:", "font-src 'self' data:; connect-src 'self' ws: http://localhost:*");
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts") } },
    },
  },
  preload: {
    resolve: { alias: shared },
    build: {
      // Preloads run sandboxed: each entry must be one self-contained CJS file
      // (no shared chunks, no node_modules requires). `electron` stays external.
      isolatedEntries: true,
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          lab: resolve(__dirname, "src/preload/lab.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: { alias: { ...shared, "@renderer": resolve(__dirname, "src/renderer/src") } },
    build: { rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html") } } },
    plugins: [react(), devCsp()],
  },
});
