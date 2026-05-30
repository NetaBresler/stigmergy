# Connecting agents over the network

The reference implementation runs agents in-process: you write a TypeScript
handler, `medium.run()` calls it on a loop, and it touches the medium directly.
That's the right shape for a demo and the wrong shape for production, where
agents live in their own processes — a Python service, a serverless function,
an LLM agent on someone else's platform — and the medium is shared
infrastructure they all reach.

This page is the other half: how an agent that lives *elsewhere* joins a colony.

## Why there's a server at all

In-process, locality is a **convention**. Nothing actually stops a handler from
importing the client and querying the whole medium — we just ask it not to.

Over the network, locality is a **boundary**. The server owns the database and
exposes nothing but the role-bounded operations. An agent authenticates with a
token, names one of *its own* roles, and gets back exactly that role's
`localQuery` slice. It never sends SQL. It never names a table or another
agent. It cannot widen its view, because there is no endpoint that would let
it. The thing the philosophy asks for — *"you cannot micro-manage what you
cannot see"* — stops being a request and becomes physics.

That's the reason the server exists. It isn't "Stigmergy-as-a-service." It's the
boundary that makes the six primitives enforceable when the agents aren't yours.

## The SDK (TypeScript)

```ts
import { connect } from "stigmergy";

const session = await connect({
  url: "https://colony.example.com",
  token: process.env.STIGMERGY_TOKEN!,
});

await session.run(async (ctx) => {
  const queue = await ctx.as("Triager").view();
  const top = queue[0];
  if (!top) return;

  if (await ctx.as("Triager").tryClaim(top.id, { until: "2m" })) {
    await ctx.as("Triager").deposit("triage_note", {
      bug_id: top.id,
      verdict: "confirm",
      /* … */
    });
  }
});
```

The surface is deliberately identical to the in-process one. Compare with the
embedded version in [`docs/api-sketch.md`](./api-sketch.md): `ctx.as(role)`,
`.view()`, `.deposit()`, `.tryClaim()`, `.release()` are the same calls. The
only differences are how you get the context (`connect` + a token instead of
`defineAgent` + `medium.run`) and that roles are named by string. Agent code
ports between embedded and remote almost verbatim.

`connect()` returns a `RemoteAgentSession`:

| Member | What it is |
|---|---|
| `agentId` | the id this token authenticates as |
| `charter` / `soul` / `skills` / `memory` | identity documents, loaded server-side |
| `roles` | descriptors: `{ name, reads, writes }` for each declared role |
| `as(role)` | narrow to a role → `view` / `deposit` / `tryClaim` / `release` |
| `writeMemory(text)` | consolidate the agent's MEMORY document (server-side) |
| `run(handler, opts)` | the network twin of `medium.run` — a poll loop |
| `refresh()` | re-fetch the session (e.g. to pick up a charter edit) |
| `close()` | stop the loop |

## The wire protocol (any language)

There is no Python SDK, and there doesn't need to be. The protocol is plain
JSON over HTTP — `examples/remote-colony/agent.py` is a complete agent in ~70
lines of standard library. Here's everything it needs to know.

**Base:** all endpoints are under `/v1`. Every request is
`Content-Type: application/json`. Every request except `GET /v1/health` carries
`Authorization: Bearer <token>`.

| Method & path | Body | Returns |
|---|---|---|
| `GET /v1/health` | — | `{ ok, signals, agents }` |
| `POST /v1/session` | `{}` | `{ agentId, charter?, soul?, skills, memory?, roles[] }` |
| `POST /v1/view` | `{ role }` | `{ signals: WireSignal[] }` |
| `POST /v1/deposit` | `{ role, type, payload }` | `{ signal: WireSignal }` |
| `POST /v1/claim` | `{ role, signalId, until }` | `{ claimed: boolean }` |
| `POST /v1/release` | `{ role, signalId }` | `{ ok: true }` |
| `POST /v1/memory` | `{ text }` | `{ ok: true }` |

A `WireSignal` is a deposited signal, JSON-encoded:

```json
{
  "id": "9f3c…",
  "type": "reported_bug",
  "payload": { "title": "login-loops", "severity": "1", "claimed_by": null },
  "createdAt": "2026-05-30T12:00:00.000Z",
  "originAgentId": "reporter-01",
  "strength": 1.0,
  "expiresAt": null
}
```

Errors come back with the right HTTP status and a stable machine code:

