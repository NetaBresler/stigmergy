import { durationSeconds } from "./decay.js";
import { tableNameFor } from "./medium.js";
import { quoteIdent } from "./sql.js";
import type {
  DepositedSignal,
  MediumClient,
  Signal,
  Validator,
  ValidatorContext,
  Verdict,
  VerdictTarget,
} from "./types.js";

/**
 * Validator runtime — polling dispatcher and verdict application.
 *
 * Validators do not run synchronously in deposit(). A validator can be
 * a human-in-the-loop webhook that takes minutes to respond, or an LLM
 * call that takes seconds. Blocking the depositing agent on that would
 * poison throughput. Instead:
 *
 *   1. An agent deposits a signal. Returns fast.
 *   2. The validator dispatcher (one per medium, started at run-time)
 *      polls for signals whose type appears in some validator's
 *      `triggers` and for which no reinforcement row exists yet with
 *      `validated_by = validator.name`.
 *   3. For each match, the dispatcher builds a ValidatorContext and
 *      calls `validator.validate(signal, ctx)`.
 *   4. The resulting Verdict is applied via `applyVerdict()`:
 *        - A row in `stigmergy_reinforcements` is always written (audit).
 *        - For `strength`-decay targets, the target's stored strength is
 *          incremented (approve+boost) or decremented floor-at-zero
 *          (reject+penalty).
 *        - For `expiry`-decay targets, `expires_at` is pushed out by
 *          `extend` (approve only).
 *        - For `reinforcement`-decay signals, the reinforcement row IS
 *          the state — no per-signal column to update.
 *
 * Idempotency:
 *   The dispatcher filters out signals already validated by this
 *   validator (joined against `stigmergy_reinforcements`), so a
 *   restarted dispatcher does not double-process anything.
 */

// ---------------------------------------------------------------------------
// ValidatorContext — the surface a validator's validate() sees
// ---------------------------------------------------------------------------

/**
 * Build the limited read surface a Validator uses to look up target
 * signals. `find(type, where)` is kin to RoleContext.view(), but
 * without decay filtering (validators need to see signals even in
 * their final decayed moments) and without locality — validators are
 * privileged by design; the whole point is gating reinforcement across
 * the colony.
 *
 * `signalsByType` is the registry the medium maintains. When the
 * validator asks for a type that's registered, we hydrate the full
 * payload (same projection RoleContext.view() uses). When the type
 * isn't registered — e.g. a validator asking for stale data — we fall
 * back to meta-only rows rather than throwing, so old validators keep
 * working across schema refactors.
 */
