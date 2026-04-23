import type { Decay, Duration } from "./types.js";
import type { MigrationClient } from "./migrator.js";

/**
 * Decay — the pure-function heart of Stigmergy.
 *
 * This module is deliberately substrate-agnostic. It does not connect to a
 * database. It returns SQL fragments that callers (src/medium.ts when it
 * lands) splice into their queries, and a single async `sweepSignal` routine
 * for the periodic cleanup that keeps the medium from growing forever.
 *
 * Design: hybrid (lazy for correctness, eager for cleanup).
 *   - Reads always compute the *effective* strength in SQL at query time,
 *     so callers never see a stale value even between sweeps.
 *   - A periodic sweep persists decayed strengths back to storage and
 *     deletes expired rows, so the computation in read queries doesn't
 *     have to multiply over arbitrarily large intervals.
 *
 * The three decay kinds map to three different SQL shapes:
 *   - expiry       — filter by `expires_at > now()`; sweep deletes.
 *   - strength     — `stored_strength * factor ^ (elapsed / period)`;
 *                    sweep catches up the stored value.
 *   - reinforcement — join-count of recent approvals in
 *                     `stigmergy_reinforcements`; no per-signal sweep.
 */

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

/**
 * Convert a duration literal ("30s", "15m", "24h", "7d") to seconds.
 * Throws on malformed input — the literal type guards callers in TS, but
 * runtime data (parsed JSON from the registry, for instance) still needs
 * validation.
 */
export function durationSeconds(d: Duration | string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(d);
  if (!match) {
    throw new Error(`Invalid Duration literal: ${JSON.stringify(d)}`);
  }
  const value = Number.parseInt(match[1] as string, 10);
  const unit = match[2] as keyof typeof UNIT_SECONDS;
  return value * UNIT_SECONDS[unit];
}

// ---------------------------------------------------------------------------
// Schema: what columns a decay kind contributes to a per-signal-type table
// ---------------------------------------------------------------------------

/**
 * The extra DDL column definitions required to support this decay kind on
 * a per-signal-type table. Consumed by `medium.defineSignal()` when it
 * generates CREATE TABLE statements.
 */
export function decayColumnsDDL(decay: Decay): readonly string[] {
  switch (decay.kind) {
    case "expiry":
      return ["expires_at timestamptz NOT NULL"];
    case "strength":
      return [
        "strength numeric NOT NULL",
        "last_decay_at timestamptz NOT NULL DEFAULT now()",
      ];
    case "reinforcement":
      return [];
  }
}

/**
 * Column-name → initial-value pairs to INSERT when depositing a signal of
 * this decay kind. Callers merge this with the developer-supplied payload.
 *
 *   - expiry: `expires_at = now() + after`
 *   - strength: `strength = 1.0`, `last_decay_at = now()` (DB default; we
 *     return nothing so the column defaults are used)
 *   - reinforcement: nothing (strength is a join-count, not a column)
 */
export function decayInsertValues(
  decay: Decay,
  now: Date = new Date()
): Record<string, unknown> {
  switch (decay.kind) {
    case "expiry": {
      const expires = new Date(now.getTime() + durationSeconds(decay.after) * 1000);
      return { expires_at: expires };
    }
    case "strength":
      return { strength: 1.0, last_decay_at: now };
    case "reinforcement":
      return {};
  }
}

// ---------------------------------------------------------------------------
// Effective strength: SQL that evaluates to "how visible is this signal now"
// ---------------------------------------------------------------------------

export interface DecaySqlContext {
  /** Signal type name, used for the reinforcement-decay subquery. */
  readonly signalType: string;
  /** Table alias in the outer query, e.g. `s` for `FROM my_table s`. */
  readonly tableAlias: string;
}

const DEFAULT_STRENGTH_FLOOR = 0.01;

/**
 * SQL expression evaluating to the signal's *effective* strength at query
 * time. The value is a numeric; zero means invisible, positive means active.
 *
 * Interpretation per decay kind:
 *   - expiry        1.0 if still within expires_at, 0.0 otherwise.
 *   - strength      stored strength exponentially decayed since last_decay_at,
 *                   clamped at the configured floor (sub-floor → 0).
 *   - reinforcement sum of (boost - penalty) across approvals/rejections in
 *                   stigmergy_reinforcements within the trailing window.
 *                   Approvals without explicit boost count as 1; rejections
 *                   without explicit penalty don't subtract.
 */
