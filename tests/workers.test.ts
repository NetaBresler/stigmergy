import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { pgliteClient } from "../src/adapters/pglite.js";
import { releaseLease, tryAcquireLease } from "../src/lease.js";
import { defineMedium, depositSignalRow, upsertAgentId } from "../src/medium.js";
import { applyVerdict } from "../src/validator.js";

/**
 * Tests for the multi-instance safety machinery: the exactly-once verdict
 * guard (unique index + ON CONFLICT) and the worker lease.
 */

describe("applyVerdict — exactly-once under the unique index", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("applies a verdict once even if the same trigger is processed twice", async () => {
    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "strength", factor: 0.99, period: "1h", floor: 0.01 },
      shape: z.object({ niche: z.string() }),
    });
    await medium.migrate();
    await upsertAgentId(client, "agent-1");

    const { id } = await depositSignalRow(client, demand, "agent-1", { niche: "x" });

    const verdict = { approve: true as const, boost: 0.5 };
    const getKind = async () => "strength" as const;
    // Simulate two dispatcher instances racing past the NOT-EXISTS pre-check.
    await applyVerdict(client, { type: "demand", id }, verdict, "v", "strength", getKind);
    await applyVerdict(client, { type: "demand", id }, verdict, "v", "strength", getKind);

    const reinforcements = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM stigmergy_reinforcements`
    );
    expect(reinforcements[0]?.count).toBe("1");

    const strength = await client.query<{ strength: string }>(
      `SELECT strength::text AS strength FROM signal_demand WHERE id = $1::uuid`,
      [id]
    );
    // 1.0 + 0.5, applied exactly once — not 2.0.
    expect(Number.parseFloat(strength[0]?.strength ?? "0")).toBeCloseTo(1.5, 5);

    await medium.close();
  });

  it("lets two distinct validators each reinforce the same trigger once", async () => {
    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "strength", factor: 0.99, period: "1h", floor: 0.01 },
      shape: z.object({ niche: z.string() }),
    });
    await medium.migrate();
    await upsertAgentId(client, "agent-1");
    const { id } = await depositSignalRow(client, demand, "agent-1", { niche: "x" });

    const getKind = async () => "strength" as const;
    await applyVerdict(client, { type: "demand", id }, { approve: true, boost: 0.5 }, "v1", "strength", getKind);
    await applyVerdict(client, { type: "demand", id }, { approve: true, boost: 0.5 }, "v2", "strength", getKind);

    const reinforcements = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM stigmergy_reinforcements`
    );
    // Distinct validators (distinct validated_by) — both rows survive.
    expect(reinforcements[0]?.count).toBe("2");
    await medium.close();
  });
});

describe("worker lease — single holder with takeover on expiry", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("grants the lease to one holder and refuses others until expiry/release", async () => {
    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    await medium.migrate();

    expect(await tryAcquireLease(client, "dispatch", "A", 60)).toBe(true);
    expect(await tryAcquireLease(client, "dispatch", "B", 60)).toBe(false);
    // The holder can renew.
    expect(await tryAcquireLease(client, "dispatch", "A", 60)).toBe(true);

    // Force the lease stale; another instance takes over.
    await client.query(
      `UPDATE stigmergy_worker_leases SET expires_at = now() - interval '1 second' WHERE worker = 'dispatch'`
    );
    expect(await tryAcquireLease(client, "dispatch", "B", 60)).toBe(true);
    expect(await tryAcquireLease(client, "dispatch", "A", 60)).toBe(false);

    // Explicit release frees it immediately.
    await releaseLease(client, "dispatch", "B");
    expect(await tryAcquireLease(client, "dispatch", "A", 60)).toBe(true);

    await medium.close();
  });
});
