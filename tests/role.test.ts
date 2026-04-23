import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { pgliteClient } from "../src/adapters/pglite.js";
import { defineMedium, upsertAgentId } from "../src/medium.js";
import { buildRoleContext } from "../src/role.js";

/**
 * Role tests — prove locality, deposit validation, and atomic claim.
 *
 * Each test stands up a fresh PGlite, defines signals + roles on a medium,
 * migrates, then drives RoleContext directly. run() wiring lands in 1.8;
 * the context is already testable without it.
 */

describe("defineRole validation", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("rejects a role whose reads reference an unregistered signal", () => {
    const medium = defineMedium({ client: pgliteClient(db) });
    const rogue = {
      type: "rogue",
      decay: { kind: "expiry" as const, after: "1h" as const },
      shape: z.object({}),
    };
    expect(() =>
      medium.defineRole({
        name: "Bad",
        reads: [rogue],
        writes: [],
        localQuery: { types: ["rogue"] },
      })
    ).toThrow(/not registered/);
  });

  it("rejects a role whose localQuery.types is not a subset of reads", () => {
    const medium = defineMedium({ client: pgliteClient(db) });
    const signalA = medium.defineSignal({
      type: "a",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({}),
    });
    expect(() =>
      medium.defineRole({
        name: "Bad",
        reads: [signalA],
        writes: [],
        localQuery: { types: ["not_a"] as never },
      })
    ).toThrow(/not in reads/);
  });
});

// ---------------------------------------------------------------------------
// Integration fixture
// ---------------------------------------------------------------------------

async function setupMedium(db: PGlite) {
  const client = pgliteClient(db);
  const medium = defineMedium({ client });

  const demand = medium.defineSignal({
    type: "demand",
    decay: { kind: "strength", factor: 0.5, period: "1h", floor: 0.05 },
    shape: z.object({
      niche: z.string(),
      claimed_by: z.string().nullable(),
      claimed_until: z.date().nullable(),
    }),
  });

  const report = medium.defineSignal({
    type: "report",
    decay: { kind: "expiry", after: "1h" },
    shape: z.object({ body: z.string() }),
  });

  const scout = medium.defineRole({
    name: "Scout",
    reads: [demand],
    writes: [demand, report],
    localQuery: {
      types: ["demand"],
      orderBy: { field: "strength", direction: "desc" },
      limit: 10,
    },
  });

  const quietScout = medium.defineRole({
    name: "QuietScout",
    reads: [demand],
    writes: [],
    localQuery: {
      types: ["demand"],
      where: { op: "lt", field: "strength", value: 0.3 },
    },
  });

  const onlyA = medium.defineRole({
    name: "OnlyA",
    reads: [demand],
    writes: [],
    localQuery: {
      types: ["demand"],
      where: { op: "eq", field: "niche", value: "a" },
    },
  });

  await medium.migrate();
  await upsertAgentId(client, "agent-1");
  await upsertAgentId(client, "agent-2");

  return { medium, client, demand, report, scout, quietScout, onlyA };
}

describe("RoleContext.view()", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("returns deposited signals with decoded payload", async () => {
    const { client, scout } = await setupMedium(db);
    const ctx = buildRoleContext(client, scout, "agent-1");

    await ctx.deposit("demand", {
      niche: "pickleball-gear",
      claimed_by: null,
      claimed_until: null,
    });

    const rows = await ctx.view();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("demand");
    expect(rows[0]?.payload).toEqual({
      niche: "pickleball-gear",
      claimed_by: null,
      claimed_until: null,
    });
    expect(rows[0]?.originAgentId).toBe("agent-1");
    expect(rows[0]?.strength).toBeGreaterThan(0.99);
  });

  it("filters out decayed-below-floor signals", async () => {
    const { client, scout, demand } = await setupMedium(db);
    const ctx = buildRoleContext(client, scout, "agent-1");
    await ctx.deposit("demand", {
      niche: "to-decay",
      claimed_by: null,
      claimed_until: null,
    });
    // Force the stored strength to something well below the floor, as if
    // many decay periods have elapsed without persistence.
    await db.exec(`UPDATE signal_demand SET strength = 0.001;`);
    const rows = await ctx.view();
    expect(rows).toHaveLength(0);
    // The row is still in the table (sweepSignal hasn't run); it's just invisible.
    const raw = await db.query(`SELECT count(*)::text AS count FROM signal_demand`);
    expect((raw.rows[0] as { count: string }).count).toBe("1");
    void demand;
  });

  it("honors user filters against shape fields", async () => {
    const { client, scout, onlyA } = await setupMedium(db);
    const writer = buildRoleContext(client, scout, "agent-1");
    await writer.deposit("demand", { niche: "a", claimed_by: null, claimed_until: null });
    await writer.deposit("demand", { niche: "b", claimed_by: null, claimed_until: null });

    const reader = buildRoleContext(client, onlyA, "agent-1");
    const rows = await reader.view();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.niche).toBe("a");
  });

  it("honors orderBy strength desc", async () => {
    const { client, scout } = await setupMedium(db);
    const ctx = buildRoleContext(client, scout, "agent-1");
    await ctx.deposit("demand", { niche: "weak", claimed_by: null, claimed_until: null });
    await ctx.deposit("demand", { niche: "strong", claimed_by: null, claimed_until: null });
    await db.exec(`UPDATE signal_demand SET strength = 0.2 WHERE niche = 'weak';`);

    const rows = await ctx.view();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.payload.niche).toBe("strong");
    expect(rows[1]?.payload.niche).toBe("weak");
  });
});

