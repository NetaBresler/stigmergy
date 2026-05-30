import { randomUUID } from "node:crypto";
import { sweepSignal } from "./decay.js";
import { tryAcquireLease } from "./lease.js";
import { mediumState, tableNameFor } from "./medium.js";
import { createValidatorDispatcher } from "./validator.js";
import type { Medium, MediumClient, Signal } from "./types.js";

/**
 * Background workers — the maintenance that keeps a colony alive regardless of
 * which agents happen to be connected.
 *
 * Two loops, both per-medium singletons:
 *
 *   - sweep    — applies decay: persists decayed strengths, deletes expired
 *                rows. Naturally idempotent (decay is computed from elapsed
 *                time), so running it twice is harmless; the lease just avoids
 *                wasted work.
 *   - dispatch — runs the validator dispatcher: finds un-validated trigger
 *                signals and applies their verdicts.
 *
 * Both are guarded by a lease (src/lease.ts) so that across many server
 * instances only one runs each loop at a time. The lease is an optimization;
 * the correctness backstop for dispatch is the unique index from migration
 * 003 (see applyVerdict).
 *
 * `ensureWorkers(medium)` is idempotent — the in-process runtime loop and the
 * network server both call it, and the second call returns the same handle.
 * `medium.close()` stops the workers (the handle is stashed on MediumState).
 */

export interface WorkerOptions {
  /** Milliseconds between decay-sweep passes. Default 5000. */
  readonly sweepIntervalMs?: number;
  /** Milliseconds between validator-dispatch passes. Default 500. */
  readonly dispatchIntervalMs?: number;
  /** Lease lifetime in ms. Default: 4× the slowest loop interval. */
  readonly leaseTtlMs?: number;
  /** Identity of this instance for lease ownership. Default: a random uuid. */
  readonly instanceId?: string;
}

export interface WorkersHandle {
  readonly instanceId: string;
  stop(): Promise<void>;
}

const workersByMedium = new WeakMap<Medium, WorkersHandle>();

/**
 * Start (once) the colony's background workers for this medium. Returns the
 * existing handle if already started.
 */
export function ensureWorkers(medium: Medium, opts: WorkerOptions = {}): WorkersHandle {
  const existing = workersByMedium.get(medium);
  if (existing) return existing;

  const state = mediumState(medium);
  if (!state) throw new Error("ensureWorkers: medium is not a valid Stigmergy medium");

  const client = state.client;
  const instanceId = opts.instanceId ?? randomUUID();
  const sweepIntervalMs = opts.sweepIntervalMs ?? 5000;
  const dispatchIntervalMs = opts.dispatchIntervalMs ?? 500;
  const leaseTtlMs = opts.leaseTtlMs ?? Math.max(sweepIntervalMs, dispatchIntervalMs) * 4;
  const leaseTtlSeconds = Math.max(1, Math.ceil(leaseTtlMs / 1000));

  let stopped = false;
  const dispatcher = createValidatorDispatcher(client, state.validators, state.signals);

  const stoppedOrClosed = () => stopped || state.closed;

  const sweepLoop = (async () => {
    while (!stoppedOrClosed()) {
      try {
        if (await tryAcquireLease(client, "sweep", instanceId, leaseTtlSeconds)) {
          await sweepAllSignals(client, state.signals.values());
        }
      } catch (err) {
        console.error("[stigmergy] sweep worker error:", err);
      }
      await delay(sweepIntervalMs, stoppedOrClosed);
    }
  })();

  const dispatchLoop = (async () => {
    while (!stoppedOrClosed()) {
      try {
        if (await tryAcquireLease(client, "dispatch", instanceId, leaseTtlSeconds)) {
          await dispatcher.tick();
        }
      } catch (err) {
        console.error("[stigmergy] dispatch worker error:", err);
      }
      await delay(dispatchIntervalMs, stoppedOrClosed);
    }
  })();

  const handle: WorkersHandle = {
    instanceId,
    async stop() {
      stopped = true;
      await dispatcher.stop();
      await Promise.allSettled([sweepLoop, dispatchLoop]);
    },
  };

  workersByMedium.set(medium, handle);
  state.workers = handle;
  return handle;
}

/**
 * Sweep every registered signal type once. Exported for tests that want
 * deterministic decay application without waiting for the loop, and re-exported
 * from src/runtime.ts for backwards compatibility.
 */
export async function sweepAllSignals(
  client: MediumClient,
  signals: Iterable<Signal>
): Promise<void> {
  for (const signal of signals) {
    await sweepSignal(client, signal.type, tableNameFor(signal.type), signal.decay);
  }
}

/**
 * Sleep that resolves early when the stop predicate becomes true. Polls in
 * small slices so a stop request takes effect promptly rather than after a
 * full interval.
 */
async function delay(ms: number, stopped: () => boolean): Promise<void> {
  const slice = 25;
  let remaining = ms;
  while (remaining > 0 && !stopped()) {
    const chunk = Math.min(slice, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}
