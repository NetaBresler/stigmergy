# Colony dynamics

What to expect from a well-configured Stigmergy colony, and how to tune it when you don't.

This is not a seventh primitive. Everything on this page is an *emergent property* of the six primitives in [`docs/primitives.md`](./primitives.md) — threshold behaviour, inhibitory trails, quorum convergence, role drift. You don't need to add a type to get any of these; you need to compose what's already there.

The motivation for writing this down: a colony that's working shows recognisable shapes in its pressure landscape, and a colony that's stuck shows different ones. If you don't have vocabulary for those shapes, you can't diagnose them. Four phenomena, each with the same four questions answered:

- **What it is** — one paragraph.
- **How it emerges** — which primitives compose to produce it.
- **How to spot it** — one `medium.query()` snippet that surfaces it.
- **How to tune it** — which knob moves it.

---

## 1. Threshold response

### What it is

Agents ignore signals below some strength, and act on signals above it. The colony's behaviour changes qualitatively when pressure crosses the line — not gradually. A Triager that pulls nothing when pressure is low and pulls steadily when pressure is high is exhibiting threshold response.

This is quiet in a healthy colony (everything above threshold gets handled promptly) and loud in a stuck one (pressure piles up just below the line and nothing wakes up).

### How it emerges

From **Decay** + **Locality**. Strength-decay signals expose an effective strength that falls with time. A role's `localQuery.where` can filter on it:

```ts
localQuery: {
  types: ["reported_bug"],
  where: { op: "gt", field: "strength", value: 0.7 },
  orderBy: { field: "strength", direction: "desc" },
  limit: 5,
}
```

Below `0.7`, the role's view is empty and the handler returns early. Above `0.7`, the handler gets work. The threshold is a property of the role, not the signal — the same signal can be below one role's threshold and above another's. That's how Explorer / Worker splits fall out cleanly: they share a signal type and differ only in where their thresholds sit.

### How to spot it

Histogram of effective strengths by signal type, bucketed around the thresholds your roles use. If a bucket just below a threshold is full and the bucket just above is empty, you have pile-up.

```sql
SELECT
  CASE
    WHEN strength < 0.3 THEN '0.0 – 0.3'
    WHEN strength < 0.7 THEN '0.3 – 0.7'
    WHEN strength < 1.2 THEN '0.7 – 1.2'
    ELSE '>= 1.2'
  END AS band,
  count(*) AS n
FROM signal_reported_bug
GROUP BY 1
ORDER BY 1;
```

A healthy colony drains the top band. A stuck one has a wall at the band just below the role's threshold.

### How to tune it

- **Lower the threshold** in the role's `localQuery.where` if pressure is pooling just below the line. Cheap, reversible.
- **Raise the decay factor** (slower decay) if everything decays out of reach before agents can touch it.
- **Add another agent** enacting the role if the threshold is right but throughput is the bottleneck — claim contention gives you natural load-balancing without any scheduling code.

Don't fix threshold response by introducing priority levels. Priority is strength; strength is a decay policy. You already have it.

---

## 2. Inhibitory stigmergy

### What it is

Negative trails. A signal that's been judged bad doesn't just fade — it *actively repels* nearby work. An invalid bug report drops not only its own strength but the strength of similar bug reports clustering on the same non-issue. Good agents don't investigate paths that are known dead ends.

### How it emerges

From **Validated reinforcement**, but not for free.

The runtime already supports negative verdicts: `{ approve: false, penalty: 0.8 }` decrements the target's strength (clamped at zero). That alone makes a bad signal fade faster — but it doesn't repel neighbours.

For true inhibitory stigmergy, write a **validator that targets signals other than the trigger**. Verdicts carry an optional `target: { type, id }` field; the penalty applies there. A validator that, on rejecting a bug, also penalises every bug with the same title stem creates a repulsive field across a topic rather than a single-signal fade.

Sketch:

```ts
medium.defineValidator({
  name: "bad_topic_suppressor",
  triggers: [triageNote],
  async validate(note, ctx) {
    if (note.payload.verdict !== "invalid") return { approve: true };

    // Penalise every other bug with this title stem.
    const stem = note.payload.bug_title.split("-")[0];
    const siblings = await ctx.find("reported_bug");
    for (const sibling of siblings) {
      // (In Phase 1, ctx.find returns bare ids — you pair with
      //  a medium.query to filter by title stem, or store the
      //  stem as a field on the signal so the filter is cheap.)
    }

    return {
      approve: false,
      penalty: 0.8,
      target: { type: "reported_bug", id: note.payload.bug_id },
    };
  },
});
```

This is a validator *pattern*, not an emergence. Document it as such in any example that uses it. The framework gives you the mechanism; you still author the similarity rule.

### How to spot it

Cross-tabulate penalties against target signals. A run that's producing inhibitory effects has penalty rows scattered across multiple target ids per trigger, not one-to-one.

```sql
SELECT
  signal_type AS target_type,
  validated_by,
  count(*)       AS penalties,
  count(DISTINCT signal_id) AS distinct_targets
FROM stigmergy_reinforcements
WHERE approved = false
GROUP BY 1, 2
ORDER BY penalties DESC;
```

If `penalties` equals `distinct_targets`, the validator is only ever penalising the trigger itself — you've got penalty-as-fade, not inhibitory stigmergy.

### How to tune it

- **Widen the similarity rule** if the colony keeps rediscovering the same dead topic — include more siblings in the repulsive blast radius.
- **Narrow it** if unrelated signals are getting caught in the net (over-suppression).
- **Cap cumulative penalty** per target per window if bugs are getting penalised down to zero before any human can overrule.

Don't conflate inhibition with deletion. Inhibited signals stay in the medium at low strength; they're just invisible to readers who threshold above them. That's the point — the trail remains, so agents who later *reinforce* it can still lift it out.

