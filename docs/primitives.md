# The Six Primitives

A system is stigmergic if and only if it has all six of these. Miss one and you have something else — a knowledge base, a queue, a workflow engine, a manager-in-disguise. All six, designed together, are the minimum load-bearing structure.

(An earlier version of this document listed five primitives and conflated *who is acting* with *what function is being enacted*. That was wrong. Biology separates them — an ant has a fixed identity and performs different functions over time — and so do we. **Agent** is now its own primitive, distinct from **Role**.)

This document is the spec. The reference implementation in `src/` should correspond 1:1 to the primitives below.

---

## 1. Medium

**The one place agents read from and write to.**

The medium is where coordination happens. It is the only legitimate coordination channel in the system. If two agents talk to each other directly — over a queue, an API, a shared prompt — you have re-invented the manager.

### Requirements

- Readable by all agents.
- Writable by all agents.
- Durable — state survives individual agent crashes.
- Queryable locally — agents must be able to fetch a slice, not the whole world (see Locality).

### In practice

For the reference implementation, the medium is **Postgres**. Tables encode different signal types. Rows are individual signals. Columns carry signal metadata: type, strength, expiry, origin agent, claim state.

Other mediums are possible: object storage, a graph database, a filesystem of markdown files. What matters is the access pattern, not the technology.

### Anti-pattern

"The agents share a message bus." No. A message bus is not a medium because the signals are transient — they flow through, they are not deposited. Without deposition, there is nothing for later agents to read, nothing to decay, and nothing that persists when the colony sleeps.

---

## 2. Decay

**Every signal evaporates unless reinforced.**

This is the primitive that every previous attempt at database-backed stigmergy has gotten wrong. Biological pheromones evaporate. Database rows do not. If you do not build decay in from day one, stale signals will poison the colony.

### Requirements

Every signal has a lifecycle. The framework supports at least three decay mechanisms, and a Stigmergy-compliant schema must declare which one applies to each signal type:

- **Explicit expiry.** A signal has an `expires_at` timestamp. Readers filter on `expires_at > now()`. A background process (or a database trigger) deletes or flags expired signals.
- **Strength decay.** A signal has a `strength` column. Readers weight signals by strength; a periodic job multiplies all strengths by a decay factor (e.g., `strength * 0.9` per hour). Signals below a threshold become invisible.
- **Reinforcement-only.** A signal's effective strength is computed from how many validated reinforcements it has received in the last N hours. No reinforcement, no effect. This is the cleanest option when it fits.

### Rule

There is no valid Stigmergy schema without a decay story for every signal. The reference implementation refuses to register a signal type without one.

### Anti-pattern

"We'll add decay later." This is the Ledger-State Stigmergy failure mode. Every hour the system runs without decay, it accumulates stale state that will later require archaeology to untangle. Decay is not an optimization. It's the primitive.

---

## 3. Role specialization

**Agents know what kind of work they do. They do not know what the other agents do.**

Specialization is not strictly required — homogeneous colonies (all ants are foragers) can do stigmergy. But for LLM agents, specialization is the cheapest way to get useful division of labor without writing a planner.

### Requirements

- A role is a bundle of: (a) what signal types the agent reads, (b) what signal types it writes, (c) what its local query looks like.
- Roles are declared in one place. New roles are added by extending the declaration, not by modifying other roles.
- Roles do not reference each other. A Worker role does not know that a Validator role exists. It knows only the signals.

### Reference roles (non-prescriptive)

SwarmSys's three roles are a solid starting pattern, and Stigmergy's built-ins will follow them:

- **Explorer** — proposes new work. Writes candidate signals with low initial strength.
- **Worker** — executes promising candidates. Reads high-strength candidate signals; writes progress and result signals.
- **Validator** — gates reinforcement. Reads result signals; writes strength-boost or strength-penalty signals.

A given Stigmergy system may define arbitrarily many roles beyond these three. The reference implementation ships the three as composable defaults.

### Anti-pattern

"The Supervisor role reads everything and decides who does what." That is a manager. Delete it.

---

## 4. Agent

**The identity that enacts roles. Distinct from the role it's enacting.**

Roles describe functions. Agents are who perform them. In biology, one ant has a fixed genome and morphology but performs different functions over its lifetime — nurse, food-processor, forager. This is called **polyethism**, and it is the default pattern in social-insect colonies.

For LLM agents, the same split matters. An agent has persistent identity (personality, values, voice), persistent capabilities (tools, skills), and accumulated learnings (memory). At any given tick, it selects which of its roles to enact based on what the medium shows.

### Requirements