```json
{ "error": { "code": "role_forbidden", "message": "Agent \"triager-01\" is not declared with role \"Reporter\"." } }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | malformed body, or a payload that fails the signal's schema |
| 401 | `unauthorized` / `unknown_agent` | missing/invalid token, or token for an agent the colony no longer defines |
| 403 | `role_forbidden` | the agent isn't declared with that role |
| 403 | `write_forbidden` | the role isn't permitted to deposit that signal type |
| 404 | `not_found` | no such route |
| 413 | `payload_too_large` | body over the size limit |

### curl

```bash
# health (no auth)
curl -s http://127.0.0.1:8787/v1/health

# what am I?
curl -s http://127.0.0.1:8787/v1/session \
  -H "authorization: Bearer $STIGMERGY_TOKEN" -H 'content-type: application/json' -d '{}'

# read my slice
curl -s http://127.0.0.1:8787/v1/view \
  -H "authorization: Bearer $STIGMERGY_TOKEN" -H 'content-type: application/json' \
  -d '{"role":"Triager"}'

# deposit
curl -s http://127.0.0.1:8787/v1/deposit \
  -H "authorization: Bearer $STIGMERGY_TOKEN" -H 'content-type: application/json' \
  -d '{"role":"Triager","type":"triage_note","payload":{"bug_id":"…","verdict":"confirm","recommended_boost":3,"bug_title":"x","body":"y"}}'
```

### One sharp edge: numbers

Postgres `numeric` columns come back as **strings** in `payload`, because that's
how Postgres serializes arbitrary-precision numbers and Stigmergy doesn't
second-guess it. The top-level `strength` is a real number (the framework
computes it); fields *inside* `payload` that you declared as `z.number()` arrive
as strings like `"1"`. JavaScript hides this — `4 - "1"` is `3` — but Python and
Go won't. Coerce on the client (`int(payload["severity"])`). This is the same
behavior as the in-process API; the wire just makes it visible.

## Authentication & tokens

A token binds a network connection to a declared agent. Mint one with the SDK or
the CLI; Stigmergy stores only a sha256 hash, so the plaintext is shown exactly
once.

```ts
import { issueToken, revokeToken } from "stigmergy";

const { token } = await issueToken(medium, "triager-01", "prod-worker-3");
// hand `token` to the agent via a secret manager / env var
await revokeToken(medium, token); // when it's compromised or retired
```

```bash
npx stigmergy token issue ./colony.js triager-01 --label prod-worker-3
npx stigmergy token revoke ./colony.js stg_…
```

The server speaks plain HTTP and trusts the bearer token on every request — so
**put it behind TLS** (a reverse proxy terminating HTTPS) and treat tokens like
passwords. There is no token-in-URL form on purpose.

## Running it

```ts
import { serve } from "stigmergy";

const handle = await serve(medium, {
  port: 8787,
  host: "0.0.0.0",      // accept remote connections (default is loopback)
  migrate: true,        // run migrations before listening
});
console.log(handle.url);
// … later
await handle.close();   // stops accepting + stops the background workers
```

or, without writing a launcher, point the CLI at a colony module that exports
the medium:

```bash
npx stigmergy serve ./colony.js --port 8787 --migrate
```

### Scaling out

The server holds no per-request state, so you can run as many instances as you
like behind a load balancer. The two pieces of background work — the decay sweep
and the validator dispatch — must not stampede, and they don't:

- **Leader election by lease.** Each instance tries to hold a short lease
  (`stigmergy_worker_leases`) before sweeping or dispatching. Only the holder
  runs the loop; if it dies, the lease expires and another instance takes over
  on its next tick. No coordinator, no config.
- **Exactly-once verdicts, enforced by the database.** Even if two instances
  ever raced past the lease, a unique index on the reinforcement log over
  `(trigger, validator)` makes a second verdict a no-op — `INSERT … ON CONFLICT
  DO NOTHING`, and the target mutation is skipped. A duplicated boost is
  impossible by construction, not by timing.

That's the whole multi-instance story. It's deliberately boring.

## What this is not (yet)

Honesty over polish, per the house style:

- **No server push.** Agents poll (`session.run` loops on an interval). Postgres
  `LISTEN/NOTIFY`-based wakeups are a natural next step but aren't built. For
  most colonies a 1–5s poll is fine and cheaper to reason about.
- **No built-in rate limiting or quotas.** Put them in your reverse proxy.
- **Memory is a server-side file.** `writeMemory` consolidates the agent's
  MEMORY document where the server can see it. A remote agent that would rather
  own its memory can simply not declare one and keep its own.
- **The server trusts its network.** Auth is bearer-token; transport security is
  your proxy's job. Don't expose it raw to the internet.

None of these block the thing this page is about: an agent, anywhere, in any
language, joining a colony and coordinating through the medium with agents it
will never talk to directly.
