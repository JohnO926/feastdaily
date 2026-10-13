import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/client";
import { dailyAlarms, deviceCredentials, missedMeals, userSettings, userStats } from "@/db/schema";
import { hashSecret, signToken } from "@/lib/auth";
import { buildHome } from "@/lib/home";
import { closeDay, getConfig, getPendingDay, refold } from "@/services/days";
import { ingestAndSettle } from "@/services/sessions";
import { sweepDueUsers } from "@/services/sweep";
import { applySettings } from "@/services/users";
import { asUser, createOnboardedUser, D, daysOf, FakeDevice, H, MIN, resetDb, type TestUser } from "./helpers";

const T0 = new Date("2026-10-12T16:00:00Z"); // 10:00 MDT, onboarding
const DAY1 = new Date("2026-10-13T09:00:00Z"); // first_day_starts_at (03:00 MDT)
const DAY2 = new Date(DAY1.getTime() + D);
const DAY3 = new Date(DAY2.getTime() + D);

async function statsOf(userId: string) {
  const d = await db();
  const [s] = await d.select().from(userStats).where(eq(userStats.userId, userId));
  return s;
}

async function mealsOf(userId: string) {
  const d = await db();
  return d.select().from(missedMeals).where(eq(missedMeals.userId, userId)).orderBy(missedMeals.occurredAt);
}

/** A second credential for the same user (another iPhone / linked device). */
async function secondDevice(u: TestUser, now: Date): Promise<TestUser> {
  const deviceId = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const d = await db();
  await d.insert(deviceCredentials).values({ deviceId, userId: u.userId, secretHash: hashSecret(secret), createdAt: now, lastSeenAt: now });
  const { token } = await signToken(u.userId, deviceId, now);
  return { userId: u.userId, deviceId, secret, token };
}