export function effectiveStrengthSQL(
  decay: Decay,
  ctx: DecaySqlContext
): string {
  const { signalType, tableAlias } = ctx;
  switch (decay.kind) {
    case "expiry":
      return `CASE WHEN ${tableAlias}.expires_at > now() THEN 1.0 ELSE 0.0 END`;
    case "strength": {
      const floor = decay.floor ?? DEFAULT_STRENGTH_FLOOR;
      const periodSeconds = durationSeconds(decay.period);
      const decayed = `${tableAlias}.strength * POWER(${decay.factor}, EXTRACT(EPOCH FROM (now() - ${tableAlias}.last_decay_at)) / ${periodSeconds})`;
      return `CASE WHEN (${decayed}) >= ${floor} THEN (${decayed}) ELSE 0.0 END`;
    }
    case "reinforcement": {
      const windowSeconds = durationSeconds(decay.window);
      return `COALESCE((
        SELECT SUM(CASE WHEN r.approved THEN COALESCE(r.boost, 1) ELSE -COALESCE(r.penalty, 0) END)
        FROM stigmergy_reinforcements r
        WHERE r.signal_type = ${quoteLiteral(signalType)}
          AND r.signal_id = ${tableAlias}.id
          AND r.created_at > now() - interval '${windowSeconds} seconds'
      ), 0)::numeric`;
    }
  }
}

/**
 * SQL predicate selecting signals that are currently visible (effective
 * strength > 0). Callers use this in WHERE clauses. Wraps the
 * effectiveStrengthSQL expression with `> 0`.
 */
export function visibilityPredicate(
  decay: Decay,
  ctx: DecaySqlContext
): string {
  return `(${effectiveStrengthSQL(decay, ctx)}) > 0`;
}

// ---------------------------------------------------------------------------
// Sweep: periodic maintenance that keeps storage from drifting
// ---------------------------------------------------------------------------

export interface SweepStats {
  readonly signalType: string;
  readonly deleted: number;
  readonly updated: number;
}

/**
 * Maintenance for one signal type. Run periodically — default cadence is a
 * runtime concern (src/runtime.ts), not a decay concern.
 *
 *   - expiry:       DELETE rows past expires_at.
 *   - strength:     UPDATE stored strength to match its decayed value;
 *                   advance last_decay_at. Rows below the floor are deleted.
 *   - reinforcement: no-op. The audit log is trimmed elsewhere.
 */
export async function sweepSignal(
  client: MigrationClient,
  signalType: string,
  tableName: string,
  decay: Decay
): Promise<SweepStats> {
  switch (decay.kind) {
    case "expiry": {
      const rows = await client.query<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM ${quoteIdent(tableName)} WHERE expires_at <= now() RETURNING 1
         )
         SELECT count(*)::text AS count FROM deleted`
      );
      const deleted = Number.parseInt(rows[0]?.count ?? "0", 10);
      return { signalType, deleted, updated: 0 };
    }
    case "strength": {
      const floor = decay.floor ?? DEFAULT_STRENGTH_FLOOR;
      const periodSeconds = durationSeconds(decay.period);
      const updatedRows = await client.query<{ count: string }>(
        `WITH updated AS (
           UPDATE ${quoteIdent(tableName)}
              SET strength = strength * POWER(${decay.factor}, EXTRACT(EPOCH FROM (now() - last_decay_at)) / ${periodSeconds}),
                  last_decay_at = now()
            WHERE last_decay_at < now() RETURNING 1
         )
         SELECT count(*)::text AS count FROM updated`
      );
      const deletedRows = await client.query<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM ${quoteIdent(tableName)} WHERE strength < ${floor} RETURNING 1
         )
         SELECT count(*)::text AS count FROM deleted`
      );
      return {
        signalType,
        deleted: Number.parseInt(deletedRows[0]?.count ?? "0", 10),
        updated: Number.parseInt(updatedRows[0]?.count ?? "0", 10),
      };
    }
    case "reinforcement":
      return { signalType, deleted: 0, updated: 0 };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quote a SQL identifier. Defensive — our signal/table names should already
 *  be alphanumeric+underscore, but this closes the door on accidental
 *  injection from misuse. */
function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/** Quote a SQL string literal. Used for the reinforcement subquery's
 *  signal_type comparison. Signal type strings come from developer code,
 *  not runtime input, but we still escape defensively. */
function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
