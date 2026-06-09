# API reference

The complete public surface of the `stigmergy` package, export by export.

This is the reference; [`api-sketch.md`](./api-sketch.md) is the narrative
(read that first if you've never used the framework), and
[`primitives.md`](./primitives.md) is the spec these exports implement. Every
type named here is exported from the package root:

```ts
import {
  defineMedium,
  pgliteClient,
  postgresJsClient,
  type Medium,
  type Signal,
  type Role,
  type Agent,
  type Validator,
  type RunOptions,
  // ...all types below are exported too
} from "stigmergy";
```

Two rules are load-bearing and enforced, not advisory:

- **Every signal declares a decay.** `defineSignal` without a `decay` is a type
  error — it does not compile.
- **Reads go through a role's `localQuery` and nowhere else.** There is no
  `ctx.medium`, no unbounded read inside a handler. Locality is the constraint
  that keeps agents from becoming managers.

---

## Entry point

### `defineMedium(connection): Medium`

Open a Stigmergy medium — the handle that owns the registry of signals, roles,
validators, and agents. Two overloads:

```ts
function defineMedium(connection: { url: string; charter?: string }): Medium;
function defineMedium(connection: { client: MediumClient; charter?: string }): Medium;
```

- **`{ url }`** — a Postgres connection string. Opens [postgres-js](https://github.com/porsager/postgres)
  internally and owns the connection (closed by `medium.close()`). The production
  form.
- **`{ client }`** — bring your own `MediumClient`. PGlite in tests and demos, a
  pooled connection or pgbouncer in production. The medium does **not** own a
  client you pass in; `close()` leaves it open.
- **`charter`** — optional. A path to a markdown file or inline markdown. Loaded
  once at `migrate()` time and exposed as `ctx.charter` on every agent. One
  charter per medium.

```ts
const medium = defineMedium({ url: process.env.DATABASE_URL!, charter: "./CHARTER.md" });
// or, in tests:
const medium = defineMedium({ client: pgliteClient(new PGlite()) });
```

### `pgliteClient(db: PGlite): MediumClient`

Adapt a [PGlite](https://github.com/electric-sql/pglite) instance to the
`MediumClient` interface. In-process Postgres — zero install, for tests and
demos.

### `postgresJsClient(sql: postgres.Sql): MediumClient`

Adapt a [postgres-js](https://github.com/porsager/postgres) `Sql` instance to
`MediumClient`. Use this when you want to control connection options, pooling,
or pgbouncer yourself and pass the client via `defineMedium({ client })`. (The
`{ url }` form builds one of these for you.)

---

## The `Medium` handle

Everything you register and run hangs off the medium. Definition methods return
their argument so the natural idiom works:

```ts
const bug = medium.defineSignal({ ... });   // returns the Signal
const role = medium.defineRole({ reads: [bug], ... });
```

### `medium.defineSignal({ type, decay, shape }): Signal`

Register a signal type. Backed by its own table (`signal_<type>`) created at
`migrate()`.

- **`type`** — unique string. Becomes the table name suffix.
- **`decay`** — required. One of the three `Decay` kinds (below). No default;
  omitting it is a compile error.
- **`shape`** — a `z.ZodObject` describing the payload columns. Must be an object
  at the top level. A `body: z.string()` field is the convention for a
  qualitative (natural-language) signal; numeric fields make a signal
  quantitative. Both can coexist.

### `medium.defineRole({ name, reads, writes, localQuery }): Role`

Register a role — a *function*, not an identity. Declares what it reads, what it
writes, and the slice it sees.

- **`reads` / `writes`** — arrays of `Signal`s (must be registered on this
  medium).
- **`localQuery`** — a `LocalQuery` (below). The agent's only read access when
  enacting this role.

**Phase 1 constraint:** `localQuery.types` must name exactly one signal type, and
that type must appear in `reads`. Multi-type local queries are a later addition.

### `medium.defineValidator({ name, triggers, validate }): Validator`

Register a validator — the gate on reinforcement.

- **`name`** — required, stable. Recorded in `stigmergy_reinforcements.validated_by`
  so multiple validators on one trigger are attributed independently and the
  audit log survives restarts.
- **`triggers`** — signal types whose deposits invoke `validate`.
- **`validate(signal, ctx)`** — async, returns a `Verdict`. `ctx` is a
  `ValidatorContext`.

### `medium.defineAgent({ id, roles, soul?, skills?, memory? }): Agent`

Register an agent — the identity that enacts roles.

- **`id`** — stable, unique on this medium. Stamped on every deposit.
- **`roles`** — roles this agent can enact, all registered on this medium.
- **`soul` / `skills` / `memory`** — optional identity documents (paths or
  inline markdown). Loaded when `run` starts, not at definition. See
  [`files.md`](./files.md).

### `medium.migrate(): Promise<void>`

Apply framework migrations and create a per-type table for every registered
signal. Idempotent. Run it explicitly — Stigmergy does **not** migrate on first
deposit. Rejects with "schema drift detected" when a registered signal's stored
shape hash or decay config no longer matches the code; that's the guardrail
against silently changing how existing signals decay.

### `medium.run(agent, handler, opts?): Promise<void>`

Start an agent loop.

```ts
function run<A extends Agent>(agent: A, handler: AgentHandler<A>, opts?: RunOptions): Promise<void>;
type AgentHandler<A> = (ctx: AgentContext<A>) => Promise<void>;
```

The handler is invoked every `opts.intervalMs` (default 1000), one invocation
per tick — back-pressure over concurrency, because tokens are expensive and the
urgency lives in the medium, not the loop. A fresh `AgentContext` is built each
tick. The decay sweep and validator dispatch start lazily on the first `run` on
a medium and stop when `close()` fires. Resolves cleanly on `close()`, or after
`opts.maxTicks` invocations when set. See `RunOptions`.

### `medium.updateValidator(validator, nextValidate): void`

Hot-swap a validator's rule without restarting the colony. The next triggering
signal is judged under the new rule; existing signals keep their current
strength and decay under the new regime. This is how goals adapt mid-run.

### `medium.query(sql): Promise<ReadonlyArray<Record<string, unknown>>>`

The inspection escape hatch — a raw read across the medium, for debugging,
dashboards, and tests. **Not available inside agent handlers** (that would
violate locality). Use it to watch the colony from outside; the queries in
[`colony-dynamics.md`](./colony-dynamics.md) are written against it.

### `medium.close(): Promise<void>`

Stop the sweep and validator loops, resolve any running `run()` promises, and
release the connection if the medium opened it (`{ url }` form). Idempotent.

---

## Signals and decay

### `Signal<TType, TShape>`

```ts
interface Signal<TType extends string, TShape extends z.ZodTypeAny> {
  readonly type: TType;
  readonly decay: Decay;
  readonly shape: TShape;
}
```

Helper types: `PayloadOf<S>` (= `z.infer<S["shape"]>`) and `TypeOf<S>` (= the
literal `type`).

### `Decay`

Every signal declares exactly one of three mechanisms:

```ts
type Decay =
  | { kind: "expiry"; after: Duration }
  | { kind: "strength"; factor: number; period: Duration; floor?: number }
  | { kind: "reinforcement"; window: Duration };
```

- **`expiry`** — binary visibility. The signal vanishes from reads after `after`
  has elapsed; the sweep deletes it. Use for signals that are simply stale after
  a known interval (a triage note, a draft).
- **`strength`** — a numeric `strength` column, multiplied by `factor` every
  `period`. Below `floor` (default `0.01`) the signal reads as 0 and the sweep
  deletes it. This is
  the quantitative pheromone — priority *is* strength, strength *is* a decay
  policy. Don't reach for a separate "priority" field.
- **`reinforcement`** — no stored strength; effective strength is the count of
  validated reinforcements in the trailing `window`. No reinforcement, no effect.
  This is how quorum / consensus-by-reinforcement falls out for free (see
  [`colony-dynamics.md`](./colony-dynamics.md) §3).

### `Duration`

```ts
type Duration = `${number}${"s" | "m" | "h" | "d"}`;  // "30s" | "15m" | "24h" | "7d"
```

### `DepositedSignal<S>`

What handlers and validators actually see when they read:

```ts
interface DepositedSignal<S extends Signal> {
  readonly id: string;
  readonly type: TypeOf<S>;
  readonly payload: PayloadOf<S>;
  readonly createdAt: Date;
  readonly originAgentId: string;
  readonly strength?: number;   // present when decay is "strength"
  readonly expiresAt?: Date;    // present when decay is "expiry"
}
```

---

## Roles, locality, and queries

### `Role<TReads, TWrites>`

```ts
interface Role<TReads, TWrites> {
  readonly name: string;
  readonly reads: TReads;
  readonly writes: TWrites;
  readonly localQuery: LocalQuery<TReads>;
}
```

Roles do not reference each other and do not know about agents. A role knows its
signals and its slice; that's all.

### `LocalQuery<TReads>`

```ts
interface LocalQuery<TReads> {
  readonly types: ReadonlyArray<TypeOf<TReads[number]>>;  // Phase 1: exactly one
  readonly where?: Filter;
  readonly orderBy?: { field: string; direction: "asc" | "desc" };
  readonly limit?: number;
}
```

The slice an agent sees while enacting the role. `field: "strength"` in `where`
or `orderBy` refers to the *effective* strength (post-decay), so a threshold like
`{ op: "gt", field: "strength", value: 0.7 }` means "loud enough right now."

### `Filter`

```ts
type Filter =
  | { op: "eq"; field: string; value: unknown }
  | { op: "gt"; field: string; value: number | string }
  | { op: "lt"; field: string; value: number | string }
  | { op: "and"; clauses: ReadonlyArray<Filter> }
  | { op: "or"; clauses: ReadonlyArray<Filter> };
```

---

## Agents and identity

### `Agent<TRoles>`

```ts
interface Agent<TRoles> {
  readonly id: string;
  readonly soul?: string;                    // path or inline markdown
  readonly skills?: ReadonlyArray<string>;   // paths or inline markdown
  readonly memory?: string;                  // path; read at run start, written at run end
  readonly roles: TRoles;
}
```

All three identity documents are optional — an agent with just an `id` and a
`roles` set is valid. The framework loads them as plain text and hands them to
the handler via the context; it does not interpret them. The one exception is
memory, which the framework writes back on `ctx.writeMemory()`. See
[`files.md`](./files.md).

---

## Validators and verdicts

### `Validator<TTriggers>`

```ts
interface Validator<TTriggers> {
  readonly name: string;
  readonly triggers: TTriggers;
  validate(signal: DepositedSignal<TTriggers[number]>, ctx: ValidatorContext): Promise<Verdict>;
}
```

Validation may be rule-based (the `validate` body is plain logic), agent-based
(the body makes an LLM call), or human-in-the-loop (the body awaits a promise a
webhook resolves). The framework applies the returned verdict uniformly.

### `Verdict`

```ts
type Verdict =
  | { approve: true;  boost?: number; extend?: Duration; target?: VerdictTarget }
  | { approve: false; penalty?: number;                  target?: VerdictTarget };
```

Reinforcement changes a signal's strength, expiry, or visibility — never its
content. `boost` adds to strength; `penalty` subtracts (clamped at zero);
`extend` pushes out an expiry. By default the verdict applies to the triggering
signal; set `target` to redirect it at another signal — the mechanism behind
cross-signal reinforcement and inhibitory trails.

### `VerdictTarget`

```ts
type VerdictTarget = { readonly type: string; readonly id: string };
```

`{ type, id }`, not a bare id — the type tells the runtime which table the
target lives in, so the mutation stays cheap. `ctx.find()` is the intended way to
locate the target.

### `ValidatorContext`

```ts
interface ValidatorContext {
  find<S extends Signal>(type: TypeOf<S>, where?: Filter): Promise<ReadonlyArray<DepositedSignal<S>>>;
}
```

A limited read surface for validators. They aren't roles and don't declare a
`localQuery`, but they need to read to decide a verdict and to locate
cross-signal targets.

---

## Contexts — what a running agent can do

### `AgentContext<A>`

The top-level surface a handler receives. No `ctx.medium`, no unbounded read, no
cross-agent messaging — the agent's surface is bounded by its roles.

```ts
interface AgentContext<A extends Agent> {
  readonly agentId: string;
  readonly soul?: string;                          // loaded text, if declared
  readonly skills: Readonly<Record<string, string>>; // keyed by skill name
  readonly memory?: string;
  readonly charter?: string;                       // inherited from the medium
  as<R extends A["roles"][number]>(role: R): RoleContext<R>;
  writeMemory(text: string): Promise<void>;
}
```

- **`as(role)`** — narrow into one of the agent's roles. The only way to read or
  write signals. Picking a role mid-handler, tick by tick, is the polyethism
  analog: the agent decides which function to enact based on what the medium
  shows. Throws if asked for a role the agent wasn't declared with.
- **`writeMemory(text)`** — replace MEMORY.md with a consolidated summary. There
  is no append API on purpose: every write is a full rewrite, so forgetting
  happens by omission. Throws if the agent has no `memory` document declared.

### `RoleContext<R>`

The per-role surface from `ctx.as(role)`. Reads and writes are constrained to
that role's signals; locality is enforced by the role's `localQuery`.

```ts
interface RoleContext<R extends Role> {
  view(): Promise<ReadonlyArray<DepositedSignal<R["reads"][number]>>>;
  deposit<T extends R["writes"][number]>(type: TypeOf<T>, payload: PayloadOf<T>): Promise<DepositedSignal<T>>;
  tryClaim(signalId: string, opts: { until: Duration }): Promise<boolean>;
  release(signalId: string): Promise<void>;
}
```

- **`view()`** — the role's local query, executed now. Effective strength is
  computed post-decay.
- **`deposit(type, payload)`** — write a signal of one of the role's `writes`
  types, stamped with the agent's id.
- **`tryClaim(id, { until })`** — atomic claim. Returns `true` if this agent got
  it, `false` if another agent already holds it. This is how competing agents
  divide work with no coordinator — the claim is a convention over the
  `claimed_by` / `claimed_until` shape fields, not a separate primitive. The TTL
  auto-releases the claim if the agent crashes.
- **`release(id)`** — drop a claim early.

---

## `RunOptions`

```ts
interface RunOptions {
  readonly intervalMs?: number;       // poll cadence; default 1000
  readonly sweepIntervalMs?: number;  // decay-sweep cadence; default 5000
  readonly maxTicks?: number;         // stop after N invocations; default: until close()
}
```

Phase 1 scheduling is interval polling. `LISTEN/NOTIFY`-driven wakeups are a
possible later addition, not a current guarantee. `maxTicks` is what bounds the
examples and lets batch jobs end deterministically.

---

## `MediumClient`

The DB-client shape the medium runs against. Both adapters satisfy it; implement
it yourself only if you're adapting a substrate the built-in adapters don't
cover.

```ts
interface MediumClient {
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close?(): Promise<void>;
}
```

---

## What is deliberately *not* in the API

A reference is also a statement of what we refused to add. None of these exist,
and each absence is a position — see [`api-sketch.md`](./api-sketch.md) for the
reasoning:

- No orchestrator or scheduler object. You run agents; they coordinate through
  the medium.
- No agent-to-agent messaging or handoffs.
- No `ctx.medium` escape hatch inside handlers.
- No priority-queue primitive (priority is strength), no retry primitive (a
  crashed agent's work stays in the medium), no cross-agent shared memory (if it
  matters to others, it's a signal with decay).
