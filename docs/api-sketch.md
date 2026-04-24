# API sketch — a worked example

This walks through what using Stigmergy feels like, end-to-end. The runtime it describes is the same one `examples/bug-triage.ts` runs against — pull both open side-by-side.

## Phase 1 revisions

Three changes to the Phase 0 surface as implementation landed:

- **`medium.migrate()`** — explicit migration step. Apply framework tables and create per-signal-type tables from the currently registered definitions. Idempotent; rejects when a registered signal's stored shape hash no longer matches the code.
- **`defineMedium({ client })`** — bring-your-own-client overload. The `{ url }` form opens postgres-js internally; `{ client }` accepts any `MediumClient` (PGlite in tests; a pooled connection or pgbouncer in production).
- **`defineSignal` returns the Signal, not a widened Medium.** The Phase 0 types had `defineSignal` return `Medium<[...signals, newSignal]>` to make "signal must belong to this medium" a compile-time check. In practice that broke the natural idiom `const bug = medium.defineSignal(...); defineRole({ reads: [bug] })`. The accumulating type parameter has been removed from `Medium`; the constraint now lives at runtime (the medium rejects roles/validators referencing unregistered signals at `migrate()` time).

---

## The scenario

A toy bug-triage colony with the following moving parts:

- **One quantitative signal** — a `reported_bug` with a strength that encodes "how loudly does this still need attention" and decays if nobody confirms it.
- **One qualitative signal** — a `triage_note` with a freeform body, a structured verdict (`confirm` / `duplicate` / `invalid`), and a link back to the bug it's about.
- **Two roles** — `ReporterRole` (file new bugs) and `TriagerRole` (pick up unclaimed bugs, investigate, write a triage note).
- **Three agents** — one Reporter and two competing Triagers (so claims are non-trivial).
- **One validator** — reads triage notes. Confirmed notes boost the bug's strength; duplicates and invalid reports push it down. This is the cross-signal reinforcement that keeps real bugs loud and noise quiet.
- **A charter** at colony level, with optional soul, skills, and memory files per agent.

Small enough to fit on a screen. Real enough to exercise every primitive.

---

## Opening the medium

```ts
import { defineMedium } from "stigmergy";
import { z } from "zod";

const medium = defineMedium({
  url: process.env.DATABASE_URL!,
  charter: "./charter.md",  // shared across every agent
});
```

The charter is loaded once and exposed as `ctx.charter` in every handler. One per medium.

---

## Defining signals

A quantitative signal — a bug record with numeric strength that decays:

```ts
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
```

