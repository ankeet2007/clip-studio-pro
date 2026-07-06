import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon (serverless Postgres) suspends compute and drops IDLE connections aggressively.
  // Recycle our own idle clients well before Neon kills them so we never hand a query a
  // dead socket, and keep active ones alive during long (10-20 min) renders.
  idleTimeoutMillis: 30_000,
  keepAlive: true,
});

// CRITICAL: without an 'error' listener, a dropped idle pooled client makes node-postgres
// emit an UNHANDLED 'error' event → uncaughtException → the whole server process dies
// (which killed long Match Story renders mid-flight). Swallow it here: the pool discards the
// dead client and opens a fresh one on the next query, so a Neon idle-drop is now recoverable.
pool.on("error", (err) => {
  console.error("[db-pro] idle Postgres client error (recovered, non-fatal):", err?.message ?? err);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
