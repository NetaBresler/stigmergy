# Contributing to Stigmergy

Stigmergy is a small, opinionated framework. It values API design over feature
count, and it has a position about how agent coordination should work. Before
contributing, read [`PHILOSOPHY.md`](PHILOSOPHY.md) and
[`docs/primitives.md`](docs/primitives.md) — a change that doesn't fit the six
primitives is unlikely to land, however good it is in isolation. That's not
gatekeeping; it's the whole product. A coordination framework that accretes
features stops being a coordination framework and becomes a platform.

## The shape of a good contribution

In rough order of how welcome they are:

1. **Bug fixes** with a failing test that now passes. Always welcome.
2. **Doc fixes** — drift between the docs and the code, a confusing
   explanation, a broken link. The docs claim to match the code; hold us to it.
3. **A new example** that exercises a primitive the existing three don't show
   well, or shows a colony-dynamics phenomenon from
   [`docs/colony-dynamics.md`](docs/colony-dynamics.md) running.
4. **A decay mechanism or query capability** demanded by a real colony you're
   building — see "Proposing a change to the primitives" below.
5. **A new primitive.** The highest bar in the repo. Usually the answer is
   "that's a layer above the framework." Sometimes it isn't. Make the case.

## Local development

Node 22+, npm. No database to install — the test suite and the examples run
against in-process [PGlite](https://github.com/electric-sql/pglite).

```bash
npm ci                 # installs deps; the `prepare` script builds via tsc
npm test               # 87 unit tests against PGlite (+3 integration, see below)
npm run typecheck      # tsc --noEmit
npm run lint           # biome check . — must be clean
npm run format         # biome format --write . — apply formatting

npx tsx examples/bug-triage.ts     # the teaching ground
npx tsx examples/polyethism.ts     # Agent-distinct-from-Role, in one agent
npx tsx examples/oss-maintainer.ts # ten agents, emergent specialization
```

Three tests are gated behind a real Postgres and skip without it. To run the
full suite against production substrate:

```bash
STIGMERGY_TEST_PG_URL=postgres://user:pass@localhost:5432/db npm test
```

CI runs all of the above — build, typecheck, lint, both test substrates, and a
smoke run of the examples — on every PR. A green checkmark is the baseline, not
the goal.

## The bar for merging

Every PR must keep all of these true. Reviewers will check them, but you'll get
there faster if you check first:

- **Tests, lint, and typecheck are green.** No exceptions, no `// biome-ignore`
  to dodge a real finding.
- **Every signal type has a decay story.** This is enforced in code —
  `defineSignal` rejects a missing `decay` — but it applies to your tests and
  examples too. A signal without a decay story is not a Stigmergy signal, and a
  PR that adds one will be sent back. "It's just a column" is the failure mode
  the whole framework exists to prevent.
- **Locality holds.** An agent reads through its role's `localQuery` and nothing
  else. If your change lets a handler see signals outside its slice, it's
  reintroducing the manager. There are tests that prove locality; don't weaken
  them.
- **No agent-to-agent reference.** Agents coordinate through the medium. If your
  change adds a way for one agent to name, message, or hand off to another,
  that's a different framework.
- **The diff reads like the surrounding code.** Match the comment density and
  idiom. Comments state constraints the code can't show — not what the next line
  does.

## API stability expectations

Phase 1 is the reference implementation, and the public surface is deliberately
tiny — the functions listed at the bottom of [`docs/primitives.md`](docs/primitives.md)
and enumerated in [`docs/api-reference.md`](docs/api-reference.md). Treat that
surface as close to frozen:

- **Additive, backward-compatible changes** (a new optional field, a new decay
  kind, a new query operator) are the normal way the API grows. They need a real
  use case behind them, not a "might be handy."
- **Breaking changes to the public surface** require a documented revision.
  Phase 1 already recorded three such revisions in the "Phase 1 revisions"
  section of [`docs/api-sketch.md`](docs/api-sketch.md) — follow that pattern:
  write down what changed and *why the implementation forced it* before you write
  the code. If you can't articulate the forcing function, the change isn't ready.
- **Convenience helpers are not additive — they're surface area.** A wrapper that
  saves three lines is three lines of someone else's code we now maintain and
  can't remove. Default to "no." (See [`GETTING-STARTED.md`](GETTING-STARTED.md):
  convenience is how frameworks turn into platforms.)

Until Stigmergy is published to npm (Phase 3), the version stays `0.x` and the
surface can still move when a real implementation problem demands it. Once
published, semver applies and breaking changes wait for a major.

## Proposing a change to the primitives

The six primitives are the framework's spine. Changing one, or adding a seventh,
is the rare contribution that needs a conversation *before* code.

**Write prose first.** Open an issue (or a docs-only PR against
`docs/primitives.md`) that argues the case. The repo's own working style is
"spec the primitive, get sign-off, then implement" — the same applies to
outside proposals. A PR that implements a new primitive without that discussion
will be asked to start over as prose, so save yourself the work.

Before proposing a new primitive, apply the test the docs already use:

> Is this a primitive, or is it a *layer above* the framework?

Most good ideas are layers above. Priority queues, retries, scheduling policies,
reputation systems, dashboards — these compose *out of* the six primitives;
they don't belong *inside* them. [`docs/colony-dynamics.md`](docs/colony-dynamics.md)
is the worked proof that rich behaviour (threshold response, inhibitory trails,
quorum, role drift) emerges from the existing six without adding a seventh. If
your idea can be built on top, build it on top — and consider contributing it as
an example instead.

A change to the primitives has to clear a high bar: it must be load-bearing
(remove it and something the framework needs can't be expressed), minimal (no
smaller version works), and orthogonal (it isn't a special case of an existing
primitive). The
addition of **Agent** as a primitive distinct from **Role** — see the note at
the top of `docs/primitives.md` — is the model for what clearing that bar looks
like.

## Issue triage

What's in scope and what isn't, so issues get the right expectation fast:

**In scope:**
- Bugs in the reference implementation.
- Doc/code drift.
- Decay correctness — anything where a signal fails to fade as declared.
- Locality leaks — anything where a handler can read outside its slice.
- Missing query/filter capability that a real colony needs.

**Out of scope for now** (see [`docs/roadmap.md`](docs/roadmap.md) non-goals):
- **Python port.** Welcome later; not a Phase 1–3 concern.
- **Non-Postgres mediums** (Redis, S3, filesystem, graph DBs). Postgres first
  because it's the cheapest substrate to build and debug against.
- **Orchestration features** — a planner, a supervisor, agent-to-agent
  messaging, handoffs. These are the thing Stigmergy is the alternative to.
- **Managed hosting.** Stigmergy is a library.
- **Direct integration with a specific agent framework.** Stigmergy composes
  with anything that reads and writes the medium; integrations are examples, not
  core.

If you're not sure which bucket an idea is in, open an issue and ask before
writing code.

## Commits and PRs

- Branch off `main`. Keep PRs focused — one logical change.
- Write commit messages that explain *why*, not just *what*. The diff shows what.
- Reference the issue a PR closes.
- If a change touches the public API or a primitive, update the relevant doc in
  the same PR. A code change that leaves the docs stale is an incomplete change.

## Honesty over polish

If something doesn't work yet, the docs say so. Keep it that way. A PR that
quietly papers over a known limitation — or claims "production-ready" for
something that isn't — is worse than one that names the gap. The README's
status line and the roadmap's phase markers are load-bearing; update them
honestly when your change moves the line, and don't move them when it doesn't.

By contributing, you agree your contributions are licensed under the project's
[MIT license](LICENSE).
