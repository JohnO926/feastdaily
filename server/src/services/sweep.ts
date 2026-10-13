// Hourly sweep (B6/B8): self-heals the alarm, closes due days for users who have not made a
// request, marks dormancy and purges abandoned device-only users.
import { and, asc, eq, isNull, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { dailyResults, jobRuns, users } from "@/db/schema";
import { alarmDateFor, alarmWindowFor } from "@/lib/alarm";
import { env } from "@/lib/env";
import { fireAndPushInline, hasStuckDeliveries, isOverdue } from "@/workflows/alarm-core";
import { ensureDay, getConfig, getSettings, lockUser } from "./days";
import { ensureAlarmStarted } from "./jobs";

const ALERT_AFTER_MS = 15 * 60_000; // 20:45 Denver = window end + 15 min

export interface AlarmSweepResult {
  alarm_date: string;
  started: boolean;
  fired_overdue: boolean;
  resent_stuck: boolean;
  alerted: boolean;
}

export async function sweepAlarm(now: Date): Promise<AlarmSweepResult> {
  const database = await db();
  const cfg = await getConfig(database);
  const alarmDate = alarmDateFor(now, cfg);
  const { end } = alarmWindowFor(alarmDate, cfg);
  const res: AlarmSweepResult = { alarm_date: alarmDate, started: false, fired_overdue: false, resent_stuck: false, alerted: false };

  // 1. Missed cron: start today's alarm workflow ourselves (at most an hour late).
  if (now.getTime() < end.getTime()) {
    const [job] = await database
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.name, "alarm"), eq(jobRuns.runDate, alarmDate)));
    if (!job || !job.workflowRunId) {
      res.started = (await ensureAlarmStarted(alarmDate, now)).started;
    }
  }

  // 2. Lost sleeping run: fire with the stored instant, so scoring uses the original moment.
  if (await isOverdue(alarmDate, now)) {
    res.fired_overdue = (await fireAndPushInline(alarmDate, now)) !== null;
  } else if (await hasStuckDeliveries(alarmDate, now)) {
    // 3. Deliveries left 'sending' by a crashed or retry-exhausted batch.
    await fireAndPushInline(alarmDate, now);
    res.resent_stuck = true;
  }

  // 4. Page a human if nothing fired by 20:45 Denver (once per day).
  if (now.getTime() > end.getTime() + ALERT_AFTER_MS) {
    const fired = await database.execute<{ n: string }>(
      sql`select count(*) as n from daily_alarms where alarm_date = ${alarmDate} and fired_at is not null`,
    );
    if (Number(fired.rows[0]?.n ?? 0) === 0) {
      const first = await database
        .insert(jobRuns)
        .values({ name: "alarm_alert", runDate: alarmDate, startedAt: now })
        .onConflictDoNothing()
        .returning({ name: jobRuns.name });
      if (first.length > 0) {
        const url = env.alertWebhookUrl();
        const text = `Feast Daily: no alarm fired for ${alarmDate} by 20:45 ${cfg.alarm_tz}. POST /api/admin/alarm/fire-now to fire it.`;
        console.error(`[sweep] ${text}`);
        if (url) {
          try {
            await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
          } catch (err) {
            console.error("[sweep] alert webhook failed", (err as Error).message);
          }
        }
        res.alerted = true;
      }
    }
  }
  return res;
}

export interface UserSweepResult {
  due: number;
  processed: number;
  closed: number;
  skipped_locked: number;
  more: boolean;
}

/**
 * Closes due days for up to `limit` users, each in its own short transaction with
 * `FOR UPDATE SKIP LOCKED`, so one failing user rolls back only itself.
 */
export async function sweepDueUsers(now: Date, limit = 500): Promise<UserSweepResult> {
  const database = await db();
  const cfg = await getConfig(database);
  const due = await database
    .selectDistinct({ userId: dailyResults.userId })
    .from(dailyResults)
    .innerJoin(users, eq(users.id, dailyResults.userId))
    .where(and(eq(dailyResults.result, "pending"), lte(dailyResults.windowEnd, now), isNull(users.dormantSince)))
    .orderBy(asc(dailyResults.userId))
    .limit(limit);
  const res: UserSweepResult = { due: due.length, processed: 0, closed: 0, skipped_locked: 0, more: false };
  for (const { userId } of due) {
    try {
      await database.transaction(async (tx) => {
        const user = await lockUser(tx, userId, { skipLocked: true });
        if (!user) {
          res.skipped_locked++;
          return;
        }
        const settings = await getSettings(tx, userId);
        const r = await ensureDay(tx, user, settings, now, cfg);
        res.closed += r.closed;
        res.processed++;
      });
    } catch (err) {
      console.error(`[sweep] ensureDay failed for user ${userId}:`, (err as Error).message);
    }
  }
  // More due users remain only if the batch was full and made progress.
  res.more = due.length === limit && res.processed > 0;
  return res;
}

export interface MaintenanceResult {
  marked_dormant: number;
  purged: number;
}

/** Marks dormant_since for users unseen for dormant_after_days; purges device-only users unseen for purge_after_days. */
export async function sweepMaintenance(now: Date): Promise<MaintenanceResult> {
  const database = await db();
  const cfg = await getConfig(database);
  const dormantBefore = new Date(now.getTime() - cfg.dormant_after_days * 86_400_000);
  const purgeBefore = new Date(now.getTime() - cfg.purge_after_days * 86_400_000);
  const marked = await database
    .update(users)
    .set({ dormantSince: now })
    .where(and(isNull(users.dormantSince), lt(users.lastSeenAt, dormantBefore)))
    .returning({ id: users.id });
  const purged = await database
    .delete(users)
    .where(and(isNull(users.appleSub), lt(users.lastSeenAt, purgeBefore)))
    .returning({ id: users.id });
  return { marked_dormant: marked.length, purged: purged.length };
}
