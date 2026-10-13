import { env } from "./env";
import { HttpError, requireSecret } from "./http";

/** Admin routes: Authorization: Bearer $ADMIN_SECRET. */
export function requireAdmin(req: Request): void {
  requireSecret(req, env.adminSecret(), "unauthorized");
}

/** Vercel Cron: Authorization: Bearer $CRON_SECRET. */
export function requireCron(req: Request): void {
  requireSecret(req, env.cronSecret(), "unauthorized");
}

export function refuseInProduction(): void {
  if (env.isProduction()) throw new HttpError(403, "forbidden_in_production", "Not available when VERCEL_ENV=production");
}
