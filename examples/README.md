# Stigmergy examples

Small self-contained colonies that demonstrate the framework end-to-end.

## Running

From a fresh clone:

```bash
git clone https://github.com/NetaBresler/stigmergy
cd stigmergy
npm install
npx tsx examples/niche-discovery.ts
```

`npm install` builds the package (via the `prepare` script). Every example runs against in-process [PGlite](https://github.com/electric-sql/pglite) — no Postgres setup required. Node 22+.

## `niche-discovery.ts` — the default colony

A toy product-discovery colony. One Scout agent deposits candidate niches as `demand_pheromone` signals. A Worker agent picks up high-strength demand and "builds" a prototype (logs to stdout). A Validator approves scout reports that look plausible, boosting the matching demand pheromone so the signal reinforces over time.

Runs for a dozen ticks and shuts down cleanly.

### What to watch for

- **Pheromones decay.** A demand signal starts at strength `1.0` and loses half per hour. Watch the `strength` column in the output drop over ticks.
- **Validators reinforce winners.** When the Validator approves a report, its matching pheromone jumps back up. Weak niches whose reports get rejected fade out.
- **Specialization emerges from pressure.** The Scout and Worker never talk to each other. They both read the same medium; they act on different slices of it because their local queries differ. That's locality.
- **Claims are atomic.** If you duplicated the Worker agent, both copies reading the same pheromone would race for `tryClaim()`; exactly one would win.

### Reading the code

The whole example is ~220 lines in one file. In order, you'll see:

1. `defineMedium` with an in-process PGlite client.
2. `defineSignal` for `demand_pheromone`, `scout_report`, `worker_result` — each with an explicit decay story.
3. `defineRole` for Scout and Worker, each with a bounded `localQuery`.
4. `defineValidator` for the report approver.
5. `defineAgent` wrapping each role with a stable id and (optionally) soul/skills/memory.
6. `runAgent` starting the loop. The runtime polls the agent's view every tick and invokes your handler.

When you're done, `Ctrl+C` stops the loop, or the example's built-in shutdown fires after N ticks.

## Writing your own

Fork `niche-discovery.ts`, rename the signals, rewrite the handlers. The structure will feel the same: medium → signals → roles → agents → validators → run. No orchestrator, no messaging, no cross-agent references.

If something feels awkward, that's a signal (the kind the framework cares about, not the kind in the database). Open an issue.
