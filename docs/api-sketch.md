# API sketch — a worked example

This walks through what using Stigmergy feels like, end-to-end, in enough detail that you can push back on the shape before any runtime is built.

No runtime exists yet. Every code block below is aspirational. If the shape feels wrong here, it's wrong, and we change `src/types.ts` before anyone writes implementation code.

---

## The scenario

A toy colony with three moving parts:

- **One quantitative signal** — a `demand_pheromone` that says "this niche looks promising" with a strength that decays if nobody reinforces it.
- **One qualitative signal** — a `scout_report` with a freeform markdown body, carrying what the Scout learned about the niche.
- **Two roles** — a `Scout` that explores new niches and deposits demand + reports, a `Validator` role's work is separate (see below) but there's a `Worker` role that picks up high-strength demand and builds a prototype.
- **One validator** — approves `scout_report` signals that meet a quality bar, which reinforces the associated demand pheromone.

Small enough to fit on a screen. Real enough to exercise every primitive.

---

## Defining the medium

```ts
import { defineMedium } from "stigmergy";
import { z } from "zod";

const medium = defineMedium({ url: process.env.DATABASE_URL! });
```

That's it. No tables created yet — that's a migration concern for Phase 1. The medium is a handle that will grow a registry as we declare signals and roles on it.

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

What's happening: every hour, every `demand_pheromone`'s strength is multiplied by 0.9. A pheromone that started at `1.0` is at `~0.35` after ten hours and drops below the `0.05` floor — invisible to readers — after about 28. If something keeps reinforcing it (see the validator below), it stays alive.

Note the `claimed_by` / `claimed_until` fields on the shape. That's the claim-as-convention pattern — no new primitive, just fields. A Scout that wants to investigate a niche atomically claims the pheromone via `ctx.tryClaim()`. The claim's lifetime is `claimed_until`, which the Scout can set to outlive its own run.

A qualitative signal — a report with a markdown body:

```ts
const scoutReport = medium.defineSignal({
  type: "scout_report",
  decay: { kind: "expiry", after: "72h" },
  shape: z.object({
    niche: z.string(),
    body: z.string(),              // markdown — this is the qualitative channel
    recommended_strength: z.number(),
  }),
});
```

Reports live for 72 hours. If a Validator approves the report in that window, the report's approval cascades into a strength boost on the matching `demand_pheromone`. If nobody approves, the report just vanishes — no archaeology.

**The rule the framework enforces:** if you try to `defineSignal` without a `decay` field, it is a type error. Not a runtime warning, not a lint rule — it does not compile. This is the whole point.

---

## Defining roles

A Scout reads no signals (it explores fresh territory) and writes demand + reports:

```ts
const Scout = medium.defineRole({
  name: "Scout",
  reads: [demandPheromone],       // reads existing demand to avoid re-exploring
  writes: [demandPheromone, scoutReport],
  localQuery: {
    types: ["demand_pheromone"],
    where: { op: "lt", field: "strength", value: 0.3 },  // look at faint or absent trails
    orderBy: { field: "created_at", direction: "desc" },
    limit: 20,
  },
});
```

