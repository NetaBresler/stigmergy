/**
 * Stigmergy — Phase 0 type sketch.
 *
 * No runtime. No implementation. Types only. These interfaces define the
 * surface a developer of a Stigmergy colony writes against.
 *
 * See docs/primitives.md for the spec these interfaces implement, and
 * docs/api-sketch.md for a worked example of how they compose.
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
 * There is no valid Stigmergy schema without a decay story — the type
 * system makes this structural, not a runtime check.
 */
export type Decay =
  /**
   * Signal disappears when `after` elapses since its creation (or last
   * reinforcement). Binary — the signal is visible or it isn't.
   *
   * Use for: claims, task states, ephemeral notes.
   */
  | { kind: "expiry"; after: Duration }
  /**
   * Signal has a numeric `strength` that is multiplied by `factor` every
   * `period`. Below `floor` the signal is invisible to readers.
   *
   * Use for: quantitative pheromones — demand signal, priority, preference.
   */
  | {
      kind: "strength";
      factor: number;        // 0 < factor < 1
      period: Duration;
      floor?: number;        // default: 0.01
    }
  /**
   * Signal's effective strength is the count of validated reinforcements
   * within the trailing `window`. No reinforcement in the window → invisible.
   *
   * Use for: emergent consensus, quality-weighted routing.
   */
  | { kind: "reinforcement"; window: Duration };

// ---------------------------------------------------------------------------
// Signal — a registered schema for one kind of trace.
// ---------------------------------------------------------------------------

/**
 * A registered signal type. Produced by `medium.defineSignal(...)`.
 *
 * A signal is quantitative if its decay is `"strength"` (strength is the
 * quantitative channel). A signal is qualitative if its shape includes a
 * `body: string` field (freeform language the next agent renders into
 * context). Both can coexist on the same signal.
 *
 * `TShape` is the Zod schema the developer supplies. The framework adds
 * stable metadata columns (id, created_at, origin_agent, and
 * decay-specific fields like strength / expires_at) around it.
 */
export interface Signal<
  TType extends string = string,
  TShape extends z.ZodTypeAny = z.ZodTypeAny
> {
  readonly type: TType;
  readonly decay: Decay;
  readonly shape: TShape;
}

/** Shorthand: extract the payload type from a Signal. */
export type PayloadOf<S extends Signal> = z.infer<S["shape"]>;

/** Shorthand: extract the type-tag from a Signal. */
export type TypeOf<S extends Signal> = S["type"];

// ---------------------------------------------------------------------------
// LocalQuery — data, not a function. This is how Locality is enforced.
// ---------------------------------------------------------------------------

/**
 * The slice of the medium a Role reads. Data-shaped, not a function —
 * the framework constructs the query, the agent never runs its own.
 * This is what makes locality a type-level guarantee instead of a
 * best-effort convention.
 */
export interface LocalQuery<TReads extends ReadonlyArray<Signal>> {
  /** Which signal types this query pulls from. Subset of the role's reads. */
  readonly types: ReadonlyArray<TypeOf<TReads[number]>>;
  /** Optional filter expression. Small by design — Phase 1 supports eq/gt/lt/and/or. */
  readonly where?: Filter;
  /** Optional ordering. */
  readonly orderBy?: { field: string; direction: "asc" | "desc" };
  /** Optional limit. Defaults to an implementation-defined cap. */
  readonly limit?: number;
}

/** A minimal filter expression tree. Intentionally small. */
export type Filter =
  | { op: "eq"; field: string; value: unknown }
  | { op: "gt"; field: string; value: number | string }
  | { op: "lt"; field: string; value: number | string }
  | { op: "and"; clauses: ReadonlyArray<Filter> }
  | { op: "or"; clauses: ReadonlyArray<Filter> };

// ---------------------------------------------------------------------------
// Role — what an agent reads, writes, and sees.
// ---------------------------------------------------------------------------

/**
 * A role is a bundle of: (a) what signal types the agent reads,
 * (b) what signal types it writes, (c) what local slice it sees.
 *
 * Roles do not reference each other. A Role knows only its signals.
 * If two roles need to coordinate, they do it through signals in the
 * medium — never by name.
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
// Validator — gates reinforcement.
// ---------------------------------------------------------------------------

/**
 * The outcome of a validator run. Reinforcement changes a signal's
 * strength or expiry — never its content.
 */
export type Verdict =
  | { approve: true; boost?: number; extend?: Duration }
  | { approve: false; penalty?: number };

/**
 * A validator watches one or more signal types and, when one appears,
 * produces a Verdict. The backing can be a rule, an LLM call, or a
 * human-in-the-loop (resolving the promise from an external webhook).
 * The framework does not care — the shape is uniform.
 */
