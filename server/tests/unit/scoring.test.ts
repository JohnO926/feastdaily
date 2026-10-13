import { describe, expect, it } from "vitest";
import { applicableAlarmAt } from "@/lib/alarm";
import { testConfig } from "@/lib/config";
import { planCatchUp } from "@/lib/day";
import { recomputeTotals } from "@/lib/sessions";
import {
  activeMeals,
  canRescore,
  decide,
  fold,
  isFamine,
  isMealActive,
  statusOf,
  type ClosedDay,
} from "@/lib/scoring";

const cfg = testConfig();
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

const BASE = new Date("2026-10-01T09:00:00Z"); // 03:00 MDT
/** Closed day i (0-based) with a deadline at 20:00Z that day. */
function day(i: number, result: "feast" | "missed"): ClosedDay {
  const key = new Date(BASE.getTime() + i * D).toISOString().slice(0, 10);
  return { id: `d${i}`, day_key: key, result, deadline_at: new Date(BASE.getTime() + i * D + 11 * H) };
}
const seq = (pattern: string) => [...pattern].map((c, i) => day(i, c === "F" ? "feast" : "missed"));

function row(over: Partial<Parameters<typeof decide>[0]> = {}) {
  return {
    window_start: BASE,
    window_end: new Date(BASE.getTime() + D),
    goal_seconds: 600,
    verified_seconds: 0,
    verified_before_alarm_seconds: 0,
    self_reported_at: null as Date | null,
    alarm_at: null as Date | null,
    ...over,
  };
}

describe("fold: stats", () => {
  it("feast and miss update streaks and totals", () => {
    const { stats, meals } = fold(seq("FFMFFF"), cfg);
    expect(stats).toMatchObject({
      current_streak: 3,
      longest_streak: 3,
      total_feasts: 5,
      total_missed: 1,
      restore_progress: 3,
      last_closed_day_key: "2026-10-06",
    });
    expect(meals).toHaveLength(1);
    expect(meals[0]).toMatchObject({ daily_result_id: "d2", restored_at: null });
  });

  it("missed meal expires at +30 d (active at +30 d - 1 s, not at +30 d)", () => {
    const { meals } = fold(seq("M"), cfg);
    const m = meals[0];
    const plus30 = new Date(m.occurred_at.getTime() + 30 * D);
    expect(isMealActive(m, new Date(plus30.getTime() - S), cfg)).toBe(true);
    expect(isMealActive(m, plus30, cfg)).toBe(false);
    expect(activeMeals(meals, new Date(plus30.getTime() - S), cfg)).toHaveLength(1);
    expect(activeMeals(meals, plus30, cfg)).toHaveLength(0);
  });

  it("3 misses put the user in famine", () => {
    const { stats, meals } = fold(seq("MMM"), cfg);
    expect(stats.famine_since).toEqual(day(2, "missed").deadline_at);
    const now = new Date(day(2, "missed").deadline_at.getTime() + H);
    expect(isFamine(activeMeals(meals, now, cfg).length, cfg)).toBe(true);
  });

  it("4 feasts restore the oldest missed meal and exit famine at 2", () => {
    const { stats, meals } = fold(seq("MMMFFFF"), cfg);
    const restored = meals.filter((m) => m.restored_at);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ daily_result_id: "d0", restored_by_daily_result_id: "d6" });
    expect(restored[0].restored_at).toEqual(day(6, "feast").deadline_at);
    expect(stats.restore_progress).toBe(0);
    expect(stats.famine_since).toBeNull();
    const now = new Date(day(6, "feast").deadline_at.getTime() + H);
    expect(activeMeals(meals, now, cfg)).toHaveLength(2);
    expect(isFamine(2, cfg)).toBe(false);
  });

  it("a miss mid-way resets restore progress", () => {
    const { stats, meals } = fold(seq("MFFFMFFF"), cfg);
    expect(meals.filter((m) => m.restored_at)).toHaveLength(0);
    expect(stats.restore_progress).toBe(3);
    const { meals: m2 } = fold(seq("MFFFMFFFF"), cfg);
    expect(m2.filter((m) => m.restored_at).map((m) => m.daily_result_id)).toEqual(["d0"]);
  });

  it("a threshold config change applies at the next close (refold) and at read time", () => {
    const days = seq("MM");
    expect(fold(days, cfg).stats.famine_since).toBeNull();
    const lowered = testConfig({ famine_threshold: 2 });
    expect(fold(days, lowered).stats.famine_since).toEqual(day(1, "missed").deadline_at);
    expect(isFamine(2, lowered)).toBe(true);
  });

  it("is idempotent: folding twice gives identical output", () => {
    const days = seq("FMFFMMFFFFMF");
    expect(fold(days, cfg)).toEqual(fold(days, cfg));
    expect(fold([...days].reverse(), cfg)).toEqual(fold(days, cfg)); // ordered by day_key, not input order
  });
});

