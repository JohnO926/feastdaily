import { env } from "@/lib/env";
import { handler, json, parse, readJson } from "@/lib/http";
import { registerSchema } from "@/lib/validation";
import { checkRateLimit, registerDevice } from "@/services/users";

function clientIp(req: Request): string {
  return (
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/** POST /api/v1/auth/register {device_id, device_secret} -> {user_id, token, token_expires_at, created} */
export const POST = handler(async (req: Request) => {
  const body = parse(registerSchema, await readJson(req));
  const now = new Date();
  await checkRateLimit(`register:${clientIp(req)}`, env.registerRateLimitPerHour(), now);
  const r = await registerDevice(body.device_id, body.device_secret, now);
  return json(r, { status: r.created ? 201 : 200 });
});
