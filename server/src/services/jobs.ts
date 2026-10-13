// Daily job kickoffs (B7/B8). The cron routes and the hourly sweep share these, guarded by
// job_runs so a second caller never starts a duplicate run (and re-starts if a previous
// caller inserted the row but crashed before recording the run id).
import { and, eq } from "drizzle-orm";
import { start } from "workflow/api";
import { db } from "@/db/client";
import { jobRuns } from "@/db/schema";
import { alarmWorkflow } from "@/workflows/alarm";
import { rolloverWorkflow } from "@/workflows/rollover";

export interface JobStart {
  name: string;
  run_date: string;
  started: boolean;
  workflow_run_id: string | null;
}

/**
 * ensureAlarmStarted: insert job_runs('alarm', date) (on conflict read it); if no run id is
 * recorded yet, start alarmWorkflow and record it. Insert and start are not atomic, so a
 * later caller re-starts while the id is still null (alarm steps are idempotent).
 */
export async function ensureAlarmStarted(alarmDate: string, now: Date): Promise<JobStart> {
  const database = await db();
  return database.transaction(async (tx) => {
    await tx.insert(jobRuns).values({ name: "alarm", runDate: alarmDate, startedAt: now }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.name, "alarm"), eq(jobRuns.runDate, alarmDate)))
      .for("update");
    if (row.workflowRunId) {
      return { name: "alarm", run_date: alarmDate, started: false, workflow_run_id: row.workflowRunId };
    }
    const run = await start(alarmWorkflow, [alarmDate]);
    await tx
      .update(jobRuns)
      .set({ workflowRunId: run.runId, startedAt: now })
      .where(and(eq(jobRuns.name, "alarm"), eq(jobRuns.runDate, alarmDate)));
    return { name: "alarm", run_date: alarmDate, started: true, workflow_run_id: run.runId };
  });
}

/** /api/cron/rollover: starts rolloverWorkflow only if this caller inserted job_runs('rollover', date). */
export async function ensureRolloverStarted(runDate: string, now: Date): Promise<JobStart> {
  const database = await db();
  const inserted = await database
    .insert(jobRuns)
    .values({ name: "rollover", runDate, startedAt: now })
    .onConflictDoNothing()
    .returning({ name: jobRuns.name });
  if (inserted.length === 0) {
    const [row] = await database
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.name, "rollover"), eq(jobRuns.runDate, runDate)));
    return { name: "rollover", run_date: runDate, started: false, workflow_run_id: row?.workflowRunId ?? null };
  }
  const run = await start(rolloverWorkflow, [runDate]);
  await database
    .update(jobRuns)
    .set({ workflowRunId: run.runId })
    .where(and(eq(jobRuns.name, "rollover"), eq(jobRuns.runDate, runDate)));
  return { name: "rollover", run_date: runDate, started: true, workflow_run_id: run.runId };
}

/** Admin/dev: start an alarm run regardless of job_runs (after POST /admin/alarm/seed). */
export async function startAlarmRun(alarmDate: string, now: Date): Promise<string> {
  const run = await start(alarmWorkflow, [alarmDate]);
  const database = await db();
  await database
    .insert(jobRuns)
    .values({ name: "alarm", runDate: alarmDate, startedAt: now, workflowRunId: run.runId })
    .onConflictDoUpdate({ target: [jobRuns.name, jobRuns.runDate], set: { workflowRunId: run.runId, startedAt: now } });
  return run.runId;
}
