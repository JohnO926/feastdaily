import { describe, expect, it } from "vitest";
import { testConfig } from "@/lib/config";
import {
  allocateProportional,
  evaluateSession,
  planIngest,
  recomputeTotals,
  resolveOverlap,
  splitAtBoundaries,
  type ClientSession,
  type IngestContext,
  type IngestState,
  type WindowRef,
} from "@/lib/sessions";

const cfg = testConfig();
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

const RECEIVED = new Date("2026-10-13T05:00:00.000Z"); // 23:00 MDT Oct 12
const NOW_MONO = 900_000_000; // client's monotonic clock at upload (ms)
const OFFSET = RECEIVED.getTime() - NOW_MONO; // server instant = mono + OFFSET

const mono = (t: Date) => t.getTime() - OFFSET;

function ctx(over: Partial<IngestContext> = {}): IngestContext {
  return {
    receivedAt: RECEIVED,
    envelope: { device_id: "dev", boot_id: "boot-A", client_now_wall: RECEIVED, client_now_mono_ms: NOW_MONO },
    bootAnchors: { "boot-A": OFFSET },
    deviceLastSeenAt: null,
    bootLastContact: {},
    cfg,
    ...over,
  };
}

let n = 0;
/** A reader session of the current boot spanning [start, end] server time. */
function sess(start: Date, end: Date, active: number, over: Partial<ClientSession> = {}): ClientSession {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    source: "reader",
    boot_id: "boot-A",
    started_at_wall: start,
    ended_at_wall: end,
    mono_start_ms: mono(start),
    mono_end_ms: mono(end),
    active_seconds: active,
    content_ref: null,
    ...over,
  };
}

function selfReport(tap: Date, over: Partial<ClientSession> = {}): ClientSession {
  return sess(tap, tap, 0, { source: "self_report", active_seconds: 0, ...over });
}

const ago = (ms: number) => new Date(RECEIVED.getTime() - ms);

// Day windows (Denver, rollover 03:00): Oct 12 03:00 MDT -> Oct 13 03:00 MDT, then the next day.
const W1: WindowRef = {
  id: "w1",
  window_start: new Date("2026-10-12T09:00:00Z"),
  window_end: new Date("2026-10-13T09:00:00Z"),
  day_key: "2026-10-12",
  alarm_at: null,
  result: "pending",
};
const W0: WindowRef = {
  id: "w0",
  window_start: new Date("2026-10-11T09:00:00Z"),
  window_end: W1.window_start,
  day_key: "2026-10-11",
  alarm_at: null,
  result: "missed",
};

function state(over: Partial<IngestState> = {}): IngestState {
  return {
    windows: [W0, W1],
    firstDayStartsAt: W0.window_start,
    firedAlarms: [],
    existingIntervals: [],
    dayTotals: {},
    selfReportDayKeys: new Set(),
    fallbackDayKey: () => "2026-10-10",
    ...over,
  };
}

