import { alarmDateFor, publicAlarmFor } from "@/lib/alarm";
import { withUser } from "@/lib/auth";
import { handler, json } from "@/lib/http";

/** GET /api/v1/alarm/today: the shared moment, time and counts present only once fired. */
export const GET = handler(async (req: Request) =>
  json(await withUser(req, (c) => publicAlarmFor(c.tx, alarmDateFor(c.now, c.cfg)))),
);
