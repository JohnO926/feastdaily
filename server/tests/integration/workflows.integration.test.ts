import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getRun, start } from "workflow/api";
import { waitForSleep } from "@workflow/vitest";
import { db } from "@/db/client";
import { dailyAlarms, jobRuns, pushDeliveries } from "@/db/schema";
import { alarmDateFor } from "@/lib/alarm";
import { testConfig } from "@/lib/config";
import { ingestAndSettle } from "@/services/sessions";
import { registerPushToken } from "@/services/users";
import { alarmWorkflow } from "@/workflows/alarm";
import { rolloverWorkflow } from "@/workflows/rollover";
import { seedAlarmRow } from "@/workflows/alarm-core";
import { asUser, createOnboardedUser, daysOf, FakeDevice, H, MIN, resetDb, rows } from "../db/helpers";

/** Moves a freshly onboarded user's day 0 so that it is open now: [now - 2 h, now + 22 h]. */
async function openDayNow(userId: string, now: Date) {
  const d = await db();
  const start = new Date(now.getTime() - 2 * H);
  await d.execute(sql`update daily_results set window_start = ${start}, window_end = ${new Date(start.getTime() + 24 * H)} where user_id = ${userId}`);
  await d.execute(sql`update users set first_day_starts_at = ${start} where id = ${userId}`);
}

describe("alarmWorkflow (in-process Local World)", () => {
  beforeEach(() => resetDb());

  it("sleeps until fire_at, then stamps fired_at, counts beat/readers and records dry-run deliveries", async () => {
    const now = new Date();
    const alarmDate = alarmDateFor(now, testConfig());
    const fireAt = new Date(now.getTime() + 60 * MIN);

    const safe = await createOnboardedUser(new Date(now.getTime() - 3 * H));
    const exposed = await createOnboardedUser(new Date(now.getTime() - 3 * H));
    for (const u of [safe, exposed]) await openDayNow(u.userId, now);
    // Upload first: a session that ended before the device's last contact would be "backdated".
    const dev = new FakeDevice(safe.deviceId);
    await asUser(
      safe,
      now,
      (c) => ingestAndSettle(c, dev.envelope(now), [dev.reading(new Date(now.getTime() - 20 * MIN), new Date(now.getTime() - 5 * MIN), 900)]),
      { ensure: "manual" },
    );
    for (const u of [safe, exposed]) {
      await asUser(u, now, (c) => registerPushToken(c, { token: randomBytes(32).toString("hex"), environment: "sandbox" }));
    }
    await seedAlarmRow(alarmDate, fireAt);

    const run = await start(alarmWorkflow, [alarmDate]);
    const sleepId = await waitForSleep(run);
    // Still asleep: nothing fired yet.
    const d = await db();
    let [alarm] = await d.select().from(dailyAlarms).where(eq(dailyAlarms.alarmDate, alarmDate));
    expect(alarm.firedAt).toBeNull();
    expect(alarm.workflowRunId).toBe(run.runId);

    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });
    const result = await run.returnValue;
    expect(result).toMatchObject({ alarm_date: alarmDate, fired: true, reader_count: 2, beat_count: 1 });
    expect(result.pushes).toMatchObject({ dry_run: 2, safe: 1, alarm: 1, sent: 0, failed: 0 });

    [alarm] = await d.select().from(dailyAlarms).where(eq(dailyAlarms.alarmDate, alarmDate));
    expect(alarm.firedAt).not.toBeNull();
    expect(alarm).toMatchObject({ beatCount: 1, readerCount: 2, pushDryRun: 2 });
    const deliveries = await d.select().from(pushDeliveries).where(eq(pushDeliveries.alarmDate, alarmDate));
    expect(deliveries.map((x) => x.status).sort()).toEqual(["dry_run", "dry_run"]);
    const [day] = await daysOf(safe.userId);
    expect(day.alarmAt?.toISOString()).toBe(fireAt.toISOString()); // scoring uses the scheduled instant
    expect(day.safeAtFire).toBe(true);
  });
});

describe("rolloverWorkflow (in-process Local World)", () => {
  beforeEach(() => resetDb());

  it("ticks once: closes a due day, then sleeps an hour", async () => {
    const now = new Date();
    // Keep the alarm self-heal quiet: pretend today's alarm run is already recorded.
    const d = await db();
    await d.insert(jobRuns).values({ name: "alarm", runDate: alarmDateFor(now, testConfig()), startedAt: now, workflowRunId: "wrun_test" });
    const u = await createOnboardedUser(new Date(now.getTime() - 3 * 24 * H));
    // Make day 0 due: it ended an hour ago.
    const dayStart = new Date(now.getTime() - 25 * H);
    await d.execute(sql`update daily_results set window_start = ${dayStart}, window_end = ${new Date(dayStart.getTime() + 24 * H)} where user_id = ${u.userId}`);
    await d.execute(sql`update users set first_day_starts_at = ${dayStart} where id = ${u.userId}`);

    const run = await start(rolloverWorkflow, [now.toISOString().slice(0, 10)]);
    await waitForSleep(run);
    const days = await daysOf(u.userId);
    expect(days.map((x) => x.result)).toEqual(["missed", "pending"]);
    const stats = await rows<{ total_missed: number }>(sql`select total_missed from user_stats where user_id = ${u.userId}`);
    expect(stats[0].total_missed).toBe(1);
    await getRun(run.runId).cancel();
  });
});
