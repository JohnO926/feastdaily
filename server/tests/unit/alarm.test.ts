import { describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { alarmDateFor, alarmWindowFor, beatPct, pickFireAt, publicAlarmColumns } from "@/lib/alarm";
import { testConfig } from "@/lib/config";

const cfg = testConfig();
const denver = (d: Date) => Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO("America/Denver");

describe("alarm window and pick", () => {
  it("window is 10:00-20:30 Denver on both sides of DST", () => {
    for (const date of ["2026-03-07", "2026-03-08", "2026-07-01", "2026-11-01", "2026-12-24"]) {
      const { start, end } = alarmWindowFor(date, cfg);
      expect([denver(start).hour, denver(start).minute]).toEqual([10, 0]);
      expect([denver(end).hour, denver(end).minute]).toEqual([20, 30]);
      expect(denver(start).toPlainDate().toString()).toBe(date);
    }
    expect(alarmWindowFor("2026-07-01", cfg).start.toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(alarmWindowFor("2026-12-24", cfg).start.toISOString()).toBe("2026-12-24T17:00:00.000Z");
  });

  it("picked instants always fall inside the window, also with extreme random values", () => {
    const date = "2026-11-01";
    const { start, end } = alarmWindowFor(date, cfg);
    const early = new Date(start.getTime() - 6 * 3_600_000);
    for (let i = 0; i < 500; i++) {
      const t = pickFireAt(date, early, cfg)!;
      expect(t.getTime()).toBeGreaterThanOrEqual(start.getTime());
      expect(t.getTime()).toBeLessThan(end.getTime());
    }
    expect(pickFireAt(date, early, cfg, () => 0)).toEqual(start);
    expect(pickFireAt(date, early, cfg, (n) => n - 1)).toEqual(new Date(end.getTime() - 1));
  });

  it("a late caller shrinks the window to [now, 20:30); after 20:30 there is no alarm", () => {
    const date = "2026-10-13";
    const now = new Date("2026-10-14T00:00:00Z"); // 18:00 MDT
    const t = pickFireAt(date, now, cfg, () => 0)!;
    expect(t).toEqual(now);
    expect(pickFireAt(date, new Date("2026-10-14T02:30:00Z"), cfg)).toBeNull();
  });

  it("alarm date is the Denver calendar date", () => {
    expect(alarmDateFor(new Date("2026-10-13T05:59:00Z"), cfg)).toBe("2026-10-12");
    expect(alarmDateFor(new Date("2026-10-13T06:00:00Z"), cfg)).toBe("2026-10-13");
  });

  it("public columns never include fire_at; beat_pct rounds and handles zero readers", () => {
    expect(Object.keys(publicAlarmColumns)).not.toContain("fireAt");
    expect(beatPct(62, 100)).toBe(62);
    expect(beatPct(2, 3)).toBe(67);
    expect(beatPct(0, 0)).toBeNull();
  });
});
