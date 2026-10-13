import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// All instants are timestamptz with millisecond precision (JS Date resolution).
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: "date" });

export const dayResultEnum = pgEnum("day_result", ["pending", "feast", "missed"]);
export const sessionSourceEnum = pgEnum("session_source", ["reader", "self_report", "audio"]);
export const apnsEnvEnum = pgEnum("apns_env", ["sandbox", "production"]);
export const pushVariantEnum = pgEnum("push_variant", ["alarm", "safe", "moment"]);
export const pushStatusEnum = pgEnum("push_status", ["sending", "sent", "failed", "dry_run"]);

export const scoringConfig = pgTable("scoring_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  clientVisible: boolean("client_visible").notNull().default(false),
  description: text("description"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  appleSub: text("apple_sub").unique(),
  createdAt: ts("created_at").notNull(),
  lastSeenAt: ts("last_seen_at").notNull(),
  dormantSince: ts("dormant_since"),
  onboardedAt: ts("onboarded_at"),
  firstDayStartsAt: ts("first_day_starts_at"),
});

export const deviceCredentials = pgTable(
  "device_credentials",
  {
    deviceId: uuid("device_id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secretHash: text("secret_hash").notNull(),
    createdAt: ts("created_at").notNull(),
    // Device-level "last contact": the reference for the no-backdating rule (B5 check 2c).
    lastSeenAt: ts("last_seen_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("device_credentials_user_idx").on(t.userId)],
);

export const deviceBoots = pgTable(
  "device_boots",
  {
    deviceId: uuid("device_id")
      .notNull()
      .references(() => deviceCredentials.deviceId, { onDelete: "cascade" }),
    bootId: text("boot_id").notNull(),
    // min observed (received_at - client_now_mono): server instant = mono_ms + anchor_offset_ms
    anchorOffsetMs: bigint("anchor_offset_ms", { mode: "number" }).notNull(),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    lastSeenMonoMs: bigint("last_seen_mono_ms", { mode: "number" }).notNull(),
    // Last non-passive request carrying this boot (envelope boot_id or X-Feast-Boot-Id): the
    // per-boot no-backdating reference. Null for a boot only seen through an uploaded session.
    lastContactAt: ts("last_contact_at"),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.bootId] })],
);

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  tz: text("tz").notNull(),
  rolloverHour: smallint("rollover_hour").notNull(),
  goalSeconds: integer("goal_seconds").notNull(),
  pendingGoalSeconds: integer("pending_goal_seconds"),
  reminderEnabled: boolean("reminder_enabled").notNull().default(false),
  reminderLocalTime: time("reminder_local_time"),
  updatedAt: ts("updated_at").notNull(),
});

export const dailyResults = pgTable(
  "daily_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dayKey: date("day_key", { mode: "string" }).notNull(),
    windowStart: ts("window_start").notNull(),
    windowEnd: ts("window_end").notNull(),
    tzAtOpen: text("tz_at_open").notNull(),
    rolloverHourAtOpen: smallint("rollover_hour_at_open").notNull(),
    goalSeconds: integer("goal_seconds").notNull(),
    verifiedSeconds: integer("verified_seconds").notNull().default(0),
    verifiedBeforeAlarmSeconds: integer("verified_before_alarm_seconds").notNull().default(0),
    goalReachedAt: ts("goal_reached_at"),
    selfReportedAt: ts("self_reported_at"),
    alarmAt: ts("alarm_at"),
    safeAtFire: boolean("safe_at_fire"),
    result: dayResultEnum("result").notNull().default("pending"),
    closedAt: ts("closed_at"),
    deadlineAt: ts("deadline_at"),
    rescoredAt: ts("rescored_at"),
  },
  (t) => [
    uniqueIndex("daily_results_user_day_key").on(t.userId, t.dayKey),
    uniqueIndex("daily_results_one_pending").on(t.userId).where(sql`${t.result} = 'pending'`),
    index("daily_results_pending_end_idx").on(t.windowEnd).where(sql`${t.result} = 'pending'`),
    index("daily_results_pending_window_idx")
      .on(t.windowStart, t.windowEnd)
      .where(sql`${t.result} = 'pending'`),
    // EXCLUDE USING gist (user_id WITH =, tstzrange(window_start, window_end) WITH &&)
    // lives in the custom migration 0001 (drizzle cannot express exclusion constraints).
  ],
);

