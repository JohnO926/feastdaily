import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/client";
import { dailyAlarms, deviceTokens, pushDeliveries, users } from "@/db/schema";
import { alarmWindowFor } from "@/lib/alarm";
import { testConfig } from "@/lib/config";
import { getPendingDay } from "@/services/days";
import { ingestAndSettle } from "@/services/sessions";
import { registerPushToken } from "@/services/users";
import {
  createAlarmRowCore,
  finalizePushCountsCore,
  fireAlarmCore,
  pushBatchCore,
  seedAlarmRow,
} from "@/workflows/alarm-core";
import { asUser, createOnboardedUser, FakeDevice, H, MIN, resetDb, type TestUser } from "./helpers";

const T0 = new Date("2026-10-12T16:00:00Z");
const DAY1 = new Date("2026-10-13T09:00:00Z");
const ALARM_DATE = "2026-10-13";
const FIRE = new Date("2026-10-13T20:47:00Z"); // 14:47 MDT

async function withToken(u: TestUser, now: Date) {
  await asUser(u, now, (c) => registerPushToken(c, { token: randomBytes(32).toString("hex"), environment: "sandbox" }));
}

describe("alarm workflow steps against Postgres", () => {
  beforeEach(() => resetDb());

  it("createAlarmRow picks inside the window, shrinks it when late, and is idempotent", async () => {
    const cfg = testConfig();
    const { start, end } = alarmWindowFor(ALARM_DATE, cfg);
    const early = await createAlarmRowCore(ALARM_DATE, new Date("2026-10-13T15:00:00Z"));
    const t = new Date(early.fire_at!).getTime();
    expect(t).toBeGreaterThanOrEqual(start.getTime());
    expect(t).toBeLessThan(end.getTime());
    const again = await createAlarmRowCore(ALARM_DATE, new Date("2026-10-13T15:00:00Z"));
    expect(again.fire_at).toBe(early.fire_at);

    const late = await createAlarmRowCore("2026-10-14", new Date("2026-10-15T01:00:00Z"));
    const lateT = new Date(late.fire_at!).getTime();
    expect(lateT).toBeGreaterThanOrEqual(new Date("2026-10-15T01:00:00Z").getTime());
    expect(lateT).toBeLessThan(alarmWindowFor("2026-10-14", cfg).end.getTime());

    const tooLate = await createAlarmRowCore("2026-10-15", new Date("2026-10-16T03:00:00Z")); // 21:00 MDT
    expect(tooLate.fire_at).toBeNull();
  });

  it("fire stamps open days once (safe_at_fire, counts); firing twice fires once; a replay still runs the push loop", async () => {
    const safe = await createOnboardedUser(T0);
    const exposed = await createOnboardedUser(T0);
    await withToken(safe, T0);
    await withToken(exposed, T0);
    const dev = new FakeDevice(safe.deviceId);
    // safe user reads 11 minutes in the morning
    const t = new Date("2026-10-13T15:00:00Z");
    await asUser(safe, t, (c) => ingestAndSettle(c, dev.envelope(t), [dev.reading(new Date(t.getTime() - 12 * MIN), new Date(t.getTime() - MIN), 660)]), { ensure: "manual" });
    // exposed user reads 5 minutes straddling the alarm (only 2.5 min before it counts)
    const edev = new FakeDevice(exposed.deviceId);
    const after = new Date(FIRE.getTime() + 3 * MIN);
    await asUser(exposed, after, (c) => ingestAndSettle(c, edev.envelope(after), [edev.reading(new Date(FIRE.getTime() - 150_000), new Date(FIRE.getTime() + 150_000), 300)]), { ensure: "manual" });

    await seedAlarmRow(ALARM_DATE, FIRE);
    const firedAt = new Date(FIRE.getTime() + 2_000); // the workflow woke 2 s late
    const first = await fireAlarmCore(ALARM_DATE, firedAt);
    expect(first).toMatchObject({ stamped: true, reader_count: 2, beat_count: 1, fired_at: firedAt.toISOString() });
    const second = await fireAlarmCore(ALARM_DATE, new Date(firedAt.getTime() + 5_000));
    expect(second).toMatchObject({ stamped: false, fired_at: firedAt.toISOString(), reader_count: 2, beat_count: 1 });

    const d = await db();
    const sp = await getPendingDay(d, safe.userId);
    const ep = await getPendingDay(d, exposed.userId);
    expect(sp).toMatchObject({ alarmAt: FIRE, safeAtFire: true, verifiedBeforeAlarmSeconds: 660 });
    expect(ep).toMatchObject({ alarmAt: FIRE, safeAtFire: false, verifiedBeforeAlarmSeconds: 150 });

    // Replay: fire returned stamped=false, the workflow still runs the fan-out.
    const batch = await pushBatchCore(ALARM_DATE, null, 500, new Date(firedAt.getTime() + 10_000));
    expect(batch).toMatchObject({ candidates: 2, claimed: 2, dry_run: 2, next_cursor: null });
    expect(batch.by_variant).toEqual({ safe: 1, alarm: 1, moment: 0 });
    const counts = await finalizePushCountsCore(ALARM_DATE);
    expect(counts).toMatchObject({ dry_run: 2, safe: 1, alarm: 1 });
    const [row] = await d.select().from(dailyAlarms).where(eq(dailyAlarms.alarmDate, ALARM_DATE));
    expect(row.pushDryRun).toBe(2);
    // A second batch finds nothing left to send.
    expect((await pushBatchCore(ALARM_DATE, null, 500, new Date(firedAt.getTime() + 20_000))).claimed).toBe(0);
  });

  it("users outside the alarm's window get the moment variant", async () => {
    const tokyo = await createOnboardedUser(T0, { tz: "Asia/Tokyo" });
    await withToken(tokyo, T0);
    // Tokyo day 1 is Oct 13 03:00 JST -> Oct 14 03:00 JST = Oct 12 18:00Z..Oct 13 18:00Z: 20:47Z is outside it.
    await seedAlarmRow(ALARM_DATE, FIRE);
    await fireAlarmCore(ALARM_DATE, FIRE);
    const batch = await pushBatchCore(ALARM_DATE, null, 500, FIRE);
    expect(batch.by_variant).toEqual({ safe: 0, alarm: 0, moment: 1 });
  });

  it("a pushBatch retry resends only rows still 'sending' for over a minute", async () => {
    const us = await Promise.all([0, 1, 2, 3].map(() => createOnboardedUser(T0)));
    for (const u of us) await withToken(u, T0);
    await seedAlarmRow(ALARM_DATE, FIRE);
    await fireAlarmCore(ALARM_DATE, FIRE);
    const now = new Date(FIRE.getTime() + 10 * MIN);
    const d = await db();
    const [a, b, c, e] = us;
    await d.insert(pushDeliveries).values([
      { alarmDate: ALARM_DATE, userId: a.userId, variant: "alarm", status: "sent", createdAt: new Date(now.getTime() - 5 * MIN), sentAt: now, apnsStatus: "200" },
      { alarmDate: ALARM_DATE, userId: b.userId, variant: "alarm", status: "sending", createdAt: new Date(now.getTime() - 2 * MIN) },
      { alarmDate: ALARM_DATE, userId: e.userId, variant: "alarm", status: "sending", createdAt: new Date(now.getTime() - 10_000) },
    ]);
    const batch = await pushBatchCore(ALARM_DATE, null, 500, now);
    expect(batch.claimed).toBe(2); // b (stuck) and c (never attempted)
    const rowsNow = await d.select().from(pushDeliveries).where(eq(pushDeliveries.alarmDate, ALARM_DATE));
    const status = Object.fromEntries(rowsNow.map((r) => [r.userId, r.status]));
    expect(status[a.userId]).toBe("sent");
    expect(status[b.userId]).toBe("dry_run");
    expect(status[c.userId]).toBe("dry_run");
    expect(status[e.userId]).toBe("sending"); // in flight elsewhere, not re-sent
  });

  it("users not seen within active_reader_window_days get no push and do not count as readers", async () => {
    const stale = await createOnboardedUser(T0);
    await withToken(stale, T0);
    const d = await db();
    await d.update(users).set({ lastSeenAt: new Date(FIRE.getTime() - 8 * 24 * H) }).where(eq(users.id, stale.userId));
    await seedAlarmRow(ALARM_DATE, FIRE);
    const fired = await fireAlarmCore(ALARM_DATE, FIRE);
    expect(fired).toMatchObject({ reader_count: 0, beat_count: 0 });
    expect((await pushBatchCore(ALARM_DATE, null, 500, FIRE)).candidates).toBe(0);
    const tokens = await d.select().from(deviceTokens).where(sql`${deviceTokens.userId} = ${stale.userId}`);
    expect(tokens).toHaveLength(1);
  });
});
