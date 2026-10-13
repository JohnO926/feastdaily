// Session ingestion rules (B5): plausibility checks, monotonic anchoring, server-side
// splitting, day assignment and per-day totals. Pure: the DB layer supplies the state
// (boot anchors, last contact, overlapping sessions, windows, day totals) and persists results.
import type { ScoringConfig } from "./config";

export type SessionSource = "reader" | "self_report" | "audio";

export const REJECT_REASONS = [
  "malformed",
  "mono_future",
  "future",
  "span_too_long",
  "active_exceeds_span",
  "overlap",
  "daily_cap",
  "self_report_after_alarm",
  "duplicate_self_report",
  "device_mismatch",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
/** Informational reasons: the session is stored verified=true, scorable=false (history only). */
export type InfoReason = "backdated" | "stale";

export interface ClientSession {
  id: string;
  source: SessionSource;
  boot_id: string;
  started_at_wall: Date;
  ended_at_wall: Date;
  mono_start_ms: number;
  mono_end_ms: number;
  active_seconds: number;
  content_ref: string | null;
}

export interface Envelope {
  device_id: string;
  boot_id: string;
  client_now_wall: Date;
  client_now_mono_ms: number;
}

export interface IngestContext {
  receivedAt: Date;
  envelope: Envelope;
  /** anchor_offset_ms per known boot of this device (the envelope's boot is always present). */
  bootAnchors: Record<string, number>;
  /** device_credentials.last_seen_at as it was before this request. */
  deviceLastSeenAt: Date | null;
  /**
   * Boots of this device known BEFORE this request, with their last contact (last non-passive
   * request carrying that boot; null if the boot was only seen through an uploaded session).
   */
  bootLastContact: Record<string, Date | null>;
  cfg: ScoringConfig;
}

export interface NewBoot {
  boot_id: string;
  anchor_offset_ms: number;
  last_seen_mono_ms: number;
}

export interface Candidate {
  start: Date;
  end: Date;
  active: number;
  scorable: boolean;
  reason: InfoReason | null;
  wallMonoMismatch: boolean;
  anchoredBy: "mono" | "wall";
  newBoot: NewBoot | null;
}

export type Evaluation =
  | { ok: false; reason: RejectReason; start: Date | null; end: Date | null; newBoot: NewBoot | null }
  | ({ ok: true } & Candidate);

const FUTURE_SLACK_MS = 60_000;

function isFiniteDate(d: Date): boolean {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/** Anchors a session's instants in server time (checks 2a/2b). */
export function anchorSession(
  s: ClientSession,
  ctx: IngestContext,
):
  | { ok: true; start: Date; end: Date; anchoredBy: "mono" | "wall"; newBoot: NewBoot | null }
  | { ok: false; reason: RejectReason; start: Date | null; end: Date | null } {
  const received = ctx.receivedAt.getTime();
  const sameBoot = s.boot_id === ctx.envelope.boot_id;
  const offset = ctx.bootAnchors[s.boot_id];

  if (sameBoot) {
    if (offset === undefined) throw new Error("envelope boot must be recorded before anchoring");
    const start = new Date(s.mono_start_ms + offset);
    const end = new Date(s.mono_end_ms + offset);
    // 2a: a session of the current boot cannot end after the client's own "now".
    if (s.mono_end_ms > ctx.envelope.client_now_mono_ms) return { ok: false, reason: "mono_future", start, end };
    return { ok: true, start, end, anchoredBy: "mono", newBoot: null };
  }

  if (offset !== undefined) {
    const start = new Date(s.mono_start_ms + offset);
    const end = new Date(s.mono_end_ms + offset);
    if (end.getTime() > received + FUTURE_SLACK_MS) return { ok: false, reason: "future", start, end };
    return { ok: true, start, end, anchoredBy: "mono", newBoot: null };
  }

  // 2b: unknown boot (first contact from it): anchor by the envelope's wall offset. Assumes the
  // wall clock was as wrong at session time as it is now (the assumption mono anchoring makes).
  const delta = received - ctx.envelope.client_now_wall.getTime();
  const start = new Date(s.started_at_wall.getTime() + delta);
  const end = new Date(s.ended_at_wall.getTime() + delta);
  if (end.getTime() > received + FUTURE_SLACK_MS) return { ok: false, reason: "future", start, end };
  return {
    ok: true,
    start,
    end,
    anchoredBy: "wall",
    newBoot: { boot_id: s.boot_id, anchor_offset_ms: end.getTime() - s.mono_end_ms, last_seen_mono_ms: s.mono_end_ms },
  };
}

/**
 * No-backdating reference (check 2c), hybrid rule:
 *  - known boot with a recorded contact: that boot's last contact only, so requests from other
 *    boots (a reboot, another iPhone sharing the device id) never backdate its sessions;
 *  - unknown boot (or a known boot that never made a request): the device-level last contact,
 *    so a fabricated fresh boot id cannot bypass the rule.
 */
export function backdateReference(bootId: string, ctx: Pick<IngestContext, "bootLastContact" | "deviceLastSeenAt">): Date | null {
  if (Object.prototype.hasOwnProperty.call(ctx.bootLastContact, bootId)) {
    const c = ctx.bootLastContact[bootId];
    if (c) return c;
  }
  return ctx.deviceLastSeenAt;
}

/** Checks 1 to 6 (first rejecting failure wins; 2c and 6 are informational). */
export function evaluateSession(s: ClientSession, ctx: IngestContext): Evaluation {
  const { cfg } = ctx;
  const isSelf = s.source === "self_report";

  // 1: well-formed
  const datesOk = isFiniteDate(s.started_at_wall) && isFiniteDate(s.ended_at_wall);
  const numsOk =
    Number.isFinite(s.mono_start_ms) && Number.isFinite(s.mono_end_ms) && Number.isInteger(s.active_seconds);
  const shapeOk = isSelf
    ? s.active_seconds === 0 && s.mono_end_ms >= s.mono_start_ms && datesOk && s.ended_at_wall >= s.started_at_wall
    : s.active_seconds > 0 &&
      s.mono_end_ms > s.mono_start_ms &&
      datesOk &&
      s.ended_at_wall.getTime() > s.started_at_wall.getTime();
  if (!numsOk || !datesOk || !shapeOk || !["reader", "self_report", "audio"].includes(s.source)) {
    return { ok: false, reason: "malformed", start: null, end: null, newBoot: null };
  }

  // 2a / 2b: anchoring
  const anchored = anchorSession(s, ctx);
  if (!anchored.ok) return { ...anchored, newBoot: null };
  let { start } = anchored;
  const { end, anchoredBy, newBoot } = anchored;
  if (isSelf) start = end; // a self-report is the single tap instant

  let reason: InfoReason | null = null;
  // 2c: no backdating past the last contact (hybrid rule)
  const contact = backdateReference(s.boot_id, ctx);
  if (contact && end.getTime() < contact.getTime() - cfg.backdate_grace_seconds * 1000) {
    reason = "backdated";
  }

  // 3: advisory wall vs mono span mismatch (same boot only)
  let wallMonoMismatch = false;
  if (s.boot_id === ctx.envelope.boot_id && !isSelf) {
    const wallSpan = (s.ended_at_wall.getTime() - s.started_at_wall.getTime()) / 1000;
    const monoSpan = (s.mono_end_ms - s.mono_start_ms) / 1000;
    wallMonoMismatch = Math.abs(wallSpan - monoSpan) > cfg.wall_mono_mismatch_seconds;
  }

  if (!isSelf) {
    const spanSec = (end.getTime() - start.getTime()) / 1000;
    // 4
    if (spanSec > cfg.max_session_span_seconds) return { ok: false, reason: "span_too_long", start, end, newBoot };
    // 5: the "45 minutes in 5 minutes" rule
    if (s.active_seconds > spanSec + cfg.active_tolerance_seconds || s.active_seconds > cfg.max_session_active_seconds) {
      return { ok: false, reason: "active_exceeds_span", start, end, newBoot };
    }
  }

  // 6: stale for scoring (history only)
  if (start.getTime() < ctx.receivedAt.getTime() - cfg.offline_sync_window_hours * 3_600_000 && reason === null) {
    reason = "stale";
  }

  return {
    ok: true,
    start,
    end,
    active: s.active_seconds,
    scorable: reason === null,
    reason,
    wallMonoMismatch,
    anchoredBy,
    newBoot,
  };
}

export interface Interval {
  start: Date;
  end: Date;
}

/**
 * Check 7: overlap with this user's scorable sessions. An overlap up to the tolerance is
 * trimmed off the new session; a larger one rejects it.
 */
export function resolveOverlap(
  c: { start: Date; end: Date; active: number },
  existing: Interval[],
  toleranceSeconds: number,
): { ok: true; start: Date; end: Date; active: number } | { ok: false } {
  const tolMs = toleranceSeconds * 1000;
  let s = c.start.getTime();
  let e = c.end.getTime();
  for (const x of existing) {
    const overlap = Math.min(e, x.end.getTime()) - Math.max(s, x.start.getTime());
    if (overlap <= 0) continue;
    if (overlap > tolMs) return { ok: false };
  }
  for (const x of existing) {
    const xs = x.start.getTime();
    const xe = x.end.getTime();
    if (Math.min(e, xe) - Math.max(s, xs) <= 0) continue;
    if (xs <= s) s = Math.max(s, xe);
    else if (xe >= e) e = Math.min(e, xs);
    // A tiny existing interval strictly inside the new one is left alone (<= tolerance).
  }
  const oldSpan = c.end.getTime() - c.start.getTime();
  const newSpan = e - s;
  if (newSpan <= 0) return { ok: false };
  const active = newSpan === oldSpan ? c.active : Math.floor((c.active * newSpan) / oldSpan);
  if (active <= 0) return { ok: false };
  return { ok: true, start: new Date(s), end: new Date(e), active };
}

/** Splits `total` integer seconds proportionally to weights (largest remainder, exact sum). */
export function allocateProportional(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map((_, i) => (i === weights.length - 1 ? total : 0));
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i] += 1;
    rest -= 1;
  }
  return floors;
}

