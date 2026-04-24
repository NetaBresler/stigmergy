/**
 * oss-maintainer.ts — the showcase colony.
 *
 * A maintainer colony for a busy open-source project. Ten agents across
 * three sensor types, four working roles, and two validators, coordinating
 * entirely through the medium — no orchestrator, no messaging, no central
 * plan.
 *
 * Mission: keep the project healthy.
 *   - Triage incoming bug reports.
 *   - Answer community questions.
 *   - Review incoming PRs.
 *   - Announce merges back to the community.
 *
 * What makes this interesting is not the number of agents; it's that
 * nobody assigns work. Bugs flow to the triager whose internal affinity
 * matches their component. Questions flow to the responder whose
 * preferences align. A PR review surfaces to whichever reviewer has
 * capacity. Specialization emerges from the pressure landscape —
 * exactly what hierarchical multi-agent frameworks cannot do without a
 * planner to decompose the work.
 *
 * No real GitHub / Slack / Twitter APIs are involved. A `SimulatedWorld`
 * function deposits realistic external events (new issue every ~1.5s,
 * community question every ~2s, PR every ~5s) for the duration of the run,
 * and you can watch the pressure landscape shift in real time.
 *
 * Runs against in-process PGlite. No Postgres install. About 25 seconds
 * wall-clock for the default run.
 *
 *   npx tsx examples/oss-maintainer.ts
 *
 * Scroll to the bottom of the output for the "who handled what" summary —
 * the emergent-specialization story lives there.
 */

import { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import { defineMedium, pgliteClient } from "../src/index.js";
import { runAgent } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const RUN_DURATION_MS = 22_000;
const COMPONENTS = ["frontend", "backend", "infra"] as const;
type Component = (typeof COMPONENTS)[number];

// Per-event cadence for the SimulatedWorld. Deliberately faster than a
// real OSS project so the colony has something to chew on during a demo.
const EVENT_RATE_MS = {
  bug: 1_500,
  question: 2_000,
  pr: 5_000,
  merge: 7_500,
} as const;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const db = new PGlite();
  await db.waitReady;
  const client = pgliteClient(db);

  const medium = defineMedium({
    client,
    charter:
      "# Keep the project healthy.\n" +
      "Real bugs get louder. Real questions get answered. Real PRs get reviewed.\n" +
      "Signals that don't reflect reality fade on their own. Nobody chases them.",
  });

  // -------------------------------------------------------------------
  // Signals — intake and internal. Every one has a decay story.
  // -------------------------------------------------------------------

  const reportedBug = medium.defineSignal({
    type: "reported_bug",
    // 14 real-world days halved = aggressive decay in demo time.
    decay: { kind: "strength", factor: 0.8, period: "30s", floor: 0.08 },
    shape: z.object({
      title: z.string(),
      component: z.string(),
      severity: z.number(),
      source: z.string(), // github | social
      body: z.string(),
      claimed_by: z.string().nullable(),
      claimed_until: z.date().nullable(),
    }),
  });

  const communityQuestion = medium.defineSignal({
    type: "community_question",
    // Fast decay on questions — fresh > stale. 24h in real time.
    decay: { kind: "expiry", after: "24h" },
    shape: z.object({
      channel: z.string(), // slack | discord
      body: z.string(),
      component: z.string(),
      asker: z.string(),
      claimed_by: z.string().nullable(),
      claimed_until: z.date().nullable(),
    }),
  });

  const prSubmitted = medium.defineSignal({
    type: "pr_submitted",
    decay: { kind: "expiry", after: "7d" },
    shape: z.object({
      title: z.string(),
      component: z.string(),
      author: z.string(),
      claimed_by: z.string().nullable(),
      claimed_until: z.date().nullable(),
    }),
  });

  const fixProposal = medium.defineSignal({
    type: "fix_proposal",
    // Strength decay — a proposal a validator hasn't confirmed fades.
    decay: { kind: "strength", factor: 0.6, period: "20s", floor: 0.05 },
    shape: z.object({
      bug_id: z.string(),
      bug_title: z.string(),
      component: z.string(),
      summary: z.string(),
      confidence: z.number(),
    }),
  });

  const draftReply = medium.defineSignal({
    type: "draft_reply",
    decay: { kind: "strength", factor: 0.5, period: "15s", floor: 0.05 },
    shape: z.object({
      question_id: z.string(),
      component: z.string(),
      reply: z.string(),
      confidence: z.number(),
    }),
  });

  const mergeEvent = medium.defineSignal({
    type: "merge_event",
    decay: { kind: "expiry", after: "48h" },
    shape: z.object({
      pr_title: z.string(),
      component: z.string(),
      notes: z.string(),
      claimed_by: z.string().nullable(),
      claimed_until: z.date().nullable(),
    }),
  });

  // -------------------------------------------------------------------
  // Sensor roles — each sensor agent translates external events into
  // signals in the medium. In a real deployment these wrap webhooks.
  // Here, the SimulatedWorld (below) feeds them.
  //
  // A Phase 1 role's localQuery must name exactly one read type, so each
  // sensor role reads back one of its outputs (harmless — sensors don't
  // actually use their view beyond dedup-by-existence checks).
  // -------------------------------------------------------------------

  const GithubListener = medium.defineRole({
    name: "GithubListener",
    reads: [reportedBug],
    writes: [reportedBug, prSubmitted, mergeEvent],
    localQuery: { types: ["reported_bug"], limit: 1 },
  });

  const CommunityListener = medium.defineRole({
    name: "CommunityListener",
    reads: [communityQuestion],
    writes: [communityQuestion],
    localQuery: { types: ["community_question"], limit: 1 },
  });

  const SocialListener = medium.defineRole({
    name: "SocialListener",
    reads: [reportedBug],
    writes: [reportedBug],
    localQuery: { types: ["reported_bug"], limit: 1 },
  });

  // -------------------------------------------------------------------
  // Worker roles — what the colony actually does.
  // -------------------------------------------------------------------

  const TriagerRole = medium.defineRole({
    name: "Triager",
    reads: [reportedBug],
    writes: [fixProposal],
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
      limit: 10,
    },
  });

  const ResponderRole = medium.defineRole({
    name: "Responder",
    reads: [communityQuestion],
    writes: [draftReply],
    localQuery: {
      types: ["community_question"],
      where: { op: "eq", field: "claimed_by", value: null },
      limit: 10,
    },
  });

  const ReviewerRole = medium.defineRole({
    name: "Reviewer",
    reads: [prSubmitted],
    writes: [], // Reviewers post a verdict; the validator handles the reinforcement side.
    localQuery: {
      types: ["pr_submitted"],
      where: { op: "eq", field: "claimed_by", value: null },
      limit: 10,
    },
  });

  const BroadcasterRole = medium.defineRole({
    name: "Broadcaster",
    reads: [mergeEvent],
    writes: [], // Broadcaster "posts" to an external channel (logs, in the demo).
    localQuery: {
      types: ["merge_event"],
      where: { op: "eq", field: "claimed_by", value: null },
      limit: 5,
    },
  });

  // -------------------------------------------------------------------
  // Validators — the selection pressure.
  // -------------------------------------------------------------------

  // Idempotency note: the dispatcher dedups on (trigger, validator),
  // but when a verdict's `target` differs from the trigger, the audit
  // row is written under the target's id and the trigger looks
  // unprocessed on the next tick. We guard with an in-closure Set so
  // the validators are honestly single-shot per trigger.
  const processedProposals = new Set<string>();
  const processedReplies = new Set<string>();

  // A fix proposal that looks solid boosts the matching bug's strength
  // so the colony keeps it loud. A weak proposal gets penalised so the
  // proposal itself fades (the bug is untouched — rejecting a weak
  // proposal shouldn't silence a real bug).
  medium.defineValidator({
    name: "fix_proposal_reviewer",
    triggers: [fixProposal],
    async validate(proposal) {
      if (processedProposals.has(proposal.id)) return { approve: true };
      processedProposals.add(proposal.id);

      const { confidence, bug_id } = proposal.payload;
      if (confidence >= 0.6) {
        return {
          approve: true,
          boost: 0.8 * confidence,
          target: { type: "reported_bug", id: bug_id },
        };
      }
      // Low-confidence proposal — decay the proposal itself.
      return { approve: false, penalty: 0.5 };
    },
  });

  // A draft reply that's confident gets boosted (so the Responder can
  // "see" its own recent wins as reinforced signal). Low-confidence
  // replies get penalised — the reply fades, the question stays open
  // for a sharper Responder.
  medium.defineValidator({
    name: "draft_reply_reviewer",
    triggers: [draftReply],
    async validate(reply) {
      if (processedReplies.has(reply.id)) return { approve: true };
      processedReplies.add(reply.id);

      const { confidence } = reply.payload;
      if (confidence >= 0.55) return { approve: true, boost: 0.5 };
      return { approve: false, penalty: 0.4 };
    },
  });

  // -------------------------------------------------------------------
  // Agents — ten in total.
  // -------------------------------------------------------------------

  // Sensors (simulated external connectors)
  const gh = medium.defineAgent({ id: "sensor-github", roles: [GithubListener] });
  const cm = medium.defineAgent({ id: "sensor-community", roles: [CommunityListener] });
  const sc = medium.defineAgent({ id: "sensor-social", roles: [SocialListener] });

  // Workers. Each triager/responder carries a bias toward one
  // component. In a real colony this bias would live in MEMORY.md and
  // get updated during the consolidation pass at end-of-tick; here we
  // keep it in closure state so the demo runs without writing files,
  // and shift it in response to validator approvals.
  //
  // Initial biases are uniform (1,1,1). Over the run, each agent's
  // own successful triages/replies reinforce the component they
  // happened to win. Specialization compounds. No planner assigned
  // anyone to a component.
  const affinity = (): Record<Component, number> => ({ frontend: 1, backend: 1, infra: 1 });

  const triager1 = medium.defineAgent({ id: "triager-01", roles: [TriagerRole] });
  const triager2 = medium.defineAgent({ id: "triager-02", roles: [TriagerRole] });
  const triager3 = medium.defineAgent({ id: "triager-03", roles: [TriagerRole] });

  const responder1 = medium.defineAgent({ id: "responder-01", roles: [ResponderRole] });
  const responder2 = medium.defineAgent({ id: "responder-02", roles: [ResponderRole] });

  const reviewer1 = medium.defineAgent({ id: "reviewer-01", roles: [ReviewerRole] });
  const reviewer2 = medium.defineAgent({ id: "reviewer-02", roles: [ReviewerRole] });

  const broadcaster = medium.defineAgent({ id: "broadcaster", roles: [BroadcasterRole] });

  await medium.migrate();

  // -------------------------------------------------------------------
  // Observability — per-agent counters for the summary at the end.
  // -------------------------------------------------------------------

  type HandledRow = { agent: string; kind: string; component: Component };
  const handled: HandledRow[] = [];
  const biases = new Map<string, Record<Component, number>>();
  for (const a of [triager1, triager2, triager3, responder1, responder2]) {
    biases.set(a.id, affinity());
  }

  console.log("colony starting. press Ctrl+C to cut short.\n");
  const startedAt = Date.now();
  const withinRun = () => Date.now() - startedAt < RUN_DURATION_MS;

  // -------------------------------------------------------------------
  // Sensor loops — simulated external events.
  // -------------------------------------------------------------------

  // Sensor cadences: each sensor loop runs at its own intervalMs, so
  // one tick = one event of the primary kind. Secondary kinds (PRs,
  // merges on the github sensor) piggyback on a modulo counter.
  let ghTick = 0;
  const ghLoop = runAgent(
    medium,
    gh,
    async (ctx) => {
      if (!withinRun()) return;
      ghTick += 1;
      const bug = synthBug("github");
      console.log(`[github] new issue: "${bug.title}" (${bug.component}, sev ${bug.severity})`);
      await ctx.as(GithubListener).deposit("reported_bug", { ...bug, claimed_by: null, claimed_until: null });
      if (ghTick % 3 === 0) {
        const pr = synthPr();
        console.log(`[github] new PR: "${pr.title}" (${pr.component})`);
        await ctx.as(GithubListener).deposit("pr_submitted", { ...pr, claimed_by: null, claimed_until: null });
      }
      if (ghTick % 5 === 0) {
        const m = synthMerge();
        console.log(`[github] merged: "${m.pr_title}"`);
        await ctx.as(GithubListener).deposit("merge_event", { ...m, claimed_by: null, claimed_until: null });
      }
    },
    { intervalMs: EVENT_RATE_MS.bug }
  );

  const cmLoop = runAgent(
    medium,
    cm,
    async (ctx) => {
      if (!withinRun()) return;
      const q = synthQuestion();
      console.log(`[community] question from @${q.asker}: "${truncate(q.body)}"`);
      await ctx.as(CommunityListener).deposit("community_question", { ...q, claimed_by: null, claimed_until: null });
    },
    { intervalMs: EVENT_RATE_MS.question }
  );

  // Social mentions: less frequent than GitHub issues and slightly
  // noisier (the validator decides what's real).
  const scLoop = runAgent(
    medium,
    sc,
    async (ctx) => {
      if (!withinRun()) return;
      const bug = synthBug("social");
      console.log(`[social] mention: "${bug.title}" (${bug.component})`);
      await ctx.as(SocialListener).deposit("reported_bug", { ...bug, claimed_by: null, claimed_until: null });
    },
    { intervalMs: EVENT_RATE_MS.bug * 2 }
  );

  // -------------------------------------------------------------------
  // Worker loops — the actual triage / response / review / broadcast.
  // -------------------------------------------------------------------

  const triageLoop = (agent: typeof triager1, intervalMs: number) =>
    runAgent(
      medium,
      agent,
      async (ctx) => {
        const queue = await ctx.as(TriagerRole).view();
        if (queue.length === 0) return;

        // Score every visible bug by (effective strength) × (my affinity
        // for its component). Whoever has the highest score wins.
        // Two triagers ending up with the same top pick still resolve
        // cleanly because tryClaim is atomic — exactly one succeeds.
        const bias = biases.get(agent.id) ?? affinity();
        const scored = queue
          .map((s) => ({ signal: s, score: (s.strength ?? 1) * (bias[s.payload.component as Component] ?? 1) }))
          .sort((a, b) => b.score - a.score);

        for (const { signal: bug } of scored) {
          const claimed = await ctx.as(TriagerRole).tryClaim(bug.id, { until: "2m" });
          if (!claimed) continue;

          const component = bug.payload.component as Component;
          const confidence = proposeConfidence(bug, bias);
          console.log(
            `[${agent.id}] propose fix for "${bug.payload.title}" ` +
              `(${component}, conf ${confidence.toFixed(2)}, bias ${bias[component].toFixed(2)})`
          );
          await ctx.as(TriagerRole).deposit("fix_proposal", {
            bug_id: bug.id,
            bug_title: bug.payload.title as string,
            component,
            summary: `auto-triage by ${agent.id}: ${String(bug.payload.body).slice(0, 80)}`,
            confidence,
          });
          handled.push({ agent: agent.id, kind: "triage", component });

          // Reinforce *this* agent's preference for the component it
          // just worked on, weighted by confidence. This is the
          // in-process stand-in for MEMORY.md consolidation.
          bias[component] = Math.min(bias[component] + 0.15 * confidence, 3);
          // Intentionally do NOT release the claim — a triaged bug is
          // done; re-triaging would double-count. The 2m claim TTL
          // auto-releases in the unlikely case this triager crashes.
          return; // one-bug-per-tick, back-pressure over concurrency
        }
      },
      { intervalMs }
    );

  const respondLoop = (agent: typeof responder1, intervalMs: number) =>
    runAgent(
      medium,
      agent,
      async (ctx) => {
        const queue = await ctx.as(ResponderRole).view();
        if (queue.length === 0) return;

        const bias = biases.get(agent.id) ?? affinity();
        const scored = queue
          .map((s) => ({ signal: s, score: bias[s.payload.component as Component] ?? 1 }))
          .sort((a, b) => b.score - a.score);

        for (const { signal: q } of scored) {
          const claimed = await ctx.as(ResponderRole).tryClaim(q.id, { until: "2m" });
          if (!claimed) continue;

          const component = q.payload.component as Component;
          const confidence = Math.min(0.4 + 0.2 * (bias[component] ?? 1), 0.95);
          console.log(
            `[${agent.id}] draft reply to @${q.payload.asker} (${component}, conf ${confidence.toFixed(2)})`
          );
          await ctx.as(ResponderRole).deposit("draft_reply", {
            question_id: q.id,
            component,
            reply: `short answer re: ${String(q.payload.body).slice(0, 60)}`,
            confidence,
          });
          handled.push({ agent: agent.id, kind: "reply", component });
          bias[component] = Math.min(bias[component] + 0.15 * confidence, 3);
          // Same claim-persistence pattern as TriagerRole: answered
          // questions stay out of the queue.
          return;
        }
      },
      { intervalMs }
    );

  const reviewLoop = (agent: typeof reviewer1, intervalMs: number) =>
    runAgent(
      medium,
      agent,
      async (ctx) => {
        const queue = await ctx.as(ReviewerRole).view();
        const pr = queue[0];
        if (!pr) return;
        const claimed = await ctx.as(ReviewerRole).tryClaim(pr.id, { until: "2m" });
        if (!claimed) return;
        const component = pr.payload.component as Component;
        const verdict = Math.random() > 0.25 ? "lgtm" : "changes-requested";
        console.log(`[${agent.id}] review "${pr.payload.title}" (${component}) → ${verdict}`);
        handled.push({ agent: agent.id, kind: "review", component });
        // Reviewed PRs stay claimed — one review per PR per demo run.
      },
      { intervalMs }
    );

  const broadcastLoop = runAgent(
    medium,
    broadcaster,
    async (ctx) => {
      const queue = await ctx.as(BroadcasterRole).view();
      for (const m of queue) {
        const claimed = await ctx.as(BroadcasterRole).tryClaim(m.id, { until: "1m" });
        if (!claimed) continue;
        const component = m.payload.component as Component;
        console.log(`[broadcaster] ANNOUNCE: "${m.payload.pr_title}" shipped (${component})`);
        handled.push({ agent: broadcaster.id, kind: "broadcast", component });
        // Announced merges stay claimed; no double-announces.
      }
    },
    { intervalMs: 900 }
  );

  // Time-box the run, then close the medium to stop every loop cleanly.
  setTimeout(() => {
    void medium.close();
  }, RUN_DURATION_MS);

  // Stagger polling intervals so no single agent always wins the
  // claim race by virtue of equal timing. In a real colony this is
  // implicit (network jitter, token latency); here we do it by hand.
  await Promise.all([
    ghLoop,
    cmLoop,
    scLoop,
    triageLoop(triager1, 310),
    triageLoop(triager2, 370),
    triageLoop(triager3, 430),
    respondLoop(responder1, 420),
    respondLoop(responder2, 490),
    reviewLoop(reviewer1, 650),
    reviewLoop(reviewer2, 820),
    broadcastLoop,
  ]);

  // -------------------------------------------------------------------
  // Summary — the emergent-specialization story.
  // -------------------------------------------------------------------

  console.log("\n".padEnd(72, "─"));
  console.log("colony shutdown. summary:\n");

  console.log("work handled per agent per component:");
  const groupedBy = new Map<string, Record<Component, number>>();
  for (const row of handled) {
    const key = `${row.agent} (${row.kind})`;
    if (!groupedBy.has(key)) groupedBy.set(key, { frontend: 0, backend: 0, infra: 0 });
    (groupedBy.get(key) as Record<Component, number>)[row.component] += 1;
  }
  const header = "  agent                         frontend    backend     infra";
  console.log(header);
  console.log("  " + "─".repeat(header.length - 2));
  for (const [key, counts] of groupedBy) {
    console.log(
      `  ${key.padEnd(30)}${String(counts.frontend).padEnd(12)}${String(counts.backend).padEnd(12)}${String(counts.infra)}`
    );
  }

  console.log("\nfinal per-agent affinity (the stand-in for MEMORY.md):");
  for (const [agentId, bias] of biases) {
    console.log(
      `  ${agentId.padEnd(20)} frontend ${bias.frontend.toFixed(2)}  backend ${bias.backend.toFixed(2)}  infra ${bias.infra.toFixed(2)}`
    );
  }

  console.log("\nthe point:");
  console.log("  No planner assigned any agent to any component.");
  console.log("  Every agent started with uniform affinity (1.0 / 1.0 / 1.0).");
  console.log("  Claims + validator reinforcement routed the work on their own.");
  console.log("  This is what the medium is doing in place of a manager.");
}

