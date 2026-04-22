import { PGlite } from "@electric-sql/pglite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pgliteClient } from "../src/adapters/pglite.js";
import { migrate } from "../src/migrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

describe("migrator", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });

  afterEach(async () => {
    await db.close();
  });

  it("applies the framework migration against a fresh database", async () => {
    const client = pgliteClient(db);
    const result = await migrate(client, MIGRATIONS_DIR);

    expect(result.applied).toEqual(["001_framework_tables.sql"]);

    const tables = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    const names = tables.map((t) => t.tablename);
    expect(names).toContain("stigmergy_agents");
    expect(names).toContain("stigmergy_signal_registry");
    expect(names).toContain("stigmergy_reinforcements");
    expect(names).toContain("_stigmergy_migrations");
  });

  it("is idempotent — a second run applies nothing", async () => {
    const client = pgliteClient(db);
    await migrate(client, MIGRATIONS_DIR);

    const second = await migrate(client, MIGRATIONS_DIR);
    expect(second.applied).toEqual([]);
  });

  it("records applied migrations in the tracking table", async () => {
    const client = pgliteClient(db);
    await migrate(client, MIGRATIONS_DIR);

    const rows = await client.query<{ name: string }>(
      `SELECT name FROM _stigmergy_migrations ORDER BY name`
    );
    expect(rows.map((r) => r.name)).toEqual(["001_framework_tables.sql"]);
  });

  it("enforces the signal-registry decay_kind check constraint", async () => {
    const client = pgliteClient(db);
    await migrate(client, MIGRATIONS_DIR);

    await expect(
      client.query(
        `INSERT INTO stigmergy_signal_registry (type, table_name, decay_kind, decay_config, shape_hash)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        ["bad_signal", "signal_bad_signal", "no_decay_here", "{}", "hash"]
      )
    ).rejects.toThrow();
  });

  it("rejects reinforcements whose signal_type is not registered", async () => {
    const client = pgliteClient(db);
    await migrate(client, MIGRATIONS_DIR);

    await expect(
      client.query(
        `INSERT INTO stigmergy_reinforcements (signal_type, signal_id, approved)
         VALUES ($1, gen_random_uuid(), $2)`,
        ["unregistered_signal", true]
      )
    ).rejects.toThrow();
  });
});