export interface Validator<
  TTriggers extends ReadonlyArray<Signal> = ReadonlyArray<Signal>
> {
  readonly triggers: TTriggers;
  validate(signal: DepositedSignal<TTriggers[number]>): Promise<Verdict>;
}

// ---------------------------------------------------------------------------
// DepositedSignal — what validators and handlers actually see.
// ---------------------------------------------------------------------------

/**
 * A signal as it exists in the medium — the developer's payload plus
 * framework-managed metadata. This is what `ctx.view()` returns and
 * what validators receive.
 */
export interface DepositedSignal<S extends Signal = Signal> {
  readonly id: string;
  readonly type: TypeOf<S>;
  readonly payload: PayloadOf<S>;
  readonly createdAt: Date;
  readonly originAgentId: string;
  /** Present when the signal's decay is "strength". */
  readonly strength?: number;
  /** Present when the signal's decay is "expiry". */
  readonly expiresAt?: Date;
}

// ---------------------------------------------------------------------------
// AgentContext — the *only* surface an agent handler sees.
// ---------------------------------------------------------------------------

/**
 * What a running agent can do. Crucially: there is no `ctx.medium`.
 * The handler cannot reach beyond its localQuery or its declared
 * writes. This is a type-level guarantee.
 */
export interface AgentContext<R extends Role> {
  /** Read the role's local slice. Returns the current matching signals. */
  view(): Promise<ReadonlyArray<DepositedSignal<R["reads"][number]>>>;

  /**
   * Write a signal of a declared-writable type. Any type not in
   * `role.writes` is a type error, not a runtime error.
   */
  deposit<T extends R["writes"][number]>(
    type: TypeOf<T>,
    payload: PayloadOf<T>
  ): Promise<DepositedSignal<T>>;

  /**
   * Atomically claim a signal. Returns true if acquired, false if
   * another agent got there first. Claim state lives in the signal's
   * shape (fields like `claimed_by`, `claimed_until`); this method
   * is only the safe conditional write.
   *
   * `until` can outlive the agent's run — a crashed agent's claim
   * evaporates when `until` passes, not when the process dies.
   */
  tryClaim(signalId: string, opts: { until: Duration }): Promise<boolean>;

  /** Release a claim this agent holds. No-op if the claim is not yours. */
  release(signalId: string): Promise<void>;

  /** The agent's own stable identifier. Stamped on every deposit. */
  readonly agentId: string;
}

/** The function a developer writes to define agent behavior. */
export type AgentHandler<R extends Role> = (
  ctx: AgentContext<R>
) => Promise<void>;

// ---------------------------------------------------------------------------
// Medium — the entry point. Owns the registry.
// ---------------------------------------------------------------------------

/**
 * A handle to the Stigmergy substrate. In Phase 1, this is a Postgres
 * connection. The Medium owns the registry of signal types, roles, and
 * validators — there is no global mutable state.
 *
 * The Medium's type parameter accumulates registered signals so that
 * later `defineRole` calls can constrain `reads`/`writes` to signals
 * this medium actually knows about.
 */
export interface Medium<
  TSignals extends ReadonlyArray<Signal> = ReadonlyArray<Signal>
> {
  /**
   * Register a signal type. Rejected at the type level if `decay` is
   * missing — that's the point of Stigmergy.
   */
  defineSignal<TType extends string, TShape extends z.ZodTypeAny>(
    def: Signal<TType, TShape>
  ): Medium<readonly [...TSignals, Signal<TType, TShape>]>;

  /**
   * Register a role. `reads` and `writes` must be signals previously
   * registered on this medium.
   */
  defineRole<
    TReads extends ReadonlyArray<TSignals[number]>,
    TWrites extends ReadonlyArray<TSignals[number]>
  >(
    def: Role<TReads, TWrites>
  ): Role<TReads, TWrites>;

  /** Register a validator for one or more signal types. */
  defineValidator<TTriggers extends ReadonlyArray<TSignals[number]>>(
    def: Validator<TTriggers>
  ): Validator<TTriggers>;

  /** Start an agent loop for a role. The handler is invoked on a schedule. */
  run<R extends Role>(role: R, handler: AgentHandler<R>): Promise<void>;

  /**
   * Developer escape hatch for inspection only. Returns raw rows across
   * the medium — not available inside agent handlers. Use for debugging,
   * dashboards, and tests. Agents use `ctx.view()`, not this.
   */
  query(sql: string): Promise<ReadonlyArray<Record<string, unknown>>>;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Open a Stigmergy medium. In Phase 1, `connection` is a Postgres URL
 * or a pg client. Returns an empty registry — nothing is registered
 * until you call `defineSignal`, `defineRole`, `defineValidator`.
 */
export declare function defineMedium(connection: {
  url: string;
}): Medium<readonly []>;
