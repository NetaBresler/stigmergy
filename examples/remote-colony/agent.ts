/**
 * agent.ts — a Stigmergy agent living in its own process.
 *
 *   STIGMERGY_URL=http://127.0.0.1:8787 \
 *   STIGMERGY_TOKEN=stg_… \
 *   npx tsx examples/remote-colony/agent.ts
 *
 * Notice what this file does NOT import: the colony definition, the database,
 * any signal schemas. It connects with a token, asks the server what roles it
 * has, and acts within them. The same binary works as a Reporter or a Triager
 * depending on which token you hand it — the behavior is selected from the
 * session, not hard-wired.
 *
 * In your own project this import is `from "stigmergy"`.
 */

import { type RemoteAgentSession, connect } from "../../src/index.js";

const SEED_BUGS = [
  { title: "login-loops-on-SSO",        component: "auth",     severity: 1, body: "infinite redirect after IdP callback" },
  { title: "slow-dashboard-on-firefox", component: "frontend", severity: 2, body: "TTI > 8s on cold load, firefox only" },
  { title: "duplicate-welcome-email",   component: "backend",  severity: 2, body: "new signups receive two emails" },
  { title: "typo-in-footer",            component: "frontend", severity: 3, body: "says 'Copywrite' instead of 'Copyright'" },
  { title: "payment-webhook-500s",      component: "backend",  severity: 1, body: "Stripe retries for hours, no ingress" },
];

async function main(): Promise<void> {
  const url = process.env.STIGMERGY_URL ?? "http://127.0.0.1:8787";
  const token = process.env.STIGMERGY_TOKEN;
  if (!token) throw new Error("Set STIGMERGY_TOKEN (printed by server.ts on startup).");

  const session = await connect({ url, token });
  const roles = session.roles.map((r) => r.name);
  console.log(`connected as ${session.agentId} — roles: ${roles.join(", ")}`);
  if (session.charter) console.log(`charter: ${session.charter.trim()}`);

  process.on("SIGINT", () => {
    session.close();
    process.exit(0);
  });

  if (roles.includes("Reporter")) {
    await session.run(reporterTick, { intervalMs: 1500 });
  } else if (roles.includes("Triager")) {
    await session.run(triagerTick, { intervalMs: 1000 });
  } else {
    console.log("no known role to enact; idling.");
  }
}

async function reporterTick(s: RemoteAgentSession): Promise<void> {
  const filed = await s.as("Reporter").view();
  const seen = new Set(filed.map((b) => b.payload.title as string));
  const next = SEED_BUGS.find((b) => !seen.has(b.title));
  if (!next) return;
  console.log(`[reporter] file "${next.title}" (sev ${next.severity})`);
  await s.as("Reporter").deposit("reported_bug", { ...next, claimed_by: null, claimed_until: null });
}

async function triagerTick(s: RemoteAgentSession): Promise<void> {
  const queue = await s.as("Triager").view();
  const target = queue[0];
  if (!target) return;
  if (!(await s.as("Triager").tryClaim(target.id, { until: "2m" }))) return;

  const title = target.payload.title as string;
  // Postgres numeric columns arrive as strings on the wire; coerce explicitly.
  const severity = Number(target.payload.severity);
  const verdict = title.includes("typo") ? "invalid" : severity === 3 ? "duplicate" : "confirm";
  const boost = verdict === "confirm" ? 4 - severity : 0;

  console.log(`[${s.agentId}] ${verdict.padEnd(9)} "${title}" (strength ${(target.strength ?? 0).toFixed(2)})`);
  await s.as("Triager").deposit("triage_note", {
    bug_id: target.id,
    bug_title: title,
    verdict,
    body: `auto-triage by ${s.agentId}`,
    recommended_boost: boost,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