describe("RoleContext.deposit()", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("rejects deposits of a signal type not in the role's writes", async () => {
    const { client, quietScout } = await setupMedium(db);
    const ctx = buildRoleContext(client, quietScout, "agent-1");
    await expect(
      // quietScout has no writes.
      ctx.deposit("demand" as never, { niche: "x", claimed_by: null, claimed_until: null } as never)
    ).rejects.toThrow(/not permitted to deposit/);
  });

  it("Zod validation catches malformed payloads before insert", async () => {
    const { client, scout } = await setupMedium(db);
    const ctx = buildRoleContext(client, scout, "agent-1");
    await expect(
      // Missing required `niche` field.
      ctx.deposit("demand" as never, { claimed_by: null, claimed_until: null } as never)
    ).rejects.toThrow();

    // And the table is untouched.
    const rows = await db.query(`SELECT count(*)::text AS count FROM signal_demand`);
    expect((rows.rows[0] as { count: string }).count).toBe("0");
  });
});

describe("RoleContext.tryClaim() / release()", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("claims an unclaimed signal exactly once", async () => {
    const { client, scout } = await setupMedium(db);
    const ctx1 = buildRoleContext(client, scout, "agent-1");
    const ctx2 = buildRoleContext(client, scout, "agent-2");

    const signal = await ctx1.deposit("demand", {
      niche: "race-me",
      claimed_by: null,
      claimed_until: null,
    });
    const firstWin = await ctx1.tryClaim(signal.id, { until: "1h" });
    const secondTry = await ctx2.tryClaim(signal.id, { until: "1h" });
    expect(firstWin).toBe(true);
    expect(secondTry).toBe(false);
  });

  it("another agent can claim after release", async () => {
    const { client, scout } = await setupMedium(db);
    const ctx1 = buildRoleContext(client, scout, "agent-1");
    const ctx2 = buildRoleContext(client, scout, "agent-2");

    const signal = await ctx1.deposit("demand", {
      niche: "handoff",
      claimed_by: null,
      claimed_until: null,
    });
    await ctx1.tryClaim(signal.id, { until: "1h" });
    await ctx1.release(signal.id);
    const reclaim = await ctx2.tryClaim(signal.id, { until: "1h" });
    expect(reclaim).toBe(true);
  });

  it("another agent can claim after claimed_until expires", async () => {
    const { client, scout } = await setupMedium(db);
    const ctx1 = buildRoleContext(client, scout, "agent-1");
    const ctx2 = buildRoleContext(client, scout, "agent-2");

    const signal = await ctx1.deposit("demand", {
      niche: "expired-claim",
      claimed_by: null,
      claimed_until: null,
    });
    await ctx1.tryClaim(signal.id, { until: "1h" });
    // Backdate the claim so it's already expired.
    await db.exec(`UPDATE signal_demand SET claimed_until = now() - interval '1 minute';`);
    const reclaim = await ctx2.tryClaim(signal.id, { until: "1h" });
    expect(reclaim).toBe(true);
  });

  it("release is a no-op on a claim owned by a different agent", async () => {
    const { client, scout } = await setupMedium(db);
    const ctx1 = buildRoleContext(client, scout, "agent-1");
    const ctx2 = buildRoleContext(client, scout, "agent-2");

    const signal = await ctx1.deposit("demand", {
      niche: "not-yours",
      claimed_by: null,
      claimed_until: null,
    });
    await ctx1.tryClaim(signal.id, { until: "1h" });
    await ctx2.release(signal.id); // not this agent's claim
    // Agent-2 still cannot claim it.
    const steal = await ctx2.tryClaim(signal.id, { until: "1h" });
    expect(steal).toBe(false);
  });
});