export interface Piece {
  start: Date;
  end: Date;
  active: number;
}

/**
 * Server-side split at every boundary strictly inside the session (window starts/ends,
 * first_day_starts_at, fired alarm instants), active seconds apportioned by duration.
 */
export function splitAtBoundaries(p: Piece, boundaries: Date[]): Piece[] {
  const s = p.start.getTime();
  const e = p.end.getTime();
  const cuts = [...new Set(boundaries.map((b) => b.getTime()))].filter((t) => t > s && t < e).sort((a, b) => a - b);
  if (cuts.length === 0) return [p];
  const edges = [s, ...cuts, e];
  const spans = edges.slice(1).map((t, i) => t - edges[i]);
  const actives = allocateProportional(p.active, spans);
  return spans.map((_, i) => ({ start: new Date(edges[i]), end: new Date(edges[i + 1]), active: actives[i] }));
}

export interface WindowRef {
  id: string;
  window_start: Date;
  window_end: Date;
  day_key: string;
  alarm_at: Date | null;
  result: "pending" | "feast" | "missed";
}

/** The window containing a piece (by containment) or, for a zero-length piece, its instant. */
export function windowFor(p: Interval, windows: WindowRef[]): WindowRef | null {
  const s = p.start.getTime();
  const e = p.end.getTime();
  for (const w of windows) {
    const ws = w.window_start.getTime();
    const we = w.window_end.getTime();
    if (s === e ? s >= ws && s < we : s >= ws && e <= we) return w;
  }
  return null;
}

