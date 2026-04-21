# Prior Art

What already exists in the stigmergy-for-LLMs space. This document is a survey, not a recommendation. Where a system does something Stigmergy also intends to do, we say so and cite. Where we intend to differ, we say that too.

Caveat up front: some descriptions below were compiled from paper abstracts and snippets rather than full-PDF reads. Before citing any specific claim externally, verify against the primary source.

---

## Published academic work

### SwarmSys (Oct 2025)
[arXiv:2510.10047](https://arxiv.org/abs/2510.10047)

Closed-loop framework with three roles — Explorers, Workers, Validators — cycling through exploration / exploitation / validation. Coordination through embedding-based compatibility traces: each validated contribution updates an agent-event compatibility score, which is used as a pheromone-like probability in future matching. Decay is implicit: unreinforced matches decline as other profiles evolve, "mimicking pheromone evaporation without explicit decay."

**Closest prior art to Stigmergy.** The three-role pattern is directly borrowed. The main difference: SwarmSys's medium is embedding space (high-dimensional, implicit), Stigmergy's is a Postgres table (low-dimensional, explicit, queryable). Embedding-space pheromones are elegant but hard to debug; database-row pheromones are inspectable.

### GPTSwarm (ICML 2024 Oral)
[arXiv:2402.16823](https://arxiv.org/abs/2402.16823)

Represents LLM agents as computational graphs. Optimizes two levels: prompt content (node) and graph connectivity (edge).

**Not stigmergic.** Coordination is explicit via the graph topology, optimized globally. Included here as the dominant "optimizable multi-agent" baseline to contrast with. Stigmergy's coordination is emergent from the medium, not planned by an optimizer.

### Society of HiveMind — SOHM (Mar 2025)
[arXiv:2503.05473](https://arxiv.org/abs/2503.05473)

Minsky-inspired DAG of foundation models with an evolutionary search over topology. "Negligible benefit on tasks that mainly require real-world knowledge" but significant gains on logic-heavy reasoning.

**Weakly stigmergic.** The evolutionary loop reshapes the graph, but agents don't deposit traces locally. Closer to GPTSwarm than SwarmSys.

### SIER (May 2025)
[arXiv:2505.17115](https://arxiv.org/abs/2505.17115)

Kernel density estimation over reasoning-step embeddings, selecting steps that optimize quality and diversity via non-dominated sorting.

**Partially stigmergic.** The density landscape acts as anti-pheromone: low-density regions attract exploration, high-density regions are deprioritized. No temporal decay — density is recomputed per step.

### Stigmergic MARL: SIRL and S-MADRL
[SIRL — arXiv:1911.12504](https://arxiv.org/abs/1911.12504) — [S-MADRL — arXiv:2510.03592](https://arxiv.org/abs/2510.03592)

Pre-LLM, but the canonical reference implementations of digital pheromones. SIRL uses a shared grid with explicit exponential evaporation (Dorigo-style). S-MADRL extends to DQN agents with virtual pheromones encoding activity signals.

**Directly portable.** The decay mechanics (exponential evaporation, per-timestep multiplication) should live in the Stigmergy reference implementation as a first-class option alongside explicit expiry.

### AntLLM Placement (2025)
[arXiv:2508.03345](https://arxiv.org/pdf/2508.03345)

Hybrid Ant Colony Optimization + LLM for agent placement in edge systems. Classical ACO pheromone matrix with standard evaporation, polished by LLM feedback.

Interesting as a composition pattern — ACO does the search, LLM does the semantics — but orthogonal to Stigmergy's goals. We are not doing ACO inside LLM reasoning; we are providing the coordination primitives around which LLM agents operate.

### Ledger-State Stigmergy (Paredes García)
[arXiv:2604.03997](https://arxiv.org/abs/2604.03997)

Formal framework for indirect coordination via distributed ledger state. The most useful paper for Stigmergy's design because it addresses the core porting problem head-on:

> On-chain, a stale trace persists unless the contract includes explicit expiry logic. This is a key distinction from biological stigmergy, where pheromone trails evaporate; ledger state does not.

The paper generalizes to any database-backed system. Its three recommended decay mechanisms — explicit expiration, decreasing rewards, design rules against trace collisions — map directly to Stigmergy's decay primitive.

---

## Shipped frameworks (not stigmergic)

### OpenAI Swarm
[github.com/openai/swarm](https://github.com/openai/swarm)

Routing-only, no pheromones. Two primitives: Agents and Handoffs. Every handoff re-passes complete context. Stateless between calls. Deprecated in favor of the OpenAI Agents SDK.

### Claude Agent Teams (Anthropic, 2026)
[code.claude.com/docs/en/agent-teams](https://code.claude.com/docs/en/agent-teams)

Hierarchical orchestration. One Claude Code session is the team lead; teammates run in their own contexts; the lead decomposes, delegates, monitors, synthesizes. Task dependencies auto-resolve.

### LangGraph, CrewAI, AutoGen, MetaGPT
All orchestration-first. Graphs, crews, conversation managers, role hierarchies. Useful for some problems. Not stigmergic.

---

## Practitioner writeups

### Paul Welty — "Context as Facticity"
[paulwelty.com/context-as-facticity](https://www.paulwelty.com/context-as-facticity/)

Heideggerian reframe: an LLM agent's context window, system prompts, and loaded files *are* its facticity — the world it inhabits before it reasons. Agents don't need a protocol; they need a medium. Coordination falls out of shared facticity.

Load-bearing claim: effective systems need **both** quantitative stigmergy (structured, atomic signals — counters, flags, priority) **and** qualitative stigmergy (unstructured, natural-language traces — logs, notes, docs). LLM agents uniquely require both because their native output is language.

**Stigmergy adopts this directly.** The dual-channel note in `primitives.md` comes from Welty.

### Roland Rodriguez — "Why Multi-Agent Systems Don't Need Managers"
[rodriguez.today/articles/emergent-coordination-without-managers](https://www.rodriguez.today/articles/emergent-coordination-without-managers)

Argues that AutoGen's conversation managers, MetaGPT's role hierarchies, and CrewAI's backstories all import human organizational patterns that become bottlenecks at scale. Three principles:

1. **Constraint over Orchestration** — design constraints that make coordination unnecessary, not protocols that manage it.
2. **Locality as a Feature** — information hiding is the coordination mechanism, not just hygiene.
3. **Pressure-field coordination** — artifact as shared environment, regional pressures as pheromone concentrations, decay as evaporation.

Validated on a shell-script improvement task with qwen2.5-coder. Finding: "When locality holds, stigmergic coordination wins; when coupling is high, explicit planning is needed."

**Stigmergy adopts the Locality primitive directly from Rodriguez.**

---

## Biology grounding

- **Pierre-Paul Grassé (1959)** — coined "stigmergy" studying termite nest repair. The original paper: *La reconstruction du nid et les coordinations interindividuelles chez Bellicositermes Natalensis et Cubitermes sp.* (Insectes Sociaux, 1959). Defined stigmergy as "stimulation of workers by the performance they have achieved."
- **Theraulaz & Bonabeau (1999)** — "A Brief History of Stigmergy," *Artificial Life* 5(2). Introduced the quantitative/qualitative distinction. [direct.mit.edu/artl/article-abstract/5/2/97/2318](https://direct.mit.edu/artl/article-abstract/5/2/97/2318)
- **Francis Heylighen** — "Stigmergy as a generic mechanism for coordination." Generalizes biology to human, digital, and distributed systems. [pespmc1.vub.ac.be/Papers/Stigmergy-WorkingPaper.pdf](https://pespmc1.vub.ac.be/Papers/Stigmergy-WorkingPaper.pdf)
- **Marco Dorigo** — Ant Colony Optimization, the formalization of ant-foraging stigmergy as an algorithm. The decay-is-not-optional insight originates here.

---

## The gap Stigmergy is trying to fill

After surveying the above, there is no framework that ships all of:

- A shared medium with declared signal types
- Explicit decay primitives for every signal
- Role specialization with enforced locality
- Validated reinforcement as a first-class operation
- Both quantitative and qualitative signal support

Academic prototypes exist for pieces. Paredes García's paper describes the theory. Welty and Rodriguez describe the shape. Nobody ships the tool.

We're shipping the tool.
