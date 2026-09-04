import { fileURLToPath } from "node:url";
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
      // fileURLToPath handles Windows drive letters and spaces in the path,
      // which `new URL(...).pathname` mangles (e.g. "/C:/My%20Apps/...").
      "@dispatch/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
});
