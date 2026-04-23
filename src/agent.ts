import { loadMarkdown, loadSkills, writeMarkdown } from "./files.js";
import type { LoadedDoc } from "./files.js";
import { upsertAgentId } from "./medium.js";
import { buildRoleContext } from "./role.js";
import type { Agent, AgentContext, MediumClient, Role, RoleContext } from "./types.js";

/**
 * Agent — construct an AgentContext for a defined agent.
 *
 * This module handles the non-DB side of running an agent: loading the
 * four identity documents (charter, soul, skills, memory) and wiring
 * `ctx.writeMemory()` to persist consolidated memory back to the same
 * file it was loaded from.
 *
 * The actual run-loop (scheduling, signal dispatch, validator calls)
 * lives in Phase 1.8's src/runtime.ts. This module is the plumbing
 * that step 1.8 calls per tick; testable in isolation now.
 */

export interface BuildAgentContextOptions<A extends Agent<ReadonlyArray<Role>>> {
  readonly client: MediumClient;
  readonly agent: A;
  /** Already-resolved charter text for the medium, or undefined if none. */
  readonly charter?: string;
}

export async function buildAgentContext<A extends Agent<ReadonlyArray<Role>>>(
  opts: BuildAgentContextOptions<A>
): Promise<AgentContext<A>> {
  const { client, agent, charter } = opts;

  await upsertAgentId(client, agent.id);

  const soulDoc = agent.soul ? await loadMarkdown(agent.soul) : undefined;
  const skillsMap = agent.skills ? await loadSkills(agent.skills) : {};
  // Memory is special — we capture the doc (so writeMemory can persist
  // back to the path) rather than just the text.
  let memoryDoc: LoadedDoc | undefined = agent.memory
    ? await loadMarkdown(agent.memory)
    : undefined;

  const skills: Record<string, string> = {};
  for (const [name, doc] of Object.entries(skillsMap)) {
    skills[name] = doc.text;
  }

  const ctx: AgentContext<A> = {
    agentId: agent.id,
    soul: soulDoc?.text,
    skills,
    memory: memoryDoc?.text,
    charter,

    as<R extends A["roles"][number]>(role: R): RoleContext<R> {
      // Runtime check: the role must be one this agent declared. The
      // generic in Phase 0 narrows the type but developers can still
      // pass a role from another medium by reference. Belt and braces.
      if (!agent.roles.includes(role)) {
        throw new Error(
          `Agent "${agent.id}" is not declared with role "${role.name}"; cannot act as it.`
        );
      }
      return buildRoleContext(client, role, agent.id);
    },

    async writeMemory(text: string): Promise<void> {
      if (!memoryDoc) {
        throw new Error(
          `Agent "${agent.id}" has no memory document declared; ` +
            `call defineAgent({ memory: "./path/to/MEMORY.md", ... }) to enable writeMemory().`
        );
      }
      memoryDoc = await writeMarkdown(memoryDoc, text);
      // Reflect the new text on the context so subsequent handler code
      // (within the same tick) sees the updated memory.
      (ctx as { memory?: string }).memory = memoryDoc.text;
    },
  };

  return ctx;
}
