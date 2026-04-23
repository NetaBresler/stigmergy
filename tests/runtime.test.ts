import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { pgliteClient } from "../src/adapters/pglite.js";
import { defineMedium } from "../src/medium.js";
import { sweepAllSignals } from "../src/runtime.js";

/**
 * End-to-end runtime tests. The public Medium.run() API is exercised here
 * — agents, validators, sweep, close — wired together with maxTicks to
 * keep the tests deterministic.
 */

describe("Medium.run()", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("invokes the handler `maxTicks` times and resolves", async () => {
    const { runAgent } = await import("../src/runtime.js");
    const client = pgliteClient(db);
    const medium = defineMedium({ client });

    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ niche: z.string() }),
    });
    const role = medium.defineRole({
      name: "Scout",
      reads: [demand],
      writes: [demand],
      localQuery: { types: ["demand"] },
    });
    const scout = medium.defineAgent({ id: "scout-01", roles: [role] });
    await medium.migrate();

    let calls = 0;
    await runAgent(
      medium,
      scout,
      async () => {
        calls += 1;
      },
      { intervalMs: 1, maxTicks: 3 }
    );
    expect(calls).toBe(3);
    await medium.close();
  });

  it("stops cleanly when medium.close() fires mid-loop", async () => {
    const { runAgent } = await import("../src/runtime.js");
    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ niche: z.string() }),
    });
    const role = medium.defineRole({
      name: "Scout",
      reads: [demand],
      writes: [demand],
      localQuery: { types: ["demand"] },
    });
    const agent = medium.defineAgent({ id: "s", roles: [role] });
    await medium.migrate();

    let calls = 0;
    const run = runAgent(
      medium,
      agent,
      async () => {
        calls += 1;
      },
      { intervalMs: 50 }
    );
    // Close after a short delay; the run() promise should resolve.
    setTimeout(() => medium.close(), 120);
    await run;
    expect(calls).toBeGreaterThan(0);
  });

  it("threads deposits from the handler into the medium", async () => {
    const { runAgent } = await import("../src/runtime.js");
    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ niche: z.string() }),
    });
    const role = medium.defineRole({
      name: "Scout",
      reads: [demand],
      writes: [demand],
      localQuery: { types: ["demand"] },
    });
    const scout = medium.defineAgent({ id: "scout-01", roles: [role] });
    await medium.migrate();

    const niches = ["a", "b", "c"];
    let idx = 0;
    await runAgent(
      medium,
      scout,
      async (ctx) => {
        const niche = niches[idx++];
        if (!niche) return;
        await ctx.as(role).deposit("demand", { niche });
      },
      { intervalMs: 1, maxTicks: 3 }
    );

    const rows = await client.query<{ niche: string }>(
      `SELECT niche FROM signal_demand ORDER BY niche`
    );
    expect(rows.map((r) => r.niche)).toEqual(["a", "b", "c"]);
    await medium.close();
  });

  it("validator dispatcher fires alongside the agent loop", async () => {
    const { runAgent } = await import("../src/runtime.js");
    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "strength", factor: 0.99, period: "1h", floor: 0.01 },
      shape: z.object({ niche: z.string() }),
    });
    const role = medium.defineRole({
      name: "Scout",
      reads: [demand],
      writes: [demand],
      localQuery: { types: ["demand"] },
    });
    medium.defineValidator({
      name: "always_approve",
      triggers: [demand],
      async validate() {
        return { approve: true, boost: 0.5 };
      },
    });
    const scout = medium.defineAgent({ id: "scout-01", roles: [role] });
    await medium.migrate();

    await runAgent(
      medium,
      scout,
      async (ctx) => {
        await ctx.as(role).deposit("demand", { niche: "x" });
      },
      { intervalMs: 5, maxTicks: 1 }
    );

    // The dispatcher runs asynchronously. Wait for it to process.
    for (let i = 0; i < 20; i++) {
      const rows = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM stigmergy_reinforcements`
      );
      if ((rows[0]?.count ?? "0") === "1") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const rows = await client.query<{ strength: string }>(
      `SELECT strength::text AS strength FROM signal_demand`
    );
    expect(Number.parseFloat(rows[0]?.strength ?? "0")).toBeCloseTo(1.5, 5);

    await medium.close();
  });
});

describe("sweepAllSignals", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });
  afterEach(async () => {
    await db.close();
  });

  it("runs sweepSignal for every registered signal type", async () => {
    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    medium.defineSignal({
      type: "demand",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ niche: z.string() }),
    });
    medium.defineSignal({
      type: "report",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ body: z.string() }),
    });
    await medium.migrate();

    // Insert agent so FK resolves, then seed an expired row in each table.
    await client.query(`INSERT INTO stigmergy_agents (id) VALUES ('s')`);
    await client.exec(`
      INSERT INTO signal_demand (origin_agent_id, expires_at, niche)
        VALUES ('s', now() - interval '1 hour', 'stale');
      INSERT INTO signal_report (origin_agent_id, expires_at, body)
        VALUES ('s', now() - interval '1 hour', 'stale');
    `);

    const signals = Array.from(
      (await client.query<{ type: string }>(`SELECT type FROM stigmergy_signal_registry`)).values()
    );
    expect(signals.length).toBe(2);

    // Sweep both via the exported helper
    await sweepAllSignals(
      client,
      (function* () {
        yield {
          type: "demand",
          decay: { kind: "expiry", after: "1h" },
          shape: z.object({ niche: z.string() }),
        };
        yield {
          type: "report",
          decay: { kind: "expiry", after: "1h" },
          shape: z.object({ body: z.string() }),
        };
      })()
    );

    for (const table of ["signal_demand", "signal_report"]) {
      const rows = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`
      );
      expect(rows[0]?.count).toBe("0");
    }
    await medium.close();
  });
});
