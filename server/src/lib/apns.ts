// APNs client (B10). Token auth over HTTP/2 via apns2. APNS_DRY_RUN=true (the default) skips
// the network and logs {variant, user, token suffix}; callers still record a dry_run delivery.
import { ApnsClient, Notification, type ApnsError } from "apns2";
import { env } from "./env";

export type PushVariant = "alarm" | "safe" | "moment";

export interface PushMessage {
  token: string;
  environment: "sandbox" | "production";
  userId: string;
  variant: PushVariant;
  alarmDate: string;
  firedAt: Date;
  /** Local "2:47 PM" in the user's zone. */
  firedAtLocal: string;
  beatPct: number | null;
}

export type PushOutcome =
  | { status: "sent"; apnsStatus: string }
  | { status: "dry_run"; apnsStatus: "dry_run" }
  | { status: "failed"; apnsStatus: string; invalidToken: boolean; retryable: boolean };

export function formatLocalTime(t: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(t);
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" }).format(t);
  }
}

/** The JSON payload for each variant (shared userInfo keys: kind, alarm_date, fired_at). */
export function buildPayload(m: Omit<PushMessage, "token" | "environment" | "userId">): {
  aps: Record<string, unknown>;
  kind: PushVariant;
  alarm_date: string;
  fired_at: string;
  beat_pct: number | null;
} {
  const pct = m.beatPct === null ? "" : ` ${m.beatPct}% of readers beat it.`;
  const base = { kind: m.variant, alarm_date: m.alarmDate, fired_at: m.firedAt.toISOString(), beat_pct: m.beatPct };
  if (m.variant === "alarm") {
    return {
      aps: {
        alert: {
          title: "The alarm went off",
          body: `It went off at ${m.firedAtLocal} before today's reading was done. Reading now still counts toward your history.`,
        },
        sound: "default",
        "interruption-level": "time-sensitive",
        "content-available": 1,
        "thread-id": "daily-alarm",
      },
      ...base,
    };
  }
  if (m.variant === "safe") {
    return {
      aps: {
        alert: { title: "You're safe today", body: `The alarm went off at ${m.firedAtLocal}. You beat it.${pct}` },
        "interruption-level": "active",
        "content-available": 1,
        "thread-id": "daily-alarm",
      },
      ...base,
    };
  }
  return {
    aps: {
      alert: { title: `The alarm went off at ${m.firedAtLocal}`, body: pct.trim() || "See how everyone did." },
      "interruption-level": "active",
      "content-available": 1,
      "thread-id": "daily-alarm",
    },
    ...base,
  };
}

const clients = new Map<string, ApnsClient>();

function clientFor(environment: "sandbox" | "production"): ApnsClient {
  const cfg = env.apns();
  const key = environment;
  let c = clients.get(key);
  if (!c) {
    if (!cfg.teamId || !cfg.keyId || !cfg.p8Base64) throw new Error("APNs credentials are not configured");
    c = new ApnsClient({
      team: cfg.teamId,
      keyId: cfg.keyId,
      signingKey: Buffer.from(cfg.p8Base64, "base64").toString("utf8"),
      defaultTopic: cfg.bundleId,
      host: environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com",
      requestTimeout: 10_000,
    });
    clients.set(key, c);
  }
  return c;
}

export function isDryRun(pushEnabled: boolean): boolean {
  return env.apns().dryRun || !pushEnabled;
}

export async function sendPush(m: PushMessage, pushEnabled: boolean): Promise<PushOutcome> {
  if (isDryRun(pushEnabled)) {
    console.log(
      `[apns dry-run] ${JSON.stringify({ variant: m.variant, user: m.userId, token: `…${m.token.slice(-6)}`, alarm_date: m.alarmDate })}`,
    );
    return { status: "dry_run", apnsStatus: "dry_run" };
  }
  const payload = buildPayload(m);
  const { aps, ...data } = payload;
  const n = new Notification(m.token, {
    aps,
    data,
    priority: 10,
    expiration: new Date(m.firedAt.getTime() + 15 * 60_000),
    collapseId: `alarm-${m.alarmDate}`,
  });
  try {
    await clientFor(m.environment).send(n);
    return { status: "sent", apnsStatus: "200" };
  } catch (err) {
    const e = err as ApnsError;
    const reason = e?.reason ?? (err as Error)?.message ?? "error";
    const code = e?.statusCode ?? 0;
    const invalidToken = code === 410 || reason === "Unregistered" || reason === "BadDeviceToken";
    const retryable = code === 429 || code >= 500 || code === 0;
    return { status: "failed", apnsStatus: `${code || "error"}:${reason}`, invalidToken, retryable };
  }
}

/** Runs fn over items with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