// ---------------------------------------------------------------------------
// SimulatedWorld — helpers that manufacture external events.
// ---------------------------------------------------------------------------

const BUG_TEMPLATES: ReadonlyArray<{ title: string; component: Component; severity: number; body: string }> = [
  { title: "login-loops-on-SSO",         component: "backend",  severity: 1, body: "infinite redirect after IdP callback" },
  { title: "stripe-webhook-500",         component: "backend",  severity: 1, body: "retries for hours, nothing ingested" },
  { title: "slow-dashboard-firefox",     component: "frontend", severity: 2, body: "TTI > 8s on cold load, firefox only" },
  { title: "duplicate-welcome-email",    component: "backend",  severity: 2, body: "new signups get two emails" },
  { title: "blank-page-on-tablet",       component: "frontend", severity: 2, body: "iPad landscape, post-login" },
  { title: "build-fails-on-arm",         component: "infra",    severity: 2, body: "CI arm64 runner segfaults mid-test" },
  { title: "edge-cache-staleness",       component: "infra",    severity: 3, body: "some users see day-old data for ~5m" },
  { title: "typo-in-footer",             component: "frontend", severity: 3, body: "says 'Copywrite'" },
  { title: "healthcheck-flapping",       component: "infra",    severity: 2, body: "k8s liveness failing every ~10m" },
  { title: "favicon-missing-safari",     component: "frontend", severity: 3, body: "default icon on some mobile safari" },
];

