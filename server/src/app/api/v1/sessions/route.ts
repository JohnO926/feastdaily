import { withUser } from "@/lib/auth";
import { buildHome } from "@/lib/home";
import { handler, HttpError, json, parse, readJson } from "@/lib/http";
import { sessionsEnvelopeSchema } from "@/lib/validation";
import { ingestAndSettle } from "@/services/sessions";

/**
 * POST /api/v1/sessions (B5). Ingests the batch first and runs ensureDay afterwards, so a
 * pre-alarm session uploaded in the request that closes its own day is scored the first time.
 */
export const POST = handler(async (req: Request) => {
  const body = parse(sessionsEnvelopeSchema, await readJson(req));
  return json(
    await withUser(
      req,
      async (c) => {
        if (body.device_id !== c.deviceId) {
          throw new HttpError(403, "device_mismatch", "device_id does not match the bearer token's device");
        }
        const { results } = await ingestAndSettle(
          c,
          {
            device_id: body.device_id,
            boot_id: body.boot_id,
            client_now_wall: body.client_now_wall,
            client_now_mono_ms: body.client_now_mono_ms,
          },
          body.sessions.map((s) => ({ ...s, content_ref: s.content_ref ?? null })),
        );
        return { results, home: await buildHome(c.tx, c.user, c.settings, c.cfg, c.now) };
      },
      { ensure: "manual" },
    ),
  );
});