---

## 3. Quorum / consensus-by-reinforcement

### What it is

A signal is ignored until enough independent validators have approved it, then it crosses a line and the colony acts on it. The count *is* the signal — no separate vote-tally primitive, no global aggregation step.

This is how ant colonies pick a new nest: a site isn't chosen by any individual; it's chosen when enough independent foragers have reinforced the trail to it. The tipping point is emergent.

### How it emerges

Directly, from the `reinforcement` decay kind in [`src/types.ts`](../src/types.ts):

```ts
| { kind: "reinforcement"; window: Duration };
```

Effective strength = count of validated reinforcements in the window. A signal declared with this decay doesn't carry its own strength column — the framework computes it from the reinforcement log. Each validator that approves the signal adds one to the count; each approval within the window contributes equally.

Pair that with a role's `localQuery.where: { op: "gt", field: "strength", value: N }` and you have "N independent approvals before this becomes actionable." No additional mechanism needed.

This is the single highest-leverage phenomenon to document, because the `reinforcement` decay kind is in the type system and almost nobody notices it exists.

### How to spot it

Count reinforcements per signal and compare to your quorum threshold.

```sql
SELECT
  r.signal_id,
  count(*) FILTER (WHERE r.approved)               AS approvals,
  count(DISTINCT r.validated_by) FILTER (WHERE r.approved) AS distinct_validators,
  max(r.created_at)                                AS most_recent
FROM stigmergy_reinforcements r
WHERE r.signal_type = 'proposal'
  AND r.created_at > now() - interval '1 hour'
GROUP BY r.signal_id
ORDER BY approvals DESC;
```

`distinct_validators` matters more than `approvals` — you want N *independent* voices, not one validator spamming approvals. Enforce that with distinct `validator.name` values.

### How to tune it

- **Shorten the window** for high-signal / low-stakes quorums (reply drafts).
- **Lengthen the window** for high-stakes ones (a release candidate).
- **Add validators** to lift the required quorum; remove them to lower it. No per-signal threshold to adjust — the quorum is the sum of who's watching.

If a quorum signal never crosses the line in any window, you have a validator-count problem, not a signal problem.

---

## 4. Role drift (polyethism)

### What it is

An agent with multiple roles switches between them as medium pressure shifts. When proposals are thin it acts as Explorer; when proposals are plentiful it acts as Worker. Across the colony's life, the distribution of "time spent in each role" varies agent-by-agent without anyone assigning it.

This is the direct analogue of ant polyethism — nurse early, forager late, same ant, same genome.

### How it emerges

From **Agent** (distinct from Role) + **Locality**. An agent's handler gets to narrow into any role it declares via `ctx.as(role)`. The handler can read the local view of each role, measure pressure, and pick whichever surface has the loudest signal *this tick*. The choice is re-made every tick. There's no `primaryRole` field because there's no such thing.

The sketch from [`docs/api-sketch.md`](./api-sketch.md):

```ts
const pressures = await Promise.all(
  agent.roles.map(async (role) => {
    const signals = await ctx.as(role).view();
    return {
      role,
      loudest: signals[0],
      pressure: signals[0]?.strength ?? 0,
    };
  })
);

const target = pressures.sort((a, b) => b.pressure - a.pressure)[0];
if (!target || target.pressure < EXPLORE_FLOOR) {
  // nothing is loud — drop into Explorer mode and deposit a fresh trail
} else {
  // act in whichever role surfaced the loudest signal
}
```

That's polyethism. The agent carries its identity (soul, memory) across role transitions; the role is the slice it's looking at right now.

See [`examples/polyethism.ts`](../examples/polyethism.ts) for a runnable demonstration.

### How to spot it

Count deposits per agent per signal type across a window. An agent exhibiting role drift will have non-trivial counts across multiple write-targets.

```sql
SELECT
  origin_agent_id,
  'reported_bug'  AS signal_type,
  count(*)        AS deposits
FROM signal_reported_bug
WHERE created_at > now() - interval '10 minutes'
GROUP BY origin_agent_id
UNION ALL
SELECT
  origin_agent_id,
  'triage_note',
  count(*)
FROM signal_triage_note
WHERE created_at > now() - interval '10 minutes'
GROUP BY origin_agent_id
ORDER BY 1, 2;
```

An agent that only ever deposits one type is not drifting — it has one role, or it's stuck in one. An agent with two or three deposit types in the same window is drifting correctly.

### How to tune it

- **Lower the role's pressure threshold** (or add an `EXPLORE_FLOOR`) if an agent gets stuck as pure Worker because every tick finds something loud enough to act on.
- **Raise Explorer's pressure score** (e.g., a small bonus when the colony is quiet) if the medium is draining and nobody's seeding new work.
- **Shrink the agent's role set** if role choice overhead is nontrivial (more than a couple of roles per agent rarely earns its keep).

If one role's view is always empty, the agent is not polyethic — it's monomorphic with an unused role. That's fine for teaching examples; it's noise in production. Drop the role from the agent's declaration.

---

## What this page is not

- It is not a seventh primitive. Adding one would violate the discipline that keeps Stigmergy small.
- It is not a cookbook. Each phenomenon is named, not prescribed — the exact thresholds, windows, and similarity rules are your call.
- It is not a runtime feature. The framework doesn't detect these phenomena for you. If you want alerts ("colony is stuck at threshold"), write them against the queries above.
- It is not exhaustive. Other phenomena compose out of the same primitives — wave propagation, strategy switching under charter change, validator hot-swap transients. Add them here as you encounter them worth naming.

The point of naming these is vocabulary. A colony that's working can be described with these four shapes; a colony that isn't, with the pathological versions of the same shapes. That's the diagnostic frame.
