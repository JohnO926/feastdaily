import { fileURLToPath } from "node:url";
import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";

// Workflow integration tests: @workflow/vitest compiles the "use workflow"/"use step"
// directives and runs workflows in-process on a Local World. Steps hit the Docker test DB.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://feast:feast@localhost:5433/feast_test";

export default defineConfig({
  plugins: [workflow()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/integration/**/*.integration.test.ts"],
    environment: "node",
    globalSetup: ["tests/db/global-setup.ts"],
    setupFiles: ["tests/db/env.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: TEST_DB,
      TEST_DATABASE_URL: TEST_DB,
      APNS_DRY_RUN: "true",
    },
  },
});
