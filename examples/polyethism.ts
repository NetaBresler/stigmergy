/**
 * polyethism.ts — one agent, two roles, chosen by pressure.
 *
 * A tiny demonstration of the Agent primitive doing what Agent-distinct-from-
 * Role buys you: a single persistent identity that drifts between functions
 * as the medium's pressure shifts. The biology term is polyethism — an ant
 * who is a nurse early, a forager late, the same ant throughout.
 *
 * One agent, `researcher-01`, can act as either Explorer or Worker:
 *
 *   - Explorer proposes a new research question when nothing in the medium
 *     is loud enough to act on. It deposits a `proposal` at low strength.
 *   - Worker picks up high-strength proposals (the validator reinforced
 *     them), claims them, and deposits a `finding`.
 *
 * At every tick the agent reads both role views, scores the pressure on
 * each, and enacts whichever role has the loudest signal. No planner, no
 * state machine — just "which view is louder right now."
 *
 * Run it:   npx tsx examples/polyethism.ts
 *
 * Watch the output: early ticks are mostly `[as Explorer]` (empty medium,
 * agent seeds). Once the validator has reinforced some proposals, the same
 * agent starts logging `[as Worker]` alongside the Explorer ticks. One
 * identity, two functions, selected per-tick by the landscape.
 */

import { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import { defineMedium, pgliteClient } from "../src/index.js";
import { runAgent } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Seed pool for the Explorer
// ---------------------------------------------------------------------------

const RESEARCH_QUESTIONS = [
  "does signal density predict colony throughput",
  "can memory consolidation be delegated across agents",
  "what decay curve minimises stuck-signal pathologies",
  "is claim-lease duration tunable per role automatically",
  "how does charter-change transient affect pressure landscape",
  "when does inhibitory stigmergy out-perform positive-only",
  "what role-count per agent balances drift and overhead",
];

// Simple deterministic approval for the demo — every 3rd proposal
// gets a strong boost, the rest get a small one. Enough variance
// to produce an uneven pressure landscape the agent reacts to.
let approvalIndex = 0;

async function main(): Promise<void> {
  const db = new PGlite();
  await db.waitReady;
  const client = pgliteClient(db);

  const medium = defineMedium({
    client,
    charter: "# Research mission: ship questions, then ship findings.",
  });

  // -------------------------------------------------------------------
  // Signals
  // -------------------------------------------------------------------

  const proposal = medium.defineSignal({
    type: "proposal",
    decay: { kind: "strength", factor: 0.6, period: "30s", floor: 0.05 },
    shape: z.object({
      question: z.string(),
      claimed_by: z.string().nullable(),
      claimed_until: z.date().nullable(),
    }),
  });

  const finding = medium.defineSignal({
    type: "finding",
    decay: { kind: "expiry", after: "24h" },
    shape: z.object({
      question: z.string(),
      body: z.string(),
    }),
  });

  // -------------------------------------------------------------------
  // Roles
  //
  // Both roles read `proposal`, but with very different local queries.
  // That's the whole mechanism: one signal type, two *views* of it.
  // -------------------------------------------------------------------

  const ExplorerRole = medium.defineRole({
    name: "Explorer",
    reads: [proposal],
    writes: [proposal],
    // Explorer looks at *every* proposal (capped) — it wants to know
    // what's already been suggested so it doesn't duplicate. The
    // handler turns an empty-or-thin view into "propose something new."
    localQuery: {
      types: ["proposal"],
      orderBy: { field: "strength", direction: "asc" },
      limit: 20,
    },
  });

  const WorkerRole = medium.defineRole({
    name: "Worker",
    reads: [proposal],
    writes: [finding],
    // Worker only sees reinforced, unclaimed proposals. Anything
    // below 1.0 is invisible to this view entirely.
    localQuery: {
      types: ["proposal"],
      where: {
        op: "and",
        clauses: [
          { op: "eq", field: "claimed_by", value: null },
          { op: "gt", field: "strength", value: 1.0 },
        ],
      },
      orderBy: { field: "strength", direction: "desc" },
      limit: 3,
    },
  });

  // -------------------------------------------------------------------
  // Validator — every proposal gets a verdict; every 3rd is a strong boost.
  // -------------------------------------------------------------------

  medium.defineValidator({
    name: "proposal_reviewer",
    triggers: [proposal],
    async validate(signal) {
      approvalIndex += 1;
      const strong = approvalIndex % 3 === 0;
      const boost = strong ? 1.2 : 0.15;
      console.log(`  [validator] boost +${boost.toFixed(2)} "${signal.payload.question}"`);
      return { approve: true, boost };
    },
  });

  // -------------------------------------------------------------------
  // Agent — one identity, two roles. Polyethism.
  // -------------------------------------------------------------------

  const researcher = medium.defineAgent({
    id: "researcher-01",
    roles: [ExplorerRole, WorkerRole],
  });

  await medium.migrate();

  // -------------------------------------------------------------------
  // Run — the handler picks a role per tick based on pressure.
  // -------------------------------------------------------------------

  console.log("colony starting — one agent, two roles...\n");

  const roleCounts = { Explorer: 0, Worker: 0 };

  await runAgent(
    medium,
    researcher,
    async (ctx) => {
      const explorerView = await ctx.as(ExplorerRole).view();
      const workerView = await ctx.as(WorkerRole).view();

      const workerPressure = workerView[0]?.strength ?? 0;

      // Decision rule: if Worker's view has anything in it, act as Worker.
      // Otherwise drop to Explorer. This is the stigmergic choice — the
      // agent isn't asking "what should I do next?", it's asking "what
      // is the medium loudest about right now?"
      if (workerPressure > 0) {
        const target = workerView[0];
        if (!target) return;

        const claimed = await ctx.as(WorkerRole).tryClaim(target.id, { until: "2m" });
        if (!claimed) {
          // Somebody else got it first (not in this single-agent demo, but
          // production topologies have contention). Fall through to Explorer.
        } else {
          roleCounts.Worker += 1;
          console.log(
            `[as Worker]   execute "${target.payload.question}" (strength ${target.strength?.toFixed(2)})`
          );
          await ctx.as(WorkerRole).deposit("finding", {
            question: target.payload.question as string,
            body: `executed by ${ctx.agentId}: result pending review`,
          });
          // Deliberately no release(): the claim is the "handled" marker.
          // Worker's view filters on claimed_by IS NULL, so the proposal
          // falls out of this role's surface and the next tick moves on
          // to the next loudest (or drops back into Explorer). A real
          // colony might let the claim lapse and rely on strength decay
          // to do the same job; for a 3-second demo, holding the claim
          // is cleaner than racing decay.
          return;
        }
      }

      // Explorer path: propose an unseen question.
      const seen = new Set(explorerView.map((p) => p.payload.question as string));
      const fresh = RESEARCH_QUESTIONS.find((q) => !seen.has(q));
      if (!fresh) return;

      roleCounts.Explorer += 1;
      console.log(`[as Explorer] propose "${fresh}"`);
      await ctx.as(ExplorerRole).deposit("proposal", {
        question: fresh,
        claimed_by: null,
        claimed_until: null,
      });
    },
    { intervalMs: 200, maxTicks: 16 }
  );

  await new Promise((r) => setTimeout(r, 800));
  await medium.close();

  // -------------------------------------------------------------------
  // Summary — how did the one agent split its time?
  // -------------------------------------------------------------------

  console.log("\nrole-enactment tally for researcher-01:");
  console.log(`  Explorer ticks: ${roleCounts.Explorer}`);
  console.log(`  Worker ticks:   ${roleCounts.Worker}`);
  console.log(
    `  → one agent, split ${roleCounts.Explorer}/${roleCounts.Worker} across roles.` +
      ` The medium picked for it.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
