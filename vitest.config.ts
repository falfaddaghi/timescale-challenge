import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    coverage: {
      reporter: ["text", "json-summary"],
      exclude: ["src/server.ts", "src/db/migrate.ts"],
    },
  },
});
