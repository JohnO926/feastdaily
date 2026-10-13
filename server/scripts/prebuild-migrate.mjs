// Runs migrations during `next build` only on Vercel production deploys
// (VERCEL_ENV=production). Preview/local builds never touch the database.
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

if (process.env.VERCEL_ENV !== "production") {
  console.log("prebuild: skipping migrations (VERCEL_ENV is not production)");
  process.exit(0);
}
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error("prebuild: DATABASE_URL_UNPOOLED is required for production migrations");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle({ client: pool }), {
    migrationsFolder: path.join(process.cwd(), "src/db/migrations"),
  });
  console.log("prebuild: migrations applied");
} finally {
  await pool.end();
}
