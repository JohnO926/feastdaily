import { requireAdmin } from "@/lib/admin";
import { alarmDateFor } from "@/lib/alarm";
import { handler, HttpError, json, parse, readJson } from "@/lib/http";
import { adminAlarmDateSchema } from "@/lib/validation";
import { db } from "@/db/client";
import { getConfig } from "@/services/days";
import { fireAndPushInline } from "@/workflows/alarm-core";

/**
 * POST /api/admin/alarm/fire-now {alarm_date?}: fires today's EXISTING row via the fire step
 * (scoring keeps the stored fire_at) and runs the push fan-out. Never inserts a row.
 */
export const POST = handler(async (req: Request) => {
  requireAdmin(req);
  const body = parse(adminAlarmDateSchema, await readJson(req));
  const now = new Date();
  const alarmDate = body.alarm_date ?? alarmDateFor(now, await getConfig(await db()));
  const r = await fireAndPushInline(alarmDate, now);
  if (!r) throw new HttpError(404, "no_alarm_row", `No daily_alarms row for ${alarmDate}`);
  return json({ alarm_date: alarmDate, fired_at: r.fired.fired_at, stamped: r.fired.stamped, reader_count: r.fired.reader_count, beat_count: r.fired.beat_count, pushes: r.counts });
});
