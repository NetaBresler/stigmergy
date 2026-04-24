# Getting Started — for a new Claude Code session on this repo

You are being invoked to help work on the **Stigmergy** framework. Phase 0 (API spec) and Phase 1 (reference implementation) are complete. The framework runs against both PGlite (in-process) and real Postgres; 86 tests pass.

## Before you respond to anything

Read these in order:

1. `README.md` — status and 30-second pitch
2. `PHILOSOPHY.md` — the thesis
3. `docs/primitives.md` — the six primitives as a concrete spec
4. `docs/prior-art.md` — what exists, what we're doing differently
5. `docs/roadmap.md` — phased plan and current phase
6. `docs/api-sketch.md` — what the code looks like end-to-end
7. `docs/files.md` — the CHARTER / SOUL / SKILL / MEMORY convention
8. `docs/colony-dynamics.md` — phenomena that emerge from the primitives, and how to diagnose them
9. `CLAUDE.md` — session protocol

## What to optimize for

- **Inspectability.** A developer should be able to query the medium directly and understand the colony's state without running any Stigmergy code.
- **Opinionatedness.** Stigmergy has a position. It rejects schemas without decay. It enforces locality. It refuses to let agents message each other directly. Make the API reflect that.
- **Minimalism.** Six primitives. A handful of functions per primitive. If you're adding a seventh concept, stop and check whether it belongs in a layer *above* the framework.

## What to avoid

- Don't pre-build helpers "for convenience." Convenience is how frameworks turn into platforms.
- Don't copy LangGraph / CrewAI / Agent Teams mental models. You're building the alternative to those.
- Don't prematurely generalize. Postgres is the only medium for Phase 1. Every abstraction over "what if it's not Postgres" costs us.
- Don't talk to the user like a survey paper. Stigmergy has a position; the docs should sound like it.

The user communicates directly. They will tell you when they want more detail and when they want less. Write accordingly.