const QUESTION_TEMPLATES: ReadonlyArray<{ channel: string; component: Component; body: string; asker: string }> = [
  { channel: "slack", component: "backend",  asker: "ana",   body: "how do I rotate the stripe webhook secret without downtime?" },
  { channel: "slack", component: "frontend", asker: "ben",   body: "dashboard feels slow on firefox. known?" },
  { channel: "slack", component: "infra",    asker: "carla", body: "can we ship to the arm runners yet?" },
  { channel: "discord", component: "backend",  asker: "dan",   body: "why does SSO loop sometimes?" },
  { channel: "discord", component: "frontend", asker: "eve",   body: "is there a light mode on the roadmap?" },
  { channel: "slack",   component: "infra",    asker: "finn",  body: "what's the cache TTL at the edge right now?" },
  { channel: "discord", component: "backend",  asker: "gia",   body: "can I batch the exports API? getting 429s." },
  { channel: "discord", component: "frontend", asker: "hal",   body: "ipad layout is blank for me. anyone else?" },
];

const PR_TEMPLATES: ReadonlyArray<{ title: string; component: Component; author: string }> = [
  { title: "fix SSO redirect loop",              component: "backend",  author: "ana" },
  { title: "bump firefox perf budget",           component: "frontend", author: "ben" },
  { title: "arm64 CI runner, first pass",        component: "infra",    author: "carla" },
  { title: "dedupe welcome emails",              component: "backend",  author: "dan" },
  { title: "footer typo + lint rule",            component: "frontend", author: "eve" },
  { title: "edge TTL → 30s for fresh endpoints", component: "infra",    author: "finn" },
];

