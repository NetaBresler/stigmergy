import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { pgliteClient } from "../src/adapters/pglite.js";
import { defineMedium, upsertAgentId } from "../src/medium.js";
import { buildRoleContext } from "../src/role.js";
import { createValidatorDispatcher } from "../src/validator.js";

/**
 * Validator dispatch + verdict application tests. Drive the dispatcher
 * synchronously via `tick()`; don't rely on setInterval cadence in tests.
 */

async function setup(db: PGlite) {
  const client = pgliteClient(db);
  const medium = defineMedium({ client });

  const demand = medium.defineSignal({
    type: "demand",
    decay: { kind: "strength", factor: 0.9, period: "1h", floor: 0.01 },
    shape: z.object({ niche: z.string() }),
  });

  const report = medium.defineSignal({
    type: "report",
    decay: { kind: "expiry", after: "72h" },
    shape: z.object({ niche: z.string(), body: z.string() }),
  });

  const scoutRole = medium.defineRole({
    name: "Scout",
    reads: [demand, report],
    writes: [demand, report],
    localQuery: { types: ["demand"] },
  });

  await medium.migrate();
  await upsertAgentId(client, "agent-1");

  return { medium, client, demand, report, scoutRole };
}

describe("validator dispatcher — approve + boost on strength-decay target", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("applies a boost to the target signal and records the reinforcement", async () => {
    const { medium, client, demand, report, scoutRole } = await setup(db);

    const validator = medium.defineValidator({
      name: "report_approver",
      triggers: [report],
      async validate(signal, ctx) {
        const [targetPheromone] = await ctx.find("demand");
        if (!targetPheromone) return { approve: false };
        return {
          approve: true,
          boost: 0.5,
          target: { type: "demand", id: targetPheromone.id },
        };
      },
    });

    const scout = buildRoleContext(client, scoutRole, "agent-1");
    const dep = await scout.deposit("demand", { niche: "pickleball" });
    await scout.deposit("report", { niche: "pickleball", body: "looks promising" });

    const dispatcher = createValidatorDispatcher(client, [validator], { intervalMs: 99_999 });
    await dispatcher.tick();
    await dispatcher.stop();

    // Strength on demand was boosted (started at 1.0, now 1.5).
    const strengths = await client.query<{ strength: string }>(
      `SELECT strength::text AS strength FROM signal_demand WHERE id = $1::uuid`,
      [dep.id]
    );
    expect(Number.parseFloat(strengths[0]?.strength ?? "0")).toBeCloseTo(1.5, 5);

    // Reinforcement row exists and names the target.
    const rows = await client.query<{
      signal_type: string;
      signal_id: string;
      approved: boolean;
      boost: string;
      validated_by: string;
    }>(
      `SELECT signal_type, signal_id::text AS signal_id, approved, boost::text AS boost, validated_by
         FROM stigmergy_reinforcements`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signal_type).toBe("demand");
    expect(rows[0]?.signal_id).toBe(dep.id);
    expect(rows[0]?.approved).toBe(true);
    expect(Number.parseFloat(rows[0]?.boost ?? "0")).toBe(0.5);
    expect(rows[0]?.validated_by).toBe("report_approver");
  });
});

describe("validator dispatcher — reject + penalty", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("decrements strength floor-at-zero and logs the penalty", async () => {
    const { medium, client, demand, scoutRole } = await setup(db);

    const validator = medium.defineValidator({
      name: "demand_pruner",
      triggers: [demand],
      async validate() {
        return { approve: false, penalty: 0.8 };
      },
    });

    const scout = buildRoleContext(client, scoutRole, "agent-1");
    const dep = await scout.deposit("demand", { niche: "stale" });

    const dispatcher = createValidatorDispatcher(client, [validator], { intervalMs: 99_999 });
    await dispatcher.tick();
    await dispatcher.stop();

    const strengths = await client.query<{ strength: string }>(
      `SELECT strength::text AS strength FROM signal_demand WHERE id = $1::uuid`,
      [dep.id]
    );
    expect(Number.parseFloat(strengths[0]?.strength ?? "0")).toBeCloseTo(0.2, 5);
  });

  it("clamps penalty at zero, never negative", async () => {
    const { medium, client, demand, scoutRole } = await setup(db);
    const validator = medium.defineValidator({
      name: "harsh",
      triggers: [demand],
      async validate() {
        return { approve: false, penalty: 999 };
      },
    });
    const scout = buildRoleContext(client, scoutRole, "agent-1");
    const dep = await scout.deposit("demand", { niche: "punish" });
    const dispatcher = createValidatorDispatcher(client, [validator], { intervalMs: 99_999 });
    await dispatcher.tick();
    await dispatcher.stop();
    const strengths = await client.query<{ strength: string }>(
      `SELECT strength::text AS strength FROM signal_demand WHERE id = $1::uuid`,
      [dep.id]
    );
    expect(Number.parseFloat(strengths[0]?.strength ?? "0")).toBe(0);
  });
});

