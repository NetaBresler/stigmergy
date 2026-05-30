import { buildAgentContext } from "./agent.js";
import { mediumState, resolvedCharter } from "./medium.js";
import type { Agent, AgentHandler, Medium, Role } from "./types.js";
import { ensureWorkers } from "./workers.js";

// Re-exported for backwards compatibility — the implementation now lives in
// src/workers.ts alongside the rest of the background-worker machinery.
export { sweepAllSignals } from "./workers.js";

/**
 * Runtime — the in-process agent loop.
 *
 * `runAgent(medium, agent, handler, opts)` invokes the handler periodically,
 * constructing a fresh AgentContext each tick. The colony's background workers
 * (decay sweep + validator dispatch) are started lazily via `ensureWorkers`
 * the first time any agent runs; both stop when `medium.close()` is called.
 *
 * Design choices:
 *   - One handler invocation per tick, not parallel within a tick. If the
 *     handler is slow, the next tick waits — back-pressure over concurrency is
 *     what a stigmergic system wants: tokens are expensive, and the medium is
 *     where the urgency lives.
 *   - Sweep and dispatch run on their own cadence in the background, not per
 *     handler tick.
 *   - Abort via `medium.close()`. The run promise resolves cleanly.
 *
 * For agents that live outside this process, see `serve()` (src/server) and
 * `connect()` (src/client) — the network equivalent of this loop.
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
  const client = state.client;
  const charter = resolvedCharter(medium);

  // Kick off the per-medium background workers on first run.
  ensureWorkers(
    medium,
    opts.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: opts.sweepIntervalMs }
  );

  let ticks = 0;
  while (!state.closed) {
    if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) break;
    ticks += 1;

    const ctx = await buildAgentContext({ client, agent, charter });
    try {
      await handler(ctx);
    } catch (err) {
      // Propagate after logging; a crashing handler stops that agent but does
      // not stop the colony. The medium stays up.
      console.error(`[stigmergy] agent "${agent.id}" handler threw:`, err);
      throw err;
    }

    if (state.closed) break;
    await sleep(intervalMs, () => state.closed);
  }
}

/**
 * Sleep that resolves early when the stop predicate becomes true. Polls every
 * 25ms so medium.close() causes prompt shutdown without dragging out the whole
 * interval.
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
