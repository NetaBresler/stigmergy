# Stigmergy

*A framework for agent colonies. And a thesis about why you want one.*

---

## The bug in how we build agent teams

Almost every multi-agent framework shipping today encodes the same assumption: **if you want many agents to work together, give them a manager.**

AutoGen has conversation managers. MetaGPT has role hierarchies with explicit backstories. CrewAI has crews with leaders. Claude Agent Teams has an orchestrator that decomposes, delegates, monitors, synthesizes. OpenAI Swarm calls the pattern "handoffs" but the topology is still a tree — one agent routes to the next.

This isn't architecture. It's **cargo-culting the org chart**. We looked at how humans coordinate, saw managers and reports, and made the LLMs wear suits.

The pattern plateaus for a predictable reason. The manager becomes the bottleneck — every decision passes through a single context window, every worker's output has to be re-read and re-summarized, every handoff re-serializes the world in prose. Token cost grows superlinearly. Latency compounds. The manager's attention is the ceiling on the team's intelligence.

There is another way to coordinate that nature figured out ~200 million years before we did, and it doesn't use managers at all.

## Stigmergy

In 1959, the French biologist Pierre-Paul Grassé was watching termites rebuild a damaged nest and noticed something that broke his model of insect behavior. The termites weren't talking to each other. They weren't taking orders. Each one was, as far as he could tell, **working as if alone** — but the thing they produced together was an intricate, coordinated, cathedral-like structure.

His insight: the termites weren't coordinating with each other. They were coordinating with **the nest**. Each deposit of pheromone-laced mud changed the environment in a way that suggested the next deposit to whoever showed up next. The work itself was the message.

He called this **stigmergy** — from Greek *stigma* (mark, sign) and *ergon* (work). Work that guides work.

Stigmergy shows up everywhere in nature that looks coordinated but has no coordinator:

- **Ant foraging trails.** A forager finds food, walks home depositing pheromone. Ants that randomly try that path find food, deposit more pheromone. Paths that lead nowhere never get reinforced and evaporate. The colony converges on the shortest route without any ant ever understanding "the shortest route."
- **Termite mounds.** Different structural configurations trigger different deposit behaviors. A pillar-shape triggers arch-making. An arch triggers chamber-making. The *shape of what exists* suggests what to build next.
- **Wasp nests.** Same logic. No blueprint. The nest is the blueprint.

Two flavors matter for us, and both are load-bearing:

- **Quantitative stigmergy.** Signal *strength* modulates action *frequency*. "How much pheromone is on this trail?" It's how ants pick routes. In software terms: priority queues, counters, concentrations, decay curves.
- **Qualitative stigmergy.** Signal *type* triggers *distinct* action. "This is an arch, so I should build a chamber." It's how termites build mounds. In software terms: the shape of what already exists — the files, the notes, the logs — tells the next agent what belongs next.

Ants do mostly quantitative. Termites do both. LLM agents, uniquely, *need* both — because their native interface is language, and language is qualitative by default.

## The primitives

A stigmergic agent system has a small number of required ingredients. Cross-referencing what SwarmSys, SIRL, Paredes García's Ledger-State Stigmergy paper, and Roland Rodriguez's pressure-field writeups all converge on, the primitives are:

1. **A shared medium.** One place agents read from and write to. A database, a filesystem, an artifact. This is the *only* coordination channel — if agents start messaging each other directly, you've re-invented the manager.
2. **Decay.** Every signal evaporates unless reinforced. A task marked "in progress" three days ago by an agent that crashed shouldn't still repel other agents from picking it up. This is the hardest part, and it's the part everyone who tries to do this in a database gets wrong.
3. **Role specialization.** Not strictly required (ants are homogeneous), but it accelerates convergence. SwarmSys uses Explorers, Workers, Validators. A colony-as-factory might use Scout, Writer, Designer, Launcher, Reporter, Decider. Each agent knows what kind of work it does.
4. **Locality.** Agents read only what's near them in the medium — a slice, a query, a directory — not the whole world. This is what stops them from becoming managers. You cannot micro-manage what you cannot see.
5. **Validated reinforcement.** Not every trace reinforces equally. Successful outcomes deposit more signal than mere activity. Without this, noise wins.

That's it. No manager. No orchestrator. No central plan. The coordination is *in the medium*, not *in an agent*.

We are building this as a framework. We call it **Stigmergy** (capital S), because it is a direct port of the biological principle — same name, same mechanics, new substrate. Where the word appears lowercase in this document, we mean the biological phenomenon. Where it appears capitalized, we mean the framework.

## Why this beats hierarchy

Five concrete wins, in order of importance:

**1. Coordination cost stops scaling with team size.** In a hierarchy, the manager's context is the bottleneck — every agent's work has to pass through it. In stigmergy, adding a tenth agent means adding one more reader of the shared medium. Linear scaling instead of quadratic.

**2. No single point of failure.** Kill the manager in a hierarchical system and the team halts. Kill a worker in a stigmergic system and its unfinished work stays visible in the medium — the next agent picks it up. Crashes become recoverable by default, not by retry logic.

**3. Specialization emerges instead of being assigned.** Agents self-select work based on what the medium needs, not on what a planner decides. This matters because planners are always wrong about what's urgent — they're working from a context window that's already stale.

**4. Forgetting is built in.** Pheromones evaporate. Stale plans die automatically. You don't need a "reconsider the strategy" step because paths that aren't working simply stop being reinforced and fade. Hierarchical systems have to be explicitly told to stop following a bad plan.

