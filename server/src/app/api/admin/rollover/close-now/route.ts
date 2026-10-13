import { requireAdmin } from "@/lib/admin";
import { handler, json } from "@/lib/http";
import { sweepAlarm, sweepDueUsers, sweepMaintenance } from "@/services/sweep";

/** POST /api/admin/rollover/close-now: runs one sweep tick immediately. */
export const POST = handler(async (req: Request) => {
  requireAdmin(req);
  const now = new Date();
  const alarm = await sweepAlarm(now);
  let closed = 0;
  let processed = 0;
  for (let i = 0; i < 200; i++) {
    const r = await sweepDueUsers(now, 500);
    closed += r.closed;
    processed += r.processed;
    if (!r.more) break;
  }
  const maintenance = await sweepMaintenance(now);
  return json({ alarm, users: { processed, closed }, maintenance });
});
