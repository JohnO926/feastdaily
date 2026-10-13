import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { testConfig } from "@/lib/config";
import {
  dayKey,
  localDate,
  nextRollover,
  planCatchUp,
  planDay,
  rescheduleWindowEnd,
} from "@/lib/day";

const cfg = testConfig();
const H = 3_600_000;

/** Instant of a local wall time in a zone, e.g. at("2026-10-12T03:00", "America/Denver"). */
function at(local: string, tz: string): Date {
  const zdt = Temporal.PlainDateTime.from(local).toZonedDateTime(tz, { disambiguation: "compatible" });
  return new Date(zdt.epochMilliseconds);
}
const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / H;
const DEN = "America/Denver";

describe("planDay", () => {
  it("an aligned Denver day is 24 h and keyed by its local date", () => {
    const start = at("2026-10-12T03:00", DEN);
    const w = planDay({ tz: DEN, rolloverHour: 3, start, prevDayKey: "2026-10-11", cfg });
    expect(hours(w.window_start, w.window_end)).toBe(24);
    expect(w.window_end).toEqual(at("2026-10-13T03:00", DEN));
    expect(w.day_key).toBe("2026-10-12");
  });

  it("spring-forward day is 23 h and fall-back day is 25 h, with correct keys", () => {
    const spring = planDay({ tz: DEN, rolloverHour: 3, start: at("2026-03-07T03:00", DEN), prevDayKey: null, cfg });
    expect(hours(spring.window_start, spring.window_end)).toBe(23);
    expect(spring.day_key).toBe("2026-03-07");
    const after = planDay({ tz: DEN, rolloverHour: 3, start: spring.window_end, prevDayKey: spring.day_key, cfg });
    expect(hours(after.window_start, after.window_end)).toBe(24);
    expect(after.day_key).toBe("2026-03-08");

    const fall = planDay({ tz: DEN, rolloverHour: 3, start: at("2026-10-31T03:00", DEN), prevDayKey: null, cfg });
    expect(hours(fall.window_start, fall.window_end)).toBe(25);
    expect(fall.day_key).toBe("2026-10-31");
  });

  it("rollover hour 2 on the spring-forward night resolves the missing 02:00 forward", () => {
    const w = planDay({ tz: DEN, rolloverHour: 2, start: at("2026-03-07T02:00", DEN), prevDayKey: null, cfg });
    // 02:00 does not exist on 2026-03-08; 'compatible' gives 03:00 MDT.
    expect(w.window_end).toEqual(new Date("2026-03-08T09:00:00Z"));
    expect(w.day_key).toBe("2026-03-07");
  });

  it("Kolkata (+05:30) windows end on the half hour", () => {
    const tz = "Asia/Kolkata";
    const w = planDay({ tz, rolloverHour: 3, start: at("2026-10-12T03:00", tz), prevDayKey: null, cfg });
    expect(w.window_end.toISOString()).toBe("2026-10-12T21:30:00.000Z");
    expect(hours(w.window_start, w.window_end)).toBe(24);
    expect(w.day_key).toBe("2026-10-12");
  });

  it("rollover hours 0 and 9", () => {
    const w0 = planDay({ tz: DEN, rolloverHour: 0, start: at("2026-10-12T00:00", DEN), prevDayKey: null, cfg });
    expect(w0.window_end).toEqual(at("2026-10-13T00:00", DEN));
    expect(w0.day_key).toBe("2026-10-12");
    const w9 = planDay({ tz: DEN, rolloverHour: 9, start: at("2026-10-12T09:00", DEN), prevDayKey: null, cfg });
    expect(w9.window_end).toEqual(at("2026-10-13T09:00", DEN));
    expect(w9.day_key).toBe("2026-10-12");
    expect(dayKey(DEN, 9, at("2026-10-13T08:59", DEN))).toBe("2026-10-12");
    expect(dayKey(DEN, 9, at("2026-10-13T09:00", DEN))).toBe("2026-10-13");
    expect(dayKey(DEN, 0, at("2026-10-12T23:59", DEN))).toBe("2026-10-12");
    expect(dayKey(DEN, 0, at("2026-10-13T00:00", DEN))).toBe("2026-10-13");
  });

  it("day key at 02:59 vs 03:00", () => {
    expect(dayKey(DEN, 3, at("2026-10-13T02:59:59", DEN))).toBe("2026-10-12");
    expect(dayKey(DEN, 3, at("2026-10-13T03:00", DEN))).toBe("2026-10-13");
  });

  it("nextRollover is strictly after", () => {
    const r = at("2026-10-13T03:00", DEN);
    expect(nextRollover(DEN, 3, r)).toEqual(at("2026-10-14T03:00", DEN));
    expect(nextRollover(DEN, 3, new Date(r.getTime() - 1))).toEqual(r);
  });
});

