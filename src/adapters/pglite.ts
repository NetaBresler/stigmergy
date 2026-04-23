import type { PGlite } from "@electric-sql/pglite";
import type { MediumClient } from "../types.js";

/**
 * Adapt a PGlite instance to the Stigmergy MediumClient interface.
 * Used by the test suite (and by anyone who wants to run Stigmergy
 * in-process without a real Postgres). For production workloads,
 * see the postgres-js adapter.
 */
export function pgliteClient(db: PGlite): MediumClient {
  return {
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },
    async query<T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = []
    ): Promise<T[]> {
      const result = await db.query<T>(sql, params);
      return result.rows;
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}
