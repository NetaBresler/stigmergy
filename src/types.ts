/**
 * Stigmergy — Phase 0 type sketch (revision 2).
 *
 * No runtime. No implementation. Types only. These interfaces define the
 * surface a developer of a Stigmergy colony writes against.
 *
 * See docs/primitives.md for the spec these interfaces implement, and
 * docs/api-sketch.md for a worked example of how they compose.
 *
 * Primitives modeled:
 *   Medium, Signal, Decay, Role, Agent, Validator.
 *   Locality is enforced through Role's localQuery field.
 */

import type { z } from "zod";

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

/**
 * Human-readable duration literal. Parsed at runtime in Phase 1.
 *
 *   "30s" | "15m" | "24h" | "7d"
 */
export type Duration = `${number}${"s" | "m" | "h" | "d"}`;

// ---------------------------------------------------------------------------
// Decay — every signal has one. No exceptions.
// ---------------------------------------------------------------------------

/**
 * How a signal fades over time. Every signal type must declare one.
 * The type system makes this structural, not a runtime check.
 */
export type Decay =
  /** Binary visibility. Signal disappears after `after` has elapsed. */
  | { kind: "expiry"; after: Duration }
  /**
   * Numeric strength, multiplied by `factor` every `period`.
   * Below `floor`, the signal is invisible.
   */
  | {
      kind: "strength";
      factor: number;
      period: Duration;
      floor?: number;
    }
  /** Effective strength = count of validated reinforcements in `window`. */
  | { kind: "reinforcement"; window: Duration };

// ---------------------------------------------------------------------------
// Signal — a registered schema for one kind of trace.
// ---------------------------------------------------------------------------

/**
 * A signal is quantitative if its decay is `"strength"`. A signal is
 * qualitative if its shape includes a `body: string` field. Both can
 * coexist on the same signal. The framework does not enforce a tag;
 * both channels are convention expressed through decay + shape.
 */
export interface Signal<
  TType extends string = string,
  TShape extends z.ZodTypeAny = z.ZodTypeAny
> {
  readonly type: TType;
  readonly decay: Decay;
  readonly shape: TShape;
}

export type PayloadOf<S extends Signal> = z.infer<S["shape"]>;
export type TypeOf<S extends Signal> = S["type"];

// ---------------------------------------------------------------------------
// LocalQuery — data, not a function. This is how Locality is enforced.
// ---------------------------------------------------------------------------

export interface LocalQuery<TReads extends ReadonlyArray<Signal>> {
  readonly types: ReadonlyArray<TypeOf<TReads[number]>>;
  readonly where?: Filter;
  readonly orderBy?: { field: string; direction: "asc" | "desc" };
  readonly limit?: number;
}

export type Filter =
  | { op: "eq"; field: string; value: unknown }
  | { op: "gt"; field: string; value: number | string }
  | { op: "lt"; field: string; value: number | string }
  | { op: "and"; clauses: ReadonlyArray<Filter> }
  | { op: "or"; clauses: ReadonlyArray<Filter> };

// ---------------------------------------------------------------------------
// Role — what function is being enacted.
// ---------------------------------------------------------------------------

/**
 * A role is a *function*, not an identity. It declares what signals are
 * read, what signals are written, and what slice of the medium is visible
 * during enactment.
 *
 * Roles do not reference each other. They do not know about agents.
 * An Agent *enacts* a Role; a Role knows only its signals and its slice.
 */
export interface Role<
  TReads extends ReadonlyArray<Signal> = ReadonlyArray<Signal>,
  TWrites extends ReadonlyArray<Signal> = ReadonlyArray<Signal>
> {
  readonly name: string;
  readonly reads: TReads;
  readonly writes: TWrites;
  readonly localQuery: LocalQuery<TReads>;
}

// ---------------------------------------------------------------------------
// Agent — who is enacting roles. The identity, distinct from the function.
// ---------------------------------------------------------------------------

/**
 * An Agent is *who* a colony member is: stable identity, a persona
 * (soul), a set of capabilities (skills), and accumulated learnings
 * (memory). An Agent can enact any role in its `roles` set — it selects
 * which role to play based on what the medium shows.
 *
 * Biological analog: an ant has a fixed genome (soul) and morphology
 * (skills) and learned history (memory), and performs different
 * functions (roles) over its lifetime as the colony needs shift.
 *
 * All three identity documents are optional. A framework consumer can
 * run Stigmergy with agents that have none — just an id and a role set.
 */
