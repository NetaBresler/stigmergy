/**
 * remote-agent.ts — the same bug-triage colony as bug-triage.ts, but the
 * agents talk to the medium over HTTP instead of running in-process.
 *
 * One process here does double duty for the demo: it runs the *server* (which
 * owns the database and the background workers) and three *clients* (the
 * agents) that connect back over the loopback via the SDK. In production these
 * are different processes on different machines — possibly different languages
 * (see examples/remote-colony/agent.py). The agent code is identical to the
 * in-process version except it holds a `session` instead of a `ctx`.
 *
 *   npx tsx examples/remote-agent.ts
 *
 * What to notice: the agents never touch Postgres, never see SQL, never see
 * each other. Each one authenticates with a token, asks for its role's slice,
 * and deposits. Locality is enforced by the server, not by good manners.
 */

import { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import { connect, defineMedium, issueToken, pgliteClient, serve } from "../src/index.js";

const SEED_BUGS = [
  { title: "login-loops-on-SSO",        component: "auth",     severity: 1, body: "infinite redirect after IdP callback" },
  { title: "slow-dashboard-on-firefox", component: "frontend", severity: 2, body: "TTI > 8s on cold load, firefox only" },
  { title: "duplicate-welcome-email",   component: "backend",  severity: 2, body: "new signups receive two emails" },
  { title: "typo-in-footer",            component: "frontend", severity: 3, body: "says 'Copywrite' instead of 'Copyright'" },
  { title: "payment-webhook-500s",      component: "backend",  severity: 1, body: "Stripe retries for 3 hours, no ingress" },
] as const;

async function main(): Promise<void> {
  const db = new PGlite();
  await db.waitReady;
  const medium = defineMedium({
    client: pgliteClient(db),
    charter: "# Triage reported bugs. Keep real ones loud. Let noise fade.",
  });

  // --- the colony definition (same as the embedded example) ---------------
  const reportedBug = medium.defineSignal({
    type: "reported_bug",
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
    decay: { kind: "expiry", after: "24h" },
    shape: z.object({
      bug_id: z.string(),
      bug_title: z.string(),
      verdict: z.enum(["confirm", "duplicate", "invalid"]),
      body: z.string(),
      recommended_boost: z.number(),
    }),
  });

  const ReporterRole = medium.defineRole({
    name: "Reporter",
    reads: [reportedBug],
    writes: [reportedBug],
    localQuery: { types: ["reported_bug"], limit: 50 },
  });
  const TriagerRole = medium.defineRole({
    name: "Triager",
    reads: [reportedBug],
    writes: [triageNote],
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

  medium.defineValidator({
    name: "triage_reviewer",
    triggers: [triageNote],
    async validate(note) {
      const { verdict, bug_id, bug_title, recommended_boost } = note.payload;
      const target = { type: "reported_bug", id: bug_id as string };
      if (verdict === "confirm") {
        console.log(`  [validator] confirm "${bug_title}" → boost +${recommended_boost}`);
        return { approve: true, boost: recommended_boost as number, target };
      }
      console.log(`  [validator] ${verdict} "${bug_title}" → penalty`);
      return { approve: false, penalty: verdict === "invalid" ? 0.8 : 0.4, target };
    },
  });

  medium.defineAgent({ id: "reporter-01", roles: [ReporterRole] });
  medium.defineAgent({ id: "triager-01", roles: [TriagerRole] });
  medium.defineAgent({ id: "triager-02", roles: [TriagerRole] });

  await medium.migrate();

  // --- run it as a server -------------------------------------------------
  const server = await serve(medium, { port: 0, dispatchIntervalMs: 100 });
  console.log(`server up at ${server.url}\n`);

  // --- mint a token per agent and connect over HTTP -----------------------
  const reporterToken = (await issueToken(medium, "reporter-01")).token;
  const triager1Token = (await issueToken(medium, "triager-01")).token;
  const triager2Token = (await issueToken(medium, "triager-02")).token;

  const reporter = await connect({ url: server.url, token: reporterToken });
  const triager1 = await connect({ url: server.url, token: triager1Token });
  const triager2 = await connect({ url: server.url, token: triager2Token });

  console.log("colony starting (agents connected over HTTP)...\n");

  const reporterLoop = reporter.run(
    async (s) => {
      const filed = await s.as("Reporter").view();
      const seen = new Set(filed.map((b) => b.payload.title as string));
      const next = SEED_BUGS.find((b) => !seen.has(b.title));
      if (!next) return;
      console.log(`[reporter] file "${next.title}" (sev ${next.severity})`);
      await s.as("Reporter").deposit("reported_bug", { ...next, claimed_by: null, claimed_until: null });
    },
    { intervalMs: 150, maxTicks: SEED_BUGS.length + 2 }
  );

  const triageLoop = (session: typeof triager1, id: string) =>
    session.run(
      async (s) => {
        const queue = await s.as("Triager").view();
        const target = queue[0];
        if (!target) return;
        if (!(await s.as("Triager").tryClaim(target.id, { until: "2m" }))) return;
        const verdict = classify(target.payload as { title: string; severity: number });
        const boost = verdict === "confirm" ? 4 - (target.payload.severity as number) : 0;
        console.log(`[${id}] ${verdict.padEnd(9)} "${target.payload.title}" (strength ${(target.strength ?? 0).toFixed(2)})`);
        await s.as("Triager").deposit("triage_note", {
          bug_id: target.id,
          bug_title: target.payload.title as string,
          verdict,
          body: `auto-triage by ${id}`,
          recommended_boost: boost,
        });
      },
      { intervalMs: 250, maxTicks: 10 }
    );

  await Promise.all([reporterLoop, triageLoop(triager1, "triager-01"), triageLoop(triager2, "triager-02")]);

  // Let the server's validator worker drain the last notes.
  await new Promise((r) => setTimeout(r, 800));

  const summary = await medium.query<{ title: string; component: string; strength: string }>(
    `SELECT title, component, strength::text AS strength FROM signal_reported_bug ORDER BY strength DESC`
  );
  console.log("\nfinal bug pressure:");
  for (const row of summary) {
    const bar = "#".repeat(Math.max(0, Math.round(Number.parseFloat(row.strength) * 4)));
    console.log(`  ${row.title.padEnd(30)} ${row.component.padEnd(10)} ${Number.parseFloat(row.strength).toFixed(2)}  ${bar}`);
  }

  reporter.close();
  triager1.close();
  triager2.close();
  await server.close();
  await medium.close();
}

function classify(bug: { title: string; severity: number }): "confirm" | "duplicate" | "invalid" {
  if (bug.title.includes("typo")) return "invalid";
  if (bug.severity === 3) return "duplicate";
  return "confirm";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
