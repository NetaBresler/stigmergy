import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MediumClient } from "./types.js";

/**
 * The migrator uses the same minimal DB-client interface as the rest of
 * Stigmergy. See `MediumClient` in `src/types.ts`. Re-exported here as
 * `MigrationClient` for readability when migrator tests drive a client.
 */
export type MigrationClient = MediumClient;

export interface MigrationResult {
  /** Migration filenames applied in this run, in order. Empty when nothing to do. */
  readonly applied: ReadonlyArray<string>;
}

const TRACKING_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _stigmergy_migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`;

const FILENAME_PATTERN = /^\d{3,}_[a-z0-9_]+\.sql$/;

/**
 * Apply every pending migration from `migrationsDir` against the given client.
 *
 * Migration files must be named `NNN_snake_case.sql` (e.g. `001_framework_tables.sql`)
 * and are applied in lexicographic order. A `_stigmergy_migrations` tracking
 * table records which files have already been applied; re-running is idempotent.
 *
 * Phase 1 does not wrap migrations in a per-file transaction — SQL files are
 * expected to use `IF NOT EXISTS` clauses. If a file fails mid-apply, fix the
 * SQL and re-run; Postgres will skip statements that already succeeded.
 */
export async function migrate(
  client: MigrationClient,
  migrationsDir: string
): Promise<MigrationResult> {
  await client.exec(TRACKING_TABLE_SQL);

  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();

  for (const file of files) {
    if (!FILENAME_PATTERN.test(file)) {
      throw new Error(`Migration filename does not match NNN_snake_case.sql: ${file}`);
    }
  }

  const appliedRows = await client.query<{ name: string }>(
    `SELECT name FROM _stigmergy_migrations`
  );
  const applied = new Set(appliedRows.map((r) => r.name));

  const pending = files.filter((f) => !applied.has(f));
  for (const file of pending) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    await client.exec(sql);
    await client.query(`INSERT INTO _stigmergy_migrations (name) VALUES ($1)`, [file]);
  }

  return { applied: pending };
}
