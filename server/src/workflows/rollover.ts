// rolloverWorkflow (B8): started once a day by /api/cron/rollover; sweeps every hour for 24 h.
// Lazy ensureDay on every request means active users never wait on this; it closes days for
// users who don't open the app and self-heals the alarm.
import { sleep } from "workflow";
import { sweepAlarmStep, sweepMaintenanceStep, sweepUsersStep } from "./rollover-steps";

export const ROLLOVER_TICKS = 24;
const USERS_PER_STEP = 500;
const MAX_USER_STEPS_PER_TICK = 200;

export async function rolloverWorkflow(runDate: string): Promise<{ run_date: string; ticks: number; closed: number }> {
  "use workflow";
  let closed = 0;
  for (let tick = 0; tick < ROLLOVER_TICKS; tick++) {
    await sweepAlarmStep();
    for (let i = 0; i < MAX_USER_STEPS_PER_TICK; i++) {
      const r = await sweepUsersStep(USERS_PER_STEP);
      closed += r.closed;
      if (!r.more) break;
    }
    await sweepMaintenanceStep();
    if (tick < ROLLOVER_TICKS - 1) await sleep("1h");
  }
  return { run_date: runDate, ticks: ROLLOVER_TICKS, closed };
}
