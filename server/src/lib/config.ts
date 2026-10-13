// Scoring configuration (the `scoring_config` table), loaded once per request and cached 60 s.
// Rule functions receive a plain ScoringConfig object, never read the DB themselves.

export interface ScoringConfig {
  missed_meal_expiry_days: number;
  feasts_to_restore: number;
  famine_threshold: number;
  min_day_hours: number;
  max_day_hours: number;
  offline_sync_window_hours: number;
  backdate_grace_seconds: number;
  max_session_span_seconds: number;
  max_session_active_seconds: number;
  max_daily_active_seconds: number;
  active_tolerance_seconds: number;
  overlap_tolerance_seconds: number;
  wall_mono_mismatch_seconds: number;
  alarm_tz: string;
  alarm_window_start: string;
  alarm_window_end: string;
  active_reader_window_days: number;
  dormant_after_days: number;
  purge_after_days: number;
  push_enabled: boolean;
}

export const DEFAULT_CONFIG: Readonly<ScoringConfig> = Object.freeze({
  missed_meal_expiry_days: 30,
  feasts_to_restore: 4,
  famine_threshold: 3,
  min_day_hours: 12,
  max_day_hours: 36,
  offline_sync_window_hours: 48,
  backdate_grace_seconds: 60,
  max_session_span_seconds: 21_600,
  max_session_active_seconds: 14_400,
  max_daily_active_seconds: 57_600,
  active_tolerance_seconds: 5,
  overlap_tolerance_seconds: 5,
  wall_mono_mismatch_seconds: 60,
  alarm_tz: "America/Denver",
  alarm_window_start: "10:00",
  alarm_window_end: "20:30",
  active_reader_window_days: 7,
  dormant_after_days: 30,
  purge_after_days: 180,
  push_enabled: false,
});

/** Builds a config from DB rows, falling back to defaults for missing or mistyped keys. */
export function configFromRows(rows: { key: string; value: unknown }[]): ScoringConfig {
  const cfg: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const { key, value } of rows) {
    if (!(key in DEFAULT_CONFIG)) continue;
    const def = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
    if (typeof value === typeof def) cfg[key] = value;
  }
  return cfg as unknown as ScoringConfig;
}

export function testConfig(overrides: Partial<ScoringConfig> = {}): ScoringConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

const CACHE_MS = 60_000;
let cache: { at: number; cfg: ScoringConfig } | null = null;

export function invalidateConfigCache(): void {
  cache = null;
}

/** Loads scoring_config through the given query function (kept DB-agnostic for tests). */
export async function loadConfig(
  fetchRows: () => Promise<{ key: string; value: unknown }[]>,
  nowMs: number = Date.now(),
): Promise<ScoringConfig> {
  if (cache && nowMs - cache.at < CACHE_MS) return cache.cfg;
  const cfg = configFromRows(await fetchRows());
  cache = { at: nowMs, cfg };
  return cfg;
}