**5. The medium can hold more state than any single context window.** In a hierarchy, the manager's context window caps the team's working memory. In stigmergy, the medium is the working memory — a Postgres table can hold millions of signals, and no agent ever needs to see all of them at once.

## Why this is not "just a knowledge base"

This is the sharpest question about stigmergy and the one that most people get wrong when they first encounter it.

A RAG knowledge base is **read-only memory of facts**. A stigmergic medium is **a coordination surface with temporal pressure**. They solve different problems:

| Dimension         | Knowledge Base (RAG)             | Stigmergic Medium                  |
|-------------------|----------------------------------|------------------------------------|
| Who writes        | Humans curate; batch ingestion   | Every agent writes as it works     |
| Time dimension    | Static until re-indexed          | Decays; recency encodes priority   |
| What it encodes   | Facts                            | Intent, attention, claim-state     |
| Agent's question  | "What do I need to know?"        | "What does the colony need next?"  |
| Failure mode     | Stale facts mislead              | Stale signals decay away           |

A knowledge base tells an agent *what is true*. A medium tells an agent *what to do*. You want both. They are not substitutes.

## A worked example

The `examples/` directory in this repo has two colonies you can run end-to-end against in-process Postgres. No install, no API keys — just `npx tsx`.

`bug-triage.ts` is the teaching ground: three agents, one medium, every primitive exercised in about 240 lines. A Reporter files bugs, two Triagers compete for claims, a Validator reinforces real bugs and penalises noise. You can watch strength decay, watch the claim race, watch signals evaporate.

`oss-maintainer.ts` is the showcase. Ten agents keeping an open-source project healthy — three sensor agents translating simulated GitHub / community / social events into signals, three Triagers, two Responders, two Reviewers, and a Broadcaster announcing merges. Nobody assigns anyone to a component. Over ~25 seconds of wall time, the colony visibly specializes — one Triager trends frontend, another trends backend, purely because claims plus validator reinforcement route the work on their own.

Both run against the same reference implementation that ships in `src/`. If you want to see what Stigmergy feels like before reading another word of theory, run them.

## The hard parts — and why decay is the one that kills you

We have to be honest about what's hard, because stigmergy is not a free lunch:

- **Debugging has no trace.** There is no single log of "what happened." You read the medium's state at time T and infer the path. This requires better observability than hierarchical systems need.
- **Upfront schema cost is real.** You can stand up a hierarchical agent team in an afternoon. A stigmergic one requires thinking carefully about what signals matter, what their lifetimes are, and how they decay. This is architecture, not glue code.
- **It doesn't help with single-threaded reasoning.** If the task is "write one brilliant essay," stigmergy adds nothing over a single agent. It pays off when there's genuine parallelism.
- **Decay is the failure mode that will kill you.** Paredes García's Ledger-State Stigmergy paper makes the point clearly: biological pheromones evaporate; database rows do not. A stale task flag, left OPEN, will trigger wasted agent work forever. Every signal in the medium needs an explicit lifecycle — `expires_at` columns, cron-based evaporation, or decreasing-reward decay functions. Get this wrong and the colony poisons itself.

Stigmergy builds decay in from day one. Anything that doesn't is not stigmergy, it's just a shared database.

## Where the field is

Stigmergy-for-LLMs is still early. The work to know:

- **SwarmSys** (Oct 2025, [arXiv:2510.10047](https://arxiv.org/abs/2510.10047)) — three-role agent system (Explorers/Workers/Validators) coordinating through embedding-based compatibility traces. Closest published work to what we're building.
- **Stigmergic MARL** — [SIRL](https://arxiv.org/abs/1911.12504) and [S-MADRL](https://arxiv.org/abs/2510.03592) — pre-LLM but the digital-pheromone mechanics port directly.
- **Paul Welty, "Context as Facticity"** — practitioner argument that agents don't need a protocol, they need a medium. Also the clearest articulation of the quantitative+qualitative dual-channel idea. [paulwelty.com/context-as-facticity](https://www.paulwelty.com/context-as-facticity/)
- **Roland Rodriguez, "Why Multi-Agent Systems Don't Need Managers"** — the sharpest critique of hierarchical multi-agent frameworks. Constraint over orchestration. Locality as the coordination mechanism. [rodriguez.today/articles/emergent-coordination-without-managers](https://www.rodriguez.today/articles/emergent-coordination-without-managers)
- **Paredes García, "Ledger-State Stigmergy"** ([arXiv:2604.03997](https://arxiv.org/abs/2604.03997)) — formal framework for database-backed stigmergy. Required reading for the decay problem.
- **Grassé (1959)** and **Theraulaz & Bonabeau, "A Brief History of Stigmergy"** (*Artificial Life* 1999) — the biology grounding.

What does not yet exist: a production-ready, install-today stigmergic LLM orchestrator. Academic prototypes exist. One-maintainer projects exist. The shipped frameworks — LangGraph, CrewAI, AutoGen, OpenAI Agents SDK, Claude Agent Teams — are all orchestration-first. The gap is real.

This repo is our attempt to close it.

## The claim

Agent systems that scale will look less like corporations and more like colonies. Not because biology is pretty, but because the math is better: linear coordination cost, no manager bottleneck, graceful failure, automatic forgetting, emergent specialization. The primitives are small — a shared medium, decay, roles, locality, validated reinforcement — and none of them are exotic.

Stigmergy is our bet on those primitives: a small, careful porting of a 200-million-year-old coordination pattern onto a substrate — LLMs writing to a Postgres database — that it has never lived in at production scale before.

The philosophy is simple: **stop managing the agents. Shape the landscape they walk on.**
