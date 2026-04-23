import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { pgliteClient } from "../src/adapters/pglite.js";
import { defineMedium, depositSignalRow, tableNameFor } from "../src/medium.js";
import { shapeHash } from "../src/shape.js";

/**
 * Medium + Signal tests. All run against in-process PGlite — no external
 * dependencies required. The tests drive the public surface
 * (defineMedium / defineSignal / migrate / query) and the internal
 * `depositSignalRow` helper exposed for the role runtime.
 */

describe("defineMedium", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    // Every test expects the stigmergy_agents table and a seed agent row,
    // because per-signal-type tables foreign-key into it. The medium's
    // migrate() creates stigmergy_agents itself; we seed the row here.
  });
  afterEach(async () => {
    await db.close();
  });

  it("opens with a bring-your-own client", async () => {
    const medium = defineMedium({ client: pgliteClient(db) });
    expect(medium).toBeDefined();
    await medium.close();
  });

  it("close is idempotent", async () => {
    const medium = defineMedium({ client: pgliteClient(db) });
    await medium.close();
    await medium.close();
  });

  it("does not close a bring-your-own client on medium.close()", async () => {
    const medium = defineMedium({ client: pgliteClient(db) });
    await medium.close();
    // PGlite still usable because medium doesn't own the client.
    const result = await db.query("SELECT 1 AS one");
    expect((result.rows[0] as { one: number }).one).toBe(1);
  });
});

