// Route handlers called directly with Request objects (no server), with Date faked so the
// flow can move past the first rollover.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as deleteAccount } from "@/app/api/v1/account/route";
import { GET as alarmToday } from "@/app/api/v1/alarm/today/route";
import { POST as register } from "@/app/api/v1/auth/register/route";
import { GET as devAlarm } from "@/app/api/v1/dev/today-alarm/route";
import { POST as devices } from "@/app/api/v1/devices/route";
import { GET as history } from "@/app/api/v1/history/route";
import { GET as home } from "@/app/api/v1/home/route";
import { POST as onboarding } from "@/app/api/v1/onboarding/route";
import { POST as sessions } from "@/app/api/v1/sessions/route";
import { PATCH as settings } from "@/app/api/v1/settings/route";
import { NextRequest } from "next/server";
import { seedAlarmRow, fireAlarmCore } from "@/workflows/alarm-core";
import { FakeDevice, MIN, resetDb, rows } from "./helpers";
import { sql } from "drizzle-orm";

function at(iso: string) {
  vi.setSystemTime(new Date(iso));
  return new Date(iso);
}

function call(token: string | null, url: string, method: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest(new URL(url, "http://localhost:3000"), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function body(res: Response) {
  return { status: res.status, json: await res.json() };
}

describe("HTTP flow (route handlers)", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await resetDb();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("register -> onboarding -> two sessions crossing the goal -> GET /home is safe", async () => {
    at("2026-10-12T16:00:00.000Z");
    const deviceId = randomUUID();
    const secret = randomBytes(32).toString("hex");
    const reg = await body(await register(call(null, "/api/v1/auth/register", "POST", { device_id: deviceId, device_secret: secret })));
    expect(reg.status).toBe(201);
    expect(reg.json).toMatchObject({ created: true });
    const token = reg.json.token as string;

    const again = await body(await register(call(null, "/api/v1/auth/register", "POST", { device_id: deviceId, device_secret: secret })));
    expect(again).toMatchObject({ status: 200, json: { user_id: reg.json.user_id, created: false } });
    const wrong = await body(await register(call(null, "/api/v1/auth/register", "POST", { device_id: deviceId, device_secret: "x".repeat(64) })));
    expect(wrong.status).toBe(401);

    const h0 = await body(await home(call(token, "/api/v1/home", "GET")));
    expect(h0.json).toMatchObject({ onboarded: false, today: null, settings: null });

    const ob = await body(
      await onboarding(
        call(token, "/api/v1/onboarding", "POST", {
          tz: "America/Denver",
          rollover_hour: 3,
          goal_seconds: 600,
          reminder_enabled: true,
          reminder_local_time: "07:30",
        }),
      ),
    );
    expect(ob.status).toBe(200);
    expect(ob.json.first_day_starts_at).toBe("2026-10-13T09:00:00.000Z");
    expect(ob.json.home.today).toMatchObject({ day_key: "2026-10-13", status: "not_started" });
    expect(ob.json.settings).toEqual({
      tz: "America/Denver",
      rollover_hour: 3,
      goal_seconds: 600,
      pending_goal_seconds: null,
      reminder_enabled: true,
      reminder_local_time: "07:30",
    });

    // Day 1, 07:00 MDT
    const now = at("2026-10-13T13:00:00.000Z");
    const dev = new FakeDevice(deviceId);
    const s1 = dev.reading(new Date(now.getTime() - 60 * MIN), new Date(now.getTime() - 54 * MIN), 330);
    const s2 = dev.reading(new Date(now.getTime() - 10 * MIN), new Date(now.getTime() - 4 * MIN), 330);
    const env = dev.envelope(now);
    const post = await body(
      await sessions(
        call(token, "/api/v1/sessions", "POST", {
          ...env,
          client_now_wall: env.client_now_wall.toISOString(),
          sessions: [s1, s2].map((s) => ({
            ...s,
            started_at_wall: s.started_at_wall.toISOString(),
            ended_at_wall: s.ended_at_wall.toISOString(),
          })),
        }),
      ),
    );
    expect(post.status).toBe(200);
    expect(post.json.results).toEqual([
      { id: s1.id, status: "accepted", reason: null, day_key: "2026-10-13", scored: true },
      { id: s2.id, status: "accepted", reason: null, day_key: "2026-10-13", scored: true },
    ]);
    const h = await body(await home(call(token, "/api/v1/home", "GET")));
    expect(h.json.today).toMatchObject({
      status: "safe",
      verified_seconds: 660,
      verified_before_alarm_seconds: 660,
      goal_seconds: 600,
      goal_reached_at: new Date(s2.started_at_wall.getTime() + (270 / 330) * 6 * MIN).toISOString(),
    });

    // Goal change mid-day -> pending, applies tomorrow
    const st = await body(await settings(call(token, "/api/v1/settings", "PATCH", { goal_seconds: 900 })));
    expect(st.json.settings).toMatchObject({ goal_seconds: 600, pending_goal_seconds: 900 });
    expect(st.json.home.today.goal_seconds).toBe(600);
    const badReminder = await body(await settings(call(token, "/api/v1/settings", "PATCH", { reminder_local_time: "02:00" })));
    expect(badReminder).toMatchObject({ status: 400, json: { error: { code: "invalid_reminder_time" } } });
    const badGoal = await body(await settings(call(token, "/api/v1/settings", "PATCH", { goal_seconds: 310 })));
    expect(badGoal).toMatchObject({ status: 400, json: { error: { code: "invalid_request" } } });

    // History
    at("2026-10-15T13:00:00.000Z");
    const hist = await body(await history(call(token, "/api/v1/history?from=2026-10-12&to=2026-10-15", "GET")));
    expect(hist.status).toBe(200);
    expect(hist.json.days.map((d: { day_key: string; result: string }) => [d.day_key, d.result])).toEqual([
      ["2026-10-13", "feast"],
      ["2026-10-14", "missed"],
      ["2026-10-15", "pending"],
    ]);
    expect(hist.json.days[0].sessions).toHaveLength(2);
    expect(hist.json.days[1].goal_seconds).toBe(900);

    // Push token, then delete the account
    const dv = await body(await devices(call(token, "/api/v1/devices", "POST", { token: "ab".repeat(32), environment: "sandbox" })));
    expect(dv.json.device).toMatchObject({ device_id: deviceId, environment: "sandbox", token_suffix: "abababab" });
    const del = await body(await deleteAccount(call(token, "/api/v1/account", "DELETE")));
    expect(del.json).toEqual({ deleted: true, user_id: reg.json.user_id });
    const left = await rows<{ n: string }>(sql`select count(*) as n from reading_sessions`);
    expect(Number(left[0].n)).toBe(0);
    const after = await body(await home(call(token, "/api/v1/home", "GET")));
    expect(after.status).toBe(401);
  });

  it("GET /home and /alarm/today never contain fire_at before the alarm fires", async () => {
    at("2026-10-13T15:00:00.000Z");
    const reg = await body(
      await register(call(null, "/api/v1/auth/register", "POST", { device_id: randomUUID(), device_secret: randomBytes(32).toString("hex") })),
    );
    const token = reg.json.token;
    await onboarding(call(token, "/api/v1/onboarding", "POST", { tz: "America/Denver", goal_seconds: 120 }));
    const fire = new Date("2026-10-13T21:12:34.567Z");
    await seedAlarmRow("2026-10-13", fire);

    const h = await (await home(call(token, "/api/v1/home", "GET"))).text();
    const a = await (await alarmToday(call(token, "/api/v1/alarm/today", "GET"))).text();
    for (const text of [h, a]) {
      expect(text).not.toContain("fire_at");
      expect(text).not.toContain("21:12:34");
    }
    expect(JSON.parse(a)).toEqual({
      alarm_date: "2026-10-13",
      fired: false,
      fired_at: null,
      beat_count: null,
      reader_count: null,
      beat_pct: null,
    });

    // The dev reveal route (DEV_REVEAL_ALARM=true in tests) is the only one that shows it.
    const dv = await body(await devAlarm(call(token, "/api/v1/dev/today-alarm", "GET")));
    expect(dv.json.fire_at).toBe(fire.toISOString());

    at("2026-10-13T21:12:40.000Z");
    await fireAlarmCore("2026-10-13", new Date("2026-10-13T21:12:40.000Z"));
    const fired = await body(await alarmToday(call(token, "/api/v1/alarm/today", "GET")));
    expect(fired.json).toMatchObject({ fired: true, fired_at: "2026-10-13T21:12:40.000Z", reader_count: 0, beat_count: 0, beat_pct: null });
  });

  it("rejects requests without a valid token and validates bodies", async () => {
    at("2026-10-13T15:00:00.000Z");
    expect((await home(call(null, "/api/v1/home", "GET"))).status).toBe(401);
    expect((await home(call("garbage", "/api/v1/home", "GET"))).status).toBe(401);
    const bad = await body(await register(call(null, "/api/v1/auth/register", "POST", { device_id: "nope" })));
    expect(bad).toMatchObject({ status: 400, json: { error: { code: "invalid_request" } } });
  });
});
