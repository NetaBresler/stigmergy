/**
 * A tiny Stigmergy colony, in one file.
 *
 * Three moving parts:
 *   - Scout    — an agent that deposits candidate niches (demand_pheromone).
 *   - Worker   — an agent that picks up high-strength demand and "builds" it.
 *   - Validator — approves scout reports that look plausible; its verdict
 *                 boosts the matching demand pheromone so good niches
 *                 reinforce while weak ones fade.
 *
 * Everything runs in-process against PGlite. No Postgres install needed.
 * Run it:   npx tsx examples/niche-discovery.ts
 */

import { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import { defineMedium, pgliteClient } from "../src/index.js";
import { runAgent } from "../src/runtime.js";

// Seed niches the Scout picks from. A real Scout would generate these
// from web research, past memory, or an LLM call — we keep it static
// so the example is deterministic.
const SEED_NICHES = [
  "pickleball-gear",
  "off-grid-coffee",
  "micro-sauna",
  "snake-plant-subscription",
  "bike-packing-stove",
];

async function main(): Promise<void> {
  const db = new PGlite();
  await db.waitReady;
  const client = pgliteClient(db);

  const medium = defineMedium({
    client,
    charter: "# Find validated, monetizable niches. Ship one per quarter.",
  });

  // -------------------------------------------------------------------
  // Signals
  // -------------------------------------------------------------------

  const demand = medium.defineSignal({
    type: "demand",
    // Strength decay: each hour, strength * 0.8. A niche that isn't
    // reinforced fades away; a niche that gets validator approvals
    // sticks around.
    decay: { kind: "strength", factor: 0.8, period: "1h", floor: 0.05 },
    shape: z.object({
      niche: z.string(),
      claimed_by: z.string().nullable(),
      claimed_until: z.date().nullable(),
    }),
  });

  const report = medium.defineSignal({
    type: "report",
    decay: { kind: "expiry", after: "72h" },
    shape: z.object({
      niche: z.string(),
      body: z.string(),
      recommended_strength: z.number(),
    }),
  });

  const worker_result = medium.defineSignal({
    type: "worker_result",
    decay: { kind: "expiry", after: "24h" },
    shape: z.object({
      niche: z.string(),
      outcome: z.enum(["shipped", "failed"]),
    }),
  });

  // -------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------

  const ScoutRole = medium.defineRole({
    name: "Scout",
    reads: [demand],
    writes: [demand, report],
    localQuery: {
      types: ["demand"],
      orderBy: { field: "strength", direction: "asc" }, // look for faint trails
      limit: 10,
    },
  });

  const WorkerRole = medium.defineRole({
    name: "Worker",
    reads: [demand],
    writes: [worker_result],
    localQuery: {
      types: ["demand"],
      where: {
        op: "and",
        clauses: [
          { op: "gt", field: "strength", value: 1.2 }, // already reinforced
          { op: "eq", field: "claimed_by", value: null },
        ],
      },
      orderBy: { field: "strength", direction: "desc" },
      limit: 3,
    },
  });

  // -------------------------------------------------------------------
  // Validator — gates reinforcement
  // -------------------------------------------------------------------

  medium.defineValidator({
    name: "report_reviewer",
    triggers: [report],
    async validate(signal, ctx) {
      // Trivial quality check: report body must mention "demand".
      const looksGood = /demand/.test(signal.payload.body);
      if (!looksGood) {
        console.log(`  [validator] reject report for "${signal.payload.niche}"`);
        return { approve: false, penalty: 0.2 };
      }
      // Find the matching demand pheromone and boost it.
      const pheromones = await ctx.find("demand");
      const target = pheromones.find(() => true); // simplistic: first match
      if (!target) return { approve: true };
      console.log(
        `  [validator] approve + boost ${signal.payload.recommended_strength} → "${signal.payload.niche}"`
      );
      return {
        approve: true,
        boost: signal.payload.recommended_strength,
        target: { type: "demand", id: target.id },
      };
    },
  });

  // -------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------

  const scout = medium.defineAgent({ id: "scout-01", roles: [ScoutRole] });
  const worker = medium.defineAgent({ id: "worker-01", roles: [WorkerRole] });

  await medium.migrate();

  // -------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------

  console.log("colony starting...\n");

  const scoutLoop = runAgent(
    medium,
    scout,
    async (ctx) => {
      const trails = await ctx.as(ScoutRole).view();
      const seenNiches = new Set(trails.map((t) => t.payload.niche as string));
      const freshNiche = SEED_NICHES.find((n) => !seenNiches.has(n));
      if (!freshNiche) return;

      console.log(`[scout] deposit niche "${freshNiche}"`);
      await ctx.as(ScoutRole).deposit("demand", {
        niche: freshNiche,
        claimed_by: null,
        claimed_until: null,
      });
      await ctx.as(ScoutRole).deposit("report", {
        niche: freshNiche,
        body: `early demand signals look promising for ${freshNiche}`,
        recommended_strength: 0.6,
      });
    },
    { intervalMs: 200, maxTicks: 8 }
  );

  const workerLoop = runAgent(
    medium,
    worker,
    async (ctx) => {
      const ready = await ctx.as(WorkerRole).view();
      if (ready.length === 0) return;
      const target = ready[0];
      if (!target) return;

      const claimed = await ctx.as(WorkerRole).tryClaim(target.id, { until: "10m" });
      if (!claimed) return;

      console.log(
        `[worker] ship "${target.payload.niche}" (strength ${target.strength?.toFixed(2)})`
      );
      await ctx.as(WorkerRole).deposit("worker_result", {
        niche: target.payload.niche as string,
        outcome: "shipped",
      });
    },
    { intervalMs: 300, maxTicks: 8 }
  );

  await Promise.all([scoutLoop, workerLoop]);
  await medium.close();

  // -------------------------------------------------------------------
  // Snapshot the final pressure landscape
  // -------------------------------------------------------------------

  const summary = await client.query<{ niche: string; strength: string }>(
    `SELECT niche, strength::text AS strength FROM signal_demand ORDER BY strength DESC`
  );
  console.log("\nfinal demand pressure:");
  for (const row of summary) {
    console.log(`  ${row.niche.padEnd(28)}  ${Number.parseFloat(row.strength).toFixed(3)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