describe("ensureDay / closeDay / refold against Postgres", () => {
  beforeEach(() => resetDb());

  it("onboarding opens day 0 at the next rollover; closeDay twice is a no-op", async () => {
    const u = await createOnboardedUser(T0);
    const [day] = await daysOf(u.userId);
    expect(day).toMatchObject({ dayKey: "2026-10-13", result: "pending", windowStart: DAY1, windowEnd: DAY2 });

    const now = new Date(DAY2.getTime() + MIN);
    const d = await db();
    const cfg = await getConfig(d);
    const first = await d.transaction((tx) => closeDay(tx, day.id, now, cfg));
    const second = await d.transaction((tx) => closeDay(tx, day.id, now, cfg));
    expect([first, second]).toEqual([true, false]);
    expect(await statsOf(u.userId)).toMatchObject({ totalMissed: 1, currentStreak: 0 });
    expect(await mealsOf(u.userId)).toHaveLength(1);
  });

  it("two concurrent ensureDay calls (request + sweep) produce one new pending row and one fold", async () => {
    const u = await createOnboardedUser(T0);
    const now = new Date(DAY2.getTime() + H);
    const [req, sweep] = await Promise.all([
      asUser(u, now, async (c) => c.user.id, { ensure: "before" }),
      sweepDueUsers(now, 500),
    ]);
    expect(req).toBe(u.userId);
    expect(sweep.closed + sweep.skipped_locked).toBeLessThanOrEqual(1);
    const days = await daysOf(u.userId);
    expect(days.map((x) => [x.dayKey, x.result])).toEqual([
      ["2026-10-13", "missed"],
      ["2026-10-14", "pending"],
    ]);
    expect(await statsOf(u.userId)).toMatchObject({ totalMissed: 1 });
    expect(await mealsOf(u.userId)).toHaveLength(1);

    // Two concurrent requests: the second waits on the users row lock and finds nothing due.
    const later = new Date(DAY3.getTime() + H);
    await Promise.all([asUser(u, later, async () => 0), asUser(u, later, async () => 0)]);
    const after = await daysOf(u.userId);
    expect(after.filter((x) => x.result === "pending")).toHaveLength(1);
    expect(after).toHaveLength(3);
    expect(await statsOf(u.userId)).toMatchObject({ totalMissed: 2 });
  });

  it("a 10-day gap closes 10 missed days; the home read model shows famine", async () => {
    const u = await createOnboardedUser(T0);
    const now = new Date(DAY1.getTime() + 10 * D + H);
    const home = await asUser(u, now, (c) => buildHome(c.tx, c.user, c.settings, c.cfg, c.now));
    const days = await daysOf(u.userId);
    expect(days.filter((x) => x.result === "missed")).toHaveLength(10);
    expect(days.at(-1)).toMatchObject({ result: "pending", dayKey: "2026-10-23" });
    expect(home.stats).toMatchObject({ current_streak: 0, active_missed_meals: 10, famine: true });
    expect(home.today?.status).toBe("racing");
  });

  it("returning after 40 days closes one day, skips the gap, and opens at the next rollover", async () => {
    const u = await createOnboardedUser(T0);
    const now = new Date(DAY2.getTime() + 40 * D + 5 * H); // 08:00 MST
    const home = await asUser(u, now, (c) => buildHome(c.tx, c.user, c.settings, c.cfg, c.now));
    const days = await daysOf(u.userId);
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ dayKey: "2026-10-13", result: "missed" });
    expect(days[1].result).toBe("pending");
    expect(days[1].windowStart.getTime()).toBeGreaterThan(now.getTime());
    expect(days[1].windowStart.toISOString()).toBe("2026-11-24T10:00:00.000Z"); // 03:00 MST
    expect(home.today?.status).toBe("not_started");
    expect(home.stats.active_missed_meals).toBe(0); // the one miss expired after 30 days
  });

  it("a dormant user (marked by the sweep) skips the gap on return", async () => {
    const u = await createOnboardedUser(T0);
    const d = await db();
    await d.execute(sql`update users set dormant_since = ${new Date(DAY2.getTime() + 2 * D)} where id = ${u.userId}`);
    const now = new Date(DAY2.getTime() + 5 * D);
    await asUser(u, now, async () => 0);
    const days = await daysOf(u.userId);
    expect(days.map((x) => x.result)).toEqual(["missed", "pending"]);
    const [user] = await d.execute<{ dormant_since: Date | null }>(sql`select dormant_since from users where id = ${u.userId}`).then((r) => r.rows);
    expect(user.dormant_since).toBeNull(); // cleared after ensureDay
  });

  it("goal change applies directly on day 0, otherwise only at the next open", async () => {
    const u = await createOnboardedUser(T0, { goal_seconds: 600 });
    // Day 0 (first day not started yet): direct.
    await asUser(u, new Date(T0.getTime() + H), (c) => applySettings(c, { goal_seconds: 900 }));
    let pending = await getPendingDay(await db(), u.userId);
    expect(pending?.goalSeconds).toBe(900);
    const d = await db();
    let [s] = await d.select().from(userSettings).where(eq(userSettings.userId, u.userId));
    expect(s).toMatchObject({ goalSeconds: 900, pendingGoalSeconds: null });

    // Mid-day: stored as pending, today's goal unchanged.
    await asUser(u, new Date(DAY1.getTime() + 5 * H), (c) => applySettings(c, { goal_seconds: 1200 }));
    pending = await getPendingDay(d, u.userId);
    expect(pending?.goalSeconds).toBe(900);
    [s] = await d.select().from(userSettings).where(eq(userSettings.userId, u.userId));
    expect(s).toMatchObject({ goalSeconds: 900, pendingGoalSeconds: 1200 });

    // Next open promotes it.
    await asUser(u, new Date(DAY2.getTime() + H), async () => 0);
    pending = await getPendingDay(d, u.userId);
    expect(pending?.goalSeconds).toBe(1200);
    [s] = await d.select().from(userSettings).where(eq(userSettings.userId, u.userId));
    expect(s).toMatchObject({ goalSeconds: 1200, pendingGoalSeconds: null });
  });

  it("tz change reschedules the open day (Denver -> Tokyo) without moving below now", async () => {
    const u = await createOnboardedUser(T0);
    const now = new Date(DAY1.getTime() + 7 * H); // 10:00 MDT = 01:00 JST next day
    await asUser(u, now, (c) => applySettings(c, { tz: "Asia/Tokyo" }));
    const pending = await getPendingDay(await db(), u.userId);
    expect(pending?.windowEnd.toISOString()).toBe("2026-10-14T18:00:00.000Z"); // 03:00 JST Oct 15
    expect(pending?.dayKey).toBe("2026-10-13");
  });
});

