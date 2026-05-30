# remote-colony — agents in their own processes

The same bug-triage colony as `examples/bug-triage.ts`, but the agents don't
run in-process. A **server** owns the medium; **agents** connect over HTTP from
wherever they live — a different process, a different machine, a different
language. This is the shape you deploy.

```
            ┌──────────────────────────────┐
            │  server.ts                    │
            │  • owns the Postgres medium   │
            │  • runs decay + validation    │
            │  • exposes /v1 over HTTP       │
            └──────────────┬───────────────┘
                  ▲         │         ▲
        Bearer token        │       Bearer token
                  │         │         │
        ┌─────────┴──┐  ┌───┴─────┐  ┌┴──────────┐
        │ agent.ts   │  │ agent.ts│  │ agent.py  │
        │ Reporter   │  │ Triager │  │ Triager   │
        └────────────┘  └─────────┘  └───────────┘
```

Because the processes are separate, they need a **shared** substrate — a real
Postgres, not in-process PGlite. (For a zero-setup single-process version, run
`npx tsx examples/remote-agent.ts` instead.)

## Run it

You need a Postgres. A Supabase free-tier database works; so does a local one.

**Terminal 1 — the server.** It migrates, mints a token per agent, prints them,
and serves.

```bash
export DATABASE_URL='postgres://…'
npx tsx examples/remote-colony/server.ts
```

It prints something like:

```
agent tokens (copy into the agent terminals):

  reporter-01  STIGMERGY_TOKEN=stg_…
  triager-01   STIGMERGY_TOKEN=stg_…
  triager-02   STIGMERGY_TOKEN=stg_…

server listening on http://127.0.0.1:8787
```

**Terminal 2 — the Reporter** (TypeScript). Files bugs into the medium.

```bash
export STIGMERGY_URL=http://127.0.0.1:8787
export STIGMERGY_TOKEN=stg_…       # the reporter-01 token
npx tsx examples/remote-colony/agent.ts
```

**Terminal 3 — a Triager** (TypeScript). Claims bugs, writes triage notes.

```bash
export STIGMERGY_URL=http://127.0.0.1:8787
export STIGMERGY_TOKEN=stg_…       # a triager token
npx tsx examples/remote-colony/agent.ts
```

**Terminal 4 — another Triager, in Python** (stdlib only, no Stigmergy package).

```bash
export STIGMERGY_URL=http://127.0.0.1:8787
export STIGMERGY_TOKEN=stg_…       # the other triager token
python3 examples/remote-colony/agent.py
```

The TypeScript triager and the Python triager compete for the same claims
through the medium. Exactly one wins each bug — the medium doesn't know or care
what language deposited a signal. That's the whole point: **the colony is the
coordination surface, and it's reachable from anywhere.**

## What's worth noticing

- **`agent.ts` and `agent.py` import no colony definition.** They connect with a
  token, ask the server which roles they have (`POST /v1/session`), and act
  within them. The signal schemas, the decay policy, the validator — all of
  that lives on the server.
- **Locality is enforced by the server.** A triager token cannot view as a
  Reporter or deposit a `reported_bug`; the server returns `403`. Try it.
- **`server.ts` is the only thing that touches the database.** Scale it
  horizontally — run several instances behind a load balancer. The decay sweep
  and validator dispatch elect a single leader via a lease, and double-applied
  verdicts are impossible by construction (a unique index on the reinforcement
  log). See `docs/connect.md`.

## The same thing with the CLI

`colony.ts` exports the medium as its default export, so the `stigmergy` CLI can
drive it directly instead of `server.ts`:

```bash
export DATABASE_URL='postgres://…'
npx stigmergy migrate examples/remote-colony/colony.ts
npx stigmergy token issue examples/remote-colony/colony.ts triager-01
npx stigmergy serve examples/remote-colony/colony.ts --port 8787
npx stigmergy inspect examples/remote-colony/colony.ts
```
