import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/client";
import { dailyResults } from "@/db/schema";
import { ingestAndSettle } from "@/services/sessions";
import { asUser, createOnboardedUser, FakeDevice, H, MIN, resetDb } from "./helpers";

const T0 = new Date("2026-10-12T16:00:00Z");
const DAY1 = new Date("2026-10-13T09:00:00Z");

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.code ?? err.cause?.code ?? "unknown";
  }
  return "none";
}

describe("schema constraints", () => {
  beforeEach(() => resetDb());

  it("the exclusion constraint rejects overlapping windows for one user", async () => {
    const u = await createOnboardedUser(T0);
    const d = await db();
    const code = await pgError(
      d.insert(dailyResults).values({
        userId: u.userId,
        dayKey: "2026-10-20",
        windowStart: new Date(DAY1.getTime() + 2 * H),
        windowEnd: new Date(DAY1.getTime() + 30 * H),
        tzAtOpen: "America/Denver",
        rolloverHourAtOpen: 3,
        goalSeconds: 600,
        result: "feast",
      }),
    );
    expect(code).toBe("23P01"); // exclusion_violation
  });

  it("allows only one pending day per user", async () => {
    const u = await createOnboardedUser(T0);
    const d = await db();
    const code = await pgError(
      d.insert(dailyResults).values({
        userId: u.userId,
        dayKey: "2026-11-20",
        windowStart: new Date("2026-11-20T10:00:00Z"),
        windowEnd: new Date("2026-11-21T10:00:00Z"),
        tzAtOpen: "America/Denver",
        rolloverHourAtOpen: 3,
        goalSeconds: 600,
      }),
    );
    expect(code).toBe("23505"); // unique_violation on daily_results_one_pending
  });

  it("duplicate session ids return the stored status; overlapping sessions are rejected via the gist query", async () => {
    const u = await createOnboardedUser(T0);
    const dev = new FakeDevice(u.deviceId);
    const now = new Date(DAY1.getTime() + 5 * H);
    const s1 = dev.reading(new Date(now.getTime() - 40 * MIN), new Date(now.getTime() - 30 * MIN), 600);
    const first = await asUser(u, now, (c) => ingestAndSettle(c, dev.envelope(now), [s1]), { ensure: "manual" });
    expect(first.results[0]).toMatchObject({ id: s1.id, status: "accepted", scored: true, day_key: "2026-10-13" });

    const again = await asUser(u, now, (c) => ingestAndSettle(c, dev.envelope(now), [s1]), { ensure: "manual" });
    expect(again.results[0]).toMatchObject({ id: s1.id, status: "duplicate", scored: true, day_key: "2026-10-13" });

    const overlapping = dev.reading(new Date(now.getTime() - 35 * MIN), new Date(now.getTime() - 20 * MIN), 900);
    const r = await asUser(u, now, (c) => ingestAndSettle(c, dev.envelope(now), [overlapping]), { ensure: "manual" });
    expect(r.results[0]).toMatchObject({ status: "rejected", reason: "overlap", scored: false });

    // A different user may never collide with another user's session id.
    const other = await createOnboardedUser(T0);
    const odev = new FakeDevice(other.deviceId);
    const stolen = { ...odev.reading(new Date(now.getTime() - 10 * MIN), new Date(now.getTime() - 5 * MIN), 300), id: s1.id };
    const r2 = await asUser(other, now, (c) => ingestAndSettle(c, odev.envelope(now), [stolen]), { ensure: "manual" });
    expect(r2.results[0]).toMatchObject({ status: "duplicate", scored: false });
  });
});