describe("late sessions and re-scoring", () => {
  beforeEach(() => resetDb());

  async function seedFiredAlarm(alarmDate: string, at: Date) {
    const d = await db();
    await d.insert(dailyAlarms).values({
      alarmDate,
      windowStart: new Date(at.getTime() - 2 * H),
      windowEnd: new Date(at.getTime() + 8 * H),
      fireAt: at,
      firedAt: at,
    });
  }

  /**
   * Device A reads on day 1 offline (before the 10:00 MDT alarm) and only syncs on day 3.
   * Device B (same user) reads on day 2 online. Meanwhile day 1 closed as a miss.
   */
  async function scenario() {
    const u = await createOnboardedUser(T0, { goal_seconds: 600 });
    const a = new FakeDevice(u.deviceId);
    const ub = await secondDevice(u, T0);
    const b = new FakeDevice(ub.deviceId);
    const alarm1 = new Date("2026-10-13T16:00:00Z");
    await seedFiredAlarm("2026-10-13", alarm1);
    // Day 2 reading on device B (online) at Oct 14 13:00Z; this request also closes day 1 (missed).
    const t2 = new Date(DAY2.getTime() + 4 * H);
    await asUser(ub, t2, (c) => ingestAndSettle(c, b.envelope(t2), [b.reading(new Date(t2.getTime() - 15 * MIN), new Date(t2.getTime() - 3 * MIN), 700)]), { ensure: "manual" });
    // The offline day-1 session (ended 15:30Z, before the alarm); device A's last contact was onboarding (T0).
    const late = a.reading(new Date("2026-10-13T15:15:00Z"), new Date("2026-10-13T15:30:00Z"), 800);
    return { u, a, ub, b, late };
  }

  it("re-scores a missed day to feast within 48 h, removes its missed meal, repairs the streak", async () => {
    const { u, a, late } = await scenario();
    // Day 2 closes as a feast via the sweep at Oct 15 09:30Z.
    await sweepDueUsers(new Date(DAY3.getTime() + 30 * MIN), 500);
    let days = await daysOf(u.userId);
    expect(days.map((x) => [x.dayKey, x.result])).toEqual([
      ["2026-10-13", "missed"],
      ["2026-10-14", "feast"],
      ["2026-10-15", "pending"],
    ]);
    expect(days[0].alarmAt?.toISOString()).toBe("2026-10-13T16:00:00.000Z");
    expect(await statsOf(u.userId)).toMatchObject({ currentStreak: 1, totalMissed: 1 });
    expect(await mealsOf(u.userId)).toHaveLength(1);

    const syncAt = new Date(DAY3.getTime() + H); // 25 h after day 1's window_end
    const r = await asUser(u, syncAt, (c) => ingestAndSettle(c, a.envelope(syncAt), [late]), { ensure: "manual" });
    expect(r.results[0]).toMatchObject({ status: "accepted", scored: true, day_key: "2026-10-13" });
    expect(r.rescored).toBe(1);
    days = await daysOf(u.userId);
    expect(days[0]).toMatchObject({ result: "feast", verifiedBeforeAlarmSeconds: 800 });
    expect(days[0].rescoredAt).not.toBeNull();
    expect(await statsOf(u.userId)).toMatchObject({ currentStreak: 2, longestStreak: 2, totalMissed: 0, totalFeasts: 2 });
    expect(await mealsOf(u.userId)).toHaveLength(0);
  });

  it("the same session synced 49 h after window_end does not re-score", async () => {
    const { u, a, late } = await scenario();
    const syncAt = new Date(DAY2.getTime() + 49 * H);
    const r = await asUser(u, syncAt, (c) => ingestAndSettle(c, a.envelope(syncAt), [late]), { ensure: "manual" });
    expect(r.rescored).toBe(0);
    const days = await daysOf(u.userId);
    expect(days[0].result).toBe("missed");
    expect(r.results[0]).toMatchObject({ status: "accepted", reason: "stale", scored: false });
  });

  it("concurrent late ingest (re-score) and sweep close leave missed_meals consistent", async () => {
    const { u, a, late } = await scenario();
    const now = new Date(DAY3.getTime() + H);
    await Promise.all([
      asUser(u, now, (c) => ingestAndSettle(c, a.envelope(now), [late]), { ensure: "manual" }),
      sweepDueUsers(now, 500),
    ]);
    const days = await daysOf(u.userId);
    expect(days.map((x) => x.result)).toEqual(["feast", "feast", "pending"]);
    expect(await mealsOf(u.userId)).toHaveLength(0);
    const before = await statsOf(u.userId);
    expect(before).toMatchObject({ currentStreak: 2, totalMissed: 0 });
    // Refold is idempotent.
    const d = await db();
    await d.transaction(async (tx) => refold(tx, u.userId, await getConfig(tx)));
    expect(await statsOf(u.userId)).toEqual(before);
  });

  it("phone A reading offline still scores while phone B (same device id, different boot) makes requests", async () => {
    const u = await createOnboardedUser(T0);
    const phoneA = new FakeDevice(u.deviceId, "boot-phone-A");
    const phoneB = new FakeDevice(u.deviceId, "boot-phone-B", new Date("2026-09-20T00:00:00Z"));
    // A syncs (empty batch) at 07:00 MDT, then goes offline and reads 08:00-08:15.
    const t1 = new Date(DAY1.getTime() + 4 * H);
    await asUser(u, t1, (c) => ingestAndSettle(c, phoneA.envelope(t1), []), { ensure: "manual" });
    const offline = phoneA.reading(new Date(DAY1.getTime() + 5 * H), new Date(DAY1.getTime() + 5 * H + 15 * MIN), 900);
    // Meanwhile B (iCloud Keychain shares the device credential) is online.
    const t2 = new Date(DAY1.getTime() + 6 * H);
    await asUser(u, t2, async () => 0, { headers: { "x-feast-boot-id": phoneB.bootId, "x-feast-mono-ms": String(phoneB.mono(t2)) } });
    const t3 = new Date(DAY1.getTime() + 7 * H);
    await asUser(u, t3, (c) => ingestAndSettle(c, phoneB.envelope(t3), []), { ensure: "manual" });
    // A comes back online at 11:00 MDT and uploads.
    const t4 = new Date(DAY1.getTime() + 8 * H);
    const r = await asUser(u, t4, (c) => ingestAndSettle(c, phoneA.envelope(t4), [offline]), { ensure: "manual" });
    expect(r.results[0]).toMatchObject({ status: "accepted", reason: null, scored: true });
    expect((await getPendingDay(await db(), u.userId))?.verifiedSeconds).toBe(900);

    // But a session of A's boot that ended before A's own last contact is backdated.
    const before = phoneA.reading(new Date(t1.getTime() - 30 * MIN), new Date(t1.getTime() - 10 * MIN), 1200);
    const r2 = await asUser(u, t4, (c) => ingestAndSettle(c, phoneA.envelope(t4), [before]), { ensure: "manual" });
    expect(r2.results[0]).toMatchObject({ status: "accepted", reason: "backdated", scored: false });
  });

  it("a fabricated unknown boot with past wall times after device contact is backdated", async () => {
    const u = await createOnboardedUser(T0);
    const dev = new FakeDevice(u.deviceId, "boot-real");
    const t = new Date(DAY1.getTime() + 8 * H);
    await asUser(u, t, (c) => ingestAndSettle(c, dev.envelope(t), []), { ensure: "manual" }); // device contact at t
    const later = new Date(t.getTime() + 2 * H);
    const fake = {
      ...dev.reading(new Date(t.getTime() - 60 * MIN), new Date(t.getTime() - 20 * MIN), 2400),
      boot_id: "boot-never-seen",
      mono_start_ms: 5_000,
      mono_end_ms: 5_000 + 40 * MIN,
    };
    const r = await asUser(u, later, (c) => ingestAndSettle(c, dev.envelope(later), [fake]), { ensure: "manual" });
    expect(r.results[0]).toMatchObject({ status: "accepted", reason: "backdated", scored: false });
    expect((await getPendingDay(await db(), u.userId))?.verifiedSeconds).toBe(0);
    // The boot is now recorded but has no contact of its own: later uploads still use the device rule.
    const again = { ...fake, id: randomUUID(), mono_start_ms: 5_000 + 41 * MIN, mono_end_ms: 5_000 + 50 * MIN, active_seconds: 500 };
    const r2 = await asUser(u, new Date(later.getTime() + MIN), (c) => ingestAndSettle(c, dev.envelope(new Date(later.getTime() + MIN)), [again]), { ensure: "manual" });
    expect(r2.results[0]).toMatchObject({ reason: "backdated", scored: false });
  });

  it("a backdated session (ended before the device's last contact) is history only", async () => {
    const u = await createOnboardedUser(T0);
    const dev = new FakeDevice(u.deviceId);
    const t = new Date(DAY1.getTime() + 6 * H);
    await asUser(u, t, async () => 0); // device contact at t
    const later = new Date(t.getTime() + 2 * H);
    const back = dev.reading(new Date(t.getTime() - 40 * MIN), new Date(t.getTime() - 20 * MIN), 1200);
    const r = await asUser(u, later, (c) => ingestAndSettle(c, dev.envelope(later), [back]), { ensure: "manual" });
    expect(r.results[0]).toMatchObject({ status: "accepted", reason: "backdated", scored: false });
    const pending = await getPendingDay(await db(), u.userId);
    expect(pending?.verifiedSeconds).toBe(0);
  });

  it("a self-report tapped at 09:59 and synced at 23:00 beats a 10:05 alarm; one tapped after it is refused", async () => {
    const u = await createOnboardedUser(T0);
    const dev = new FakeDevice(u.deviceId);
    await seedFiredAlarm("2026-10-13", new Date("2026-10-13T16:05:00Z"));
    const syncAt = new Date("2026-10-14T05:00:00Z"); // 23:00 MDT
    const ok = await asUser(u, syncAt, (c) => ingestAndSettle(c, dev.envelope(syncAt), [dev.selfReport(new Date("2026-10-13T15:59:00Z"))]), { ensure: "manual" });
    expect(ok.results[0]).toMatchObject({ status: "accepted", scored: true });
    const home = await asUser(u, syncAt, (c) => buildHome(c.tx, c.user, c.settings, c.cfg, c.now));
    expect(home.today?.status).toBe("safe");
    expect(home.today?.self_reported_at).toBe("2026-10-13T15:59:00.000Z");

    const u2 = await createOnboardedUser(T0);
    const dev2 = new FakeDevice(u2.deviceId);
    const bad = await asUser(u2, syncAt, (c) => ingestAndSettle(c, dev2.envelope(syncAt), [dev2.selfReport(new Date("2026-10-13T16:10:00Z"))]), { ensure: "manual" });
    expect(bad.results[0]).toMatchObject({ status: "rejected", reason: "self_report_after_alarm" });
    const dup = await asUser(u, syncAt, (c) => ingestAndSettle(c, dev.envelope(syncAt), [dev.selfReport(new Date("2026-10-13T15:58:00Z"))]), { ensure: "manual" });
    expect(dup.results[0]).toMatchObject({ status: "rejected", reason: "duplicate_self_report" });
  });

  it("a session ingested before its day exists is adopted (and split) when the day opens", async () => {
    const u = await createOnboardedUser(T0);
    const dev = new FakeDevice(u.deviceId);
    // Device offline across the rollover: 02:40-03:20 MDT on Oct 14 straddles day 1 / day 2.
    const start = new Date(DAY2.getTime() - 20 * MIN);
    const end = new Date(DAY2.getTime() + 20 * MIN);
    const now = new Date(DAY2.getTime() + 25 * MIN);
    const r = await asUser(u, now, (c) => ingestAndSettle(c, dev.envelope(now), [dev.reading(start, end, 2400)]), { ensure: "manual" });
    expect(r.results[0]).toMatchObject({ status: "accepted", scored: true, day_key: "2026-10-13" });
    const days = await daysOf(u.userId);
    expect(days.map((x) => [x.dayKey, x.result, x.verifiedSeconds])).toEqual([
      ["2026-10-13", "feast", 1200],
      ["2026-10-14", "pending", 1200],
    ]);
  });
});
