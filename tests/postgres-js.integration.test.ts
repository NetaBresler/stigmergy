import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { postgresJsClient } from "../src/adapters/postgres.js";
import { defineMedium, upsertAgentId } from "../src/medium.js";
import { buildRoleContext } from "../src/role.js";
import { createValidatorDispatcher } from "../src/validator.js";

/**
 * Integration suite: exercises the postgres-js adapter against a real
 * Postgres. PGlite passes our unit suite; this is the sanity check that
 * production substrate behaves the same. Gated by env var so CI without
 * Postgres skips cleanly.
 *
 * Run:  STIGMERGY_TEST_PG_URL=postgres://user:pass@host:5432/db npm test
 */

const PG_URL = process.env.STIGMERGY_TEST_PG_URL;

async function dropAll(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    DROP TABLE IF EXISTS stigmergy_reinforcements CASCADE;
    DROP TABLE IF EXISTS stigmergy_signal_registry CASCADE;
    DROP TABLE IF EXISTS stigmergy_agents CASCADE;
    DROP TABLE IF EXISTS _stigmergy_migrations CASCADE;
    DROP TABLE IF EXISTS signal_pg_demand CASCADE;
    DROP TABLE IF EXISTS signal_pg_report CASCADE;
  `);
}

describe.skipIf(!PG_URL)("postgres-js adapter (real Postgres)", () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    if (!PG_URL) return;
    sql = postgres(PG_URL, { onnotice: () => {} });
  });

  beforeEach(async () => {
    if (sql) await dropAll(sql);
  });

  afterEach(async () => {
    if (sql) await dropAll(sql);
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it("migrates the framework schema and a per-type table", async () => {
    const client = postgresJsClient(sql);
    const medium = defineMedium({ client });

    medium.defineSignal({
      type: "pg_demand",
      decay: { kind: "strength", factor: 0.9, period: "1h", floor: 0.05 },
      shape: z.object({ niche: z.string() }),
    });

    await medium.migrate();

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name
    `;
    const names = tables.map((t) => t.table_name);
    expect(names).toContain("stigmergy_agents");
    expect(names).toContain("stigmergy_signal_registry");
    expect(names).toContain("stigmergy_reinforcements");
    expect(names).toContain("signal_pg_demand");
  });

  it("round-trips a deposit through RoleContext.view()", async () => {
    const client = postgresJsClient(sql);
    const medium = defineMedium({ client });

    const demand = medium.defineSignal({
      type: "pg_demand",
      decay: { kind: "strength", factor: 0.9, period: "1h", floor: 0.05 },
      shape: z.object({ niche: z.string() }),
    });
    const role = medium.defineRole({
      name: "PgScout",
      reads: [demand],
      writes: [demand],
      localQuery: { types: ["pg_demand"] },
    });
    await medium.migrate();
    await upsertAgentId(client, "pg-agent-1");

    const ctx = buildRoleContext(client, role, "pg-agent-1");
    await ctx.deposit("pg_demand", { niche: "postgres-test" });

    const rows = await ctx.view();
    const match = rows.find((r) => r.payload.niche === "postgres-test");
    expect(match).toBeDefined();
    expect(match?.originAgentId).toBe("pg-agent-1");
    expect(match?.strength).toBeGreaterThan(0.99);
  });

  it("validator dispatcher applies a verdict end-to-end", async () => {
    const client = postgresJsClient(sql);
    const medium = defineMedium({ client });

    const demand = medium.defineSignal({
      type: "pg_demand",
      decay: { kind: "strength", factor: 0.9, period: "1h", floor: 0.05 },
      shape: z.object({ niche: z.string() }),
    });
    const report = medium.defineSignal({
      type: "pg_report",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ niche: z.string(), body: z.string() }),
    });
    const role = medium.defineRole({
      name: "PgScout",
      reads: [demand, report],
      writes: [demand, report],
      localQuery: { types: ["pg_demand"] },
    });
    const validator = medium.defineValidator({
      name: "pg_approver",
      triggers: [report],
      async validate(signal, ctx) {
        const [target] = await ctx.find("pg_demand");
        if (!target) return { approve: false };
        return {
          approve: true,
          boost: 0.4,
          target: { type: "pg_demand", id: target.id },
        };
      },
    });

    await medium.migrate();
    await upsertAgentId(client, "pg-agent-1");

    const scout = buildRoleContext(client, role, "pg-agent-1");
    const dep = await scout.deposit("pg_demand", { niche: "validated-niche" });
    await scout.deposit("pg_report", {
      niche: "validated-niche",
      body: "promising",
    });

    const dispatcher = createValidatorDispatcher(client, [validator]);
    await dispatcher.tick();
    await dispatcher.stop();

    const rows = await client.query<{ strength: string }>(
      `SELECT strength::text AS strength FROM signal_pg_demand WHERE id = $1::uuid`,
      [dep.id]
    );
    expect(Number.parseFloat(rows[0]?.strength ?? "0")).toBeCloseTo(1.4, 5);

    const audit = await client.query<{ validated_by: string; approved: boolean }>(
      `SELECT validated_by, approved FROM stigmergy_reinforcements WHERE signal_type = 'pg_demand'`
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.validated_by).toBe("pg_approver");
    expect(audit[0]?.approved).toBe(true);
  });
});