The `localQuery` is what a Scout *can see*. It can see recent low-strength pheromones (hints that others haven't converged on). It cannot see high-strength pheromones — those are for Workers. It cannot peek at `scout_report` rows — even ones it wrote. If the Scout's handler tries to access anything outside this query, it doesn't compile.

A Worker reads high-strength demand and writes progress:

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

const Worker = medium.defineRole({
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

A Worker sees the top five unclaimed, high-strength pheromones. It knows nothing about Scouts. It knows nothing about reports. It knows only what its signals tell it.

**What Locality bought us:** the Scout cannot decide "I should do the Worker's job on this one." The types won't let it. Emergence is enforced.

---

## Defining a validator

The validator watches `scout_report` deposits and, if the report passes a quality check, reinforces the matching demand pheromone:

```ts
const reportValidator = medium.defineValidator({
  triggers: [scoutReport],
  async validate(signal) {
    const body = signal.payload.body;
    const lookGood = body.length > 200 && /\bdemand\b/.test(body);
    if (!lookGood) return { approve: false };
    return {
      approve: true,
      boost: signal.payload.recommended_strength,
      extend: "24h",  // also delay the report's own expiry
    };
  },
});
```

The verdict is uniform whether the validator is rule-based (like this), agent-based (replace the body of `validate` with an LLM call), or human-in-the-loop (await a promise that a Telegram webhook resolves).

The framework applies the verdict. On `approve: true`, it finds the signal whose `niche` matches the report and boosts its strength. That's reinforcement. No new signal is deposited — existing state is updated. If no matching pheromone exists, the framework logs and moves on.

---

## Running agents

```ts
await medium.run(Scout, async (ctx) => {
  const faintPheromones = await ctx.view();

  if (faintPheromones.length === 0) {
    const niche = await pickFreshNiche();
    await ctx.deposit("demand_pheromone", {
      niche,
      claimed_by: null,
      claimed_until: null,
    });
    return;
  }

  const target = faintPheromones[0];
  const claimed = await ctx.tryClaim(target.id, { until: "2h" });
  if (!claimed) return;  // another Scout got there first

  const findings = await investigate(target.payload.niche);
  await ctx.deposit("scout_report", {
    niche: target.payload.niche,
    body: findings.markdown,
    recommended_strength: findings.score,
  });

  await ctx.release(target.id);
});
```

What's in `ctx`:

- `view()` returns only the rows matching the Scout's localQuery. Always.
- `deposit(...)` is type-constrained to `demand_pheromone` and `scout_report`. Calling it with `"worker_result"` is a compile error.
- `tryClaim()` is an atomic conditional write. If two Scouts race for the same pheromone, exactly one gets `true`.
- `release()` unclaims. Crashing without releasing is fine — the claim decays when `claimed_until` passes.

There is no `ctx.medium`. There is no way, from inside the handler, to read or write outside the role's declared bounds.

---

## The shape of the whole thing

```ts
const medium = defineMedium({ url });

const demandPheromone = medium.defineSignal({ ... });
const scoutReport    = medium.defineSignal({ ... });
const workerResult   = medium.defineSignal({ ... });

const Scout  = medium.defineRole({ ... });
const Worker = medium.defineRole({ ... });

const reportValidator = medium.defineValidator({ ... });

await Promise.all([
  medium.run(Scout, scoutHandler),
  medium.run(Worker, workerHandler),
]);
```

Six declarations, two handlers, one runtime call per role. That's the framework.

---

## What this API does not have

Deliberately:

- **No orchestrator.** There is nothing that "runs the colony." You run roles. They coordinate through the medium.
- **No messaging.** Agents cannot send each other messages. They deposit signals.
- **No global state.** The medium owns a registry, scoped to one connection.
- **No agent-to-agent handoffs.** No `ctx.handoffTo(otherRole)`. That's a manager.
- **No "priority queue" primitive.** Priority is strength. Strength is a decay policy.
- **No retry primitive.** An agent that crashed leaves its signals in the medium; the next agent's localQuery pulls them if they still matter. Retries are a pattern, not a feature.
- **No `ctx.medium` escape hatch.** An agent's surface is bounded by its role. Period.

---

## What still needs to be decided

A short list of open design questions this sketch surfaces but doesn't resolve:

1. **How are agents scheduled?** `medium.run()` starts a loop, but on what cadence? Polling interval? Event-driven via Postgres `LISTEN/NOTIFY`? Both? This is a Phase 1 concern but worth flagging now.
2. **Do we need agent identity?** `ctx.agentId` is in the sketch — it's stamped on every deposit for provenance. Is one agent ID per `run()` invocation the right granularity, or per process, or something else?
3. **Should `DepositedSignal` expose reinforcement history?** Right now it doesn't. If a Worker wants to see "this pheromone has been reinforced three times in the last hour," that's not queryable from the type. Either we add it, or we say "query the medium directly for that" and keep the hot path simple.
4. **Does `defineSignal` need a `version` field?** For schema evolution across deployments. Probably yes, probably not in Phase 0.

I'd rather ship a small type file with these left unresolved than speculatively add knobs. We answer them when we hit them in Phase 1 or in real usage.
