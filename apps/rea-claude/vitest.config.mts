import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(root, "src/shared"),
      "@renderer": resolve(root, "src/renderer/src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Renderer tests opt into jsdom with a `// @vitest-environment jsdom` docblock.
    environment: "node",
  },
});
