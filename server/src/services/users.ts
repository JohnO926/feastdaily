// Registration, onboarding, settings, push tokens and account deletion (B3, B9).
import { and, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db/client";
import { deviceCredentials, deviceTokens, rateLimits, users, userSettings, type UserSettingsRow } from "@/db/schema";
import { hashSecret, secretMatches, signToken, type UserCtx } from "@/lib/auth";
import { nextRollover } from "@/lib/day";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { getPendingDay, openDayAt, recomputeDay, rescheduleOpenDay } from "./days";

/** Fixed-window per-key limiter in Postgres (one row per key per hour). */
export async function checkRateLimit(key: string, limit: number, now: Date): Promise<void> {
  const windowStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const database = await db();
  const [row] = await database
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });
  // opportunistic cleanup of old windows
  if (row.count === 1) {
    await database.delete(rateLimits).where(sql`${rateLimits.windowStart} < ${new Date(windowStart.getTime() - 86_400_000)}`);
  }
  if (row.count > limit) throw new HttpError(429, "rate_limited", "Too many registrations from this address; try later");
}

export interface RegisterResult {
  user_id: string;
  token: string;
  token_expires_at: string;
  created: boolean;
}

/** POST /auth/register: same device key -> same user; unknown key -> new user + credential. */
export async function registerDevice(deviceId: string, deviceSecret: string, now: Date): Promise<RegisterResult> {
  const database = await db();
  const out = await database.transaction(async (tx) => {
    const [cred] = await tx.select().from(deviceCredentials).where(eq(deviceCredentials.deviceId, deviceId)).for("update");
    if (cred) {
      if (cred.revokedAt || !secretMatches(deviceSecret, cred.secretHash)) {
        throw new HttpError(401, "invalid_credentials", "Device id is registered with a different secret");
      }
      await tx.update(deviceCredentials).set({ lastSeenAt: now }).where(eq(deviceCredentials.deviceId, deviceId));
      return { userId: cred.userId, created: false };
    }
    const [user] = await tx.insert(users).values({ createdAt: now, lastSeenAt: now }).returning({ id: users.id });
    await tx.insert(deviceCredentials).values({
      deviceId,
      userId: user.id,
      secretHash: hashSecret(deviceSecret),
      createdAt: now,
      lastSeenAt: now,
    });
    return { userId: user.id, created: true };
  });
  const { token, expiresAt } = await signToken(out.userId, deviceId, now);
  return { user_id: out.userId, token, token_expires_at: expiresAt.toISOString(), created: out.created };
}

export { isValidGoal } from "@/lib/goal";

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export interface SettingsPatch {
  tz?: string;
  rollover_hour?: number;
  goal_seconds?: number;
  reminder_enabled?: boolean;
  reminder_local_time?: string | null;
}

function validateReminder(rolloverHour: number, reminder: string | null | undefined) {
  if (reminder && minutesOf(reminder) < rolloverHour * 60) {
    throw new HttpError(400, "invalid_reminder_time", "reminder_local_time must be at or after the rollover hour");
  }
}

/**
 * Settings change rules: goal -> applied directly to a pending day that has not started yet
 * (day 0), otherwise stored as pending_goal_seconds (applies at the next rollover);
 * tz / rollover_hour -> reschedule the open day immediately.
 */