describe("evaluateSession: each reject reason", () => {
  it("malformed", () => {
    const r = evaluateSession(sess(ago(10 * MIN), ago(5 * MIN), 0), ctx());
    expect(r).toMatchObject({ ok: false, reason: "malformed" });
    const r2 = evaluateSession(sess(ago(5 * MIN), ago(10 * MIN), 60), ctx());
    expect(r2).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("mono_future: a current-boot session ending after the client's own now", () => {
    const s = sess(ago(5 * MIN), ago(1 * MIN), 200, { mono_end_ms: NOW_MONO + 5_000 });
    expect(evaluateSession(s, ctx())).toMatchObject({ ok: false, reason: "mono_future" });
  });

  it("future: an unknown-boot session anchored more than 60 s past receipt", () => {
    const s = sess(ago(1 * MIN), new Date(RECEIVED.getTime() + 2 * MIN), 100, { boot_id: "boot-old" });
    expect(evaluateSession(s, ctx())).toMatchObject({ ok: false, reason: "future" });
  });

  it("span_too_long", () => {
    const s = sess(ago(7 * H), ago(10 * MIN), 3600);
    expect(evaluateSession(s, ctx())).toMatchObject({ ok: false, reason: "span_too_long" });
  });

  it("active_exceeds_span: 45 minutes logged in 5 minutes of wall time", () => {
    const s = sess(ago(10 * MIN), ago(5 * MIN), 45 * 60);
    expect(evaluateSession(s, ctx())).toMatchObject({ ok: false, reason: "active_exceeds_span" });
    // within the 5 s tolerance is fine
    const ok = sess(ago(10 * MIN), ago(5 * MIN), 5 * 60 + 5);
    expect(evaluateSession(ok, ctx())).toMatchObject({ ok: true, scorable: true });
  });

  it("overlap: a second device reading the same minutes is rejected", () => {
    const s = sess(ago(30 * MIN), ago(20 * MIN), 600);
    const d = planIngest(s, ctx(), state({ existingIntervals: [{ start: ago(25 * MIN), end: ago(15 * MIN) }] }));
    expect(d).toMatchObject({ status: "rejected", reason: "overlap" });
  });

  it("daily_cap", () => {
    const s = sess(ago(30 * MIN), ago(20 * MIN), 600);
    const d = planIngest(s, ctx(), state({ dayTotals: { w1: cfg.max_daily_active_seconds - 100 } }));
    expect(d).toMatchObject({ status: "rejected", reason: "daily_cap" });
  });

  it("stale at 49 h is kept as history (verified, unscorable); 47 h is scorable", () => {
    const stale = evaluateSession(sess(ago(49 * H), ago(49 * H - 10 * MIN), 600), ctx());
    expect(stale).toMatchObject({ ok: true, scorable: false, reason: "stale" });
    const fresh = evaluateSession(sess(ago(47 * H), ago(47 * H - 10 * MIN), 600), ctx());
    expect(fresh).toMatchObject({ ok: true, scorable: true, reason: null });
  });

  it("backdated: a session that ended before the device's last contact is history only", () => {
    const lastSeen = ago(1 * H);
    const back = evaluateSession(sess(ago(3 * H), ago(2 * H), 1800), ctx({ deviceLastSeenAt: lastSeen }));
    expect(back).toMatchObject({ ok: true, scorable: false, reason: "backdated" });
    // ending within the 60 s grace before last contact is still fine
    const ok = evaluateSession(sess(ago(2 * H), new Date(lastSeen.getTime() - 30 * S), 1800), ctx({ deviceLastSeenAt: lastSeen }));
    expect(ok).toMatchObject({ ok: true, scorable: true });
    // the legitimate late upload (plane trip): ended after the last successful request
    const trip = evaluateSession(sess(ago(50 * MIN), ago(20 * MIN), 1800), ctx({ deviceLastSeenAt: lastSeen }));
    expect(trip).toMatchObject({ ok: true, scorable: true });
  });

  it("hybrid rule: a known boot is judged by its own last contact, not the device's", () => {
    const deviceContact = ago(10 * MIN); // e.g. a second iPhone sharing the device id
    const bootContact = ago(3 * H); // this boot's last request, before it went offline
    const c = ctx({ deviceLastSeenAt: deviceContact, bootLastContact: { "boot-A": bootContact } });
    // read offline after its own last contact: scores even though the device was seen since
    expect(evaluateSession(sess(ago(2 * H), ago(90 * MIN), 1800), c)).toMatchObject({ ok: true, scorable: true, reason: null });
    // ended before its own last contact: backdated
    expect(evaluateSession(sess(ago(4 * H), ago(3 * H + 5 * MIN), 1800), c)).toMatchObject({ scorable: false, reason: "backdated" });
  });

  it("hybrid rule: an unknown boot (or a known boot with no contact) falls back to the device's last contact", () => {
    const deviceContact = ago(30 * MIN);
    const old = (over: Partial<ClientSession>) =>
      sess(ago(2 * H), ago(90 * MIN), 1800, { boot_id: "boot-fake", mono_start_ms: 1_000, mono_end_ms: 1_000 + 30 * MIN, ...over });
    const unknown = evaluateSession(old({}), ctx({ deviceLastSeenAt: deviceContact }));
    expect(unknown).toMatchObject({ ok: true, anchoredBy: "wall", scorable: false, reason: "backdated" });
    const noContact = evaluateSession(
      old({}),
      ctx({ deviceLastSeenAt: deviceContact, bootLastContact: { "boot-fake": null }, bootAnchors: { "boot-A": OFFSET, "boot-fake": ago(90 * MIN).getTime() - (1_000 + 30 * MIN) } }),
    );
    expect(noContact).toMatchObject({ ok: true, anchoredBy: "mono", scorable: false, reason: "backdated" });
  });

  it("wall/mono mismatch is advisory only", () => {
    const s = sess(ago(30 * MIN), ago(20 * MIN), 600, { ended_at_wall: ago(10 * MIN) });
    expect(evaluateSession(s, ctx())).toMatchObject({ ok: true, scorable: true, wallMonoMismatch: true });
  });
});

describe("anchoring", () => {
  it("an unknown boot is anchored by the envelope wall offset (device clock a day fast)", () => {
    const skew = 24 * H;
    const realStart = ago(2 * H);
    const realEnd = ago(90 * MIN);
    const s = sess(realStart, realEnd, 1800, {
      boot_id: "boot-previous",
      started_at_wall: new Date(realStart.getTime() + skew),
      ended_at_wall: new Date(realEnd.getTime() + skew),
      mono_start_ms: 5_000,
      mono_end_ms: 5_000 + 30 * MIN,
    });
    const c = ctx({
      envelope: {
        device_id: "dev",
        boot_id: "boot-A",
        client_now_wall: new Date(RECEIVED.getTime() + skew),
        client_now_mono_ms: NOW_MONO,
      },
    });
    const r = evaluateSession(s, c);
    expect(r).toMatchObject({ ok: true, anchoredBy: "wall" });
    if (!r.ok) return;
    expect(r.start).toEqual(realStart);
    expect(r.end).toEqual(realEnd);
    expect(r.newBoot).toEqual({
      boot_id: "boot-previous",
      anchor_offset_ms: realEnd.getTime() - (5_000 + 30 * MIN),
      last_seen_mono_ms: 5_000 + 30 * MIN,
    });
  });

  it("the device wall clock is never trusted for a current-boot session", () => {
    const s = sess(ago(20 * MIN), ago(10 * MIN), 600, {
      started_at_wall: new Date("2030-01-01T00:00:00Z"),
      ended_at_wall: new Date("2030-01-01T00:10:00Z"),
    });
    const r = evaluateSession(s, ctx());
    expect(r).toMatchObject({ ok: true, anchoredBy: "mono" });
    if (r.ok) expect(r.end).toEqual(ago(10 * MIN));
  });

  it("a stable per-boot anchor keeps back-to-back split sessions from overlapping", () => {
    const m0 = NOW_MONO - 40 * MIN;
    const m1 = NOW_MONO - 20 * MIN;
    const m2 = NOW_MONO - 1 * MIN;
    const w = (m: number) => new Date(m + OFFSET);
    const a = sess(w(m0), w(m1), 1200);
    const b = sess(w(m1), w(m2), 1140);
    // b is uploaded in a later request whose latency was 2 s worse; the stored minimum offset is reused
    const ra = evaluateSession(a, ctx());
    const rb = evaluateSession(b, ctx({ receivedAt: new Date(RECEIVED.getTime() + 2_000) }));
    expect(ra.ok && rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect(rb.start).toEqual(ra.end);
    const ov = resolveOverlap(rb, [{ start: ra.start, end: ra.end }], cfg.overlap_tolerance_seconds);
    expect(ov).toEqual({ ok: true, start: rb.start, end: rb.end, active: 1140 });
  });
});

describe("overlap trimming", () => {
  it("an overlap within tolerance trims the new session to the free interval", () => {
    const existing = [{ start: ago(40 * MIN), end: ago(30 * MIN) }];
    const r = resolveOverlap({ start: ago(30 * MIN + 3 * S), end: ago(20 * MIN), active: 603 }, existing, 5);
    expect(r).toMatchObject({ ok: true, start: ago(30 * MIN), end: ago(20 * MIN) });
    if (r.ok) expect(r.active).toBe(600);
  });
  it("a larger overlap rejects", () => {
    const existing = [{ start: ago(40 * MIN), end: ago(30 * MIN) }];
    expect(resolveOverlap({ start: ago(31 * MIN), end: ago(20 * MIN), active: 600 }, existing, 5)).toEqual({ ok: false });
  });
});

describe("server-side splitting and day assignment", () => {
  it("splits a session crossing window_end into two days with proportional active seconds", () => {
    const now = new Date("2026-10-13T09:40:00Z");
    const c = ctx({
      receivedAt: now,
      envelope: { device_id: "dev", boot_id: "boot-A", client_now_wall: now, client_now_mono_ms: NOW_MONO },
      bootAnchors: { "boot-A": now.getTime() - NOW_MONO },
    });
    const W2: WindowRef = { ...W1, id: "w2", window_start: W1.window_end, window_end: new Date("2026-10-14T09:00:00Z"), day_key: "2026-10-13" };
    const start = new Date("2026-10-13T08:30:00Z");
    const end = new Date("2026-10-13T09:30:00Z");
    const off = now.getTime() - NOW_MONO;
    const s = sess(start, end, 3000, { mono_start_ms: start.getTime() - off, mono_end_ms: end.getTime() - off });
    const d = planIngest(s, c, state({ windows: [W0, W1, W2] }));
    expect(d.status).toBe("accepted");
    if (d.status !== "accepted") return;
    expect(d.pieces).toEqual([
      { start, end: W1.window_end, active: 1500, windowId: "w1", day_key: "2026-10-12" },
      { start: W1.window_end, end, active: 1500, windowId: "w2", day_key: "2026-10-13" },
    ]);
  });

  it("splits at a fired alarm instant so no piece straddles it", () => {
    const alarm = ago(30 * MIN);
    const d = planIngest(sess(ago(50 * MIN), ago(20 * MIN), 1800), ctx(), state({ firedAlarms: [alarm] }));
    expect(d.status).toBe("accepted");
    if (d.status !== "accepted") return;
    expect(d.pieces.map((p) => [p.end.getTime() - p.start.getTime(), p.active, p.windowId])).toEqual([
      [20 * MIN, 1200, "w1"],
      [10 * MIN, 600, "w1"],
    ]);
    const totals = recomputeTotals(
      d.pieces.map((p) => ({ ...p, source: "reader" as const, scorable: true })),
      600,
      alarm,
    );
    expect(totals.verified_seconds).toBe(1800);
    expect(totals.verified_before_alarm_seconds).toBe(1200);
  });

  it("pieces before first_day_starts_at are history only", () => {
    const firstDay = new Date("2026-10-13T09:00:00Z");
    const day0: WindowRef = { ...W1, id: "d0", window_start: firstDay, window_end: new Date("2026-10-14T09:00:00Z"), day_key: "2026-10-13" };
    const d = planIngest(
      sess(ago(30 * MIN), ago(20 * MIN), 600),
      ctx(),
      state({ windows: [day0], firstDayStartsAt: firstDay, fallbackDayKey: () => "2026-10-12" }),
    );
    expect(d).toMatchObject({ status: "accepted", scorable: true });
    if (d.status !== "accepted") return;
    expect(d.pieces).toHaveLength(1);
    expect(d.pieces[0]).toMatchObject({ windowId: null, day_key: "2026-10-12" });
  });

  it("allocates integer active seconds exactly", () => {
    expect(allocateProportional(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitAtBoundaries({ start: ago(3 * S), end: ago(0), active: 2 }, [ago(2 * S), ago(1 * S)]).map((p) => p.active)).toEqual([1, 1, 0]);
  });
});

describe("recomputeTotals", () => {
  it("interpolates goal_reached_at inside the piece that crosses the goal, across two sessions", () => {
    const t1 = new Date("2026-10-12T14:00:00Z");
    const t2 = new Date("2026-10-12T16:00:00Z");
    const pieces = [
      { start: t1, end: new Date(t1.getTime() + 300 * S), active: 300, source: "reader" as const, scorable: true },
      { start: t2, end: new Date(t2.getTime() + 600 * S), active: 600, source: "reader" as const, scorable: true },
    ];
    const r = recomputeTotals(pieces, 600, null);
    expect(r.verified_seconds).toBe(900);
    expect(r.verified_before_alarm_seconds).toBe(900);
    expect(r.goal_reached_at).toEqual(new Date(t2.getTime() + 300 * S));
  });

  it("clips a straddling piece at the alarm and ignores unscorable pieces", () => {
    const a = new Date("2026-10-12T15:00:00Z");
    const pieces = [
      { start: new Date(a.getTime() - 5 * MIN), end: new Date(a.getTime() + 5 * MIN), active: 600, source: "reader" as const, scorable: true },
      { start: new Date(a.getTime() - 60 * MIN), end: new Date(a.getTime() - 50 * MIN), active: 600, source: "reader" as const, scorable: false },
    ];
    const r = recomputeTotals(pieces, 300, a);
    expect(r.verified_seconds).toBe(600);
    expect(r.verified_before_alarm_seconds).toBe(300);
  });
});

describe("self-report", () => {
  it("is anchored by its tap instant, not the upload time", () => {
    const tap = new Date("2026-10-12T15:59:00Z"); // 09:59 MDT, synced at 23:00 MDT
    const d = planIngest(selfReport(tap), ctx(), state());
    expect(d.status).toBe("accepted");
    if (d.status !== "accepted") return;
    expect(d.pieces).toEqual([{ start: tap, end: tap, active: 0, windowId: "w1", day_key: "2026-10-12" }]);
  });

  it("a second self-report for the same day is rejected", () => {
    const tap = new Date("2026-10-12T15:59:00Z");
    const d = planIngest(selfReport(tap), ctx(), state({ selfReportDayKeys: new Set(["2026-10-12"]) }));
    expect(d).toMatchObject({ status: "rejected", reason: "duplicate_self_report" });
  });

  it("a self-report tapped after the alarm is refused", () => {
    const alarm = new Date("2026-10-12T16:05:00Z");
    const d = planIngest(selfReport(new Date("2026-10-12T16:10:00Z")), ctx(), state({ firedAlarms: [alarm] }));
    expect(d).toMatchObject({ status: "rejected", reason: "self_report_after_alarm" });
    const ok = planIngest(selfReport(new Date("2026-10-12T15:59:00Z")), ctx(), state({ firedAlarms: [alarm] }));
    expect(ok.status).toBe("accepted");
  });

  it("must be zero-length", () => {
    const s = selfReport(ago(MIN), { active_seconds: 5 });
    expect(evaluateSession(s, ctx())).toMatchObject({ ok: false, reason: "malformed" });
  });
});
