// Device-key auth (B3): POST /auth/register exchanges a device id + secret for a bearer JWT;
// withUser() verifies it and runs the handler inside one per-user transaction.
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { db, type Tx } from "@/db/client";
import { deviceBoots, deviceCredentials, users, type UserRow, type UserSettingsRow } from "@/db/schema";
import type { ScoringConfig } from "./config";
import { env } from "./env";
import { bearer, HttpError } from "./http";
import { ensureDay, getConfig, getSettings, lockUser, type EnsureDayResult } from "@/services/days";

const TOKEN_TTL_SECONDS = 365 * 24 * 3600;
const USER_TOUCH_MS = 3_600_000;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function signToken(userId: string, deviceId: string, now: Date): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ did: deviceId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(env.jwtSecret());
  return { token, expiresAt: new Date(exp * 1000) };
}

export async function verifyToken(token: string): Promise<{ userId: string; deviceId: string }> {
  try {
    const { payload } = await jwtVerify(token, env.jwtSecret(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.did !== "string") throw new Error("claims");
    return { userId: payload.sub, deviceId: payload.did };
  } catch {
    throw new HttpError(401, "invalid_token", "Missing, invalid or expired bearer token");
  }
}

export interface UserCtx {
  tx: Tx;
  now: Date;
  cfg: ScoringConfig;
  user: UserRow;
  settings: UserSettingsRow | null;
  deviceId: string;
  /** device_credentials.last_seen_at before this request (device-level no-backdating reference). */
  prevDeviceLastSeenAt: Date | null;
  /** This device's boots as they were before this request, with each boot's last contact. */
  prevBootContacts: Record<string, Date | null>;
  passive: boolean;
  /** Runs ensureDay now (withUser runs it before the handler unless ensure: "manual"). */
  ensureDay: () => Promise<EnsureDayResult>;
}

export interface WithUserOptions {
  /** "before" (default): ensureDay before the handler. "manual": the handler calls ctx.ensureDay(). */
  ensure?: "before" | "manual";
  now?: Date;
}

/**
 * requireUser (B3) as a transaction wrapper: verify the bearer token, lock the users row,
 * record device contact, run ensureDay, then clear dormant_since (after ensureDay, so the
 * dormancy branch can see it) and touch last_seen_at (if older than 1 h).
 *
 * Optional headers on any authenticated request:
 *  - X-Feast-Boot-Id + X-Feast-Mono-Ms: refine the per-boot monotonic anchor.
 *  - X-Feast-Passive: 1 (widget/background fetches): does not count as device contact.
 */
export async function withUser<T>(req: Request, fn: (ctx: UserCtx) => Promise<T>, opts: WithUserOptions = {}): Promise<T> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "invalid_token", "Missing bearer token");
  const { userId, deviceId } = await verifyToken(token);
  const passive = req.headers.get("x-feast-passive") === "1";
  const bootId = req.headers.get("x-feast-boot-id");
  const monoHeader = req.headers.get("x-feast-mono-ms");
  const database = await db();

  return database.transaction(async (tx) => {
    const now = opts.now ?? new Date();
    const user = await lockUser(tx, userId);
    if (!user) throw new HttpError(401, "invalid_token", "User no longer exists");
    const [cred] = await tx
      .select()
      .from(deviceCredentials)
      .where(and(eq(deviceCredentials.deviceId, deviceId), eq(deviceCredentials.userId, userId)));
    if (!cred || cred.revokedAt) throw new HttpError(401, "invalid_token", "Device credential revoked");
    const cfg = await getConfig(tx);
    const settings = await getSettings(tx, userId);

    // Snapshot boot contacts before this request touches them (per-boot backdating reference).
    const boots = await tx
      .select({ bootId: deviceBoots.bootId, lastContactAt: deviceBoots.lastContactAt })
      .from(deviceBoots)
      .where(eq(deviceBoots.deviceId, deviceId));
    const prevBootContacts = Object.fromEntries(boots.map((b) => [b.bootId, b.lastContactAt]));

    if (!passive) {
      await tx.update(deviceCredentials).set({ lastSeenAt: now }).where(eq(deviceCredentials.deviceId, deviceId));
    }
    if (bootId && bootId.length <= 128) {
      if (monoHeader && /^\d+$/.test(monoHeader)) {
        await recordBoot(tx, deviceId, bootId, Number(monoHeader), now, !passive);
      } else if (!passive) {
        await tx
          .update(deviceBoots)
          .set({ lastContactAt: now })
          .where(and(eq(deviceBoots.deviceId, deviceId), eq(deviceBoots.bootId, bootId)));
      }
    }

    const ctx: UserCtx = {
      tx,
      now,
      cfg,
      user,
      settings,
      deviceId,
      prevDeviceLastSeenAt: cred.lastSeenAt,
      prevBootContacts,
      passive,
      ensureDay: () => ensureDay(tx, user, ctx.settings, now, cfg),
    };
    const finish = async () => {
      if (passive) return;
      const patch: Partial<UserRow> = {};
      if (user.dormantSince) patch.dormantSince = null;
      if (now.getTime() - user.lastSeenAt.getTime() > USER_TOUCH_MS) patch.lastSeenAt = now;
      if (Object.keys(patch).length) {
        await tx.update(users).set(patch).where(eq(users.id, userId));
        Object.assign(user, patch);
      }
    };
    if ((opts.ensure ?? "before") === "before") {
      await ctx.ensureDay();
      await finish();
      return fn(ctx);
    }
    const out = await fn(ctx);
    await finish();
    return out;
  });
}

/**
 * Upserts a device boot; anchor_offset_ms keeps the minimum observed (received - mono).
 * `contact` (a non-passive request carrying this boot) also sets last_contact_at.
 */
export async function recordBoot(
  tx: Tx,
  deviceId: string,
  bootId: string,
  clientNowMono: number,
  receivedAt: Date,
  contact: boolean,
) {
  const offset = receivedAt.getTime() - clientNowMono;
  await tx
    .insert(deviceBoots)
    .values({
      deviceId,
      bootId,
      anchorOffsetMs: offset,
      firstSeenAt: receivedAt,
      lastSeenAt: receivedAt,
      lastSeenMonoMs: clientNowMono,
      lastContactAt: contact ? receivedAt : null,
    })
    .onConflictDoUpdate({
      target: [deviceBoots.deviceId, deviceBoots.bootId],
      set: {
        anchorOffsetMs: sql`least(${deviceBoots.anchorOffsetMs}, excluded.anchor_offset_ms)`,
        lastSeenAt: receivedAt,
        lastSeenMonoMs: sql`greatest(${deviceBoots.lastSeenMonoMs}, excluded.last_seen_mono_ms)`,
        ...(contact ? { lastContactAt: receivedAt } : {}),
      },
    });
}
