import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { dailyResults, scoringConfig } from "@/db/schema";
import { withUser, type UserCtx, type WithUserOptions } from "@/lib/auth";
import { DEFAULT_CONFIG, invalidateConfigCache, type ScoringConfig } from "@/lib/config";
import type { ClientSession } from "@/lib/sessions";
import { onboard, registerDevice } from "@/services/users";

const TABLES = [
  "push_deliveries",
  "device_tokens",
  "missed_meals",
  "user_stats",
  "reading_sessions",
  "daily_results",
  "device_boots",
  "device_credentials",
  "user_settings",
  "users",
  "daily_alarms",
  "job_runs",
  "rate_limits",
];

export async function resetDb(cfg: Partial<ScoringConfig> = {}): Promise<void> {
  const d = await db();
  await d.execute(sql.raw(`truncate table ${TABLES.join(", ")} restart identity cascade`));
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  for (const [key, value] of Object.entries(merged)) {
    await d
      .insert(scoringConfig)
      .values({ key, value })
      .onConflictDoUpdate({ target: scoringConfig.key, set: { value } });
  }
  invalidateConfigCache();
}

export async function setConfig(cfg: Partial<ScoringConfig>): Promise<void> {
  const d = await db();
  for (const [key, value] of Object.entries(cfg)) {
    await d.insert(scoringConfig).values({ key, value }).onConflictDoUpdate({ target: scoringConfig.key, set: { value } });
  }
  invalidateConfigCache();
}

export interface TestUser {
  userId: string;
  deviceId: string;
  secret: string;
  token: string;
}

export function authedRequest(token: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; url?: string } = {}) {
  return new Request(init.url ?? "http://localhost/api/test", {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

export async function registerUser(now: Date): Promise<TestUser> {
  const deviceId = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const r = await registerDevice(deviceId, secret, now);
  return { userId: r.user_id, deviceId, secret, token: r.token };
}

export function asUser<T>(
  u: TestUser,
  now: Date,
  fn: (c: UserCtx) => Promise<T>,
  opts: Omit<WithUserOptions, "now"> & { headers?: Record<string, string> } = {},
) {
  const { headers, ...rest } = opts;
  return withUser(authedRequest(u.token, { headers }), fn, { ...rest, now });
}

export async function createOnboardedUser(
  now: Date,
  o: { tz?: string; rollover_hour?: number; goal_seconds?: number } = {},
): Promise<TestUser> {
  const u = await registerUser(now);
  await asUser(u, now, (c) =>
    onboard(c, {
      tz: o.tz ?? "America/Denver",
      rollover_hour: o.rollover_hour ?? 3,
      goal_seconds: o.goal_seconds ?? 600,
      reminder_enabled: false,
      reminder_local_time: null,
    }),
  );
  return u;
}

export async function rows<T = Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T[]> {
  const d = await db();
  const r = await d.execute(query);
  return r.rows as T[];
}

export async function daysOf(userId: string) {
  const d = await db();
  return d.select().from(dailyResults).where(sql`${dailyResults.userId} = ${userId}`).orderBy(dailyResults.dayKey);
}

/** A simulated device: monotonic ms since a fixed boot instant, so anchoring is exact. */
export class FakeDevice {
  constructor(
    public deviceId: string,
    public bootId = `boot-${randomUUID()}`,
    public bootInstant = new Date("2026-09-01T00:00:00Z"),
  ) {}
  mono(t: Date): number {
    return t.getTime() - this.bootInstant.getTime();
  }
  envelope(now: Date) {
    return {
      device_id: this.deviceId,
      boot_id: this.bootId,
      client_now_wall: now,
      client_now_mono_ms: this.mono(now),
    };
  }
  reading(start: Date, end: Date, active: number, over: Partial<ClientSession> = {}): ClientSession {
    return {
      id: randomUUID(),
      source: "reader",
      boot_id: this.bootId,
      started_at_wall: start,
      ended_at_wall: end,
      mono_start_ms: this.mono(start),
      mono_end_ms: this.mono(end),
      active_seconds: active,
      content_ref: "bom/1-ne/1",
      ...over,
    };
  }
  selfReport(tap: Date): ClientSession {
    return this.reading(tap, tap, 0, { source: "self_report", content_ref: null });
  }
}

export const H = 3_600_000;
export const D = 24 * H;
export const MIN = 60_000;
