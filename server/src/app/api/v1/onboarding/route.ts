import { withUser } from "@/lib/auth";
import { buildHome, settingsDTO } from "@/lib/home";
import { handler, iso, json, parse, readJson } from "@/lib/http";
import { onboardingSchema } from "@/lib/validation";
import { onboard } from "@/services/users";

/** POST /api/v1/onboarding (idempotent): settings + first_day_starts_at + day 0. */
export const POST = handler(async (req: Request) => {
  const body = parse(onboardingSchema, await readJson(req));
  return json(
    await withUser(req, async (c) => {
      await onboard(c, body);
      return {
        settings: settingsDTO(c.settings),
        first_day_starts_at: iso(c.user.firstDayStartsAt),
        home: await buildHome(c.tx, c.user, c.settings, c.cfg, c.now),
      };
    }),
  );
});
