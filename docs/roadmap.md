# Roadmap

Phased plan for taking Stigmergy from a thesis to an installable framework that other projects use. Each phase has a clear "done" definition. We do not start a phase until the previous phase's "done" is met.

---

## Phase 0 — Spec the API *(current phase)*

**Goal:** A TypeScript sketch of the five primitives that a developer could look at and understand what Stigmergy offers, without any implementation yet.

**Deliverables:**
- `src/types.ts` — interfaces for `Medium`, `Signal`, `Decay`, `Role`, `Validator`, `LocalQuery`.
- `docs/api-sketch.md` — prose walkthrough of how a developer uses the framework. Minimal example.
- User has read and signed off on the shape.

**Rules for this phase:**
- No runtime code. Types only.
- No Postgres schema yet. That's Phase 1.
- Iterate with the user. The API is the product — it matters more than the implementation.

**Done when:** The user looks at `src/types.ts` and says "yes, this is what I want to use."

---

## Phase 1 — Reference implementation

**Goal:** A working `stigmergy` npm package that runs against Postgres (Supabase-compatible) and implements the primitives spec'd in Phase 0.

**Deliverables:**
- `src/medium.ts` — Postgres-backed medium with declared signal types.
- `src/decay.ts` — all three decay mechanisms (explicit expiry, strength decay, reinforcement-only).
- `src/role.ts` — role definition with local-query enforcement.
- `src/validator.ts` — validator hook with rule-based and webhook-based triggers.
- `src/runtime.ts` — `run(role, handler)` loop.
- Migration file(s) to stand up a bare Stigmergy schema in a fresh Supabase project.
- Vitest test suite covering each primitive in isolation.
- One end-to-end example in `examples/` — three agents, one medium, decay, validation, the whole loop — small enough to read in ten minutes.

**Rules for this phase:**
- Every signal type declared in tests must have a decay story. The framework rejects schemas without one.
- Locality is enforced at the query-builder level — an agent's handler cannot read signals outside its `localQuery`. Tests must prove this.
- API stays unchanged from Phase 0 unless a real implementation problem forces a revision; if it does, document the revision in `docs/api-sketch.md` before writing the code.

**Done when:** `npm install stigmergy` (local, not yet published) gives a developer everything they need to define a colony, run it, and watch signals decay.

---

## Phase 2 — Extract real usage from the first factory

**Goal:** Use Stigmergy in anger on the first real project (a private factory owned by the user) and surface what the framework is missing.

**Deliverables:**
- The private factory is ported to use `stigmergy` instead of its ad-hoc Supabase patterns.
- A `MIGRATIONS.md` in this repo describing what had to be added, changed, or removed in Stigmergy to make that port work.
- Revised primitive API if Phase 1's guess was wrong about anything.

**Rules for this phase:**
- No new features in Stigmergy that aren't demanded by the real port. Speculative abstractions get rejected.
- The private factory does not leak into this repo. This repo stays open-source and standalone.

**Done when:** The private factory runs on published-from-local Stigmergy, with zero direct Supabase queries in its agent code.

---

## Phase 3 — Publish

**Goal:** Stigmergy is available to the world.

**Deliverables:**
- Published to npm.
- A docs site (could be GitHub Pages initially) with: the Philosophy, the primitives, the API reference, the end-to-end example, a "how this compares to CrewAI / LangGraph / Agent Teams" page.
- A short "read this first" blog post aimed at people who build agent systems.
- A CONTRIBUTING.md covering API stability expectations, issue triage, and how to propose changes to the primitives.

**Rules for this phase:**
- Announce once there's at least one third-party user (or at least one visible real-world use case). Don't ship into a void.

**Done when:** Someone who is not us tries Stigmergy, tells us what broke, and we fix it.

---

## Non-goals (for now)

These are deliberately out of scope until the roadmap above is complete:

- **Python port.** The reference implementation is TypeScript. A Python port is welcome later; it is not a Phase 0–3 concern.
- **Non-Postgres mediums.** Filesystem, Redis, S3, graph databases — all interesting, all possible, all later. Postgres first because it is the cheapest substrate to build and debug against.
- **Decentralized / peer-to-peer stigmergy.** The Ledger-State Stigmergy paper is inspirational, but on-chain is not a Phase 1 target.
- **Managed hosting.** Stigmergy is a library. If someone wants to host "Stigmergy-as-a-service" later, that is a separate project.
- **Direct integration with a specific agent framework** (LangGraph, CrewAI, Agent Teams). Stigmergy is a coordination primitive; it composes with anything that can read and write the medium. Integrations are examples, not core.
