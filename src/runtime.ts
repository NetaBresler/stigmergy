import { buildAgentContext } from "./agent.js";
import { sweepSignal } from "./decay.js";
import {
  mediumState,
  resolvedCharter,
  startValidatorDispatcherIfNeeded,
  tableNameFor,
} from "./medium.js";
import type { Agent, AgentHandler, Medium, MediumClient, Role, Signal } from "./types.js";

/**
 * Runtime — the agent loop and medium-level maintenance.
 *
 * `runAgent(medium, agent, handler, opts)` invokes the handler
 * periodically, constructing a fresh AgentContext each tick. Validator
 * dispatch and decay sweep are per-medium singletons started lazily
 * the first time any agent runs; both stop when `medium.close()` is
 * called.
 *
 * Design choices:
 *   - One handler invocation per tick, not parallel within a tick. If
 *     the handler is slow, the next tick waits — back-pressure over
 *     concurrency is what a stigmergic system wants: tokens are
 *     expensive, and the medium is where the urgency lives.
 *   - Sweep runs at its own cadence, not per handler tick. Decay
 *     cleanup shouldn't stall agent work.
 *   - Abort via `medium.close()`. The run promise resolves cleanly.
 */

export interface RunOptions {
  /** Milliseconds between handler invocations. Default 1000. */
  readonly intervalMs?: number;
  /** Milliseconds between decay-sweep passes. Default 5000. */
  readonly sweepIntervalMs?: number;
  /** For tests: stop after this many handler invocations. Default: no limit. */
  readonly maxTicks?: number;
}

export async function runAgent<A extends Agent<ReadonlyArray<Role>>>(
  medium: Medium,
  agent: A,
  handler: AgentHandler<A>,
  opts: RunOptions = {}
): Promise<void> {
  const state = mediumState(medium);
  if (!state) throw new Error("runAgent: medium is not a valid Stigmergy medium");
  if (state.closed) throw new Error("runAgent: medium is closed");
  if (state.agents.get(agent.id) !== agent) {
    throw new Error(
      `runAgent: agent "${agent.id}" is not registered on this medium (did you call medium.defineAgent()?)`
    );
  }

  const intervalMs = opts.intervalMs ?? 1000;
  const sweepIntervalMs = opts.sweepIntervalMs ?? 5000;
  const client = state.client;
  const charter = resolvedCharter(medium);

  // Kick off the per-medium singletons on first run.
  startValidatorDispatcherIfNeeded(medium);
  startSweepLoopIfNeeded(medium, state, sweepIntervalMs);

  let ticks = 0;
  while (!state.closed) {
    if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) break;
    ticks += 1;

    const ctx = await buildAgentContext({ client, agent, charter });
    try {
      await handler(ctx);
    } catch (err) {
      // Propagate after logging; a crashing handler stops that agent
      // but does not stop the colony. The medium stays up.
      console.error(`[stigmergy] agent "${agent.id}" handler threw:`, err);
      throw err;
    }

    if (state.closed) break;
    await sleep(intervalMs, () => state.closed);
  }
}

// ---------------------------------------------------------------------------
// Sweep loop — per-medium singleton, started lazily
// ---------------------------------------------------------------------------

const mediumSweepState = new WeakMap<Medium, { started: boolean }>();

function startSweepLoopIfNeeded(
  medium: Medium,
  state: ReturnType<typeof mediumState> & object,
  intervalMs: number
): void {
  let tracker = mediumSweepState.get(medium);
  if (!tracker) {
    tracker = { started: false };
    mediumSweepState.set(medium, tracker);
  }
  if (tracker.started) return;
  tracker.started = true;

  void (async () => {
    while (!state.closed) {
      await sleep(intervalMs, () => state.closed);
      if (state.closed) break;
      try {
        await sweepAllSignals(state.client, state.signals.values());
      } catch (err) {
        console.error("[stigmergy] sweep loop errored:", err);
      }
    }
  })();
}

/**
 * Sweep every registered signal type. Exported for tests that want
 * deterministic decay application without waiting for the loop.
 */
export async function sweepAllSignals(
  client: MediumClient,
  signals: Iterable<Signal>
): Promise<void> {
  for (const signal of signals) {
    await sweepSignal(client, signal.type, tableNameFor(signal.type), signal.decay);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sleep that resolves early when the stop predicate becomes true.
 * Polls every 25ms so medium.close() causes prompt shutdown without
 * dragging out the whole interval.
 */
async function sleep(ms: number, stopped: () => boolean): Promise<void> {
  const slice = 25;
  let remaining = ms;
  while (remaining > 0 && !stopped()) {
    const chunk = Math.min(slice, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}
