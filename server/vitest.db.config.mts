import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// DB tests against the Docker Postgres test database (TEST_DATABASE_URL).
// globalSetup migrates; each test truncates. Files run serially (one shared database).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/db/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/db/global-setup.ts"],
    setupFiles: ["tests/db/env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
