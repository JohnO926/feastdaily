// Loads .env.local (if present) and points DATABASE_URL at the test database.
import { existsSync } from "node:fs";
import path from "node:path";

export function loadTestEnv(): string {
  const file = path.join(process.cwd(), ".env.local");
  if (existsSync(file) && !process.env.__FEAST_ENV_LOADED) {
    process.loadEnvFile(file);
    process.env.__FEAST_ENV_LOADED = "1";
  }
  const url = process.env.TEST_DATABASE_URL ?? "postgres://feast:feast@localhost:5433/feast_test";
  process.env.TEST_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
  process.env.DATABASE_URL_UNPOOLED = url;
  process.env.JWT_SECRET ??= "test-jwt-secret-0123456789abcdef0123456789";
  process.env.JWT_SECRET = process.env.JWT_SECRET.length >= 32 ? process.env.JWT_SECRET : "test-jwt-secret-0123456789abcdef0123456789";
  process.env.ADMIN_SECRET = "test-admin";
  process.env.CRON_SECRET = "test-cron";
  process.env.APNS_DRY_RUN = "true";
  process.env.DEV_REVEAL_ALARM = "true";
  process.env.REGISTER_RATE_LIMIT_PER_HOUR = "1000";
  return url;
}