describe("validator dispatcher — approve + extend on expiry-decay target", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("pushes expires_at out by the extend duration", async () => {
    const { medium, client, report, scoutRole } = await setup(db);
    const validator = medium.defineValidator({
      name: "report_keeper",
      triggers: [report],
      async validate() {
        return { approve: true, extend: "24h" };
      },
    });

    const scout = buildRoleContext(client, scoutRole, "agent-1");
    const dep = await scout.deposit("report", { niche: "x", body: "hello" });

    // Capture initial expires_at
    const before = await client.query<{ expires_at: Date }>(
      `SELECT expires_at FROM signal_report WHERE id = $1::uuid`,
      [dep.id]
    );
    const before_ms = (before[0]?.expires_at as Date).getTime();

    const dispatcher = createValidatorDispatcher(client, [validator], { intervalMs: 99_999 });
    await dispatcher.tick();
    await dispatcher.stop();

    const after = await client.query<{ expires_at: Date }>(
      `SELECT expires_at FROM signal_report WHERE id = $1::uuid`,
      [dep.id]
    );
    const after_ms = (after[0]?.expires_at as Date).getTime();
    const delta_s = (after_ms - before_ms) / 1000;
    expect(delta_s).toBeGreaterThan(24 * 3600 - 2);
    expect(delta_s).toBeLessThan(24 * 3600 + 2);
  });
});

describe("validator dispatcher — idempotency", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("does not re-validate a signal it has already validated", async () => {
    const { medium, client, demand, scoutRole } = await setup(db);
    let calls = 0;
    const validator = medium.defineValidator({
      name: "once",
      triggers: [demand],
      async validate() {
        calls += 1;
        return { approve: true, boost: 0.1 };
      },
    });

    const scout = buildRoleContext(client, scoutRole, "agent-1");
    await scout.deposit("demand", { niche: "once" });

    const dispatcher = createValidatorDispatcher(client, [validator], { intervalMs: 99_999 });
    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.stop();

    expect(calls).toBe(1);
  });

  it("picks up new signals on subsequent ticks", async () => {
    const { medium, client, demand, scoutRole } = await setup(db);
    let calls = 0;
    const validator = medium.defineValidator({
      name: "v",
      triggers: [demand],
      async validate() {
        calls += 1;
        return { approve: true };
      },
    });

    const scout = buildRoleContext(client, scoutRole, "agent-1");
    const dispatcher = createValidatorDispatcher(client, [validator], { intervalMs: 99_999 });

    await scout.deposit("demand", { niche: "first" });
    await dispatcher.tick();
    expect(calls).toBe(1);

    await scout.deposit("demand", { niche: "second" });
    await dispatcher.tick();
    expect(calls).toBe(2);

    await dispatcher.stop();
  });
});

describe("validator dispatcher — hot-swap", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("updateValidator changes behavior on subsequent ticks", async () => {
    const { medium, client, demand, scoutRole } = await setup(db);
    const validator = medium.defineValidator({
      name: "swap_me",
      triggers: [demand],
      async validate() {
        return { approve: true, boost: 0.1 };
      },
    });

    const scout = buildRoleContext(client, scoutRole, "agent-1");
    const dispatcher = createValidatorDispatcher(client, [validator], { intervalMs: 99_999 });

    const a = await scout.deposit("demand", { niche: "a" });
    await dispatcher.tick();

    medium.updateValidator(validator, async () => ({ approve: false, penalty: 0.5 }));

    const b = await scout.deposit("demand", { niche: "b" });
    await dispatcher.tick();
    await dispatcher.stop();

    const byNiche = async (id: string) => {
      const rows = await client.query<{ strength: string }>(
        `SELECT strength::text AS strength FROM signal_demand WHERE id = $1::uuid`,
        [id]
      );
      return Number.parseFloat(rows[0]?.strength ?? "0");
    };
    expect(await byNiche(a.id)).toBeCloseTo(1.1, 5);
    expect(await byNiche(b.id)).toBeCloseTo(0.5, 5);
  });
});