Every 30 seconds, every `reported_bug`'s strength is multiplied by 0.5. Below `0.05` it's invisible to readers. (In production you'd use hours or days; the example uses seconds so the decay is watchable.)

`claimed_by` / `claimed_until` are shape fields — the claim-as-convention pattern. No new primitive, just fields. `ctx.tryClaim()` does the atomic write.

A qualitative signal — a triage note that carries a verdict:

```ts
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
```

Notes live 24 hours. The validator applies their verdict to the matching `reported_bug` (see below).

**Rule the framework enforces:** `defineSignal` without `decay` is a type error. Not runtime, not lint — the code does not compile.

---

## Defining roles

Roles describe *functions*, not agents. They say what signals get read, what gets written, and what slice of the medium is visible.

```ts
const ReporterRole = medium.defineRole({
  name: "Reporter",
  reads: [reportedBug],
  writes: [reportedBug],
  // Phase 1: localQuery.types must name exactly one read type.
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
```

Reporter sees every current bug so it can avoid re-filing duplicates. Triager sees only unclaimed bugs above the "worth-triaging" strength floor, loudest first. Neither knows the other exists. Each is a bounded view; an agent in that role cannot look beyond it.

---

## Defining a validator

The validator watches `triage_note` deposits and applies their verdict to the matching `reported_bug`:

```ts
const triageReviewer = medium.defineValidator({
  name: "triage_reviewer",
  triggers: [triageNote],
  async validate(note) {
    const { verdict, bug_id, recommended_boost } = note.payload;
    const target = { type: "reported_bug", id: bug_id };

    if (verdict === "confirm") return { approve: true, boost: recommended_boost, target };
    if (verdict === "duplicate") return { approve: false, penalty: 0.4, target };
    return { approve: false, penalty: 0.8, target };
  },
});
```

Two shape notes the runtime added during Phase 1:

- **`name`** is required. Reinforcements are logged with `validated_by = name` so multiple validators on the same trigger are attributed independently, and audit history survives restarts.
- **`target`** is `{ type, id }`, not a bare id. A bare id would force the runtime to scan every per-type table to find where the target lives; requiring the type makes the mutation cheap and the code readable.

The verdict is uniform whether the validator is rule-based (like this), agent-based (swap the body for an LLM call), or human-in-the-loop (await a promise that a webhook resolves). The framework applies the verdict.

If goals change mid-project, hot-swap the rule — `medium.updateValidator(triageReviewer, newValidate)` — and the next note is judged under the new regime. The colony re-orients within one decay cycle.

---

## Defining agents

Three agents: one Reporter and two competing Triagers:

```ts
const reporter = medium.defineAgent({
  id: "reporter-01",
  soul:  "./agents/reporter/SOUL.md",
  skills: ["./agents/reporter/skills/normalise-issue.md"],
  memory: "./agents/reporter/MEMORY.md",
  roles: [ReporterRole],
});

const triager1 = medium.defineAgent({ id: "triager-01", roles: [TriagerRole] });
const triager2 = medium.defineAgent({ id: "triager-02", roles: [TriagerRole] });
```

The four identity documents:

- **SOUL.md** — who this agent is. Personality, voice, values, boundaries. Rarely changes.
- **SKILL.md** files — what this agent can do. Added/removed as capabilities evolve.
- **MEMORY.md** — what this agent has learned. Consolidated, not streamed. Rewritten at end of each run.
- **CHARTER.md** — colony-wide mission. Inherited from the medium.

See `docs/files.md` for the full convention.

All four are optional. An agent with none is a valid agent — it just has a stable id and a set of enactable roles.

---

## Running the agents

```ts
await medium.migrate();

// Reporter files seed bugs one per tick.
await medium.run(reporter, async (ctx) => {
  const filed = await ctx.as(ReporterRole).view();
  const seen = new Set(filed.map(b => b.payload.title));
  const nextBug = SEED_BUGS.find(b => !seen.has(b.title));
  if (!nextBug) return;

  await ctx.as(ReporterRole).deposit("reported_bug", {
    ...nextBug,
    claimed_by: null,
    claimed_until: null,
  });
});

// Triagers compete for claims and write a triage_note each.
const triage = async (ctx: AgentContext<typeof triager1>) => {
  const queue = await ctx.as(TriagerRole).view();
  const target = queue[0];
  if (!target) return;

  // tryClaim is atomic. If the other triager already has it, we get
  // `false` and move on without any further coordination.
  const claimed = await ctx.as(TriagerRole).tryClaim(target.id, { until: "2m" });
  if (!claimed) return;

  const verdict = classify(target.payload);
  const recommended_boost =
    verdict === "confirm" ? 4 - target.payload.severity : 0;

  await ctx.as(TriagerRole).deposit("triage_note", {
    bug_id: target.id,
    bug_title: target.payload.title,
    verdict,
    body: `auto-triage: ${target.payload.body}`,
    recommended_boost,
  });

  // Intentionally do NOT release the claim — a triaged bug is done;
  // re-triaging would double-count. The 2m claim TTL auto-releases in
  // the unlikely case this triager crashes.
};

await Promise.all([
  medium.run(triager1, triage),
  medium.run(triager2, triage),
]);
```

What's in the context:

- `ctx.soul` / `ctx.skills` / `ctx.memory` / `ctx.charter` — loaded text, passed into LLM prompts by the handler.
- `ctx.as(role)` — narrows to a role's bounded surface. Read is `role.localQuery`; write is constrained to `role.writes`.
- `ctx.writeMemory(text)` — replaces MEMORY.md with the consolidated summary. Forgetting happens by omission.
- No `ctx.medium`. No unbounded read. No cross-agent messaging. The agent's surface is bounded by its roles, period.

---

## The shape of the whole thing

```ts
const medium = defineMedium({ url, charter });

// Signals
const reportedBug = medium.defineSignal({ ... });
const triageNote  = medium.defineSignal({ ... });

// Roles
const ReporterRole = medium.defineRole({ ... });
const TriagerRole  = medium.defineRole({ ... });

// Validators
const triageReviewer = medium.defineValidator({ ... });

// Agents
const reporter = medium.defineAgent({ id: "reporter-01", roles: [ReporterRole], ... });
const triager1 = medium.defineAgent({ id: "triager-01", roles: [TriagerRole] });
const triager2 = medium.defineAgent({ id: "triager-02", roles: [TriagerRole] });

await Promise.all([
  medium.run(reporter, reporterHandler),
  medium.run(triager1, triageHandler),
  medium.run(triager2, triageHandler),
]);
```

---

## How this answers "adaptiveness"

Three loops of adaptation, all already expressed in the primitives:

1. **The colony adapts to reality.** Signals that lead somewhere get reinforced by validators; signals that don't decay. Within one decay cycle, colony attention shifts to what's working.
2. **Agents adapt across runs.** Every run ends with memory consolidation — the agent's LLM distills useful lessons into MEMORY.md and drops the noise. Over time, an agent gets better at its roles without any framework-level learning.
3. **Goals adapt mid-work.** Update the charter, update a validator, swap a decay rate — the framework applies them live. No redeploy, no restart.

No separate "adaptiveness primitive" exists because the existing primitives already compose to produce it.

---

## What this API does not have

- **No orchestrator.** Nothing "runs the colony." You run agents. They coordinate through the medium.
- **No messaging.** Agents cannot send each other messages. They deposit signals.
- **No global state.** The medium owns a registry, scoped to one connection.
- **No agent-to-agent handoffs.** No `ctx.handoffTo(otherAgent)`. That's a manager.
- **No "priority queue" primitive.** Priority is strength. Strength is a decay policy.
- **No retry primitive.** A crashed agent's unfinished signals stay in the medium; the next agent picks them up if they still matter.
- **No cross-agent memory.** If information matters to others, it's a signal with decay — not a shared file.
- **No `ctx.medium` escape hatch.** An agent's surface is bounded by its roles. Period.

---

## Open questions this sketch surfaces

Flagged for Phase 1, not solved here:

1. **Scheduling.** `medium.run()` starts a loop, but on what cadence? Polling interval? Postgres `LISTEN/NOTIFY`? Both?
2. **Agent identity persistence.** `agentId` is on every deposit. Is one agent per process the right granularity, or can one process run several agents?
3. **Reinforcement history on DepositedSignal.** If an agent wants to see "this signal has been reinforced three times in the last hour," it can't — the type doesn't expose history. Either we add it, or we say "query the medium directly" and keep the hot path lean.
4. **Signal versioning.** `defineSignal` has no `version` field yet. For schema evolution across deployments, probably yes, but not Phase 0.
5. **Memory size control.** MEMORY.md could grow unbounded if the agent's consolidation is too verbose. The framework could cap size and force the agent to prune, or trust the agent to compress. Lean toward trust for now, revisit if it bites.
6. **Cross-signal dedup for validators.** When a verdict's `target` differs from the trigger, the audit row is keyed to the target, so the dispatcher's "already processed" check on the trigger doesn't fire. In the example, the validator guards itself with an in-closure Set. Whether the framework should own that dedup is an open question.
