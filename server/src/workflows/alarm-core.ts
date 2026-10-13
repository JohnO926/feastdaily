// Alarm workflow implementation (B7): plain functions behind the steps in alarm-steps.ts.
// The hourly sweep and the admin routes call these directly. Every result is plain JSON
// (ISO strings for instants), so replay never depends on Date revival.
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db, type Tx } from "@/db/client";
import { dailyAlarms, deviceTokens, pushDeliveries } from "@/db/schema";
import { alarmWindowFor, beatPct, pickFireAt } from "@/lib/alarm";
import { formatLocalTime, mapLimit, sendPush, type PushVariant } from "@/lib/apns";
import type { ScoringConfig } from "@/lib/config";
import { getConfig } from "@/services/days";

export interface AlarmRowResult {
  alarm_date: string;
  fire_at: string | null;
  fired_at: string | null;
}

/** Inserts today's row with a secret uniform fire_at (ON CONFLICT DO NOTHING) and reads it back. */
export async function createAlarmRowCore(alarmDate: string, now: Date, runId: string | null = null): Promise<AlarmRowResult> {
  const database = await db();
  const cfg = await getConfig(database);
  const { start, end } = alarmWindowFor(alarmDate, cfg);
  const pick = pickFireAt(alarmDate, now, cfg);
  if (pick) {
    await database
      .insert(dailyAlarms)
      .values({ alarmDate, windowStart: start, windowEnd: end, fireAt: pick, workflowRunId: runId })
      .onConflictDoNothing();
  }
  if (runId) {
    await database
      .update(dailyAlarms)
      .set({ workflowRunId: runId })
      .where(and(eq(dailyAlarms.alarmDate, alarmDate), isNull(dailyAlarms.workflowRunId)));
  }
  const [row] = await database
    .select({ fireAt: dailyAlarms.fireAt, firedAt: dailyAlarms.firedAt })
    .from(dailyAlarms)
    .where(eq(dailyAlarms.alarmDate, alarmDate));
  return {
    alarm_date: alarmDate,
    fire_at: row ? row.fireAt.toISOString() : null,
    fired_at: row?.firedAt ? row.firedAt.toISOString() : null,
  };
}

export interface FireResult {
  alarm_date: string;
  fire_at: string;
  fired_at: string;
  /** false when fired_at was already set (replay or a second caller): stamping is skipped. */
  stamped: boolean;
  reader_count: number;
  beat_count: number;
}

const STAMP_BATCH = 1000;

/**
 * Stamps alarm_at = fire_at on every pending day whose window contains it, in user-id order
 * and batches of 1000. Rows are locked first (one statement), then the clipped
 * verified_before_alarm_seconds is recomputed from reading_sessions in a new statement, so
 * sessions ingested while the workflow slept are counted.
 */
async function stampDays(tx: Tx, fireAt: Date): Promise<void> {
  for (;;) {
    const locked = await tx.execute<{ id: string }>(sql`
      select id from daily_results
      where result = 'pending' and alarm_at is null and window_start <= ${fireAt} and window_end > ${fireAt}
      order by user_id
      limit ${STAMP_BATCH}
      for update`);
    if (locked.rows.length === 0) return;
    const ids = sql.join(
      locked.rows.map((r) => sql`${r.id}::uuid`),
      sql`, `,
    );
    await tx.execute(sql`
      with sums as (
        select dr.id,
          coalesce(floor(sum(rs.active_seconds * case
            when rs.server_end_at <= ${fireAt} then 1.0
            when rs.server_start_at >= ${fireAt} then 0.0
            else extract(epoch from (${fireAt}::timestamptz - rs.server_start_at))
                 / nullif(extract(epoch from (rs.server_end_at - rs.server_start_at)), 0)
          end) + 0.000000001), 0)::int as before
        from daily_results dr
        left join reading_sessions rs
          on rs.daily_result_id = dr.id and rs.verified and rs.scorable and rs.source <> 'self_report'
        where dr.id in (${ids})
        group by dr.id
      )
      update daily_results dr set
        alarm_at = ${fireAt},
        verified_before_alarm_seconds = s.before,
        safe_at_fire = (dr.self_reported_at is not null and dr.self_reported_at <= ${fireAt})
                       or s.before >= dr.goal_seconds
      from sums s
      where s.id = dr.id`);
  }
}

