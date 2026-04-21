# Stigmergy — Claude Code Session Protocol

## Session Start Protocol (MANDATORY)

Before responding to ANY request in this repo, read these files in order:

1. `README.md` — what Stigmergy is, status, 30-second pitch
2. `PHILOSOPHY.md` — the thesis, the primitives, why this exists
3. `docs/primitives.md` — the five primitives as a concrete spec
4. `docs/prior-art.md` — what already exists, what we're building differently
5. `docs/roadmap.md` — current phase, what comes next
6. `GETTING-STARTED.md` — brief for the first working task

## What this repo is

Stigmergy is a framework for coordinating LLM agents through a shared environment with decay, rather than through a manager. This repo is the framework. It is meant to be open-source, installable, and used by other projects.

## What this repo is not

- Not a factory. The first factory running on Stigmergy is a private project; it does not live here.
- Not a wrapper around LangGraph / CrewAI / AutoGen. Stigmergy is an alternative coordination pattern, not a prettier orchestrator.
- Not academic. Academic prototypes exist (SwarmSys, SIER). This is meant to be installable and production-worthy.

## Current phase

**Phase 0 — Design the primitive API.**

Do not start implementing until the API has been sketched and the user has reviewed it. The first task is to propose TypeScript interfaces for the five primitives (Medium, Decay, Role, Locality, ValidatedReinforcement) and get the user's read on them before writing any implementation code.

See `docs/roadmap.md` for phases beyond 0.

## Tech stack (planned)

- **Reference implementation:** TypeScript / Node (ESM, `.mts` or `.ts`)
- **Medium substrate:** Postgres (Supabase as the dev target)
- **Testing:** Vitest
- **Python port:** later. Not in scope for the reference implementation.

## Related private context

A private product factory — owned by the same user — is the first system running on Stigmergy. If the user references it (niches, colonies, Scout / Copywriter / Designer / Ad Manager / Reporter agents, Supabase tables like `colonies` or `waitlist_signups`), that's the context. The factory's Supabase schema is a useful reference for what a real Stigmergy medium looks like, but this framework must be designed to stand alone — the framework cannot depend on the factory.

## Working style

- This repo values API design over feature count. A smaller, more opinionated framework wins.
- Write prose before code. Spec the primitive, get sign-off, then implement.
- Every signal in any example or implementation must have a decay story. "It's just a column in Postgres" is not a framework — it's a database. Stigmergy without decay is not Stigmergy.
- Honesty over polish in the docs. If something doesn't work yet, say so.
