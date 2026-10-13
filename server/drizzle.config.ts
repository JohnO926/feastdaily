import { defineConfig } from "drizzle-kit";

// Migrations always run against the direct (unpooled) connection.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL_UNPOOLED ??
      process.env.DATABASE_URL ??
      "postgres://feast:feast@localhost:5433/feast",
  },
  strict: true,
  verbose: true,
});