- An Agent has a stable `id`. Every deposit it makes is stamped with that id.
- An Agent has a declared set of roles it is capable of enacting.
- An Agent may have identity documents attached: a **SOUL** (persona/values), one or more **SKILLs** (capabilities), a **MEMORY** (consolidated learnings). See `docs/files.md` for the convention.
- Agents do not reference each other. An Agent knows its roles, its identity documents, and nothing else about the colony's composition.

### Selection, not composition

Multi-role agents select which role to enact at each tick — they do not enact several simultaneously. This preserves locality: when an agent is acting as Scout, it sees only ScoutRole's slice; when it switches to Worker, only WorkerRole's. The agent is never looking at the whole medium at once.

This mirrors polyethism: an ant does one task at a time, but transitions freely.

### Why this is a primitive

Because Agent and Role answer different questions. Role says "what function is happening." Agent says "who is doing it." They have independent lifecycles — a role is a framework-level declaration, an agent is a runtime entity with memory that accumulates.

Collapsing them (as the earlier five-primitive draft did) forces one of two bad choices: either every change of function requires a new agent (no polyethism), or agents accumulate every possible role's state at once (no locality). Splitting them cleanly resolves both.

### Anti-pattern

"Agents can message each other directly to coordinate." No. An Agent knows its roles and its own identity. Coordination is mediated by signals in the medium — never by direct reference.

---

## 5. Locality

**Agents see only what they need to see.**

Locality is what stops specialization from collapsing back into hierarchy. If an agent can see the whole medium, it will start reasoning about the whole medium, which means it will start making plans about the whole medium, which means it is now a manager.

### Requirements

- Every role declares its **local query** — the slice of the medium it reads.
- The framework enforces this query as the agent's only read access. An agent cannot bypass its local query to peek at other parts of the medium.
- Local queries are typed. A Worker's local query returns Worker-readable signals, not every row in the medium.

### Why this matters

Locality is a coordination mechanism, not a privacy mechanism. It is the constraint that makes emergent specialization *emerge* — because each agent has a partial view, it has to respond to what's locally present rather than optimize globally. Global optimization is what managers do. We don't want managers.

### Anti-pattern

"The Worker agent also needs to see the Validator queue so it can pre-empt." No. If the Worker needs information from the Validator, the Validator writes a signal the Worker reads. No peeking.

---

## 6. Validated reinforcement

**Not every trace reinforces equally. Successful outcomes deposit more signal than mere activity.**

Without validation, noise wins — any agent can deposit any signal and the medium fills with garbage. With validation, the colony converges on actually-good work.

### Requirements

- Reinforcement is a distinct operation from deposition. An agent deposits a signal; a Validator (or a rule) reinforces it.
- Reinforcement changes the signal's strength, expiry, or visibility — never its content.
- Validation can be rule-based, agent-based, or human-in-the-loop. All three must be supported.

### Phase-1 pattern: human-in-the-loop validator

For early Stigmergy systems, a human validator (approving via a side channel like Telegram or a dashboard) gates reinforcement. The framework makes this easy: a Validator role can be implemented as a webhook plus an `approve(signal_id)` / `reject(signal_id)` function pair.

### Phase-2 pattern: rule-based validator

Once thresholds are known (e.g., "conversion rate > 15% means the signal is valid"), the human validator is replaced by a rule, and the colony becomes autonomous.

### Anti-pattern

"Every signal immediately has full strength." This is the failure mode of every naive multi-agent system: the first deposit dominates regardless of quality, so whoever runs first wins. Reinforcement is the mechanism that lets quality beat speed.

---

## Dual-channel signals (a note, not a seventh primitive)

Paul Welty's framing — **quantitative** and **qualitative** stigmergy working in parallel — is load-bearing for LLM agents specifically, because LLM-native output is language, which is qualitative by default.

Practically: some signals are numbers (priority, strength, claim-count) — these are quantitative. Some signals are natural language (a note in a log, a design doc left in the medium, an annotation on a decision) — these are qualitative. An LLM agent reads both. A Stigmergy medium must support both.

The reference implementation treats this as a schema convention: quantitative signals live in typed columns; qualitative signals live in markdown-shaped `body` columns that agents render into their context.

---

## What an implementation must provide

The reference `stigmergy` library must expose:

- `defineMedium({ url, charter? })` — open a connection to the medium substrate; optionally attach a colony-level charter.
- `defineSignal({ type, decay, shape })` — register a signal type. Rejected if decay is missing.
- `defineRole({ name, reads, writes, localQuery })` — register a role with its local-query bounds enforced.
- `defineAgent({ id, roles, soul?, skills?, memory? })` — register an agent and its identity documents.
- `defineValidator({ triggers, validate })` — register a validation rule.
- `run(agent, handler)` — start an agent loop. The handler selects which role to enact at each tick.
- `updateValidator(validator, nextValidate)` — hot-swap a validator's rule without restarting the colony.

That's the minimum surface. Everything else is opinion.
