import type postgres from "postgres";
import type { MediumClient } from "../types.js";

/**
 * Adapt a postgres-js `Sql` instance to the Stigmergy MediumClient interface.
 * This is the production adapter — opened by `defineMedium({ url })`.
 */
export function postgresJsClient(sql: postgres.Sql): MediumClient {
  return {
    async exec(raw: string): Promise<void> {
      await sql.unsafe(raw);
    },
    async query<T = Record<string, unknown>>(raw: string, params: unknown[] = []): Promise<T[]> {
      // postgres-js's sql.unsafe(raw, params) returns a PostgresResult that
      // is iterable as rows. Cast through unknown to our generic row type.
      const rows = await sql.unsafe(raw, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