export function buildValidatorContext(
  client: MediumClient,
  signalsByType: ReadonlyMap<string, Signal>
): ValidatorContext {
  return {
    async find<S extends Signal>(
      type: S["type"],
      _where?: unknown
    ): Promise<ReadonlyArray<DepositedSignal<S>>> {
      // `where` arrives with the role-query refactor when a second
      // caller needs it. Most validators match by trigger payload
      // (which they already have) and only need `find` to walk to a
      // related signal of a different type.
      const signal = signalsByType.get(type as string);
      const tableName = tableNameFor(type as string);

      if (!signal) {
        const rows = await client.query<Record<string, unknown>>(
          `SELECT id::text AS id, created_at, origin_agent_id FROM ${quoteIdent(tableName)}`
        );
        return rows.map((r) => ({
          id: r.id as string,
          type: type as S["type"],
          payload: {} as never,
          createdAt: r.created_at as Date,
          originAgentId: r.origin_agent_id as string,
        })) as ReadonlyArray<DepositedSignal<S>>;
      }

      const rows = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM ${quoteIdent(tableName)}`
      );
      const hydrated = await Promise.all(rows.map((r) => hydrateSignal(client, signal, r.id)));
      const defined = hydrated.filter((d): d is DepositedSignal => d !== undefined);
      return defined as unknown as ReadonlyArray<DepositedSignal<S>>;
    },
  };
}

// ---------------------------------------------------------------------------
// applyVerdict — write reinforcement row + mutate target as required
// ---------------------------------------------------------------------------

export async function applyVerdict(
  client: MediumClient,
  trigger: { type: string; id: string },
  verdict: Verdict,
  validatorName: string,
  triggerDecayKind: "expiry" | "strength" | "reinforcement",
  getDecayKind: (type: string) => Promise<"expiry" | "strength" | "reinforcement">
): Promise<void> {
  const target: VerdictTarget = verdict.target ?? { type: trigger.type, id: trigger.id };
  const approved = verdict.approve;

  // Audit row — always. signal_type/signal_id point at the verdict's target
  // (what got reinforced). trigger_signal_type/trigger_signal_id point at
  // the signal that tripped the validator, and are what the dispatcher
  // dedups on so cross-signal verdicts don't re-fire every tick.
  const boost = approved ? (verdict.boost ?? null) : null;
  const penalty = !approved ? (verdict.penalty ?? null) : null;
  const extendUntilDelta =
    approved && "extend" in verdict && verdict.extend ? durationSeconds(verdict.extend) : null;

  await client.query(
    `INSERT INTO stigmergy_reinforcements
       (signal_type, signal_id, trigger_signal_type, trigger_signal_id,
        approved, boost, penalty, extend_until, validated_by)
     VALUES ($1, $2::uuid, $3, $4::uuid, $5, $6, $7, ${
       extendUntilDelta === null ? "NULL" : `now() + (interval '1 second' * ${extendUntilDelta})`
     }, $8)`,
    [target.type, target.id, trigger.type, trigger.id, approved, boost, penalty, validatorName]
  );

  // Mutate the target signal's stored state. Only needed for strength-
  // and expiry-decay kinds; reinforcement-decay signals derive their
  // effective strength from the audit log directly.
  const targetDecay =
    target.type === trigger.type ? triggerDecayKind : await getDecayKind(target.type);
  const targetTable = tableNameFor(target.type);

  if (targetDecay === "strength") {
    if (approved && verdict.boost) {
      await client.query(
        `UPDATE ${quoteIdent(targetTable)}
           SET strength = strength + $1, last_decay_at = now()
         WHERE id = $2::uuid`,
        [verdict.boost, target.id]
      );
    } else if (!approved && verdict.penalty) {
      await client.query(
        `UPDATE ${quoteIdent(targetTable)}
           SET strength = GREATEST(strength - $1, 0), last_decay_at = now()
         WHERE id = $2::uuid`,
        [verdict.penalty, target.id]
      );
    }
    return;
  }

  if (targetDecay === "expiry" && approved && "extend" in verdict && verdict.extend) {
    const seconds = durationSeconds(verdict.extend);
    await client.query(
      `UPDATE ${quoteIdent(targetTable)}
         SET expires_at = expires_at + (interval '1 second' * ${seconds})
       WHERE id = $1::uuid`,
      [target.id]
    );
    return;
  }

  // reinforcement-decay: the audit row is the state. Nothing else to do.
}

// ---------------------------------------------------------------------------
// Dispatcher — polling loop that finds unvalidated signals and processes them
// ---------------------------------------------------------------------------

export interface DispatcherOptions {
  readonly intervalMs?: number;
}

export interface DispatcherHandle {
  /**
   * Start the polling loop. Safe to call once; subsequent calls are no-ops.
   * Production callers invoke this after defining validators. Tests usually
   * drive `tick()` explicitly and never call `start()`.
   */
  start(): void;
  /** Run one poll pass. Waits for any in-flight pass to complete first. */
  tick(): Promise<void>;
  /** Stop the polling loop (if started) and drain the in-flight pass. */
  stop(): Promise<void>;
}

/**
 * Construct a validator dispatcher. Does NOT auto-start; the caller
 * invokes `.start()` to begin polling or `.tick()` to run one pass
 * (tests do the latter). All ticks are serialized through a single
 * in-flight promise so there's no double-processing even if a caller
 * fires `tick()` while the polling loop is mid-pass.
 */
export function createValidatorDispatcher(
  client: MediumClient,
  validators: ReadonlyArray<Validator>,
  signalsByType: ReadonlyMap<string, Signal>,
  opts: DispatcherOptions = {}
): DispatcherHandle {
  const intervalMs = opts.intervalMs ?? 500;
  let stopped = false;
  let started = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const ctx = buildValidatorContext(client, signalsByType);

  const singleTick = async (): Promise<void> => {
    for (const validator of validators) {
      for (const signal of validator.triggers) {
        await processValidatorSignalPair(client, validator, signal, ctx);
      }
    }
  };

  const serialize = (): Promise<void> => {
    inFlight = inFlight.then(() => singleTick());
    return inFlight;
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      await serialize();
      if (stopped) break;
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, intervalMs);
      });
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      void loop();
    },
    async tick() {
      await serialize();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}

async function processValidatorSignalPair(
  client: MediumClient,
  validator: Validator,
  signal: Signal,
  ctx: ValidatorContext
): Promise<void> {
  const tableName = tableNameFor(signal.type);

  // Fetch every row of this trigger type not yet validated by this
  // validator. One round trip per (validator, trigger) per poll; we can
  // batch further if load demands.
  const rows = await client.query<{
    id: string;
    created_at: Date;
    origin_agent_id: string;
  }>(
    `SELECT s.id::text AS id, s.created_at, s.origin_agent_id
       FROM ${quoteIdent(tableName)} s
      WHERE NOT EXISTS (
        SELECT 1 FROM stigmergy_reinforcements r
         WHERE r.trigger_signal_type = $1
           AND r.trigger_signal_id = s.id
           AND r.validated_by = $2
      )`,
    [signal.type, validator.name]
  );

  for (const row of rows) {
    // Read the full signal (via a projection that mirrors the role
    // runtime) so the validator sees payload and decay metadata.
    const deposited = await hydrateSignal(client, signal, row.id);
    if (!deposited) continue;
    const verdict = await validator.validate(deposited, ctx);
    await applyVerdict(
      client,
      { type: signal.type, id: row.id },
      verdict,
      validator.name,
      signal.decay.kind,
      async (t) => lookupDecayKind(client, t)
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function lookupDecayKind(
  client: MediumClient,
  signalType: string
): Promise<"expiry" | "strength" | "reinforcement"> {
  const rows = await client.query<{ decay_kind: "expiry" | "strength" | "reinforcement" }>(
    `SELECT decay_kind FROM stigmergy_signal_registry WHERE type = $1`,
    [signalType]
  );
  const first = rows[0];
  if (!first) throw new Error(`Unknown signal type "${signalType}" when applying verdict`);
  return first.decay_kind;
}

async function hydrateSignal(
  client: MediumClient,
  signal: Signal,
  id: string
): Promise<DepositedSignal | undefined> {
  const tableName = tableNameFor(signal.type);
  const rows = await client.query<Record<string, unknown>>(
    `SELECT * FROM ${quoteIdent(tableName)} WHERE id = $1::uuid`,
    [id]
  );
  const row = rows[0];
  if (!row) return undefined;

  const shapeFields = listShapeFieldNames(signal);
  const payload: Record<string, unknown> = {};
  for (const field of shapeFields) payload[field] = row[field];

  const result: DepositedSignal = {
    id: row.id as string,
    type: signal.type,
    payload,
    createdAt: row.created_at as Date,
    originAgentId: row.origin_agent_id as string,
  };
  if (signal.decay.kind === "strength") {
    (result as { strength?: number }).strength = Number.parseFloat(String(row.strength));
  }
  if (signal.decay.kind === "expiry") {
    (result as { expiresAt?: Date }).expiresAt = row.expires_at as Date;
  }
  return result;
}

function listShapeFieldNames(signal: Signal): string[] {
  const def = (
    signal.shape as { _def: { typeName?: string; shape?: () => Record<string, unknown> } }
  )._def;
  if (def.typeName !== "ZodObject" || typeof def.shape !== "function") return [];
  return Object.keys(def.shape());
}