/** fire (B7): one transaction; stamps fired_at once. A replay with fired_at set skips stamping. */
export async function fireAlarmCore(alarmDate: string, now: Date): Promise<FireResult | null> {
  const database = await db();
  const cfg = await getConfig(database);
  return database.transaction(async (tx) => {
    const fired = await tx
      .update(dailyAlarms)
      .set({ firedAt: now })
      .where(and(eq(dailyAlarms.alarmDate, alarmDate), isNull(dailyAlarms.firedAt)))
      .returning({ fireAt: dailyAlarms.fireAt, firedAt: dailyAlarms.firedAt });
    if (fired.length === 0) {
      const [row] = await tx.select().from(dailyAlarms).where(eq(dailyAlarms.alarmDate, alarmDate));
      if (!row || !row.firedAt) return null;
      return {
        alarm_date: alarmDate,
        fire_at: row.fireAt.toISOString(),
        fired_at: row.firedAt.toISOString(),
        stamped: false,
        reader_count: row.readerCount ?? 0,
        beat_count: row.beatCount ?? 0,
      };
    }
    const fireAt = fired[0].fireAt;
    await stampDays(tx, fireAt);
    const counts = await tx.execute<{ readers: string; beat: string }>(sql`
      select
        count(*) filter (where u.last_seen_at > ${fireAt}::timestamptz - make_interval(days => ${cfg.active_reader_window_days})) as readers,
        count(*) filter (where u.last_seen_at > ${fireAt}::timestamptz - make_interval(days => ${cfg.active_reader_window_days}) and dr.safe_at_fire) as beat
      from daily_results dr join users u on u.id = dr.user_id
      where dr.alarm_at = ${fireAt} and dr.safe_at_fire is not null`);
    const readers = Number(counts.rows[0]?.readers ?? 0);
    const beat = Number(counts.rows[0]?.beat ?? 0);
    await tx
      .update(dailyAlarms)
      .set({ readerCount: readers, beatCount: beat })
      .where(eq(dailyAlarms.alarmDate, alarmDate));
    return {
      alarm_date: alarmDate,
      fire_at: fireAt.toISOString(),
      fired_at: now.toISOString(),
      stamped: true,
      reader_count: readers,
      beat_count: beat,
    };
  });
}

export interface PushBatchResult {
  candidates: number;
  claimed: number;
  sent: number;
  failed: number;
  dry_run: number;
  by_variant: Record<PushVariant, number>;
  next_cursor: string | null;
}

const STUCK_SENDING_MS = 60_000;

function pickVariant(r: {
  has_day: boolean;
  safe_at_fire: boolean | null;
  before: number | null;
  goal: number | null;
  self_reported_at: Date | null;
  fire_at: Date;
}): PushVariant {
  if (!r.has_day) return "moment";
  const safe =
    r.safe_at_fire ??
    ((r.before ?? 0) >= (r.goal ?? Infinity) ||
      (r.self_reported_at !== null && r.self_reported_at.getTime() <= r.fire_at.getTime()));
  return safe ? "safe" : "alarm";
}

/**
 * One push fan-out batch (B7/B10): users seen within active_reader_window_days with an
 * active device token, not yet delivered (or stuck in 'sending' for over a minute). Rows are
 * claimed as 'sending' BEFORE any APNs call, so a retry resends only rows still sending.
 */