export function splitBoundaries(windows: WindowRef[], firstDayStartsAt: Date | null, firedAlarms: Date[]): Date[] {
  const b: Date[] = [];
  for (const w of windows) b.push(w.window_start, w.window_end);
  if (firstDayStartsAt) b.push(firstDayStartsAt);
  b.push(...firedAlarms);
  return b;
}

/** Check 8: no day may be credited more than max_daily_active_seconds. */
export function exceedsDailyCap(
  pieces: { windowId: string | null; active: number }[],
  dayTotals: Record<string, number>,
  cfg: Pick<ScoringConfig, "max_daily_active_seconds">,
): boolean {
  const add: Record<string, number> = {};
  for (const p of pieces) {
    if (!p.windowId) continue;
    add[p.windowId] = (add[p.windowId] ?? 0) + p.active;
  }
  return Object.entries(add).some(([id, a]) => (dayTotals[id] ?? 0) + a > cfg.max_daily_active_seconds);
}

export interface ScoredPiece {
  start: Date;
  end: Date;
  active: number;
  source: SessionSource;
  scorable: boolean;
}

export interface DayTotals {
  verified_seconds: number;
  verified_before_alarm_seconds: number;
  goal_reached_at: Date | null;
  self_reported_at: Date | null;
}

/** Fraction of a piece that lies at or before the alarm instant. */
export function beforeAlarmFraction(p: Interval, alarmAt: Date): number {
  const s = p.start.getTime();
  const e = p.end.getTime();
  const a = alarmAt.getTime();
  if (e <= a) return 1;
  if (s >= a) return 0;
  return (a - s) / (e - s);
}

/**
 * recomputeDay totals: verified seconds from scorable non-self-report pieces, the part
 * anchored at or before the alarm (clipped, so a piece that straddles the alarm only counts
 * its earlier part), goal_reached_at interpolated inside the piece that crosses the goal, and
 * self_reported_at = earliest scorable self-report tap.
 */
export function recomputeTotals(pieces: ScoredPiece[], goalSeconds: number, alarmAt: Date | null): DayTotals {
  const reading = pieces
    .filter((p) => p.scorable && p.source !== "self_report" && p.active > 0)
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  let verified = 0;
  let before = 0;
  let goalReachedAt: Date | null = null;
  for (const p of reading) {
    if (goalReachedAt === null && verified + p.active >= goalSeconds) {
      const need = goalSeconds - verified;
      const frac = p.active > 0 ? need / p.active : 1;
      const t = p.start.getTime() + (p.end.getTime() - p.start.getTime()) * frac;
      goalReachedAt = new Date(Math.round(t));
    }
    verified += p.active;
    if (alarmAt) before += p.active * beforeAlarmFraction(p, alarmAt);
  }
  const selfTaps = pieces
    .filter((p) => p.scorable && p.source === "self_report")
    .map((p) => p.start.getTime())
    .sort((a, b) => a - b);
  return {
    verified_seconds: verified,
    verified_before_alarm_seconds: alarmAt ? Math.floor(before + 1e-9) : verified,
    goal_reached_at: goalReachedAt,
    self_reported_at: selfTaps.length ? new Date(selfTaps[0]) : null,
  };
}

