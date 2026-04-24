# Stigmergy examples

Two self-contained colonies that show what the framework does and why. Both run entirely against in-process [PGlite](https://github.com/electric-sql/pglite) — no Postgres install, no API keys.

## Running

From a fresh clone:

```bash
git clone https://github.com/NetaBresler/stigmergy
cd stigmergy
npm install
```

`npm install` builds the package (via the `prepare` script). Node 22+.

Then either:

```bash
npx tsx examples/bug-triage.ts       # 10-minute read, 3 agents, ~5s run
npx tsx examples/oss-maintainer.ts   # 25s run, 10 agents, watch it live
```

---

## Which one should I run first?

**Start with `bug-triage.ts`** if you want to learn the primitives. It's the teaching ground — about 240 lines, one file, every primitive appears exactly once. Read it end-to-end and you can write your own colony.

**Read `oss-maintainer.ts`** when you want to see why the pattern matters. It's about 500 lines, ten agents, three sensor types, and shows emergent specialization under load. The punchline is the summary at the bottom of the run output — agents self-select components without any planner assigning them.

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