describe("rescheduleWindowEnd (tz / rollover change on the open day)", () => {
  const start = at("2026-10-12T03:00", DEN); // 09:00Z

  it("Denver -> Tokyo mid-day ends at the following JST rollover, at least 12 h", () => {
    const now = at("2026-10-12T10:00", DEN); // 16:00Z = 01:00 JST; next 03:00 JST is only 9 h after start
    const end = rescheduleWindowEnd({ tz: "Asia/Tokyo", rolloverHour: 3, start, now, alarmAt: null, cfg });
    expect(end).toEqual(at("2026-10-14T03:00", "Asia/Tokyo"));
    expect(hours(start, end)).toBeGreaterThanOrEqual(12);
    expect(hours(start, end)).toBe(33);
  });

  it("Denver -> Honolulu lengthens the day to 28 h with no clamp", () => {
    const now = at("2026-10-12T12:00", DEN);
    const end = rescheduleWindowEnd({ tz: "Pacific/Honolulu", rolloverHour: 3, start, now, alarmAt: null, cfg });
    expect(end).toEqual(at("2026-10-13T03:00", "Pacific/Honolulu"));
    expect(hours(start, end)).toBe(28);
  });

  it("Denver -> Halifax shortens the day to 21 h with no clamp", () => {
    const now = at("2026-10-12T12:00", DEN);
    const end = rescheduleWindowEnd({ tz: "America/Halifax", rolloverHour: 3, start, now, alarmAt: null, cfg });
    expect(end).toEqual(at("2026-10-13T03:00", "America/Halifax"));
    expect(hours(start, end)).toBe(21);
  });

  it("tz change plus rollover-hour change 3 -> 9 hits the 36 h cap; following keys equal local dates (drift regression)", () => {
    const tz = "Asia/Tokyo";
    const now = at("2026-10-13T09:30", tz); // start + 15.5 h; next 09:00 JST is 23.5 h away
    const end = rescheduleWindowEnd({ tz, rolloverHour: 9, start, now, alarmAt: null, cfg });
    expect(hours(start, end)).toBe(36); // capped, and the end lands at 06:00 JST, before the rollover hour
    expect(Temporal.Instant.fromEpochMilliseconds(end.getTime()).toZonedDateTimeISO(tz).hour).toBe(6);

    // The open day keeps its key (2026-10-12). Then two normal days: keys are the real local dates.
    const d2 = planDay({ tz, rolloverHour: 9, start: end, prevDayKey: "2026-10-12", cfg });
    expect(d2.window_end).toEqual(at("2026-10-15T09:00", tz));
    expect(d2.day_key).toBe("2026-10-14");
    const d3 = planDay({ tz, rolloverHour: 9, start: d2.window_end, prevDayKey: d2.day_key, cfg });
    expect(d3.day_key).toBe("2026-10-15");
    expect(d3.day_key).toBe(localDate(tz, d3.window_start).toString());
    const d4 = planDay({ tz, rolloverHour: 9, start: d3.window_end, prevDayKey: d3.day_key, cfg });
    expect(d4.day_key).toBe("2026-10-16");
    expect(hours(d4.window_start, d4.window_end)).toBe(24);
  });

  it("never moves window_end below now or a stamped alarm_at", () => {
    const now = new Date("2026-10-13T03:30:00Z"); // 21:30 MDT, past the alarm, before the Denver rollover
    const alarmAt = new Date("2026-10-12T20:00:00Z");
    // London: the first 03:00 BST after start + 12 h is 02:00Z, which is already in the past.
    const end = rescheduleWindowEnd({ tz: "Europe/London", rolloverHour: 3, start, now, alarmAt, cfg });
    expect(end.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(end.getTime()).toBeGreaterThanOrEqual(alarmAt.getTime());
    expect(end).toEqual(new Date(start.getTime() + 36 * H)); // next 03:00 BST is beyond the cap

    const lateAlarm = new Date(start.getTime() + 13 * H);
    const end2 = rescheduleWindowEnd({
      tz: "America/Halifax",
      rolloverHour: 3,
      start,
      now: new Date(start.getTime() + 13.5 * H),
      alarmAt: lateAlarm,
      cfg,
    });
    expect(end2.getTime()).toBeGreaterThanOrEqual(lateAlarm.getTime());
  });
});

describe("planCatchUp", () => {
  it("does nothing while the pending window is open", () => {
    const p = planCatchUp({
      pending: { window_end: at("2026-10-13T03:00", DEN), day_key: "2026-10-12" },
      now: at("2026-10-12T20:00", DEN),
      tz: DEN,
      rolloverHour: 3,
      dormantSince: null,
      cfg,
    });
    expect(p.mode).toBe("none");
  });

  it("returning after a long absence skips the gap and opens at the next rollover", () => {
    const now = at("2026-11-25T12:00", DEN);
    const p = planCatchUp({
      pending: { window_end: at("2026-10-13T03:00", DEN), day_key: "2026-10-12" },
      now,
      tz: DEN,
      rolloverHour: 3,
      dormantSince: null,
      cfg,
    });
    expect(p.mode).toBe("dormant");
    if (p.mode !== "dormant") return;
    expect(p.windows[0].window_start).toEqual(at("2026-11-26T03:00", DEN));
    expect(p.windows[0].day_key).toBe("2026-11-26");
  });
});
