import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;
/** A Drizzle transaction handle (same query API as DB). */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
/** Anything that can run queries: the pool-backed DB or an open transaction. */
export type Executor = DB | Tx;

type Holder = { pool: Pool; db: DB; url: string; warmed: boolean };
const g = globalThis as unknown as { __feastDb?: Holder };

function poolConfig(url: string): PoolConfig {
  return {
    connectionString: url,
    // Small module-scoped pool reused across invocations; idle clients are released quickly
    // so idle Fluid instances don't pin Neon pooler slots.
    max: 5,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 15_000,
  };
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

function holder(): Holder {
  const url = databaseUrl();
  if (!g.__feastDb || g.__feastDb.url !== url) {
    const pool = new Pool(poolConfig(url));
    pool.on("error", (err) => console.error("[db] idle client error", err.message));
    g.__feastDb = { pool, db: drizzle({ client: pool, schema }), url, warmed: false };
  }
  return g.__feastDb;
}

export function getPool(): Pool {
  return holder().pool;
}

export function getDb(): DB {
  return holder().db;
}

/**
 * Returns the DB after making sure one connection works. The first query of an invocation
 * retries once, because a free-tier Neon compute waking from autosuspend can fail the first
 * connection attempt.
 */
export async function db(): Promise<DB> {
  const h = holder();
  if (!h.warmed) {
    try {
      await h.pool.query("select 1");
    } catch (err) {
      console.warn("[db] first connection failed, retrying once:", (err as Error).message);
      await new Promise((r) => setTimeout(r, 500));
      await h.pool.query("select 1");
    }
    h.warmed = true;
  }
  return h.db;
}

export async function closeDb(): Promise<void> {
  if (g.__feastDb) {
    const p = g.__feastDb.pool;
    g.__feastDb = undefined;
    await p.end();
  }
}