export async function applySettings(ctx: UserCtx, patch: SettingsPatch): Promise<UserSettingsRow> {
  const { tx, user, now, cfg } = ctx;
  const current = ctx.settings;
  if (!current) throw new HttpError(409, "not_onboarded", "Complete onboarding first");
  const next: UserSettingsRow = { ...current };
  if (patch.tz !== undefined) next.tz = patch.tz;
  if (patch.rollover_hour !== undefined) next.rolloverHour = patch.rollover_hour;
  if (patch.reminder_enabled !== undefined) next.reminderEnabled = patch.reminder_enabled;
  if (patch.reminder_local_time !== undefined) next.reminderLocalTime = patch.reminder_local_time;
  validateReminder(next.rolloverHour, next.reminderLocalTime ? next.reminderLocalTime.slice(0, 5) : null);

  const pending = await getPendingDay(tx, user.id);
  let goalChangedOnPendingDay = false;
  if (patch.goal_seconds !== undefined) {
    const g = patch.goal_seconds;
    if (pending && pending.windowStart.getTime() > now.getTime()) {
      next.goalSeconds = g;
      next.pendingGoalSeconds = null;
      goalChangedOnPendingDay = true;
    } else if (pending) {
      next.pendingGoalSeconds = g === next.goalSeconds ? null : g;
    } else {
      next.goalSeconds = g;
      next.pendingGoalSeconds = null;
    }
  }
  next.updatedAt = now;
  await tx
    .update(userSettings)
    .set({
      tz: next.tz,
      rolloverHour: next.rolloverHour,
      goalSeconds: next.goalSeconds,
      pendingGoalSeconds: next.pendingGoalSeconds,
      reminderEnabled: next.reminderEnabled,
      reminderLocalTime: next.reminderLocalTime,
      updatedAt: now,
    })
    .where(eq(userSettings.userId, user.id));
  ctx.settings = next;

  if (pending && goalChangedOnPendingDay) {
    await tx.execute(sql`update daily_results set goal_seconds = ${next.goalSeconds} where id = ${pending.id}`);
    await recomputeDay(tx, pending.id);
  }
  if (next.tz !== current.tz || next.rolloverHour !== current.rolloverHour) {
    await rescheduleOpenDay(tx, user, next, now, cfg);
  }
  return next;
}

export interface OnboardingInput {
  tz: string;
  rollover_hour: number;
  goal_seconds: number;
  reminder_enabled: boolean;
  reminder_local_time: string | null;
}

/**
 * POST /onboarding: sets onboarded_at, first_day_starts_at = next rollover, and inserts the
 * first pending day in the same transaction. Idempotent: an onboarded user only gets a
 * settings update.
 */
export async function onboard(ctx: UserCtx, input: OnboardingInput): Promise<void> {
  const { tx, user, now, cfg } = ctx;
  if (user.onboardedAt && ctx.settings) {
    await applySettings(ctx, input);
    return;
  }
  validateReminder(input.rollover_hour, input.reminder_local_time);
  const values = {
    tz: input.tz,
    rolloverHour: input.rollover_hour,
    goalSeconds: input.goal_seconds,
    pendingGoalSeconds: null,
    reminderEnabled: input.reminder_enabled,
    reminderLocalTime: input.reminder_local_time,
    updatedAt: now,
  };
  const [settings] = await tx
    .insert(userSettings)
    .values({ userId: user.id, ...values })
    .onConflictDoUpdate({ target: userSettings.userId, set: values })
    .returning();
  const firstDay = nextRollover(input.tz, input.rollover_hour, now);
  await tx.update(users).set({ onboardedAt: now, firstDayStartsAt: firstDay }).where(eq(users.id, user.id));
  user.onboardedAt = now;
  user.firstDayStartsAt = firstDay;
  ctx.settings = settings;
  await openDayAt(tx, user.id, settings, firstDay, null, cfg);
}

export interface DeviceTokenInput {
  token: string;
  environment: "sandbox" | "production";
}

export async function registerPushToken(ctx: UserCtx, input: DeviceTokenInput) {
  const { tx, user, deviceId, now } = ctx;
  const token = input.token.toLowerCase();
  // A token moves with the physical device: drop it from any other user/device first.
  await tx
    .delete(deviceTokens)
    .where(and(eq(deviceTokens.token, token), sql`(${deviceTokens.userId}, ${deviceTokens.deviceId}) <> (${user.id}, ${deviceId})`));
  const [row] = await tx
    .insert(deviceTokens)
    .values({ userId: user.id, deviceId, token, environment: input.environment, lastSeenAt: now })
    .onConflictDoUpdate({
      target: [deviceTokens.userId, deviceTokens.deviceId],
      set: { token, environment: input.environment, lastSeenAt: now, invalidatedAt: null },
    })
    .returning();
  return row;
}

/** DELETE /account: deletes the user row; everything else cascades. */
export async function deleteAccount(tx: Tx, userId: string): Promise<void> {
  await tx.delete(users).where(eq(users.id, userId));
}

