# Stigmergy — Claude Code Session Protocol

## Session Start Protocol (MANDATORY)

Before responding to ANY request in this repo, read these files in order:

1. `README.md` — what Stigmergy is, status, 30-second pitch
2. `PHILOSOPHY.md` — the thesis, the primitives, why this exists
3. `docs/primitives.md` — the six primitives as a concrete spec
4. `docs/prior-art.md` — what already exists, what we're building differently
5. `docs/roadmap.md` — current phase, what comes next
6. `GETTING-STARTED.md` — brief for the first working task

## What this repo is

Stigmergy is a framework for coordinating LLM agents through a shared environment with decay, rather than through a manager. This repo is the framework. It is open-source, installable, and meant to be used by other projects.

## What this repo is not

- Not a product. It is generic coordination infrastructure — any product on top lives in its own repo.
- Not a wrapper around LangGraph / CrewAI / AutoGen. Stigmergy is an alternative coordination pattern, not a prettier orchestrator.
- Not academic. Academic prototypes exist (SwarmSys, SIER). This is meant to be installable and production-worthy.

## Current phase

Phase 1 is complete. The reference implementation runs; 86 tests pass against both PGlite and real Postgres; the worked example is runnable end-to-end. See `docs/roadmap.md` for what's next.

## Tech stack

- **Reference implementation:** TypeScript / Node (ESM), Node 22+
- **Medium substrate:** Postgres. [PGlite](https://github.com/electric-sql/pglite) for in-process tests and demos.
- **Testing:** Vitest
- **Python port:** later. Not in scope for the reference implementation.

## Working style

- This repo values API design over feature count. A smaller, more opinionated framework wins.
- Write prose before code. Spec the primitive, get sign-off, then implement.
- Every signal in any example or implementation must have a decay story. "It's just a column in Postgres" is not a framework — it's a database. Stigmergy without decay is not Stigmergy.
- Honesty over polish in the docs. If something doesn't work yet, say so.

