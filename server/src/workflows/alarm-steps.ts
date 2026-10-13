// Steps of the alarm workflow (B7). Arguments and results are plain JSON (ISO strings for
// instants). Each body imports its implementation lazily so the workflow bundle (which
// replaces step bodies) never pulls in pg or other Node-only modules.
import type { AlarmRowResult, FireResult, PushBatchResult } from "./alarm-core";

const nowFrom = (nowIso?: string | null) => (nowIso ? new Date(nowIso) : new Date());

export async function createAlarmRow(
  alarmDate: string,
  runId: string | null,
  nowIso?: string | null,
): Promise<AlarmRowResult> {
  "use step";
  const core = await import("./alarm-core");
  return core.createAlarmRowCore(alarmDate, nowFrom(nowIso), runId);
}

export async function fireAlarm(alarmDate: string, nowIso?: string | null): Promise<FireResult | null> {
  "use step";
  const core = await import("./alarm-core");
  return core.fireAlarmCore(alarmDate, nowFrom(nowIso));
}

export async function pushBatch(
  alarmDate: string,
  cursor: string | null,
  limit: number,
  nowIso?: string | null,
): Promise<PushBatchResult> {
  "use step";
  const core = await import("./alarm-core");
  return core.pushBatchCore(alarmDate, cursor, limit, nowFrom(nowIso));
}

export async function finalizePushCounts(alarmDate: string) {
  "use step";
  const core = await import("./alarm-core");
  return core.finalizePushCountsCore(alarmDate);
}