let bugIdx = 0;
function synthBug(source: "github" | "social"): { title: string; component: Component; severity: number; source: string; body: string } {
  const tmpl = BUG_TEMPLATES[bugIdx % BUG_TEMPLATES.length];
  if (!tmpl) throw new Error("no bug templates");
  bugIdx += 1;
  return { ...tmpl, source };
}

let qIdx = 0;
function synthQuestion(): { channel: string; component: Component; body: string; asker: string } {
  const tmpl = QUESTION_TEMPLATES[qIdx % QUESTION_TEMPLATES.length];
  if (!tmpl) throw new Error("no question templates");
  qIdx += 1;
  return tmpl;
}

let prIdx = 0;
function synthPr(): { title: string; component: Component; author: string } {
  const tmpl = PR_TEMPLATES[prIdx % PR_TEMPLATES.length];
  if (!tmpl) throw new Error("no pr templates");
  prIdx += 1;
  return tmpl;
}

let mergeIdx = 0;
function synthMerge(): { pr_title: string; component: Component; notes: string } {
  const tmpl = PR_TEMPLATES[mergeIdx % PR_TEMPLATES.length];
  if (!tmpl) throw new Error("no merge templates");
  mergeIdx += 1;
  return { pr_title: tmpl.title, component: tmpl.component, notes: "shipped to main" };
}

// Proposal confidence is a function of severity (the bug's inherent
// urgency) and how well the bug matches the agent's current bias.
// No LLM call here — this stands in for ctx.soul/ctx.skills/ctx.memory.
function proposeConfidence(
  bug: { payload: Record<string, unknown>; strength?: number },
  bias: Record<Component, number>
): number {
  const severity = (bug.payload.severity as number) ?? 3;
  const component = bug.payload.component as Component;
  const sevWeight = severity === 1 ? 0.9 : severity === 2 ? 0.7 : 0.4;
  const biasWeight = Math.min((bias[component] ?? 1) / 2, 1);
  return Math.max(0.2, Math.min(0.95, sevWeight * 0.6 + biasWeight * 0.4));
}

function truncate(s: string, n = 60): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
