import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pgliteClient } from "../src/adapters/pglite.js";
import {
  decayColumnsDDL,
  decayInsertValues,
  durationSeconds,
  effectiveStrengthSQL,
  sweepSignal,
  visibilityPredicate,
} from "../src/decay.js";
import type { Decay } from "../src/types.js";

/**
 * Decay tests. We drive real PGlite and validate each decay kind against
 * hand-rolled per-signal-type tables. `defineSignal()` (step 1.4) will
 * generate these automatically; here, spelling out the DDL keeps the unit
 * under test narrow.
 */

describe("durationSeconds", () => {
  it("parses every supported unit", () => {
    expect(durationSeconds("30s")).toBe(30);
    expect(durationSeconds("15m")).toBe(15 * 60);
    expect(durationSeconds("24h")).toBe(24 * 3600);
    expect(durationSeconds("7d")).toBe(7 * 86400);
  });

  it("rejects malformed inputs", () => {
    expect(() => durationSeconds("forever" as never)).toThrow();
    expect(() => durationSeconds("10" as never)).toThrow();
    expect(() => durationSeconds("10x" as never)).toThrow();
  });
});

describe("decayColumnsDDL", () => {
  it("declares expires_at for expiry decay", () => {
    const ddl = decayColumnsDDL({ kind: "expiry", after: "24h" });
    expect(ddl).toEqual(["expires_at timestamptz NOT NULL"]);
  });

  it("declares strength and last_decay_at for strength decay", () => {
    const ddl = decayColumnsDDL({
      kind: "strength",
      factor: 0.9,
      period: "1h",
    });
    expect(ddl).toEqual([
      "strength numeric NOT NULL",
      "last_decay_at timestamptz NOT NULL DEFAULT now()",
    ]);
  });

  it("declares no columns for reinforcement decay", () => {
    const ddl = decayColumnsDDL({ kind: "reinforcement", window: "6h" });
    expect(ddl).toEqual([]);
  });
});

