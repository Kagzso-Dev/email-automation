import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
  resolve: {
    alias: {
      "@dispatch/shared": new URL("../../packages/shared/src/index.ts", import.meta.url).pathname,
    },
  },
});
