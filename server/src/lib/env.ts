// Typed access to environment variables. Read lazily so tests can set them per run.
export const env = {
  jwtSecret(): Uint8Array {
    const s = process.env.JWT_SECRET;
    if (!s || s.length < 32) throw new Error("JWT_SECRET must be set (>= 32 chars)");
    return new TextEncoder().encode(s);
  },
  cronSecret: () => process.env.CRON_SECRET ?? "",
  adminSecret: () => process.env.ADMIN_SECRET ?? "",
  devRevealAlarm: () => process.env.DEV_REVEAL_ALARM === "true",
  isProduction: () => process.env.VERCEL_ENV === "production",
  registerRateLimitPerHour: () => Number(process.env.REGISTER_RATE_LIMIT_PER_HOUR ?? 30),
  alertWebhookUrl: () => process.env.ALERT_WEBHOOK_URL || null,
  apns: () => ({
    teamId: process.env.APNS_TEAM_ID ?? "",
    keyId: process.env.APNS_KEY_ID ?? "",
    p8Base64: process.env.APNS_P8_BASE64 ?? "",
    bundleId: process.env.APNS_BUNDLE_ID ?? "com.valiflo.feastdaily",
    env: (process.env.APNS_ENV === "production" ? "production" : "sandbox") as "sandbox" | "production",
    // Defaults to true: only an explicit APNS_DRY_RUN=false sends real pushes.
    dryRun: process.env.APNS_DRY_RUN !== "false",
  }),
};
