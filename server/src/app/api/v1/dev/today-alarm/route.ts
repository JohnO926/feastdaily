import { alarmDateFor, revealAlarm } from "@/lib/alarm";
import { withUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { handler, HttpError, iso, json } from "@/lib/http";

/**
 * GET /api/v1/dev/today-alarm: DEV ONLY. Reveals today's unfired fire_at so the simulator's
 * local notification fires at the instant the server scores against. 404 unless
 * DEV_REVEAL_ALARM=true (never set in production).
 */
export const GET = handler(async (req: Request) => {
  if (!env.devRevealAlarm() || env.isProduction()) throw new HttpError(404, "not_found", "Not found");
  return json(
    await withUser(req, async (c) => {
      const alarmDate = alarmDateFor(c.now, c.cfg);
      const row = await revealAlarm(c.tx, alarmDate);
      return {
        alarm_date: alarmDate,
        fire_at: iso(row?.fireAt),
        fired_at: iso(row?.firedAt),
        window_start: iso(row?.windowStart),
        window_end: iso(row?.windowEnd),
      };
    }),
  );
});
