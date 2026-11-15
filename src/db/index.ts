import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and run `docker compose up -d`.");
}

// One pool per process: dev hot reload re-runs this module, so park the pool on globalThis.
const globalForDb = globalThis as unknown as { pgPool?: Pool };
const pool = globalForDb.pgPool ?? new Pool({ connectionString: url, max: 10 });
if (process.env.NODE_ENV !== "production") globalForDb.pgPool = pool;

export const db = drizzle(pool, { schema });
