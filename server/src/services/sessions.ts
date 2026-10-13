// POST /sessions DB layer (B5): records the envelope's boot, runs the pure ingest pipeline per
// session, persists pieces, recomputes touched days and re-scores closed missed days that a
// late (but pre-alarm, within 48 h) session turns into feasts.
import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { deviceBoots, readingSessions } from "@/db/schema";
import { firedAlarmInstantsBetween } from "@/lib/alarm";
import { recordBoot, type UserCtx } from "@/lib/auth";
import {
  evaluateSession,
  planIngest,
  type ClientSession,
  type Envelope,
  type IngestContext,
} from "@/lib/sessions";
import { canRescore, decide } from "@/lib/scoring";
import { dayTotalsFor, fallbackDayKeyFn, recomputeDay, refold, rescoreDay, toWindowRef, windowsOverlapping } from "./days";

export interface SessionResult {
  id: string;
  status: "accepted" | "duplicate" | "rejected";
  reason: string | null;
  day_key: string | null;
  scored: boolean;
}

async function storedResult(tx: Tx, id: string, userId: string): Promise<SessionResult | null> {
  const rows = await tx
    .select({
      id: readingSessions.id,
      userId: readingSessions.userId,
      verified: readingSessions.verified,
      scorable: readingSessions.scorable,
      reason: readingSessions.rejectReason,
      dayKey: readingSessions.dayKey,
      dailyResultId: readingSessions.dailyResultId,
    })
    .from(readingSessions)
    .where(eq(readingSessions.id, id));
  const r = rows[0];
  if (!r) return null;
  if (r.userId !== userId) return { id, status: "duplicate", reason: "duplicate", day_key: null, scored: false };
  const family = await tx
    .select({ dailyResultId: readingSessions.dailyResultId, scorable: readingSessions.scorable })
    .from(readingSessions)
    .where(eq(readingSessions.parentId, id));
  const scored = r.verified && r.scorable && (r.dailyResultId !== null || family.some((f) => f.dailyResultId !== null));
  return { id, status: "duplicate", reason: r.reason, day_key: r.dayKey, scored };
}

export interface SubmitOutcome {
  results: SessionResult[];
  rescored: number;
}