describe("defineSignal + migrate", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("creates a per-type table with framework, decay, and shape columns", async () => {
    const medium = defineMedium({ client: pgliteClient(db) });
    medium.defineSignal({
      type: "demand_pheromone",
      decay: { kind: "strength", factor: 0.9, period: "1h", floor: 0.05 },
      shape: z.object({
        niche: z.string(),
        claimed_by: z.string().nullable(),
      }),
    });
    await medium.migrate();

    const cols = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_name = $1
         ORDER BY column_name`,
      [tableNameFor("demand_pheromone")]
    );
    const names = cols.rows.map((c) => c.column_name);
    expect(names).toContain("id");
    expect(names).toContain("created_at");
    expect(names).toContain("origin_agent_id");
    expect(names).toContain("strength");
    expect(names).toContain("last_decay_at");
    expect(names).toContain("niche");
    expect(names).toContain("claimed_by");

    const niche = cols.rows.find((c) => c.column_name === "niche");
    expect(niche?.is_nullable).toBe("NO");
    const claimed = cols.rows.find((c) => c.column_name === "claimed_by");
    expect(claimed?.is_nullable).toBe("YES");
  });

  it("records the signal in the registry with its shape hash", async () => {
    const shape = z.object({ niche: z.string() });
    const medium = defineMedium({ client: pgliteClient(db) });
    medium.defineSignal({
      type: "scout_report",
      decay: { kind: "expiry", after: "72h" },
      shape,
    });
    await medium.migrate();

    const rows = await db.query<{
      type: string;
      table_name: string;
      decay_kind: string;
      shape_hash: string;
    }>(`SELECT type, table_name, decay_kind, shape_hash FROM stigmergy_signal_registry`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.type).toBe("scout_report");
    expect(rows.rows[0]?.table_name).toBe("signal_scout_report");
    expect(rows.rows[0]?.decay_kind).toBe("expiry");
    expect(rows.rows[0]?.shape_hash).toBe(shapeHash(shape));
  });

  it("migrate is idempotent — second call does not re-create tables", async () => {
    const medium = defineMedium({ client: pgliteClient(db) });
    medium.defineSignal({
      type: "worker_result",
      decay: { kind: "expiry", after: "24h" },
      shape: z.object({ outcome: z.string() }),
    });
    await medium.migrate();
    await medium.migrate();

    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM stigmergy_signal_registry`
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("refuses to migrate when the stored shape hash differs from code", async () => {
    // First deployment: register a signal with shape A.
    let medium = defineMedium({ client: pgliteClient(db) });
    medium.defineSignal({
      type: "evolving_signal",
      decay: { kind: "expiry", after: "24h" },
      shape: z.object({ original_field: z.string() }),
    });
    await medium.migrate();

    // Second deployment: same type name, different shape. Should throw.
    medium = defineMedium({ client: pgliteClient(db) });
    medium.defineSignal({
      type: "evolving_signal",
      decay: { kind: "expiry", after: "24h" },
      shape: z.object({ different_field: z.string() }),
    });
    await expect(medium.migrate()).rejects.toThrow(/drift/i);
  });

  it("refuses to migrate when the decay kind changes", async () => {
    let medium = defineMedium({ client: pgliteClient(db) });
    const shape = z.object({ niche: z.string() });
    medium.defineSignal({
      type: "switcheroo",
      decay: { kind: "expiry", after: "24h" },
      shape,
    });
    await medium.migrate();

    medium = defineMedium({ client: pgliteClient(db) });
    medium.defineSignal({
      type: "switcheroo",
      decay: { kind: "strength", factor: 0.9, period: "1h" },
      shape,
    });
    await expect(medium.migrate()).rejects.toThrow(/drift/i);
  });

  it("rejects invalid signal type names", () => {
    const medium = defineMedium({ client: pgliteClient(db) });
    expect(() =>
      medium.defineSignal({
        type: "BadName",
        decay: { kind: "expiry", after: "24h" },
        shape: z.object({}),
      })
    ).toThrow();
    expect(() =>
      medium.defineSignal({
        type: "has spaces",
        decay: { kind: "expiry", after: "24h" },
        shape: z.object({}),
      })
    ).toThrow();
  });

  it("rejects registering the same type twice with different definitions", () => {
    const medium = defineMedium({ client: pgliteClient(db) });
    medium.defineSignal({
      type: "dup",
      decay: { kind: "expiry", after: "24h" },
      shape: z.object({ a: z.string() }),
    });
    expect(() =>
      medium.defineSignal({
        type: "dup",
        decay: { kind: "expiry", after: "48h" },
        shape: z.object({ a: z.string() }),
      })
    ).toThrow();
  });
});

describe("depositSignalRow (internal helper used by the role runtime)", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("inserts rows with framework metadata, decay fields, and payload", async () => {
    const medium = defineMedium({ client: pgliteClient(db) });
    const signal = medium.defineSignal({
      type: "demand_pheromone",
      decay: { kind: "strength", factor: 0.9, period: "1h" },
      shape: z.object({
        niche: z.string(),
        claimed_by: z.string().nullable(),
      }),
    });
    await medium.migrate();

    // Seed an agent row so the FK succeeds.
    await db.query(`INSERT INTO stigmergy_agents (id) VALUES ($1)`, ["scout-01"]);

    const deposited = await depositSignalRow(
      pgliteClient(db),
      signal,
      "scout-01",
      { niche: "cat-photography", claimed_by: null }
    );
    expect(deposited.id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await db.query<{
      niche: string;
      claimed_by: string | null;
      strength: string;
      origin_agent_id: string;
    }>(`SELECT niche, claimed_by, strength::text, origin_agent_id FROM signal_demand_pheromone`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.niche).toBe("cat-photography");
    expect(rows.rows[0]?.claimed_by).toBeNull();
    expect(rows.rows[0]?.origin_agent_id).toBe("scout-01");
    expect(Number.parseFloat(rows.rows[0]?.strength ?? "0")).toBe(1.0);
  });
});

describe("query (inspection escape hatch)", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("returns raw rows for ad-hoc SQL", async () => {
    const medium = defineMedium({ client: pgliteClient(db) });
    medium.defineSignal({
      type: "pheromone",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ v: z.string() }),
    });
    await medium.migrate();
    const rows = await medium.query(`SELECT 42 AS answer`);
    expect(rows[0]).toEqual({ answer: 42 });
  });
});
