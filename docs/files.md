# The file convention

Stigmergy models its information tiers on biology. In a living organism, information lives in distinct layers — genome, expressed proteins, consolidated memory, colony-level instinct, environment — each with its own lifetime and its own forgetting mechanism. We keep the same tiering.

Four markdown files, scoped explicitly. Each one has a biological referent and an explicit decay story. That second part matters: **any form of accumulated state in a Stigmergy deployment must have a way to be forgotten**, including its identity documents.

---

## Tier map

```
Colony level (one per Medium):
  CHARTER.md    → what the colony is for

Agent level (per Agent):
  SOUL.md       → who this agent is
  SKILL.md (×n) → what this agent can do
  MEMORY.md     → what this agent has learned

Environment (the Medium itself):
  Signals with decay → what's happening right now
```

Each tier has a distinct:

- **Biological analog.**
- **Rate of change.** Rarely → frequently edited.
- **Decay mechanism.** How outdated content gets dropped.
- **Authorship.** Human, agent, or emergent.

| File | Analog | Changes | Decay | Author |
|---|---|---|---|---|
| CHARTER.md | Queen pheromone / species instinct | Rarely | Human edit | Human |
| SOUL.md | Genome + personality | Rarely | Human edit | Human (optionally co-authored with LLM) |
| SKILL.md | Expressed proteins / tools | Occasionally | Added/removed explicitly | Human |
| MEMORY.md | Consolidated episodic memory | Every run | **Consolidation (rewrite drops the noise)** | Agent's LLM |
| Signals | Pheromones | Constantly | Framework-level decay | Agent |

---

## CHARTER.md

**One per Medium.** What the colony is for.

Loaded on `defineMedium({ charter: "./CHARTER.md" })`. Exposed as `ctx.charter` in every agent's handler. Every agent reads the same charter.

Contents: the mission. What success looks like. Values the whole colony shares. Goals that cut across roles.

**Why not fold into SOUL.md?** Because charter changes affect every agent at once, and soul changes affect one. Different scopes, different update semantics.

**Decay story:** Humans edit it. The framework does not modify it. But — because it is loaded fresh on every handler invocation, editing it mid-run propagates to all agents on their next tick. That's the adaptiveness story: shift the charter, shift the colony.

**Shape:** freeform markdown. No required frontmatter. No standard we conform to yet.

---

## SOUL.md

**One per Agent.** Who the agent is.

Loaded on `defineAgent({ soul: "./agents/scout/SOUL.md", ... })`. Exposed as `ctx.soul`. Passed by the handler into LLM calls as prompt context.

Contents: personality, voice, values, expertise, boundaries. The Stanza/SoulSpec framing is useful here — "who are you?" and "how should you act?" live in this one file.

**Compatibility target: SoulSpec.** We do not invent a format. A soul.md written for Stigmergy should work in OpenClaw, Claude Code, Aeon, and anywhere else that reads the SoulSpec convention. See <https://soulspec.org/>.

**Decay story:** Human-edited. Changes are expected to be deliberate and diff-reviewed. The framework does not modify it.

---

## SKILL.md

**Zero or more per Agent.** What the agent can do.

Loaded on `defineAgent({ skills: ["./skills/web-research.md", ...], ... })`. Exposed as `ctx.skills` — a record keyed by skill name.

Contents: a single capability, documented. The agent invokes it by recognizing when the task calls for it.

**Compatibility target: agentskills.io v1.0 (H2 2026).** The convention is stable enough to follow now: YAML frontmatter with `name` and `description`, markdown body under 500 lines, optional subdirectories for scripts and references. Progressive disclosure (name/description in system prompt, full body loaded on match) is the runtime's job.

**Decay story:** Skills are explicitly added or removed from the agent's declaration. They don't silently expire. If a skill is no longer relevant, remove it from the `skills` array.

---

## MEMORY.md

**One per Agent.** What the agent has learned.

Loaded on `defineAgent({ memory: "./agents/scout/MEMORY.md", ... })` at run start. Exposed as `ctx.memory`. Written back at run end via `ctx.writeMemory(text)`.

Contents: **consolidated, not streamed.** This is the central constraint. MEMORY.md is not a log of everything the agent saw — that's what the medium is for. It's a distilled record of lessons the agent decided are worth keeping.

**The consolidation pattern:**

1. Handler starts. `ctx.memory` holds what this agent carried in.
2. Handler runs. The agent observes, acts, and witnesses outcomes.
3. Before handler returns: the agent's LLM is asked to rewrite MEMORY.md, folding in new insights and dropping what it decided wasn't worth keeping.
4. `ctx.writeMemory(newText)` persists the rewrite.
5. Next run starts with the consolidated memory.

This is the biomimetic forgetting pass. Neurons consolidate memory during sleep — raw events don't persist, distilled patterns do. Stigmergy treats MEMORY.md the same way: the LLM is the sleeping brain, the rewrite is the consolidation, and what gets dropped is how forgetting happens.

**Decay story:** Decay is the consolidation itself. Nothing lives in MEMORY.md except what survived the agent's last rewrite. An outdated lesson gets pruned the first time it stops being confirmed by recent runs.

**Raw event logs belong in the medium.** If the information is useful to other agents, it's a signal with framework-level decay. If it's private and distilled, it's memory.

**No external standard exists yet.** Format is a Stigmergy convention for now.

---

## Why this set and not more

The taxonomy is deliberately small. Here's what I considered and rejected:

| Rejected | Why | Where it folds |
|---|---|---|
| IDENTITY.md | Too thin. Name/org are a few lines. | Frontmatter of SOUL.md |
| RELATIONSHIPS.md | Violates stigmergy. Agents coordinate via medium, not by naming peers. | The medium (reputation signals with decay) |
| BOUNDARIES.md | A subset of personality. | SOUL.md |
| HABITS.md | Same concept as consolidated memory. | MEMORY.md |
| DIET.md / SENSES.md | What the agent perceives is its Role's localQuery. | Role declaration |
| INSTINCT.md / REFLEX.md | Instincts are personality; reflexes are handler logic. | SOUL.md / handler |
| GOAL.md | Goals are expressed as pheromone gradients and validator rules. | The medium + Validator |

Four files. Each has a biological referent. Each has an explicit decay story. Nothing accumulates indefinitely. That's the whole discipline.

---

## The framework's role

Stigmergy **does not interpret** any of these files. It loads them as plain text and hands them to the agent's handler via the context. What the handler does with the text — pass it to an LLM, parse it, template it — is the handler's decision.

This is deliberate. Interpreting the markdown would make Stigmergy a prompt-engineering framework. It isn't. It's a coordination framework that happens to pass prose through to where prose belongs: the LLM's context window.

The one thing Stigmergy *does* actively do with these files: **write MEMORY.md** at the agent's request. Because memory has a lifecycle that the framework owns (load at run start, persist at run end), the framework provides `ctx.writeMemory()`. Everything else is read-only from the framework's perspective.
