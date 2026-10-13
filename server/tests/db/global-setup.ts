import { runMigrations } from "@/db/migrate";
import { loadTestEnv } from "../load-env";

export default async function setup() {
  const url = loadTestEnv();
  await runMigrations(url);
}
