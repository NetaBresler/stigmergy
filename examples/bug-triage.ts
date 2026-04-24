/**
 * bug-triage.ts — a tiny Stigmergy colony, in one file.
 *
 * The teaching example. Three agents coordinate through a shared medium,
 * with no orchestrator between them:
 *
 *   Reporter  — files new bug reports into the medium.
 *   Triager   — picks up unclaimed bugs, investigates, writes a triage note.
 *   Validator — reads triage notes and either boosts the bug (confirmed)
 *               or penalises it (duplicate / invalid). The bug's strength
 *               encodes "how loudly does this still need attention."
 *
 * Everything runs against in-process PGlite. No Postgres install, no API
 * keys. Run it:
 *
 *   npx tsx examples/bug-triage.ts
 *
 * What to watch in the output:
 *
 *   - Strength decays every 30s. A bug nobody confirms fades away.
 *   - Confirmed bugs get boosted by the validator and rise back up.
 *   - Duplicates / invalid reports get penalised and drop fast.
 *   - Triager-01 and Triager-02 compete for claims: exactly one wins
 *     each bug. The other moves on.
 *
 * The whole thing is about 240 lines. Every primitive shows up once.
 */

import { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import { defineMedium, pgliteClient } from "../src/index.js";
import { runAgent } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Seed data — a small backlog for the Reporter to file.
// ---------------------------------------------------------------------------

const SEED_BUGS = [
  { title: "login-loops-on-SSO",          component: "auth",     severity: 1, body: "user reports infinite redirect after IdP callback" },
  { title: "slow-dashboard-on-firefox",   component: "frontend", severity: 2, body: "TTI > 8s on cold load, firefox only" },
  { title: "duplicate-welcome-email",     component: "backend",  severity: 2, body: "new signups receive two emails. probably a retry bug" },
  { title: "typo-in-footer",              component: "frontend", severity: 3, body: "says 'Copywrite' instead of 'Copyright'" },
  { title: "favicon-missing",             component: "frontend", severity: 3, body: "some mobile browsers show default icon" },
  { title: "payment-webhook-500s",        component: "backend",  severity: 1, body: "Stripe retries for 3 hours, no ingress" },
] as const;

async function main(): Promise<void> {
  const db = new PGlite();
  await db.waitReady;
  const client = pgliteClient(db);

  const medium = defineMedium({
    client,
    charter: "# Triage reported bugs. Keep real ones loud. Let noise fade.",
  });

  // -------------------------------------------------------------------
  // Signals — one quantitative (strength), one qualitative (body).
  // -------------------------------------------------------------------

  const reportedBug = medium.defineSignal({
    type: "reported_bug",
    // Strength halves every 30 seconds for demo purposes. In a real
    // colony you'd use hours or days. The floor is what makes stale
    // bugs invisible to readers without any delete step.
    decay: { kind: "strength", factor: 0.5, period: "30s", floor: 0.05 },
    shape: z.object({
      title: z.string(),
      component: z.string(),
      severity: z.number(),
      body: z.string(),
      claimed_by: z.string().nullable(),
      claimed_until: z.date().nullable(),
    }),
  });

  const triageNote = medium.defineSignal({
    type: "triage_note",
    // Expiry decay: notes live 24h and then vanish. The framework
    // doesn't care about their strength because the validator uses
    // them to reinforce the *bug*, not the note.
    decay: { kind: "expiry", after: "24h" },
    shape: z.object({
      bug_id: z.string(),
      bug_title: z.string(),
      verdict: z.enum(["confirm", "duplicate", "invalid"]),
      body: z.string(),
      recommended_boost: z.number(),
    }),
  });

  // -------------------------------------------------------------------
  // Roles — what slice of the medium each function sees.
  //
  // A role is a *function*, not an identity. An agent enacts a role.
  // Crucially, each role's localQuery bounds the agent's read surface —
  // neither Reporter nor Triager can see anything outside its slice.
  // -------------------------------------------------------------------

  const ReporterRole = medium.defineRole({
    name: "Reporter",
    reads: [reportedBug],
    writes: [reportedBug],
    // Reporter sees every current bug so it can avoid re-filing dupes.
    localQuery: { types: ["reported_bug"], limit: 50 },
  });

  const TriagerRole = medium.defineRole({
    name: "Triager",
    reads: [reportedBug],
    writes: [triageNote],
    // Triager only cares about unclaimed bugs with strength above
    // the "worth-triaging" floor. Ordered loud-first — pressure drives
    // attention.
    localQuery: {
      types: ["reported_bug"],
      where: {
        op: "and",
        clauses: [
          { op: "eq", field: "claimed_by", value: null },
          { op: "gt", field: "strength", value: 0.1 },
        ],
      },
      orderBy: { field: "strength", direction: "desc" },
      limit: 5,
    },
  });

  // -------------------------------------------------------------------
  // Validator — the reinforcement gate.
  //
  // Triage notes trigger the validator. Its verdict reinforces (or
  // punishes) the *bug* the note is about — this is cross-signal
  // reinforcement via the `target` field.
  // -------------------------------------------------------------------

  // Notes already processed this run. The validator dispatcher dedups
  // on (trigger, validator), but when the verdict's `target` is a
  // *different* signal (cross-signal reinforcement), the framework
  // stamps the audit row with the target's id — so from the
  // dispatcher's point of view the trigger looks unprocessed forever.
  // Tracking processed note ids ourselves keeps the demo's boost from
  // compounding unrealistically on the same note.
  const processedNotes = new Set<string>();

  medium.defineValidator({
    name: "triage_reviewer",
    triggers: [triageNote],
    async validate(note) {
      if (processedNotes.has(note.id)) return { approve: true }; // idempotent no-op
      processedNotes.add(note.id);

      const { verdict, bug_id, bug_title, recommended_boost } = note.payload;
      const target = { type: "reported_bug", id: bug_id };

      if (verdict === "confirm") {
        console.log(`  [validator] confirm "${bug_title}" → boost +${recommended_boost}`);
        return { approve: true, boost: recommended_boost, target };
      }
      if (verdict === "duplicate") {
        console.log(`  [validator] duplicate "${bug_title}" → penalty 0.4`);
        return { approve: false, penalty: 0.4, target };
      }
      console.log(`  [validator] invalid "${bug_title}" → penalty 0.8`);
      return { approve: false, penalty: 0.8, target };
    },
  });

  // -------------------------------------------------------------------
  // Agents — who enacts the roles.
  // Two triagers to show the claim race; one reporter to seed the backlog.
  // -------------------------------------------------------------------

  const reporter = medium.defineAgent({ id: "reporter-01", roles: [ReporterRole] });
  const triager1 = medium.defineAgent({ id: "triager-01", roles: [TriagerRole] });
  const triager2 = medium.defineAgent({ id: "triager-02", roles: [TriagerRole] });

  await medium.migrate();

  // -------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------

  console.log("colony starting...\n");

  const reporterLoop = runAgent(
    medium,
    reporter,
    async (ctx) => {
      const filed = await ctx.as(ReporterRole).view();
      const seen = new Set(filed.map((b) => b.payload.title as string));
      const nextBug = SEED_BUGS.find((b) => !seen.has(b.title));
      if (!nextBug) return;
      console.log(`[reporter] file bug "${nextBug.title}" (sev ${nextBug.severity})`);
      await ctx.as(ReporterRole).deposit("reported_bug", {
        ...nextBug,
        claimed_by: null,
        claimed_until: null,
      });
    },
    { intervalMs: 150, maxTicks: SEED_BUGS.length + 2 }
  );

  const triageLoop = (agentId: string) =>
    runAgent(
      medium,
      agentId === "triager-01" ? triager1 : triager2,
      async (ctx) => {
        const queue = await ctx.as(TriagerRole).view();
        const target = queue[0];
        if (!target) return;

        // tryClaim is atomic — if the other triager already has it,
        // we get `false` and move on without any further coordination.
        const claimed = await ctx.as(TriagerRole).tryClaim(target.id, { until: "2m" });
        if (!claimed) return;

        // Toy heuristic for the demo: sev-1 "backend|auth" bugs are
        // confirmed loud; the two-liner frontend bugs are marked
        // duplicate; the "typo" bug is invalid (not really a bug).
        const verdict = classify(target.payload as { title: string; component: string; severity: number; body: string });
        const boost =
          verdict === "confirm" ? 4 - (target.payload.severity as number) : 0;

        console.log(
          `[${agentId}] ${verdict.padEnd(9)} "${target.payload.title}" (strength ${(target.strength ?? 0).toFixed(2)})`
        );

        await ctx.as(TriagerRole).deposit("triage_note", {
          bug_id: target.id,
          bug_title: target.payload.title as string,
          verdict,
          body: `auto-triage by ${agentId}: ${target.payload.body}`,
          recommended_boost: boost,
        });

        // Intentionally do NOT release the claim. A triaged bug stays
        // claimed (until the 2m TTL elapses) so it drops out of the
        // Triager queue. Re-triage by another agent would just double-
        // count. In a real colony the verdict itself is the terminal
        // state and the bug is either resolved (fades to floor) or
        // boosted loud enough that a downstream role picks it up.
      },
      { intervalMs: 250, maxTicks: 10 }
    );

  await Promise.all([reporterLoop, triageLoop("triager-01"), triageLoop("triager-02")]);

  // Give the validator dispatcher a beat to drain the last notes.
  await new Promise((r) => setTimeout(r, 800));
  await medium.close();

  // -------------------------------------------------------------------
  // Snapshot the final pressure landscape
  // -------------------------------------------------------------------

  const summary = await client.query<{ title: string; strength: string; component: string }>(
    `SELECT title, component, strength::text AS strength FROM signal_reported_bug ORDER BY strength DESC`
  );
  console.log("\nfinal bug pressure:");
  for (const row of summary) {
    const bar = "#".repeat(Math.max(0, Math.round(Number.parseFloat(row.strength) * 4)));
    console.log(
      `  ${row.title.padEnd(30)} ${row.component.padEnd(10)} ${Number.parseFloat(row.strength).toFixed(2)}  ${bar}`
    );
  }
}

// The triage "model" for the demo. In a real colony this is an LLM call
// using ctx.soul, ctx.skills, ctx.memory, and ctx.charter.
function classify(bug: { title: string; component: string; severity: number; body: string }): "confirm" | "duplicate" | "invalid" {
  if (bug.title.includes("typo")) return "invalid";
  if (bug.severity === 3) return "duplicate";
  return "confirm";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
