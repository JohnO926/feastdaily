import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { handler, HttpError, json } from "@/lib/http";
import { db } from "@/db/client";
import { userStats } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getConfig, lockUser, refold } from "@/services/days";

/** POST /api/admin/users/:id/recompute: full refold of one user from the day log. */
export const POST = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  requireAdmin(req);
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) throw new HttpError(400, "invalid_user_id", "id must be a UUID");
  const database = await db();
  const stats = await database.transaction(async (tx) => {
    const user = await lockUser(tx, id);
    if (!user) throw new HttpError(404, "user_not_found", "No such user");
    await refold(tx, id, await getConfig(tx));
    const [s] = await tx.select().from(userStats).where(eq(userStats.userId, id));
    return s;
  });
  return json({
    user_id: id,
    stats: {
      current_streak: stats.currentStreak,
      longest_streak: stats.longestStreak,
      total_feasts: stats.totalFeasts,
      total_missed: stats.totalMissed,
      restore_progress: stats.restoreProgress,
      famine_since: stats.famineSince?.toISOString() ?? null,
      last_closed_day_key: stats.lastClosedDayKey,
    },
  });
});
