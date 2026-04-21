# Getting Started — for the next Claude Code session

You are being invoked in a fresh session to help design and build the **Stigmergy** framework. The user has read the `PHILOSOPHY.md` and signed off on the thesis. They are now ready to build.

## Before you respond to anything

Read these in order:

1. `README.md` — 30-second pitch and status
2. `PHILOSOPHY.md` — the thesis
3. `docs/primitives.md` — the spec for the five primitives
4. `docs/prior-art.md` — what exists, what we're doing differently
5. `docs/roadmap.md` — phased plan. **We are in Phase 0.**
6. `CLAUDE.md` — session protocol

## Your first task

Phase 0 asks for an API sketch. Specifically:

1. Propose TypeScript interfaces for the five primitives: `Medium`, `Signal`, `Decay`, `Role`, `Validator`. Put them in `src/types.ts`.
2. Write a short `docs/api-sketch.md` walking through a minimal example: a developer defines a medium, two signal types (one quantitative, one qualitative), two roles, and a validator. Show what the code looks like end-to-end, without yet implementing the runtime.
3. **Do not implement anything.** No runtime code. No Postgres schema. Types and prose only.
4. Present the sketch to the user. Get their read. Iterate.

The API is the product. Get it right before you write any implementation. A smaller, more opinionated API is better than a bigger, more flexible one. If a primitive feels like two primitives jammed together, split it. If two primitives feel like one, merge them. Argue the tradeoff in the docs, not just the code.

## What to optimize for

- **Inspectability.** A developer should be able to query the medium directly and understand the colony's state without running any Stigmergy code.
- **Opinionatedness.** Stigmergy has a position. It rejects schemas without decay. It enforces locality. It refuses to let agents message each other directly. Make the API reflect that.
- **Minimalism.** Five primitives. A handful of functions per primitive. If you're adding a seventh concept, stop and check whether it belongs in a layer *above* the framework.

## What to avoid

- Don't pre-build helpers "for convenience." Convenience is how frameworks turn into platforms.
- Don't copy LangGraph / CrewAI / Agent Teams mental models. You're building the alternative to those.
- Don't prematurely generalize. Postgres is the only medium for Phase 1. Every abstraction over "what if it's not Postgres" costs us.
- Don't talk to the user like a survey paper. Stigmergy has a position; the docs should sound like it.

## Context you don't have but may need

The user owns a private project — a digital product factory — that is the first system running on Stigmergy. If they reference it (Scout, Copywriter, Designer, Ad Manager, Reporter agents; `colonies`, `waitlist_signups`, `validation_decisions` tables in Supabase), that's the source of their design intuitions. The factory is not in this repo and should not leak into it, but its schema is a useful reference for what a real stigmergic medium looks like.

The user communicates directly. They will tell you when they want more detail and when they want less. Write accordingly.

Good luck.
