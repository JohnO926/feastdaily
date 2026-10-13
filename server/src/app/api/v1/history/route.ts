import type { NextRequest } from "next/server";
import { withUser } from "@/lib/auth";
import { addDays, daysBetween, dayKey } from "@/lib/day";
import { handler, HttpError, json, parse } from "@/lib/http";
import { historyQuerySchema } from "@/lib/validation";
import { getPendingDay } from "@/services/days";
import { getHistory, HISTORY_MAX_DAYS } from "@/services/history";

/** GET /api/v1/history?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive, at most 93 days). */
export const GET = handler(async (req: NextRequest) => {
  const q = parse(historyQuerySchema, Object.fromEntries(req.nextUrl.searchParams));
  return json(
    await withUser(req, async (c) => {
      const pending = await getPendingDay(c.tx, c.user.id);
      const today = pending?.dayKey ?? dayKey(c.settings?.tz ?? "America/Denver", c.settings?.rolloverHour ?? 3, c.now);
      const to = q.to ?? today;
      const from = q.from ?? addDays(to, -29);
      const span = daysBetween(from, to) + 1;
      if (span < 1) throw new HttpError(400, "invalid_range", "from must be on or before to");
      if (span > HISTORY_MAX_DAYS) throw new HttpError(400, "range_too_large", `At most ${HISTORY_MAX_DAYS} days per request`);
      return { from, to, days: await getHistory(c.tx, c.user.id, from, to) };
    }),
  );
});
