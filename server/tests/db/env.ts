import { afterAll } from "vitest";
import { closeDb } from "@/db/client";
import { loadTestEnv } from "../load-env";

loadTestEnv();

afterAll(async () => {
  await closeDb();
});