export interface IngestState {
  /** The user's day windows that may contain the session (any result). */
  windows: WindowRef[];
  firstDayStartsAt: Date | null;
  /** Fired alarm instants near the session (split boundaries; unfired alarms are never passed). */
  firedAlarms: Date[];
  /** This user's scorable reading intervals overlapping the session. */
  existingIntervals: Interval[];
  /** Current scorable active seconds per daily_result id. */
  dayTotals: Record<string, number>;
  /** Day keys that already have a verified self-report. */
  selfReportDayKeys: Set<string>;
  /** Day key for pieces outside every window (history only), from the user's current settings. */
  fallbackDayKey: (t: Date) => string;
}

export interface PlannedPiece {
  start: Date;
  end: Date;
  active: number;
  windowId: string | null;
  day_key: string;
}

export type IngestDecision =
  | {
      status: "rejected";
      reason: RejectReason;
      start: Date | null;
      end: Date | null;
      newBoot: NewBoot | null;
    }
  | {
      status: "accepted";
      reason: InfoReason | null;
      scorable: boolean;
      wallMonoMismatch: boolean;
      pieces: PlannedPiece[];
      newBoot: NewBoot | null;
    };

/** Full B5 pipeline for one session (after the duplicate-id check, which the DB layer does). */
export function planIngest(s: ClientSession, ctx: IngestContext, state: IngestState): IngestDecision {
  const ev = evaluateSession(s, ctx);
  if (!ev.ok) return { status: "rejected", reason: ev.reason, start: ev.start, end: ev.end, newBoot: ev.newBoot };

  if (s.source === "self_report") {
    const tap = ev.end;
    const w = windowFor({ start: tap, end: tap }, state.windows);
    const dayKeyForTap = w ? w.day_key : state.fallbackDayKey(tap);
    if (w) {
      const alarms = [...state.firedAlarms, ...(w.alarm_at ? [w.alarm_at] : [])].filter(
        (a) => a.getTime() >= w.window_start.getTime() && a.getTime() < w.window_end.getTime(),
      );
      const alarmAt = alarms.length ? new Date(Math.min(...alarms.map((a) => a.getTime()))) : null;
      // Fixed rule: a self-report counts only if tapped before the alarm.
      if (alarmAt && alarmAt.getTime() < tap.getTime()) {
        return { status: "rejected", reason: "self_report_after_alarm", start: tap, end: tap, newBoot: ev.newBoot };
      }
    }
    if (state.selfReportDayKeys.has(dayKeyForTap)) {
      return { status: "rejected", reason: "duplicate_self_report", start: tap, end: tap, newBoot: ev.newBoot };
    }
    return {
      status: "accepted",
      reason: ev.reason,
      scorable: ev.scorable,
      wallMonoMismatch: false,
      pieces: [{ start: tap, end: tap, active: 0, windowId: w?.id ?? null, day_key: dayKeyForTap }],
      newBoot: ev.newBoot,
    };
  }

  // 7: overlap (trim within tolerance, else reject)
  const ov = resolveOverlap(ev, state.existingIntervals, ctx.cfg.overlap_tolerance_seconds);
  if (!ov.ok) return { status: "rejected", reason: "overlap", start: ev.start, end: ev.end, newBoot: ev.newBoot };

  // Server-side split at window / first-day / fired-alarm boundaries, then assign by containment.
  const boundaries = splitBoundaries(state.windows, state.firstDayStartsAt, state.firedAlarms);
  const pieces = splitAtBoundaries(ov, boundaries).map((p) => {
    const w = windowFor(p, state.windows);
    return { ...p, windowId: w?.id ?? null, day_key: w ? w.day_key : state.fallbackDayKey(p.start) };
  });

  // 8: daily cap (only matters for pieces that will be credited)
  if (ev.scorable && exceedsDailyCap(pieces, state.dayTotals, ctx.cfg)) {
    return { status: "rejected", reason: "daily_cap", start: ov.start, end: ov.end, newBoot: ev.newBoot };
  }

  return {
    status: "accepted",
    reason: ev.reason,
    scorable: ev.scorable,
    wallMonoMismatch: ev.wallMonoMismatch,
    pieces,
    newBoot: ev.newBoot,
  };
}
