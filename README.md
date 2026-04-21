# Stigmergy

A framework for coordinating LLM agents through a shared environment with decay — rather than through a manager.

## Status

Early. The thesis is drafted, the primitives are specified, the reference implementation is being designed. Not yet installable. Not yet recommended for production use. Watch this repo.

## The 30-second pitch

Most multi-agent frameworks shipping today — CrewAI, AutoGen, Claude Agent Teams, OpenAI Swarm — copy the human org chart. A manager agent delegates to workers, collects their output, synthesizes a plan, delegates again. It works for small teams and plateaus hard past five or six agents. The manager becomes a context-window-shaped bottleneck.

Stigmergy replaces the manager with a shared medium. Agents read from a database, deposit signals as they work, and the next agent picks up whatever the medium suggests it should do next. Stale signals decay automatically so the colony forgets plans that aren't working. Specialization emerges from the pressure landscape instead of being assigned by a planner.

It's how termite mounds get built without blueprints, and it's the coordination pattern ant colonies have been running for two hundred million years.

## Why this exists

Because after surveying what's shipping, we found no production-ready framework that implements stigmergy for LLM agents. There are academic prototypes (SwarmSys, SIER, AntLLM). There are practitioner essays (Welty's "Context as Facticity," Rodriguez's "Why Multi-Agent Systems Don't Need Managers"). There is a formal framework for database-backed stigmergy (Paredes García's Ledger-State Stigmergy). There is no installable, opinionated, documented tool.

We're building that tool.

## Further reading

- `PHILOSOPHY.md` — the thesis.
- `docs/primitives.md` — the five primitives that make a system stigmergic.
- `docs/prior-art.md` — what exists, with citations.
- `docs/roadmap.md` — what we're building, in phases.

## License

MIT.