export async function pushBatchCore(
  alarmDate: string,
  cursor: string | null,
  limit: number,
  now: Date,
): Promise<PushBatchResult> {
  const database = await db();
  const cfg: ScoringConfig = await getConfig(database);
  const [alarm] = await database.select().from(dailyAlarms).where(eq(dailyAlarms.alarmDate, alarmDate));
  const empty: PushBatchResult = {
    candidates: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    dry_run: 0,
    by_variant: { alarm: 0, safe: 0, moment: 0 },
    next_cursor: null,
  };
  if (!alarm?.firedAt) return empty;
  const fireAt = alarm.fireAt;
  const firedAt = alarm.firedAt;
  const staleBefore = new Date(now.getTime() - STUCK_SENDING_MS);

  const cand = await database.execute<{
    user_id: string;
    tz: string | null;
    has_day: boolean;
    safe_at_fire: boolean | null;
    before: number | null;
    goal: number | null;
    self_reported_at: Date | string | null;
  }>(sql`
    select u.id as user_id, us.tz, (dr.id is not null) as has_day, dr.safe_at_fire,
           dr.verified_before_alarm_seconds as before, dr.goal_seconds as goal, dr.self_reported_at
    from users u
    left join user_settings us on us.user_id = u.id
    left join daily_results dr on dr.user_id = u.id and dr.alarm_at = ${fireAt}
    where u.last_seen_at > ${firedAt}::timestamptz - make_interval(days => ${cfg.active_reader_window_days})
      and exists (select 1 from device_tokens dt where dt.user_id = u.id and dt.invalidated_at is null)
      and (${cursor}::uuid is null or u.id > ${cursor}::uuid)
      and not exists (
        select 1 from push_deliveries pd
        where pd.alarm_date = ${alarmDate} and pd.user_id = u.id
          and not (pd.status = 'sending' and pd.created_at < ${staleBefore})
      )
    order by u.id
    limit ${limit}`);
  const rows = cand.rows;
  if (rows.length === 0) return empty;

  const variants = new Map<string, { variant: PushVariant; tz: string }>();
  for (const r of rows) {
    variants.set(r.user_id, {
      variant: pickVariant({
        has_day: r.has_day,
        safe_at_fire: r.safe_at_fire,
        before: r.before,
        goal: r.goal,
        self_reported_at: r.self_reported_at ? new Date(r.self_reported_at) : null,
        fire_at: fireAt,
      }),
      tz: r.tz ?? cfg.alarm_tz,
    });
  }

  const claimed = await database
    .insert(pushDeliveries)
    .values(
      rows.map((r) => ({
        alarmDate,
        userId: r.user_id,
        variant: variants.get(r.user_id)!.variant,
        status: "sending" as const,
        createdAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [pushDeliveries.alarmDate, pushDeliveries.userId],
      set: { createdAt: now, variant: sql`excluded.variant` },
      setWhere: and(eq(pushDeliveries.status, "sending"), lt(pushDeliveries.createdAt, staleBefore)),
    })
    .returning({ userId: pushDeliveries.userId });
  const claimedIds = claimed.map((c) => c.userId);

  const result: PushBatchResult = {
    ...empty,
    by_variant: { alarm: 0, safe: 0, moment: 0 },
    candidates: rows.length,
    claimed: claimedIds.length,
    next_cursor: rows.length === limit ? rows[rows.length - 1].user_id : null,
  };
  if (claimedIds.length === 0) return result;

  const tokens = await database
    .select()
    .from(deviceTokens)
    .where(
      and(
        sql`${deviceTokens.userId} in (${sql.join(claimedIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
        isNull(deviceTokens.invalidatedAt),
      ),
    );
  const byUser = new Map<string, typeof tokens>();
  for (const t of tokens) byUser.set(t.userId, [...(byUser.get(t.userId) ?? []), t]);
  const pct = beatPct(alarm.beatCount ?? 0, alarm.readerCount ?? 0);

  let retryNeeded = false;
  await mapLimit(claimedIds, 50, async (userId) => {
    const v = variants.get(userId)!;
    const outcomes = await Promise.all(
      (byUser.get(userId) ?? []).map(async (t) => {
        const o = await sendPush(
          {
            token: t.token,
            environment: t.environment,
            userId,
            variant: v.variant,
            alarmDate,
            firedAt,
            firedAtLocal: formatLocalTime(firedAt, v.tz),
            beatPct: pct,
          },
          cfg.push_enabled,
        );
        if (o.status === "failed" && o.invalidToken) {
          await database.update(deviceTokens).set({ invalidatedAt: now }).where(eq(deviceTokens.id, t.id));
        }
        return o;
      }),
    );
    let status: "sent" | "failed" | "dry_run" = "failed";
    if (outcomes.some((o) => o.status === "sent")) status = "sent";
    else if (outcomes.length > 0 && outcomes.every((o) => o.status === "dry_run")) status = "dry_run";
    const retryable = status === "failed" && outcomes.some((o) => o.status === "failed" && o.retryable);
    if (retryable) {
      retryNeeded = true;
      // Leave it 'sending' with an old created_at so the step retry (or the sweep) re-claims it.
      await database
        .update(pushDeliveries)
        .set({ createdAt: new Date(0), apnsStatus: outcomes.map((o) => o.apnsStatus).join(",") })
        .where(and(eq(pushDeliveries.alarmDate, alarmDate), eq(pushDeliveries.userId, userId)));
      return;
    }
    await database
      .update(pushDeliveries)
      .set({ status, sentAt: now, apnsStatus: outcomes.map((o) => o.apnsStatus).join(",") || "no_token" })
      .where(and(eq(pushDeliveries.alarmDate, alarmDate), eq(pushDeliveries.userId, userId)));
    result[status] += 1;
    result.by_variant[v.variant] += 1;
  });
  if (retryNeeded) throw new Error("APNs returned retryable errors; retrying the batch");
  return result;
}

/** Recomputes daily_alarms push counters from push_deliveries (idempotent) and logs a summary. */
export async function finalizePushCountsCore(alarmDate: string): Promise<{ sent: number; failed: number; dry_run: number; safe: number; alarm: number; moment: number }> {
  const database = await db();
  const agg = await database.execute<{ sent: string; failed: string; dry_run: string; safe: string; alarm: string; moment: string }>(sql`
    select count(*) filter (where status = 'sent') as sent,
           count(*) filter (where status = 'failed') as failed,
           count(*) filter (where status = 'dry_run') as dry_run,
           count(*) filter (where variant = 'safe' and status in ('sent', 'dry_run')) as safe,
           count(*) filter (where variant = 'alarm' and status in ('sent', 'dry_run')) as alarm,
           count(*) filter (where variant = 'moment' and status in ('sent', 'dry_run')) as moment
    from push_deliveries where alarm_date = ${alarmDate}`);
  const a = agg.rows[0];
  const out = {
    sent: Number(a?.sent ?? 0),
    failed: Number(a?.failed ?? 0),
    dry_run: Number(a?.dry_run ?? 0),
    safe: Number(a?.safe ?? 0),
    alarm: Number(a?.alarm ?? 0),
    moment: Number(a?.moment ?? 0),
  };
  await database
    .update(dailyAlarms)
    .set({ pushSent: out.sent, pushFailed: out.failed, pushDryRun: out.dry_run })
    .where(eq(dailyAlarms.alarmDate, alarmDate));
  console.log(
    `[alarm ${alarmDate}] ${out.safe} safe / ${out.alarm} alarm / ${out.moment} moment` +
      (out.dry_run > 0 ? ` (dry run: ${out.dry_run})` : "") +
      (out.failed > 0 ? `, ${out.failed} failed` : ""),
  );
  return out;
}

/** Fire + full push fan-out inline (sweep self-heal, admin fire-now). */
export async function fireAndPushInline(alarmDate: string, now: Date) {
  const fired = await fireAlarmCore(alarmDate, now);
  if (!fired) return null;
  let cursor: string | null = null;
  for (let i = 0; i < 10_000; i++) {
    const r = await pushBatchCore(alarmDate, cursor, 500, now);
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  const counts = await finalizePushCountsCore(alarmDate);
  return { fired, counts };
}

/** Sweep self-heal: today's row whose fire_at passed with no fired_at (a lost sleeping run). */
export async function isOverdue(alarmDate: string, now: Date): Promise<boolean> {
  const database = await db();
  const rows = await database
    .select({ alarmDate: dailyAlarms.alarmDate })
    .from(dailyAlarms)
    .where(and(eq(dailyAlarms.alarmDate, alarmDate), isNull(dailyAlarms.firedAt), lt(dailyAlarms.fireAt, now)));
  return rows.length > 0;
}

/** Deliveries left in 'sending' for over a minute (crashed or retry-exhausted batches). */
export async function hasStuckDeliveries(alarmDate: string, now: Date): Promise<boolean> {
  const database = await db();
  const rows = await database
    .select({ u: pushDeliveries.userId })
    .from(pushDeliveries)
    .where(
      and(
        eq(pushDeliveries.alarmDate, alarmDate),
        eq(pushDeliveries.status, "sending"),
        lt(pushDeliveries.createdAt, new Date(now.getTime() - STUCK_SENDING_MS)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Admin/dev only: replace an unfired row's instant (POST /admin/alarm/seed). */
export async function seedAlarmRow(alarmDate: string, fireAt: Date): Promise<void> {
  const database = await db();
  const cfg = await getConfig(database);
  const { start, end } = alarmWindowFor(alarmDate, cfg);
  await database
    .insert(dailyAlarms)
    .values({ alarmDate, windowStart: start, windowEnd: end, fireAt })
    .onConflictDoUpdate({ target: dailyAlarms.alarmDate, set: { fireAt }, setWhere: isNull(dailyAlarms.firedAt) });
}
