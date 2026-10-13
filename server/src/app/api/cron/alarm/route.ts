import { requireCron } from "@/lib/admin";
import { alarmDateFor } from "@/lib/alarm";
import { handler, json } from "@/lib/http";
import { db } from "@/db/client";
import { getConfig } from "@/services/days";
import { ensureAlarmStarted } from "@/services/jobs";

/**
 * Vercel Cron, daily 15:00 UTC. Starts today's alarmWorkflow (idempotent via job_runs). If it
 * runs late but before 20:30 Denver, the workflow's pick window shrinks to [now, 20:30].
 */
export const GET = handler(async (req: Request) => {
  requireCron(req);
  const now = new Date();
  const cfg = await getConfig(await db());
  return json(await ensureAlarmStarted(alarmDateFor(now, cfg), now));
});
