// zod schemas for every request body (B9: all request bodies validated with zod).
import { z } from "zod";
import { isValidTimeZone } from "./day";
import { isValidGoal } from "./goal";

const isoInstant = z.iso.datetime({ offset: true, precision: undefined }).transform((s) => new Date(s));
const tz = z.string().min(1).max(64).refine(isValidTimeZone, { message: "Unknown IANA time zone" });
const rolloverHour = z.number().int().min(0).max(9);
const goal = z
  .number()
  .int()
  .refine(isValidGoal, { message: "goal_seconds must be 45..300 in 15 s steps or 300..2700 in 60 s steps" });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM (24 h)");

export const registerSchema = z.object({
  device_id: z.uuid(),
  device_secret: z.string().min(32).max(256),
});

export const onboardingSchema = z.object({
  tz,
  rollover_hour: rolloverHour.default(3),
  goal_seconds: goal,
  reminder_enabled: z.boolean().default(false),
  reminder_local_time: hhmm.nullable().default(null),
});

export const settingsPatchSchema = z
  .object({
    tz: tz.optional(),
    rollover_hour: rolloverHour.optional(),
    goal_seconds: goal.optional(),
    reminder_enabled: z.boolean().optional(),
    reminder_local_time: hhmm.nullable().optional(),
  })
  .strict();

export const sessionSchema = z.object({
  id: z.uuid(),
  source: z.enum(["reader", "self_report", "audio"]),
  boot_id: z.string().min(1).max(128),
  started_at_wall: isoInstant,
  ended_at_wall: isoInstant,
  mono_start_ms: z.number().int().nonnegative(),
  mono_end_ms: z.number().int().nonnegative(),
  active_seconds: z.number().int().nonnegative(),
  content_ref: z.string().max(200).nullable().optional().default(null),
});

export const sessionsEnvelopeSchema = z.object({
  device_id: z.uuid(),
  boot_id: z.string().min(1).max(128),
  client_now_wall: isoInstant,
  client_now_mono_ms: z.number().int().nonnegative(),
  sessions: z.array(sessionSchema).max(200),
});

export const devicesSchema = z.object({
  token: z.string().regex(/^[0-9a-fA-F]{64,200}$/, "APNs device token as hex"),
  environment: z.enum(["sandbox", "production"]),
});

const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
export const historyQuerySchema = z.object({
  from: dayKeySchema.optional(),
  to: dayKeySchema.optional(),
});

export const adminAlarmDateSchema = z.object({ alarm_date: dayKeySchema.optional() });
