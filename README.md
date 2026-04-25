# Stigmergy

A framework for coordinating LLM agents through a shared environment with decay — rather than through a manager.

## Status

Phase 1 complete. The reference implementation runs, 90 tests pass (87 under default PGlite + 3 more when `STIGMERGY_TEST_PG_URL` points at a real Postgres), the worked examples run end-to-end, and the docs match the code. **Installable from GitHub; not yet published to npm** — awaiting its first real user (see [Roadmap](docs/roadmap.md) Phase 2). Production-ready is not yet claimed.

## The 30-second pitch

Most multi-agent frameworks shipping today — CrewAI, AutoGen, Claude Agent Teams, OpenAI Swarm — copy the human org chart. A manager agent delegates to workers, collects their output, synthesizes a plan, delegates again. It works for small teams and plateaus hard past five or six agents. The manager becomes a context-window-shaped bottleneck.

Stigmergy replaces the manager with a shared medium. Agents read from a database, deposit signals as they work, and the next agent picks up whatever the medium suggests it should do next. Stale signals decay automatically so the colony forgets plans that aren't working. Specialization emerges from the pressure landscape instead of being assigned by a planner.

It's how termite mounds get built without blueprints, and it's the coordination pattern ant colonies have been running for two hundred million years.

## Install

```bash
npm install github:NetaBresler/stigmergy
```

The package builds itself on install (via `prepare`). Node 22+. Postgres is the default substrate; [PGlite](https://github.com/electric-sql/pglite) works in-process for tests and demos.

## Quick start

Clone and run the worked examples:

```bash
git clone https://github.com/NetaBresler/stigmergy
cd stigmergy
npm install
npx tsx examples/bug-triage.ts       # 3 agents, ~5s — the teaching ground
npx tsx examples/oss-maintainer.ts   # 10 agents, ~25s — the showcase
```

`bug-triage.ts` walks a Reporter, two Triagers, and a Validator through every primitive — strength decay, claim races, cross-signal reinforcement — in about 240 lines. `oss-maintainer.ts` is the same framework turned up to ten agents across three simulated sensor streams; the summary at the bottom shows emergent specialization with no planner. See [`examples/README.md`](examples/README.md) for what's happening.

## Why this exists

After surveying what's shipping, we found no production-ready framework that implements stigmergy for LLM agents. There are academic prototypes (SwarmSys, SIER, AntLLM). There are practitioner essays (Welty's "Context as Facticity," Rodriguez's "Why Multi-Agent Systems Don't Need Managers"). There is a formal framework for database-backed stigmergy (Paredes García's Ledger-State Stigmergy). There is no installable, opinionated, documented tool.

We're building that tool.

## Further reading

- [`PHILOSOPHY.md`](PHILOSOPHY.md) — the thesis.
- [`docs/primitives.md`](docs/primitives.md) — the six primitives that make a system stigmergic.
- [`docs/files.md`](docs/files.md) — the CHARTER / SOUL / SKILL / MEMORY convention.
- [`docs/api-sketch.md`](docs/api-sketch.md) — what the code looks like end-to-end.
- [`docs/colony-dynamics.md`](docs/colony-dynamics.md) — phenomena that emerge from the primitives, and how to diagnose them.
- [`docs/prior-art.md`](docs/prior-art.md) — what exists, with citations.
- [`docs/roadmap.md`](docs/roadmap.md) — what we're building, in phases.

## License

MIT.