export const readingSessions = pgTable(
  "reading_sessions",
  {
    // Client-generated UUID. Server-side split pieces get new ids with parent_id = client id.
    id: uuid("id").primaryKey(),
    parentId: uuid("parent_id"),
    pieceIndex: smallint("piece_index").notNull().default(0),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").notNull(),
    bootId: text("boot_id").notNull(),
    source: sessionSourceEnum("source").notNull(),
    startedAtWall: ts("started_at_wall"),
    endedAtWall: ts("ended_at_wall"),
    monoStartMs: bigint("mono_start_ms", { mode: "number" }),
    monoEndMs: bigint("mono_end_ms", { mode: "number" }),
    clientActiveSeconds: integer("client_active_seconds"),
    activeSeconds: integer("active_seconds").notNull().default(0),
    serverStartAt: ts("server_start_at"),
    serverEndAt: ts("server_end_at"),
    receivedAt: ts("received_at").notNull(),
    dayKey: date("day_key", { mode: "string" }),
    dailyResultId: uuid("daily_result_id").references(() => dailyResults.id, {
      onDelete: "set null",
    }),
    verified: boolean("verified").notNull(),
    scorable: boolean("scorable").notNull(),
    rejectReason: text("reject_reason"),
    wallMonoMismatch: boolean("wall_mono_mismatch").notNull().default(false),
    contentRef: text("content_ref"),
  },
  (t) => [
    index("reading_sessions_user_day_idx").on(t.userId, t.dayKey),
    index("reading_sessions_result_idx").on(t.dailyResultId).where(sql`${t.verified}`),
    index("reading_sessions_parent_idx").on(t.parentId),
    index("reading_sessions_overlap_gist")
      .using("gist", t.userId, sql`tstzrange(${t.serverStartAt}, ${t.serverEndAt})`)
      .where(sql`${t.verified} and ${t.scorable} and ${t.source} <> 'self_report'`),
    uniqueIndex("reading_sessions_one_self_report")
      .on(t.userId, t.dayKey)
      .where(sql`${t.source} = 'self_report' and ${t.verified}`),
  ],
);

export const missedMeals = pgTable(
  "missed_meals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dailyResultId: uuid("daily_result_id")
      .notNull()
      .unique()
      .references(() => dailyResults.id, { onDelete: "cascade" }),
    // No stored expires_at: active at t = restored_at is null and occurred_at + expiry_days > t.
    occurredAt: ts("occurred_at").notNull(),
    restoredAt: ts("restored_at"),
    restoredByDailyResultId: uuid("restored_by_daily_result_id"),
  },
  (t) => [index("missed_meals_user_idx").on(t.userId)],
);

export const userStats = pgTable("user_stats", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  currentStreak: integer("current_streak").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
  totalFeasts: integer("total_feasts").notNull().default(0),
  totalMissed: integer("total_missed").notNull().default(0),
  restoreProgress: integer("restore_progress").notNull().default(0),
  famineSince: ts("famine_since"),
  lastClosedDayKey: date("last_closed_day_key", { mode: "string" }),
});

export const dailyAlarms = pgTable("daily_alarms", {
  alarmDate: date("alarm_date", { mode: "string" }).primaryKey(),
  windowStart: ts("window_start").notNull(),
  windowEnd: ts("window_end").notNull(),
  // SECRET until fired_at is set. Only src/lib/alarm.ts, src/workflows/alarm*.ts and the
  // dev-reveal route may select it (enforced by scripts/check-fire-at.sh).
  fireAt: ts("fire_at").notNull(),
  firedAt: ts("fired_at"),
  readerCount: integer("reader_count"),
  beatCount: integer("beat_count"),
  pushSent: integer("push_sent").notNull().default(0),
  pushFailed: integer("push_failed").notNull().default(0),
  pushDryRun: integer("push_dry_run").notNull().default(0),
  workflowRunId: text("workflow_run_id"),
});

export const pushDeliveries = pgTable(
  "push_deliveries",
  {
    alarmDate: date("alarm_date", { mode: "string" }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    variant: pushVariantEnum("variant").notNull(),
    status: pushStatusEnum("status").notNull(),
    createdAt: ts("created_at").notNull(),
    sentAt: ts("sent_at"),
    apnsStatus: text("apns_status"),
  },
  (t) => [primaryKey({ columns: [t.alarmDate, t.userId] })],
);

export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").notNull(),
    token: text("token").notNull().unique(),
    environment: apnsEnvEnum("environment").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    invalidatedAt: ts("invalidated_at"),
  },
  (t) => [
    uniqueIndex("device_tokens_user_device").on(t.userId, t.deviceId),
    index("device_tokens_active_user_idx").on(t.userId).where(sql`${t.invalidatedAt} is null`),
  ],
);

export const jobRuns = pgTable(
  "job_runs",
  {
    name: text("name").notNull(),
    runDate: date("run_date", { mode: "string" }).notNull(),
    workflowRunId: text("workflow_run_id"),
    startedAt: ts("started_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.name, t.runDate] })],
);

// Tiny fixed-window rate limiter (per IP for /auth/register).
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: ts("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

export type DailyResultRow = typeof dailyResults.$inferSelect;
export type ReadingSessionRow = typeof readingSessions.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type UserSettingsRow = typeof userSettings.$inferSelect;
