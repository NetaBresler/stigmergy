# Stigmergy examples

Small self-contained colonies that demonstrate the framework end-to-end.
Every example runs against in-process PGlite, so you can read the code
and then `npx tsx examples/<file>.ts` without setting up a database.

- **`niche-discovery.ts`** — a toy product-discovery colony. One Scout
  agent deposits candidate niches as demand pheromones. A Worker agent
  picks up high-strength demand and "builds" a prototype (logs to
  stdout). A Validator approves reports that look plausible, boosting
  the matching demand pheromone so the signal reinforces over time.
  Runs for a dozen ticks and then shuts down.
