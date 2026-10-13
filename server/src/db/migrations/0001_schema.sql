CREATE TYPE "public"."apns_env" AS ENUM('sandbox', 'production');--> statement-breakpoint
CREATE TYPE "public"."day_result" AS ENUM('pending', 'feast', 'missed');--> statement-breakpoint
CREATE TYPE "public"."push_status" AS ENUM('sending', 'sent', 'failed', 'dry_run');--> statement-breakpoint
CREATE TYPE "public"."push_variant" AS ENUM('alarm', 'safe', 'moment');--> statement-breakpoint
CREATE TYPE "public"."session_source" AS ENUM('reader', 'self_report', 'audio');--> statement-breakpoint
CREATE TABLE "daily_alarms" (
	"alarm_date" date PRIMARY KEY NOT NULL,
	"window_start" timestamp (3) with time zone NOT NULL,
	"window_end" timestamp (3) with time zone NOT NULL,
	"fire_at" timestamp (3) with time zone NOT NULL,
	"fired_at" timestamp (3) with time zone,
	"reader_count" integer,
	"beat_count" integer,
	"push_sent" integer DEFAULT 0 NOT NULL,
	"push_failed" integer DEFAULT 0 NOT NULL,
	"push_dry_run" integer DEFAULT 0 NOT NULL,
	"workflow_run_id" text
);
--> statement-breakpoint
CREATE TABLE "daily_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day_key" date NOT NULL,
	"window_start" timestamp (3) with time zone NOT NULL,
	"window_end" timestamp (3) with time zone NOT NULL,
	"tz_at_open" text NOT NULL,
	"rollover_hour_at_open" smallint NOT NULL,
	"goal_seconds" integer NOT NULL,
	"verified_seconds" integer DEFAULT 0 NOT NULL,
	"verified_before_alarm_seconds" integer DEFAULT 0 NOT NULL,
	"goal_reached_at" timestamp (3) with time zone,
	"self_reported_at" timestamp (3) with time zone,
	"alarm_at" timestamp (3) with time zone,
	"safe_at_fire" boolean,
	"result" "day_result" DEFAULT 'pending' NOT NULL,
	"closed_at" timestamp (3) with time zone,
	"deadline_at" timestamp (3) with time zone,
	"rescored_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "device_boots" (
	"device_id" uuid NOT NULL,
	"boot_id" text NOT NULL,
	"anchor_offset_ms" bigint NOT NULL,
	"first_seen_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"last_seen_mono_ms" bigint NOT NULL,
	CONSTRAINT "device_boots_device_id_boot_id_pk" PRIMARY KEY("device_id","boot_id")
);
--> statement-breakpoint
CREATE TABLE "device_credentials" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"token" text NOT NULL,
	"environment" "apns_env" NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"invalidated_at" timestamp (3) with time zone,
	CONSTRAINT "device_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"name" text NOT NULL,
	"run_date" date NOT NULL,
	"workflow_run_id" text,
	"started_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "job_runs_name_run_date_pk" PRIMARY KEY("name","run_date")
);
--> statement-breakpoint
CREATE TABLE "missed_meals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"daily_result_id" uuid NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"restored_at" timestamp (3) with time zone,
	"restored_by_daily_result_id" uuid,
	CONSTRAINT "missed_meals_daily_result_id_unique" UNIQUE("daily_result_id")
);
--> statement-breakpoint
CREATE TABLE "push_deliveries" (
	"alarm_date" date NOT NULL,
	"user_id" uuid NOT NULL,
	"variant" "push_variant" NOT NULL,
	"status" "push_status" NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"sent_at" timestamp (3) with time zone,
	"apns_status" text,
	CONSTRAINT "push_deliveries_alarm_date_user_id_pk" PRIMARY KEY("alarm_date","user_id")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp (3) with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "reading_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_id" uuid,
	"piece_index" smallint DEFAULT 0 NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"boot_id" text NOT NULL,
	"source" "session_source" NOT NULL,
	"started_at_wall" timestamp (3) with time zone,
	"ended_at_wall" timestamp (3) with time zone,
	"mono_start_ms" bigint,
	"mono_end_ms" bigint,
	"client_active_seconds" integer,
	"active_seconds" integer DEFAULT 0 NOT NULL,
	"server_start_at" timestamp (3) with time zone,
	"server_end_at" timestamp (3) with time zone,
	"received_at" timestamp (3) with time zone NOT NULL,
	"day_key" date,
	"daily_result_id" uuid,
	"verified" boolean NOT NULL,
	"scorable" boolean NOT NULL,
	"reject_reason" text,
	"wall_mono_mismatch" boolean DEFAULT false NOT NULL,
	"content_ref" text
);
--> statement-breakpoint
CREATE TABLE "scoring_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"client_visible" boolean DEFAULT false NOT NULL,
	"description" text,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"tz" text NOT NULL,
	"rollover_hour" smallint NOT NULL,
	"goal_seconds" integer NOT NULL,
	"pending_goal_seconds" integer,
	"reminder_enabled" boolean DEFAULT false NOT NULL,
	"reminder_local_time" time,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_stats" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"longest_streak" integer DEFAULT 0 NOT NULL,
	"total_feasts" integer DEFAULT 0 NOT NULL,
	"total_missed" integer DEFAULT 0 NOT NULL,
	"restore_progress" integer DEFAULT 0 NOT NULL,
	"famine_since" timestamp (3) with time zone,
	"last_closed_day_key" date
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"apple_sub" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"dormant_since" timestamp (3) with time zone,
	"onboarded_at" timestamp (3) with time zone,
	"first_day_starts_at" timestamp (3) with time zone,
	CONSTRAINT "users_apple_sub_unique" UNIQUE("apple_sub")
);
--> statement-breakpoint
ALTER TABLE "daily_results" ADD CONSTRAINT "daily_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_boots" ADD CONSTRAINT "device_boots_device_id_device_credentials_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device_credentials"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_meals" ADD CONSTRAINT "missed_meals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_meals" ADD CONSTRAINT "missed_meals_daily_result_id_daily_results_id_fk" FOREIGN KEY ("daily_result_id") REFERENCES "public"."daily_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD CONSTRAINT "reading_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD CONSTRAINT "reading_sessions_daily_result_id_daily_results_id_fk" FOREIGN KEY ("daily_result_id") REFERENCES "public"."daily_results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_stats" ADD CONSTRAINT "user_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_results_user_day_key" ON "daily_results" USING btree ("user_id","day_key");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_results_one_pending" ON "daily_results" USING btree ("user_id") WHERE "daily_results"."result" = 'pending';--> statement-breakpoint
CREATE INDEX "daily_results_pending_end_idx" ON "daily_results" USING btree ("window_end") WHERE "daily_results"."result" = 'pending';--> statement-breakpoint
CREATE INDEX "daily_results_pending_window_idx" ON "daily_results" USING btree ("window_start","window_end") WHERE "daily_results"."result" = 'pending';--> statement-breakpoint
CREATE INDEX "device_credentials_user_idx" ON "device_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_user_device" ON "device_tokens" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE INDEX "device_tokens_active_user_idx" ON "device_tokens" USING btree ("user_id") WHERE "device_tokens"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "missed_meals_user_idx" ON "missed_meals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reading_sessions_user_day_idx" ON "reading_sessions" USING btree ("user_id","day_key");--> statement-breakpoint
CREATE INDEX "reading_sessions_result_idx" ON "reading_sessions" USING btree ("daily_result_id") WHERE "reading_sessions"."verified";--> statement-breakpoint
CREATE INDEX "reading_sessions_parent_idx" ON "reading_sessions" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "reading_sessions_overlap_gist" ON "reading_sessions" USING gist ("user_id",tstzrange("server_start_at", "server_end_at")) WHERE "reading_sessions"."verified" and "reading_sessions"."scorable" and "reading_sessions"."source" <> 'self_report';--> statement-breakpoint
CREATE UNIQUE INDEX "reading_sessions_one_self_report" ON "reading_sessions" USING btree ("user_id","day_key") WHERE "reading_sessions"."source" = 'self_report' and "reading_sessions"."verified";