export interface Agent<
  TRoles extends ReadonlyArray<Role> = ReadonlyArray<Role>
> {
  readonly id: string;

  /**
   * Path or inline markdown for the agent's personality / values /
   * voice / boundaries. Compatible with the SoulSpec / SOUL.md
   * convention. Loaded once at run start and exposed on the context.
   */
  readonly soul?: string;

  /**
   * Paths or inline markdown for the agent's capabilities. Compatible
   * with the agentskills.io SKILL.md convention — progressive disclosure
   * is the implementation's responsibility.
   */
  readonly skills?: ReadonlyArray<string>;

  /**
   * Path to a consolidated memory file. Read at run start, written at
   * run end. Memory decays through consolidation (the agent rewrites
   * it), not through framework-level expiry. Raw events belong in the
   * medium; MEMORY.md holds distilled lessons.
   */
  readonly memory?: string;

  /**
   * The set of roles this agent is capable of enacting. At each tick,
   * the agent's handler selects which role to play.
   */
  readonly roles: TRoles;
}

// ---------------------------------------------------------------------------
// Validator — gates reinforcement. Framework equivalent of selection pressure.
// ---------------------------------------------------------------------------

/**
 * A verdict is applied to a signal — by default, the triggering signal.
 * Validators may direct a boost or penalty at a different signal by
 * setting `target` to its id; the validator is responsible for looking
 * that signal up via its ValidatorContext.
 */
export type Verdict =
  | { approve: true; boost?: number; extend?: Duration; target?: string }
  | { approve: false; penalty?: number; target?: string };

/**
 * A limited read surface for validators. Validators are not roles and
 * do not declare a localQuery, but they need read access to decide
 * verdicts and to locate target signals for cross-signal reinforcement.
 */
export interface ValidatorContext {
  find<S extends Signal>(
    type: TypeOf<S>,
    where?: Filter
  ): Promise<ReadonlyArray<DepositedSignal<S>>>;
}

export interface Validator<
  TTriggers extends ReadonlyArray<Signal> = ReadonlyArray<Signal>
> {
  readonly triggers: TTriggers;
  validate(
    signal: DepositedSignal<TTriggers[number]>,
    ctx: ValidatorContext
  ): Promise<Verdict>;
}

// ---------------------------------------------------------------------------
// DepositedSignal — what handlers and validators actually see.
// ---------------------------------------------------------------------------

export interface DepositedSignal<S extends Signal = Signal> {
  readonly id: string;
  readonly type: TypeOf<S>;
  readonly payload: PayloadOf<S>;
  readonly createdAt: Date;
  readonly originAgentId: string;
  /** Present when the signal's decay is `"strength"`. */
  readonly strength?: number;
  /** Present when the signal's decay is `"expiry"`. */
  readonly expiresAt?: Date;
}

// ---------------------------------------------------------------------------
// Contexts — what a running agent can actually do.
// ---------------------------------------------------------------------------

/**
 * The per-role surface an agent gets when it narrows into a role via
 * `ctx.as(role)`. Reads and writes are constrained to that role's
 * signals; locality is enforced by the role's localQuery.
 */
export interface RoleContext<R extends Role> {
  view(): Promise<ReadonlyArray<DepositedSignal<R["reads"][number]>>>;

  deposit<T extends R["writes"][number]>(
    type: TypeOf<T>,
    payload: PayloadOf<T>
  ): Promise<DepositedSignal<T>>;

  tryClaim(signalId: string, opts: { until: Duration }): Promise<boolean>;
  release(signalId: string): Promise<void>;
}

/**
 * The top-level surface an agent's handler sees. It exposes loaded
 * identity documents and a `.as(role)` narrowing operation. Crucially:
 * no `ctx.medium`, no unbounded read, no cross-agent messaging. The
 * agent's surface is bounded by its roles.
 */
export interface AgentContext<A extends Agent<ReadonlyArray<Role>>> {
  readonly agentId: string;

  /** Loaded content of the agent's soul file, if declared. */
  readonly soul?: string;

  /** Loaded content of the agent's skill files, keyed by skill name. */
  readonly skills: Readonly<Record<string, string>>;

  /** Loaded content of the agent's memory file, if declared. */
  readonly memory?: string;

  /** Loaded content of the medium's charter file, if declared. */
  readonly charter?: string;

