import { withUser } from "@/lib/auth";
import { buildHome } from "@/lib/home";
import { handler, json } from "@/lib/http";

/** GET /api/v1/home: the client read model (B9). */
export const GET = handler(async (req: Request) =>
  json(await withUser(req, (c) => buildHome(c.tx, c.user, c.settings, c.cfg, c.now))),
);
