import { withUser } from "@/lib/auth";
import { buildHome } from "@/lib/home";
import { handler, json, parse, readJson } from "@/lib/http";
import { devicesSchema } from "@/lib/validation";
import { registerPushToken } from "@/services/users";

/** POST /api/v1/devices {token, environment}: registers this device's APNs token. */
export const POST = handler(async (req: Request) => {
  const body = parse(devicesSchema, await readJson(req));
  return json(
    await withUser(req, async (c) => {
      const row = await registerPushToken(c, body);
      return {
        device: {
          device_id: row.deviceId,
          environment: row.environment,
          token_suffix: row.token.slice(-8),
          registered_at: row.lastSeenAt.toISOString(),
        },
        home: await buildHome(c.tx, c.user, c.settings, c.cfg, c.now),
      };
    }),
  );
});
