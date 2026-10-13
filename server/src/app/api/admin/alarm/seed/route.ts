import { z } from "zod";
import { refuseInProduction, requireAdmin } from "@/lib/admin";
import { alarmDateFor } from "@/lib/alarm";
import { handler, HttpError, json, parse, readJson } from "@/lib/http";
import { db } from "@/db/client";
import { getConfig } from "@/services/days";
import { startAlarmRun } from "@/services/jobs";
import { seedAlarmRow } from "@/workflows/alarm-core";

const seedSchema = z.object({
  fire_at: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  alarm_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start_workflow: z.boolean().default(true),
});

/**
 * POST /api/admin/alarm/seed {fire_at, alarm_date?, start_workflow?}: LOCAL DEVELOPMENT ONLY
 * (refused when VERCEL_ENV=production). Overrides today's unfired instant (e.g. 2 minutes out)
 * and starts an alarmWorkflow run that sleeps until it.
 */
export const POST = handler(async (req: Request) => {
  refuseInProduction();
  requireAdmin(req);
  const body = parse(seedSchema, await readJson(req));
  const now = new Date();
  const alarmDate = body.alarm_date ?? alarmDateFor(now, await getConfig(await db()));
  if (body.fire_at.getTime() < now.getTime() - 60_000) {
    throw new HttpError(400, "fire_at_in_past", "fire_at must not be in the past");
  }
  await seedAlarmRow(alarmDate, body.fire_at);
  const runId = body.start_workflow ? await startAlarmRun(alarmDate, now) : null;
  return json({ alarm_date: alarmDate, fire_at: body.fire_at.toISOString(), workflow_run_id: runId });
});
