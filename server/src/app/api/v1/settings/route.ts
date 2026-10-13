import { withUser } from "@/lib/auth";
import { buildHome, settingsDTO } from "@/lib/home";
import { handler, json, parse, readJson } from "@/lib/http";
import { settingsPatchSchema } from "@/lib/validation";
import { applySettings } from "@/services/users";

/** PATCH /api/v1/settings: goal -> next rollover (or directly on day 0); tz/rollover -> reschedule now. */
export const PATCH = handler(async (req: Request) => {
  const body = parse(settingsPatchSchema, await readJson(req));
  return json(
    await withUser(req, async (c) => {
      await applySettings(c, body);
      return { settings: settingsDTO(c.settings), home: await buildHome(c.tx, c.user, c.settings, c.cfg, c.now) };
    }),
  );
});

/** GET /api/v1/settings: current settings (same object as home.settings). */
export const GET = handler(async (req: Request) =>
  json(await withUser(req, async (c) => ({ settings: settingsDTO(c.settings) }))),
);