describe("decide", () => {
  it("never finished: missed at window_end", () => {
    const r = row({ verified_seconds: 300 });
    expect(decide(r)).toEqual({ result: "missed", deadline: r.window_end });
  });

  it("no alarm in the window: feast if the goal was reached by window_end", () => {
    expect(decide(row({ verified_seconds: 600 })).result).toBe("feast");
  });

  it("with an alarm only time before it counts", () => {
    const alarm = new Date(BASE.getTime() + 8 * H);
    expect(decide(row({ alarm_at: alarm, verified_seconds: 900, verified_before_alarm_seconds: 500 })).result).toBe("missed");
    expect(decide(row({ alarm_at: alarm, verified_seconds: 900, verified_before_alarm_seconds: 600 })).result).toBe("feast");
  });

  it("two alarms in one window: the first decides", () => {
    const w = { window_start: BASE, window_end: new Date(BASE.getTime() + 36 * H) };
    const first = new Date(BASE.getTime() + 8 * H);
    const second = new Date(BASE.getTime() + 32 * H);
    const unfired = new Date(BASE.getTime() + 2 * H);
    expect(
      applicableAlarmAt(w, [
        { fire_at: second, fired_at: second },
        { fire_at: first, fired_at: first },
        { fire_at: unfired, fired_at: null },
      ]),
    ).toEqual(first);
  });

  it("self-report tapped at 09:59 (synced at 23:00) beats a 10:05 alarm", () => {
    const tap = new Date("2026-10-01T15:59:00Z");
    const alarm = new Date("2026-10-01T16:05:00Z");
    expect(decide(row({ self_reported_at: tap, alarm_at: alarm })).result).toBe("feast");
  });

  it("self-report tapped after the alarm is a miss", () => {
    const tap = new Date("2026-10-01T16:10:00Z");
    const alarm = new Date("2026-10-01T16:05:00Z");
    expect(decide(row({ self_reported_at: tap, alarm_at: alarm })).result).toBe("missed");
  });

  it("statusOf: not_started / racing / safe / missed", () => {
    const before = new Date(BASE.getTime() - H);
    const mid = new Date(BASE.getTime() + 5 * H);
    expect(statusOf(row(), before, BASE)).toBe("not_started");
    expect(statusOf(row(), mid, BASE)).toBe("racing");
    expect(statusOf(row({ verified_seconds: 600 }), mid, BASE)).toBe("safe");
    expect(statusOf(row({ self_reported_at: mid }), mid, BASE)).toBe("safe");
    const alarm = new Date(BASE.getTime() + 4 * H);
    expect(statusOf(row({ alarm_at: alarm, verified_seconds: 600, verified_before_alarm_seconds: 100 }), mid, BASE)).toBe("missed");
  });
});

describe("catch-up and re-scoring", () => {
  it("a 10-day gap closes 10 missed days, then dormancy skips the gap", () => {
    const tz = "America/Denver";
    const pendingEnd = new Date("2026-10-02T09:00:00Z"); // day 2026-10-01 ends 03:00 MDT Oct 2
    const now = new Date(pendingEnd.getTime() + 9 * D + 2 * H);
    const plan = planCatchUp({
      pending: { window_end: pendingEnd, day_key: "2026-10-01" },
      now,
      tz,
      rolloverHour: 3,
      dormantSince: null,
      cfg,
    });
    expect(plan.mode).toBe("catchup");
    if (plan.mode !== "catchup") return;
    // closes: the pending day + every opened window but the last
    const closes = 1 + plan.windows.length - 1;
    expect(closes).toBe(10);
    expect(plan.windows.map((w) => w.day_key).slice(0, 3)).toEqual(["2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(plan.windows.at(-1)!.day_key).toBe("2026-10-11");

    const days: ClosedDay[] = Array.from({ length: 10 }, (_, i) => day(i, "missed"));
    const { stats } = fold(days, cfg);
    expect(stats).toMatchObject({ current_streak: 0, total_missed: 10 });

    const dormant = planCatchUp({
      pending: { window_end: pendingEnd, day_key: "2026-10-01" },
      now,
      tz,
      rolloverHour: 3,
      dormantSince: new Date(pendingEnd.getTime() + 5 * D),
      cfg,
    });
    expect(dormant.mode).toBe("dormant");
  });

  it("an offline session read before the alarm and synced after rollover (within 48 h) re-scores the day and repairs later streaks", () => {
    // Day 0 closed missed (alarm at 16:00Z, no synced reading); days 1 and 2 feasts.
    const alarm = new Date("2026-10-01T16:00:00Z");
    const window_end = new Date("2026-10-02T09:00:00Z");
    const before = seq("MFF");
    expect(fold(before, cfg).stats).toMatchObject({ current_streak: 2, total_missed: 1 });
    expect(fold(before, cfg).meals).toHaveLength(1);

    // The late session: 10 minutes ending 15:30Z, anchored before the alarm.
    const totals = recomputeTotals(
      [{ start: new Date("2026-10-01T15:20:00Z"), end: new Date("2026-10-01T15:30:00Z"), active: 600, source: "reader", scorable: true }],
      600,
      alarm,
    );
    const r = { ...row({ window_end, alarm_at: alarm }), ...totals };
    expect(decide(r).result).toBe("feast");

    const received47 = new Date(window_end.getTime() + 47 * H);
    expect(canRescore({ result: "missed", window_end }, received47, cfg)).toBe(true);
    const after = fold([{ ...before[0], result: "feast" }, before[1], before[2]], cfg);
    expect(after.stats).toMatchObject({ current_streak: 3, longest_streak: 3, total_missed: 0, total_feasts: 3 });
    expect(after.meals).toHaveLength(0);

    // The same session at 49 h: no re-score.
    const received49 = new Date(window_end.getTime() + 49 * H);
    expect(canRescore({ result: "missed", window_end }, received49, cfg)).toBe(false);
    expect(canRescore({ result: "feast", window_end }, received47, cfg)).toBe(false);
  });
});
