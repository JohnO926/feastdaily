import { requireCron } from "@/lib/admin";
import { handler, json } from "@/lib/http";
import { ensureRolloverStarted } from "@/services/jobs";

/** Vercel Cron, daily 00:00 UTC. Starts the 24-tick hourly sweep workflow once per UTC date. */
export const GET = handler(async (req: Request) => {
  requireCron(req);
  const now = new Date();
  return json(await ensureRolloverStarted(now.toISOString().slice(0, 10), now));
});