  /**
   * Narrow the context to one of the agent's roles. This is the only
   * way to read or write signals. Picking a role mid-handler is the
   * polyethism analog — the agent decides which function to enact
   * based on what the medium shows.
   */
  as<R extends A["roles"][number]>(role: R): RoleContext<R>;

  /**
   * Write a consolidated memory summary. Replaces the current
   * MEMORY.md content. The agent is expected to distill rather than
   * stream — this is a consolidation pass, not a log append.
   */
  writeMemory(text: string): Promise<void>;
}

export type AgentHandler<A extends Agent<ReadonlyArray<Role>>> = (
  ctx: AgentContext<A>
) => Promise<void>;

// ---------------------------------------------------------------------------
// Medium — the entry point. Owns the registry.
// ---------------------------------------------------------------------------

/**
 * A handle to the Stigmergy substrate. Owns the registry of signals,
 * roles, validators, and agents.
 *
 * (Phase 1 revision: dropped the accumulating `TSignals` type parameter
 * that the Phase 0 sketch carried. Compile-time "signals must be
 * registered on this medium" was nice but forced `defineSignal` to return
 * the Medium instead of the Signal — which breaks the natural idiom
 * `const pheromone = medium.defineSignal(...); reads: [pheromone]`. The
 * constraint now lives at runtime: the medium rejects roles or validators
 * referencing unregistered signals when you `migrate()` or `run()`.)
 */
export interface Medium {
  defineSignal<TType extends string, TShape extends z.ZodTypeAny>(
    def: Signal<TType, TShape>
  ): Signal<TType, TShape>;

  defineRole<
    TReads extends ReadonlyArray<Signal>,
    TWrites extends ReadonlyArray<Signal>
  >(
    def: Role<TReads, TWrites>
  ): Role<TReads, TWrites>;

  defineValidator<TTriggers extends ReadonlyArray<Signal>>(
    def: Validator<TTriggers>
  ): Validator<TTriggers>;

  /**
   * Register an agent. `roles` must be roles previously registered on
   * this medium. Identity documents (soul, skills, memory) are loaded
   * when `run` is invoked, not at definition time.
   */
  defineAgent<TRoles extends ReadonlyArray<Role>>(
    def: Agent<TRoles>
  ): Agent<TRoles>;

  /**
   * Apply framework migrations and create per-signal-type tables from
   * currently-registered signal definitions. Idempotent. Rejects when
   * the stored shape hash of a registered signal differs from the code
   * ("schema drift detected"). Run explicitly — Stigmergy does not
   * migrate on first deposit.
   */
  migrate(): Promise<void>;

  /**
   * Start an agent loop. The handler is invoked on a schedule (Phase 1
   * will specify cadence and LISTEN/NOTIFY semantics).
   */
  run<A extends Agent<ReadonlyArray<Role>>>(
    agent: A,
    handler: AgentHandler<A>
  ): Promise<void>;

  /**
   * Hot-swap a validator's rule without restarting the colony. The
   * next triggering signal sees the new rule; existing signals keep
   * their current strength and decay under the new regime.
   */
  updateValidator<V extends Validator>(
    validator: V,
    nextValidate: V["validate"]
  ): void;

  /**
   * Developer escape hatch for inspection only. Raw read across the
   * medium, unavailable inside agent handlers. Use for debugging,
   * dashboards, and tests.
   */
  query(sql: string): Promise<ReadonlyArray<Record<string, unknown>>>;

  /** Release the underlying connection. Idempotent. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * A minimal DB client shape sufficient for Stigmergy's operations. Both
 * postgres-js (production) and PGlite (tests / in-process dev) satisfy
 * this via tiny adapters in `src/adapters/`.
 */
export interface MediumClient {
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close?(): Promise<void>;
}

/**
 * Open a Stigmergy medium.
 *
 * The common form passes `{ url }` — a Postgres connection string, opened
 * with postgres-js internally. The `{ client }` form lets callers bring
 * their own MediumClient (PGlite for tests, a custom pool, pgbouncer).
 *
 * `charter` is optional; when provided it's loaded (from path or treated
 * as inline markdown) and exposed as `ctx.charter` on every agent.
 */
export declare function defineMedium(
  connection: { url: string; charter?: string }
): Medium;
export declare function defineMedium(
  connection: { client: MediumClient; charter?: string }
): Medium;
