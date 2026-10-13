-- Day windows of one user never overlap (needs btree_gist for the uuid equality operator).
ALTER TABLE "daily_results"
  ADD CONSTRAINT "daily_results_no_window_overlap"
  EXCLUDE USING gist ("user_id" WITH =, tstzrange("window_start", "window_end") WITH &&);
--> statement-breakpoint
ALTER TABLE "daily_results"
  ADD CONSTRAINT "daily_results_window_order" CHECK ("window_end" > "window_start");
--> statement-breakpoint
ALTER TABLE "user_settings"
  ADD CONSTRAINT "user_settings_rollover_hour" CHECK ("rollover_hour" BETWEEN 0 AND 9);
--> statement-breakpoint
ALTER TABLE "user_settings"
  ADD CONSTRAINT "user_settings_goal" CHECK (
    ("goal_seconds" BETWEEN 45 AND 300 AND "goal_seconds" % 15 = 0)
    OR ("goal_seconds" BETWEEN 300 AND 2700 AND "goal_seconds" % 60 = 0)
  );
--> statement-breakpoint
ALTER TABLE "reading_sessions"
  ADD CONSTRAINT "reading_sessions_active_nonneg" CHECK ("active_seconds" >= 0);
--> statement-breakpoint
INSERT INTO "scoring_config" ("key", "value", "client_visible", "description") VALUES
  ('missed_meal_expiry_days',     '30',               true,  'Days after which a missed meal clears'),
  ('feasts_to_restore',           '4',                true,  'Consecutive feasts that restore one missed meal early'),
  ('famine_threshold',            '3',                true,  'Active missed meals that put a user in Famine'),
  ('min_day_hours',               '12',               false, 'Shortest allowed day window'),
  ('max_day_hours',               '36',               false, 'Longest allowed day window'),
  ('offline_sync_window_hours',   '48',               false, 'Late sessions can re-score a closed day within this many hours of window_end'),
  ('backdate_grace_seconds',      '60',               false, 'Grace before the device last contact for the no-backdating rule'),
  ('max_session_span_seconds',    '21600',            false, 'Longest accepted session span'),
  ('max_session_active_seconds',  '14400',            false, 'Most active seconds in one session'),
  ('max_daily_active_seconds',    '57600',            false, 'Most active seconds credited to one day'),
  ('active_tolerance_seconds',    '5',                false, 'Slack for active_seconds vs span'),
  ('overlap_tolerance_seconds',   '5',                false, 'Overlaps up to this size are trimmed instead of rejected'),
  ('wall_mono_mismatch_seconds',  '60',               false, 'Advisory wall vs monotonic span mismatch threshold'),
  ('alarm_tz',                    '"America/Denver"', true,  'Time zone of the shared alarm window'),
  ('alarm_window_start',          '"10:00"',          true,  'Alarm window start (local to alarm_tz)'),
  ('alarm_window_end',            '"20:30"',          true,  'Alarm window end (local to alarm_tz)'),
  ('active_reader_window_days',   '7',                false, 'Users seen within this many days count as readers and get the alarm push'),
  ('dormant_after_days',          '30',               false, 'Users unseen this long stop generating days'),
  ('purge_after_days',            '180',              false, 'Device-only users unseen this long are deleted'),
  ('push_enabled',                'false',            false, 'Send real APNs pushes (otherwise dry run)')
ON CONFLICT ("key") DO NOTHING;