describe("decayInsertValues", () => {
  it("computes expires_at for expiry decay", () => {
    const now = new Date("2026-04-22T12:00:00Z");
    const vals = decayInsertValues({ kind: "expiry", after: "24h" }, now);
    expect((vals.expires_at as Date).toISOString()).toBe("2026-04-23T12:00:00.000Z");
  });

  it("seeds strength at 1.0 for strength decay", () => {
    const now = new Date("2026-04-22T12:00:00Z");
    const vals = decayInsertValues({ kind: "strength", factor: 0.9, period: "1h" }, now);
    expect(vals.strength).toBe(1.0);
    expect(vals.last_decay_at).toBe(now);
  });

  it("inserts nothing for reinforcement decay", () => {
    expect(decayInsertValues({ kind: "reinforcement", window: "6h" })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Integration: each decay kind, against real PGlite
// ---------------------------------------------------------------------------

describe("expiry decay (integration)", () => {
  let db: PGlite;
  const decay: Decay = { kind: "expiry", after: "24h" };

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(`
      CREATE TABLE test_expiry (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        expires_at timestamptz NOT NULL
      );
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  it("a signal still within its window is visible", async () => {
    await db.exec(`
      INSERT INTO test_expiry (expires_at) VALUES (now() + interval '1 hour');
    `);
    const predicate = visibilityPredicate(decay, {
      signalType: "test_expiry",
      tableAlias: "s",
    });
    const result = await db.query(
      `SELECT count(*)::text AS count FROM test_expiry s WHERE ${predicate}`
    );
    expect((result.rows[0] as { count: string }).count).toBe("1");
  });

  it("an already-expired signal is filtered out by visibilityPredicate", async () => {
    await db.exec(`
      INSERT INTO test_expiry (expires_at) VALUES (now() - interval '1 second');
    `);
    const predicate = visibilityPredicate(decay, {
      signalType: "test_expiry",
      tableAlias: "s",
    });
    const result = await db.query(
      `SELECT count(*)::text AS count FROM test_expiry s WHERE ${predicate}`
    );
    expect((result.rows[0] as { count: string }).count).toBe("0");
  });

  it("sweepSignal deletes expired rows", async () => {
    await db.exec(`
      INSERT INTO test_expiry (expires_at) VALUES
        (now() - interval '1 hour'),
        (now() - interval '5 seconds'),
        (now() + interval '1 hour');
    `);
    const client = pgliteClient(db);
    const stats = await sweepSignal(client, "test_expiry", "test_expiry", decay);
    expect(stats.deleted).toBe(2);

    const remaining = await db.query(`SELECT count(*)::text AS count FROM test_expiry`);
    expect((remaining.rows[0] as { count: string }).count).toBe("1");
  });
});

describe("strength decay (integration)", () => {
  let db: PGlite;
  const decay: Decay = {
    kind: "strength",
    factor: 0.5,
    period: "1h",
    floor: 0.1,
  };

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await db.exec(`
      CREATE TABLE test_strength (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        strength numeric NOT NULL,
        last_decay_at timestamptz NOT NULL
      );
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  it("effectiveStrengthSQL returns approximately stored strength at t=0", async () => {
    await db.exec(`
      INSERT INTO test_strength (strength, last_decay_at)
      VALUES (1.0, now());
    `);
    const expr = effectiveStrengthSQL(decay, {
      signalType: "test_strength",
      tableAlias: "s",
    });
    const result = await db.query(`SELECT (${expr})::text AS strength FROM test_strength s`);
    const value = Number.parseFloat((result.rows[0] as { strength: string }).strength);
    expect(value).toBeGreaterThan(0.99);
    expect(value).toBeLessThanOrEqual(1.0);
  });

  it("effectiveStrengthSQL halves after one period (factor=0.5, period=1h)", async () => {
    await db.exec(`
      INSERT INTO test_strength (strength, last_decay_at)
      VALUES (1.0, now() - interval '1 hour');
    `);
    const expr = effectiveStrengthSQL(decay, {
      signalType: "test_strength",
      tableAlias: "s",
    });
    const result = await db.query(`SELECT (${expr})::text AS strength FROM test_strength s`);
    const value = Number.parseFloat((result.rows[0] as { strength: string }).strength);
    expect(value).toBeGreaterThan(0.49);
    expect(value).toBeLessThan(0.51);
  });

  it("effectiveStrengthSQL returns 0 below the floor", async () => {
    // After 10 periods at factor 0.5, strength is 1/1024 ≈ 0.001, below floor 0.1
    await db.exec(`
      INSERT INTO test_strength (strength, last_decay_at)
      VALUES (1.0, now() - interval '10 hours');
    `);
    const expr = effectiveStrengthSQL(decay, {
      signalType: "test_strength",
      tableAlias: "s",
    });
    const result = await db.query(`SELECT (${expr})::text AS strength FROM test_strength s`);
    expect((result.rows[0] as { strength: string }).strength).toBe("0.0");
  });

  it("sweepSignal persists decayed strength back to storage", async () => {
    await db.exec(`
      INSERT INTO test_strength (strength, last_decay_at)
      VALUES (1.0, now() - interval '1 hour');
    `);
    const client = pgliteClient(db);
    const stats = await sweepSignal(client, "test_strength", "test_strength", decay);
    expect(stats.updated).toBe(1);

    const result = await db.query(
      `SELECT strength::text AS strength, last_decay_at FROM test_strength`
    );
    const row = result.rows[0] as { strength: string; last_decay_at: Date };
    const value = Number.parseFloat(row.strength);
    expect(value).toBeGreaterThan(0.49);
    expect(value).toBeLessThan(0.51);
  });

  it("sweepSignal deletes sub-floor rows", async () => {
    await db.exec(`
      INSERT INTO test_strength (strength, last_decay_at) VALUES
        (1.0, now() - interval '10 hours'),
        (1.0, now() - interval '30 minutes');
    `);
    const client = pgliteClient(db);
    const stats = await sweepSignal(client, "test_strength", "test_strength", decay);
    expect(stats.deleted).toBe(1);

    const remaining = await db.query(`SELECT count(*)::text AS count FROM test_strength`);
    expect((remaining.rows[0] as { count: string }).count).toBe("1");
  });
});

describe("reinforcement decay (integration)", () => {
  let db: PGlite;
  const decay: Decay = { kind: "reinforcement", window: "6h" };

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    // Minimal fixture: the signal registry row and a trivial per-type table.
    await db.exec(`
      CREATE TABLE stigmergy_signal_registry (
        type text PRIMARY KEY,
        table_name text NOT NULL UNIQUE,
        decay_kind text NOT NULL,
        decay_config jsonb NOT NULL,
        shape_hash text NOT NULL
      );
      CREATE TABLE stigmergy_reinforcements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        signal_type text NOT NULL REFERENCES stigmergy_signal_registry(type),
        signal_id uuid NOT NULL,
        approved boolean NOT NULL,
        boost numeric,
        penalty numeric,
        extend_until timestamptz,
        validated_by text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE test_reinforcement (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid()
      );
      INSERT INTO stigmergy_signal_registry (type, table_name, decay_kind, decay_config, shape_hash)
      VALUES ('test_reinforcement', 'test_reinforcement', 'reinforcement', '{}'::jsonb, 'h');
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  it("returns 0 effective strength when no reinforcements exist", async () => {
    await db.exec(`INSERT INTO test_reinforcement DEFAULT VALUES;`);
    const expr = effectiveStrengthSQL(decay, {
      signalType: "test_reinforcement",
      tableAlias: "s",
    });
    const result = await db.query(`SELECT (${expr})::text AS strength FROM test_reinforcement s`);
    expect((result.rows[0] as { strength: string }).strength).toBe("0");
  });

  it("counts approvals in the window", async () => {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO test_reinforcement DEFAULT VALUES RETURNING id::text`
    );
    const signalId = ins.rows[0]?.id as string;

    await db.query(
      `INSERT INTO stigmergy_reinforcements (signal_type, signal_id, approved, boost)
       VALUES ('test_reinforcement', $1::uuid, true, 1),
              ('test_reinforcement', $1::uuid, true, 2),
              ('test_reinforcement', $1::uuid, true, 1)`,
      [signalId]
    );

    const expr = effectiveStrengthSQL(decay, {
      signalType: "test_reinforcement",
      tableAlias: "s",
    });
    const result = await db.query(
      `SELECT (${expr})::text AS strength FROM test_reinforcement s WHERE s.id = $1::uuid`,
      [signalId]
    );
    expect((result.rows[0] as { strength: string }).strength).toBe("4");
  });

  it("ignores reinforcements outside the window", async () => {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO test_reinforcement DEFAULT VALUES RETURNING id::text`
    );
    const signalId = ins.rows[0]?.id as string;

    await db.query(
      `INSERT INTO stigmergy_reinforcements (signal_type, signal_id, approved, boost, created_at)
       VALUES ('test_reinforcement', $1::uuid, true, 5, now() - interval '7 hours')`,
      [signalId]
    );

    const expr = effectiveStrengthSQL(decay, {
      signalType: "test_reinforcement",
      tableAlias: "s",
    });
    const result = await db.query(
      `SELECT (${expr})::text AS strength FROM test_reinforcement s WHERE s.id = $1::uuid`,
      [signalId]
    );
    expect((result.rows[0] as { strength: string }).strength).toBe("0");
  });

  it("subtracts penalties from rejections", async () => {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO test_reinforcement DEFAULT VALUES RETURNING id::text`
    );
    const signalId = ins.rows[0]?.id as string;

    await db.query(
      `INSERT INTO stigmergy_reinforcements (signal_type, signal_id, approved, boost, penalty)
       VALUES ('test_reinforcement', $1::uuid, true, 3, NULL),
              ('test_reinforcement', $1::uuid, false, NULL, 1)`,
      [signalId]
    );

    const expr = effectiveStrengthSQL(decay, {
      signalType: "test_reinforcement",
      tableAlias: "s",
    });
    const result = await db.query(
      `SELECT (${expr})::text AS strength FROM test_reinforcement s WHERE s.id = $1::uuid`,
      [signalId]
    );
    expect((result.rows[0] as { strength: string }).strength).toBe("2");
  });

  it("sweepSignal is a no-op for reinforcement decay", async () => {
    const client = pgliteClient(db);
    const stats = await sweepSignal(client, "test_reinforcement", "test_reinforcement", decay);
    expect(stats).toEqual({
      signalType: "test_reinforcement",
      deleted: 0,
      updated: 0,
    });
  });
});