export async function submitSessions(
  ctx: UserCtx,
  envelope: Envelope,
  sessions: ClientSession[],
): Promise<SubmitOutcome> {
  const { tx, user, cfg, now: receivedAt } = ctx;

  // The envelope's boot is always known after this (min-latency anchor).
  await recordBoot(tx, envelope.device_id, envelope.boot_id, envelope.client_now_mono_ms, receivedAt, !ctx.passive);
  const boots = await tx
    .select({ bootId: deviceBoots.bootId, offset: deviceBoots.anchorOffsetMs })
    .from(deviceBoots)
    .where(eq(deviceBoots.deviceId, envelope.device_id));
  const ictx: IngestContext = {
    receivedAt,
    envelope,
    bootAnchors: Object.fromEntries(boots.map((b) => [b.bootId, b.offset])),
    deviceLastSeenAt: ctx.prevDeviceLastSeenAt,
    bootLastContact: ctx.prevBootContacts,
    cfg,
  };
  const fallbackDayKey = fallbackDayKeyFn(ctx.settings);
  const touched = new Set<string>();
  const results: SessionResult[] = [];

  for (const s of sessions) {
    const dup = await storedResult(tx, s.id, user.id);
    if (dup) {
      results.push(dup);
      continue;
    }
    const pre = evaluateSession(s, ictx);
    let decision;
    if (!pre.ok) {
      decision = planIngest(s, ictx, {
        windows: [],
        firstDayStartsAt: user.firstDayStartsAt,
        firedAlarms: [],
        existingIntervals: [],
        dayTotals: {},
        selfReportDayKeys: new Set(),
        fallbackDayKey,
      });
    } else {
      const windows = (await windowsOverlapping(tx, user.id, pre.start, pre.end)).map(toWindowRef);
      const spanFrom = new Date(Math.min(pre.start.getTime(), ...windows.map((w) => w.window_start.getTime())));
      const spanTo = new Date(Math.max(pre.end.getTime(), ...windows.map((w) => w.window_end.getTime())));
      const firedAlarms = await firedAlarmInstantsBetween(tx, spanFrom, spanTo);
      const existing = await tx
        .select({ start: readingSessions.serverStartAt, end: readingSessions.serverEndAt })
        .from(readingSessions)
        .where(
          and(
            eq(readingSessions.userId, user.id),
            eq(readingSessions.verified, true),
            eq(readingSessions.scorable, true),
            ne(readingSessions.source, "self_report"),
            sql`tstzrange(${readingSessions.serverStartAt}, ${readingSessions.serverEndAt}) && tstzrange(${pre.start}, ${pre.end})`,
          ),
        );
      const selfKeys = await tx
        .select({ dayKey: readingSessions.dayKey })
        .from(readingSessions)
        .where(
          and(
            eq(readingSessions.userId, user.id),
            eq(readingSessions.source, "self_report"),
            eq(readingSessions.verified, true),
          ),
        );
      decision = planIngest(s, ictx, {
        windows,
        firstDayStartsAt: user.firstDayStartsAt,
        firedAlarms,
        existingIntervals: existing.map((e) => ({ start: e.start!, end: e.end! })),
        dayTotals: await dayTotalsFor(tx, windows.map((w) => w.id)),
        selfReportDayKeys: new Set(selfKeys.map((k) => k.dayKey!).filter(Boolean)),
        fallbackDayKey,
      });
    }

    if (decision.newBoot) {
      await tx
        .insert(deviceBoots)
        .values({
          deviceId: envelope.device_id,
          bootId: decision.newBoot.boot_id,
          anchorOffsetMs: decision.newBoot.anchor_offset_ms,
          firstSeenAt: receivedAt,
          lastSeenAt: receivedAt,
          lastSeenMonoMs: decision.newBoot.last_seen_mono_ms,
        })
        .onConflictDoNothing();
      ictx.bootAnchors[decision.newBoot.boot_id] ??= decision.newBoot.anchor_offset_ms;
    }

    const base = {
      userId: user.id,
      deviceId: envelope.device_id,
      bootId: s.boot_id,
      source: s.source,
      startedAtWall: Number.isFinite(s.started_at_wall.getTime()) ? s.started_at_wall : null,
      endedAtWall: Number.isFinite(s.ended_at_wall.getTime()) ? s.ended_at_wall : null,
      monoStartMs: Number.isFinite(s.mono_start_ms) ? s.mono_start_ms : null,
      monoEndMs: Number.isFinite(s.mono_end_ms) ? s.mono_end_ms : null,
      clientActiveSeconds: s.active_seconds,
      receivedAt,
      contentRef: s.content_ref,
    };

    if (decision.status === "rejected") {
      await tx.insert(readingSessions).values({
        ...base,
        id: s.id,
        activeSeconds: 0,
        serverStartAt: decision.start,
        serverEndAt: decision.end,
        verified: false,
        scorable: false,
        rejectReason: decision.reason,
      });
      results.push({ id: s.id, status: "rejected", reason: decision.reason, day_key: null, scored: false });
      continue;
    }

    const rows = decision.pieces.map((p, i) => ({
      ...base,
      id: i === 0 ? s.id : randomUUID(),
      parentId: i === 0 ? null : s.id,
      pieceIndex: i,
      activeSeconds: p.active,
      serverStartAt: p.start,
      serverEndAt: p.end,
      dayKey: p.day_key,
      dailyResultId: p.windowId,
      verified: true,
      scorable: decision.scorable,
      rejectReason: decision.reason,
      wallMonoMismatch: decision.wallMonoMismatch,
    }));
    await tx.insert(readingSessions).values(rows);
    for (const p of decision.pieces) if (p.windowId) touched.add(p.windowId);
    results.push({
      id: s.id,
      status: "accepted",
      reason: decision.reason,
      day_key: decision.pieces[0]?.day_key ?? null,
      scored: decision.scorable && decision.pieces.some((p) => p.windowId !== null),
    });
  }

  // Recompute every touched day; re-score closed missed days that are now feasts (48 h window).
  let rescored = 0;
  for (const id of touched) {
    const r = await recomputeDay(tx, id);
    if (!canRescore({ result: r.result, window_end: r.windowEnd }, receivedAt, cfg)) continue;
    const d = decide({
      window_end: r.windowEnd,
      goal_seconds: r.goalSeconds,
      verified_seconds: r.verifiedSeconds,
      verified_before_alarm_seconds: r.verifiedBeforeAlarmSeconds,
      self_reported_at: r.selfReportedAt,
      alarm_at: r.alarmAt,
    });
    if (d.result === "feast" && (await rescoreDay(tx, id, receivedAt))) rescored++;
  }
  return { results, rescored };
}

/**
 * Full POST /sessions handling inside withUser(ensure: "manual"): ingest first, then ensureDay
 * (closing the user's due days with the new sessions already counted), then one refold if a
 * closed day was re-scored and ensureDay did not already refold.
 */
export async function ingestAndSettle(ctx: UserCtx, envelope: Envelope, sessions: ClientSession[]) {
  const { results, rescored } = await submitSessions(ctx, envelope, sessions);
  const ensured = await ctx.ensureDay();
  if (rescored > 0 && !ensured.refolded) await refold(ctx.tx, ctx.user.id, ctx.cfg);
  return { results, rescored };
}
