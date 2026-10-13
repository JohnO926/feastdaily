import { withUser } from "@/lib/auth";
import { handler, json } from "@/lib/http";
import { deleteAccount } from "@/services/users";

/** DELETE /api/v1/account: deletes the user and everything that cascades from it. */
export const DELETE = handler(async (req: Request) =>
  json(
    await withUser(
      req,
      async (c) => {
        await deleteAccount(c.tx, c.user.id);
        return { deleted: true, user_id: c.user.id };
      },
      { ensure: "manual" },
    ),
  ),
);
