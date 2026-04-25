# Stigmergy examples

Three self-contained colonies that show what the framework does and why. All run entirely against in-process [PGlite](https://github.com/electric-sql/pglite) — no Postgres install, no API keys.

## Running

From a fresh clone:

```bash
git clone https://github.com/NetaBresler/stigmergy
cd stigmergy
npm install
```

`npm install` builds the package (via the `prepare` script). Node 22+.

Then any of:

```bash
npx tsx examples/bug-triage.ts       # 3 agents, ~5s run, every primitive once
npx tsx examples/polyethism.ts       # 1 agent, 2 roles, role-drift in action
npx tsx examples/oss-maintainer.ts   # 10 agents, ~25s run, emergent specialization
```

---

## Which one should I run first?

**Start with `bug-triage.ts`** to learn the primitives. The teaching ground — about 240 lines, one file, every primitive appears exactly once. Read it end-to-end and you can write your own colony.

**Read `polyethism.ts`** to see why **Agent** is a separate primitive from **Role**. About 180 lines, one file, one agent wearing two roles and switching between them tick-by-tick based on what the medium is loudest about. This is the smallest runnable demonstration of polyethism.

**Read `oss-maintainer.ts`** to see why the pattern matters at scale. About 500 lines, ten agents, three sensor types — shows emergent specialization under load. The punchline is the summary at the bottom of the run output: agents self-select components without any planner assigning them.

---

## `bug-triage.ts` — the teaching ground

A three-agent colony:

- **Reporter** files new bugs into the medium.
- **Triager** (×2 — they compete for claims) picks up unclaimed bugs, investigates, writes a `triage_note`.
- **Validator** reads the note and either boosts the bug (confirmed) or penalises it (duplicate / invalid). The bug's strength encodes "how loudly does this still need attention."

### What to watch for

- **Pheromones decay.** A bug starts at strength `1.0` and halves every 30s. Watch the `strength` column in the output.
- **Validators reinforce winners.** A confirmed sev-1 bug climbs to `4.0`+. A bug marked invalid drops to near-zero.
- **Specialization emerges from locality.** Reporter and Triager never talk to each other. They read the same medium; they act on different slices because their local queries differ.
- **Claims are atomic.** Two Triagers scanning the same queue compete for `tryClaim()`. Exactly one wins each bug. The other moves on.

### Reading the code

Everything is in one file. In order, you'll see:

1. `defineMedium` with an in-process PGlite client.
2. `defineSignal` for `reported_bug` (strength decay) and `triage_note` (expiry decay) — each with an explicit decay story.
3. `defineRole` for Reporter and Triager, each with a bounded `localQuery`.
4. `defineValidator` that applies a note's verdict to the matching bug via cross-signal `target`.
5. `defineAgent` wrapping each role with a stable id.
6. `runAgent` starting each loop.

---

## `polyethism.ts` — one agent, two roles

A single agent, `researcher-01`, enacts two roles — Explorer (propose a research question) and Worker (execute a reinforced one) — and the handler picks between them every tick based on which role's view is loudest. That's the point: no scheduler, no state machine, just "what is the medium loudest about right now?"

### What to watch for

- **Early ticks log `[as Explorer]`.** The Worker view filters for strength > 1.0; at start nothing qualifies, so the agent seeds proposals.
- **Validator reinforces some proposals strongly.** Every third proposal gets a big boost; the rest get a small one. The landscape becomes uneven.
- **Later ticks start logging `[as Worker]`.** Same agent, different function, selected by pressure. The switch isn't scripted — it falls out of which view has signals above threshold.
- **The summary at the end** shows how the one agent split its ticks across roles. Polyethism in a single number pair.

### Why it's its own example

`bug-triage.ts` has many agents, each with one role. That teaches Role and Locality, but it leaves Agent-as-distinct-from-Role implicit. `polyethism.ts` is the minimum runnable proof that Agent is load-bearing: remove it from the primitive set and you can't write this example cleanly.

---

## `oss-maintainer.ts` — the showcase

A maintainer colony for an open-source project. Ten agents coordinate entirely through the medium — no orchestrator, no messaging, no central plan.

**Three sensor agents** translate simulated external events into signals:

- **GithubListener** — new issues, PRs, merges.
- **CommunityListener** — questions from Slack / Discord.
- **SocialListener** — bug-shaped mentions from social.

**Seven worker agents** pick up work from the medium:

- Three **Triagers** — read unclaimed bugs, propose fixes.
- Two **Responders** — read unclaimed questions, draft replies.
- Two **Reviewers** — read unclaimed PRs, post verdicts.
- One **Broadcaster** — reads merge events, announces shipped changes.

Two **validators** gate reinforcement: `fix_proposal_reviewer` boosts high-confidence proposals (and reinforces the underlying bug), `draft_reply_reviewer` boosts confident replies.

### The punchline

Every Triager and Responder starts with **uniform** affinity across components (frontend / backend / infra). Nobody assigns anyone to a component. As the run proceeds, each agent's affinity updates based on the work it successfully picks up, and the affinity biases future picks. Over ~25 seconds of wall-clock time, the colony visibly specializes — one Triager goes frontend, another goes backend, without any planner ever deciding that.

The summary block at the end of the run output is the whole reason the example exists.

### Why this shape

Each role reads exactly one signal type (Phase 1 constraint) — TriagerRole reads `reported_bug`, ResponderRole reads `community_question`, etc. Roles can write multiple types. No role references any other role. Agents don't know each other exists.

The "emergent specialization" is genuine, not scripted. Claims are atomic — two Triagers seeing the same top-strength bug race for `tryClaim`, exactly one wins. The agent that wins gets its affinity reinforced for that component, biasing its next pick. In a real colony this bias would live in each agent's MEMORY.md and update during the consolidation pass; the example keeps it in closure state so the demo doesn't write files.

---

## Writing your own

Fork `bug-triage.ts`, rename the signals, rewrite the handlers. The structure will feel the same: medium → signals → roles → agents → validators → run. No orchestrator, no messaging, no cross-agent references.

If something feels awkward, that's a signal (the kind the framework cares about, not the kind in the database). Open an issue.
