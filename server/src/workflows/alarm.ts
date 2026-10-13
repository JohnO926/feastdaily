// alarmWorkflow (B7): pick the secret instant, sleep until it, fire (stamp alarm_at on every
// open day containing it), then fan out the shared-moment push in batches.
// Arguments and step results are ISO strings, never Date, so replay is revival-independent.
import { getWorkflowMetadata, sleep } from "workflow";
import { createAlarmRow, finalizePushCounts, fireAlarm, pushBatch } from "./alarm-steps";

export interface AlarmWorkflowResult {
  alarm_date: string;
  fired: boolean;
  fired_at: string | null;
  reader_count: number;
  beat_count: number;
  pushes: { sent: number; failed: number; dry_run: number; safe: number; alarm: number; moment: number } | null;
}

export async function alarmWorkflow(alarmDate: string): Promise<AlarmWorkflowResult> {
  "use workflow";

  const row = await createAlarmRow(alarmDate, getWorkflowMetadata().workflowRunId);
  if (!row.fire_at) {
    // The cron ran after 20:30 Denver: no alarm today; every day decides at its window_end.
    return { alarm_date: alarmDate, fired: false, fired_at: null, reader_count: 0, beat_count: 0, pushes: null };
  }
  if (!row.fired_at) {
    await sleep(new Date(row.fire_at));
  }

  // On replay with fired_at already set this skips stamping and still runs the fan-out.
  const fired = await fireAlarm(alarmDate);
  if (!fired) {
    return { alarm_date: alarmDate, fired: false, fired_at: null, reader_count: 0, beat_count: 0, pushes: null };
  }

  let cursor: string | null = null;
  try {
    do {
      const batch = await pushBatch(alarmDate, cursor, 500);
      cursor = batch.next_cursor;
    } while (cursor);
  } catch {
    // Retries exhausted (e.g. an APNs outage). Rows stay 'sending'; the hourly sweep resends them.
  }
  const pushes = await finalizePushCounts(alarmDate);
  return {
    alarm_date: alarmDate,
    fired: true,
    fired_at: fired.fired_at,
    reader_count: fired.reader_count,
    beat_count: fired.beat_count,
    pushes,
  };
}
