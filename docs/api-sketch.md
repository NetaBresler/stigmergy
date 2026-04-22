# API sketch — a worked example

This walks through what using Stigmergy feels like, end-to-end, in enough detail that you can push back on the shape before any runtime is built.

No runtime exists yet. Every code block below is aspirational. If the shape feels wrong here, it's wrong, and we change `src/types.ts` before anyone writes implementation code.

---

## The scenario

A toy colony with the following moving parts:

- **One quantitative signal** — a `demand_pheromone` that says "this niche looks promising" with a strength that decays if nobody reinforces it.
- **One qualitative signal** — a `scout_report` with a freeform markdown body.
- **Two roles** — `ScoutRole` (explore new territory, deposit demand + reports) and `WorkerRole` (pick up high-strength demand and build a prototype).
- **One agent** — `Scout`, who can enact *either* role depending on what the medium shows.
- **One validator** — approves `scout_report` signals that meet a quality bar, which boosts the associated demand pheromone.
- **A charter** at colony level and a soul, skills, and memory file per agent.

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

A quantitative signal — a pheromone with numeric strength that decays:

```ts
const demandPheromone = medium.defineSignal({
  type: "demand_pheromone",
  decay: { kind: "strength", factor: 0.9, period: "1h", floor: 0.05 },
  shape: z.object({
    niche: z.string(),
    claimed_by: z.string().nullable(),
    claimed_until: z.date().nullable(),
  }),
});
```

Every hour, every `demand_pheromone`'s strength is multiplied by 0.9. Below `0.05` it's invisible to readers. Reinforcement keeps it alive.

`claimed_by` / `claimed_until` are shape fields — the claim-as-convention pattern. No new primitive, just fields. `ctx.tryClaim()` does the atomic write.

A qualitative signal — a report with a markdown body:

```ts
const scoutReport = medium.defineSignal({
  type: "scout_report",
  decay: { kind: "expiry", after: "72h" },
  shape: z.object({
    niche: z.string(),
    body: z.string(),
    recommended_strength: z.number(),
  }),
});
```

Reports live 72 hours. An approved report's boost is applied to the matching demand pheromone (see validator below).

A worker result:

```ts
const workerResult = medium.defineSignal({
  type: "worker_result",
  decay: { kind: "expiry", after: "24h" },
  shape: z.object({
    niche: z.string(),
    outcome: z.enum(["shipped", "failed", "blocked"]),
    body: z.string(),
  }),
});
```

**Rule the framework enforces:** `defineSignal` without `decay` is a type error. Not runtime, not lint — the code does not compile.

---

## Defining roles

Roles describe *functions*, not agents. They say what signals get read, what gets written, and what slice of the medium is visible.

```ts
const ScoutRole = medium.defineRole({
  name: "Scout",
  reads: [demandPheromone],
  writes: [demandPheromone, scoutReport],
  localQuery: {
    types: ["demand_pheromone"],
    where: { op: "lt", field: "strength", value: 0.3 },
    orderBy: { field: "created_at", direction: "desc" },
    limit: 20,
  },
});

const WorkerRole = medium.defineRole({
  name: "Worker",
  reads: [demandPheromone],
  writes: [workerResult],
  localQuery: {
    types: ["demand_pheromone"],
    where: {
      op: "and",
      clauses: [
        { op: "gt", field: "strength", value: 0.7 },
        { op: "eq", field: "claimed_by", value: null },
      ],
    },
    orderBy: { field: "strength", direction: "desc" },
    limit: 5,
  },
});
```

ScoutRole sees faint or absent trails. WorkerRole sees top-five unclaimed, high-strength pheromones. Neither knows the other exists. Each is a bounded view; an agent in that role cannot look beyond it.

---

## Defining a validator

The validator watches `scout_report` deposits and, if the report looks good, boosts the matching demand pheromone:

```ts
const reportValidator = medium.defineValidator({
  triggers: [scoutReport],
  async validate(report, ctx) {
    const body = report.payload.body;
    const lookGood = body.length > 200 && /\bdemand\b/.test(body);
    if (!lookGood) return { approve: false };

    const [matchingPheromone] = await ctx.find("demand_pheromone", {
      op: "eq",
      field: "niche",
      value: report.payload.niche,
    });
    if (!matchingPheromone) return { approve: true };  // nothing to reinforce

    return {
      approve: true,
      target: matchingPheromone.id,
      boost: report.payload.recommended_strength,
    };
  },
});
```

The verdict is uniform whether the validator is rule-based (like this), agent-based (swap the body for an LLM call), or human-in-the-loop (await a promise that a webhook resolves). The framework applies the verdict.

If goals change mid-project, hot-swap the rule — `medium.updateValidator(reportValidator, newValidate)` — and the next report is judged under the new regime. The colony re-orients within one decay cycle.

---

## Defining an agent

One agent, two roles. This is where polyethism lives — an agent that can enact either role depending on what the medium shows:

```ts
const Scout = medium.defineAgent({
  id: "scout-01",
  soul: "./agents/scout/SOUL.md",
  skills: [
    "./agents/scout/skills/web-research.md",
    "./agents/scout/skills/niche-analysis.md",
  ],
  memory: "./agents/scout/MEMORY.md",
  roles: [ScoutRole, WorkerRole],
});
```

The four identity documents:

- **SOUL.md** — who this agent is. Personality, voice, values, boundaries. Rarely changes.
- **SKILL.md** files — what this agent can do. Web research, niche analysis. Added/removed as capabilities evolve.
- **MEMORY.md** — what this agent has learned. Consolidated, not streamed. Rewritten at end of each run.
- **CHARTER.md** — colony-wide mission. Inherited from the medium.

See `docs/files.md` for the full convention.

All four are optional. An agent with none is a valid agent — it just has a stable id and a set of enactable roles.

---

## Running the agent

```ts
await medium.run(Scout, async (ctx) => {
  // ctx.soul, ctx.skills, ctx.memory, ctx.charter are loaded.
  // They are plain text. The framework does not interpret them —
  // the handler passes them to its LLM calls as needed.

  // Polyethism, the stigmergic way: gather every signal the agent's roles
  // can see, score by pressure, and act on whichever is loudest. The
  // handler is not routing through a menu — it's responding to a gradient.
  const pressures = (
    await Promise.all(
      Scout.roles.map(async (role) => {
        const signals = await ctx.as(role).view();
        return signals.map((s) => ({
          role,
          signal: s,
          pressure: s.strength ?? 1,  // expiry-decay signals carry binary pressure
        }));
      })
    )
  ).flat();

  const loudest = pressures.sort((a, b) => b.pressure - a.pressure)[0];

  if (!loudest) {
    // Nothing pulling at this agent. Explore: deposit a fresh, faint trail
    // so the next agent has something to react to. (Exploration is what an
    // ant does when it finds no pheromone to follow.)
    const niche = await pickFreshNiche(ctx.soul, ctx.memory, ctx.charter);
    await ctx.as(ScoutRole).deposit("demand_pheromone", {
      niche,
      claimed_by: null,
      claimed_until: null,
    });
  } else {
    // Act in whichever role surfaced the loudest signal. The agent doesn't
    // pick a role then look for work; the work picks the role.
    const role = ctx.as(loudest.role);
    const claimed = await role.tryClaim(loudest.signal.id, { until: "6h" });
    if (!claimed) return;  // another agent got there first

    if (loudest.role === WorkerRole) {
      const result = await buildPrototype(loudest.signal.payload.niche, {
        soul: ctx.soul, skills: ctx.skills, memory: ctx.memory, charter: ctx.charter,
      });
      await role.deposit("worker_result", {
        niche: loudest.signal.payload.niche,
        outcome: result.outcome,
        body: result.notes,
      });
    } else {
      const report = await investigate(loudest.signal.payload.niche, ctx.skills);
      await role.deposit("scout_report", {
        niche: loudest.signal.payload.niche,
        body: report.markdown,
        recommended_strength: report.score,
      });
    }

    await role.release(loudest.signal.id);
  }

  // End-of-run: consolidate memory. The agent's LLM distills what it
  // learned this tick into a rewritten MEMORY.md. This is the
  // biomimetic forgetting pass.
  const consolidated = await consolidate({
    previousMemory: ctx.memory,
    soul: ctx.soul,
    justHappened: /* summarize what the handler did */,
  });
  await ctx.writeMemory(consolidated);
});
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
const demandPheromone = medium.defineSignal({ ... });
const scoutReport    = medium.defineSignal({ ... });
const workerResult   = medium.defineSignal({ ... });

// Roles
const ScoutRole  = medium.defineRole({ ... });
const WorkerRole = medium.defineRole({ ... });

// Validators
const reportValidator = medium.defineValidator({ ... });

// Agents
const Scout  = medium.defineAgent({ id: "scout-01", roles: [ScoutRole, WorkerRole], ... });
const Scout2 = medium.defineAgent({ id: "scout-02", roles: [ScoutRole, WorkerRole], ... });
// ... more agents, same shape.

await Promise.all([
  medium.run(Scout,  scoutHandler),
  medium.run(Scout2, scoutHandler),
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
3. **Reinforcement history on DepositedSignal.** If an agent wants to see "this pheromone has been reinforced three times in the last hour," it can't — the type doesn't expose history. Either we add it, or we say "query the medium directly" and keep the hot path lean.
4. **Signal versioning.** `defineSignal` has no `version` field yet. For schema evolution across deployments, probably yes, but not Phase 0.
5. **Memory size control.** MEMORY.md could grow unbounded if the agent's consolidation is too verbose. The framework could cap size and force the agent to prune, or trust the agent to compress. Lean toward trust for now, revisit if it bites.
