import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { pgliteClient } from "../src/adapters/pglite.js";
import { buildAgentContext } from "../src/agent.js";
import { defineMedium, resolvedCharter } from "../src/medium.js";

/**
 * Agent + file-loading tests.
 *
 * Covers:
 *   - charter loaded on migrate (path-or-inline)
 *   - agent soul / skills / memory loaded when context is built
 *   - writeMemory persists to the declared path and updates ctx.memory
 *   - writeMemory errors when agent has no memory declared
 *   - ctx.as(role) narrows correctly and rejects foreign roles
 */

describe("charter loading", () => {
  let db: PGlite;
  let dir: string;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    dir = await mkdtemp(join(tmpdir(), "stigmergy-agent-"));
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("loads charter from a path on migrate()", async () => {
    const path = join(dir, "CHARTER.md");
    await writeFile(path, "# Find demand.\n", "utf8");
    const medium = defineMedium({ client: pgliteClient(db), charter: path });
    await medium.migrate();
    expect(resolvedCharter(medium)).toBe("# Find demand.\n");
  });

  it("treats charter with a newline as inline markdown", async () => {
    const medium = defineMedium({
      client: pgliteClient(db),
      charter: "# Inline charter\n\nShip things.",
    });
    await medium.migrate();
    expect(resolvedCharter(medium)).toBe("# Inline charter\n\nShip things.");
  });

  it("returns undefined when no charter is declared", async () => {
    const medium = defineMedium({ client: pgliteClient(db) });
    await medium.migrate();
    expect(resolvedCharter(medium)).toBeUndefined();
  });
});

describe("buildAgentContext", () => {
  let db: PGlite;
  let dir: string;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    dir = await mkdtemp(join(tmpdir(), "stigmergy-agent-"));
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("loads soul, skills, memory, and exposes them on the context", async () => {
    const soulPath = join(dir, "SOUL.md");
    const skillA = join(dir, "web-research.md");
    const skillB = join(dir, "niche-analysis.md");
    const memoryPath = join(dir, "MEMORY.md");
    await writeFile(soulPath, "soul-text", "utf8");
    await writeFile(skillA, "A", "utf8");
    await writeFile(skillB, "B", "utf8");
    await writeFile(memoryPath, "memory-text", "utf8");

    const client = pgliteClient(db);
    const medium = defineMedium({ client, charter: "# Charter\n" });
    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ niche: z.string() }),
    });
    const role = medium.defineRole({
      name: "Scout",
      reads: [demand],
      writes: [demand],
      localQuery: { types: ["demand"] },
    });
    const agent = medium.defineAgent({
      id: "scout-01",
      soul: soulPath,
      skills: [skillA, skillB],
      memory: memoryPath,
      roles: [role],
    });
    await medium.migrate();

    const ctx = await buildAgentContext({
      client,
      agent,
      charter: resolvedCharter(medium),
    });

    expect(ctx.agentId).toBe("scout-01");
    expect(ctx.soul).toBe("soul-text");
    expect(ctx.skills).toEqual({
      "web-research": "A",
      "niche-analysis": "B",
    });
    expect(ctx.memory).toBe("memory-text");
    expect(ctx.charter).toBe("# Charter\n");
  });

  it("omits identity documents that the agent didn't declare", async () => {
    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ niche: z.string() }),
    });
    const role = medium.defineRole({
      name: "Minimal",
      reads: [demand],
      writes: [],
      localQuery: { types: ["demand"] },
    });
    const agent = medium.defineAgent({ id: "bare", roles: [role] });
    await medium.migrate();

    const ctx = await buildAgentContext({ client, agent });
    expect(ctx.soul).toBeUndefined();
    expect(ctx.memory).toBeUndefined();
    expect(ctx.skills).toEqual({});
    expect(ctx.charter).toBeUndefined();
  });
});

describe("ctx.writeMemory", () => {
  let db: PGlite;
  let dir: string;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    dir = await mkdtemp(join(tmpdir(), "stigmergy-agent-"));
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("persists consolidated text to the declared path and updates ctx.memory", async () => {
    const memoryPath = join(dir, "MEMORY.md");
    await writeFile(memoryPath, "old", "utf8");

    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ niche: z.string() }),
    });
    const role = medium.defineRole({
      name: "Scout",
      reads: [demand],
      writes: [],
      localQuery: { types: ["demand"] },
    });
    const agent = medium.defineAgent({ id: "s", memory: memoryPath, roles: [role] });
    await medium.migrate();

    const ctx = await buildAgentContext({ client, agent });
    await ctx.writeMemory("consolidated");

    const onDisk = await readFile(memoryPath, "utf8");
    expect(onDisk).toBe("consolidated");
    expect(ctx.memory).toBe("consolidated");
  });

  it("errors when the agent has no memory file declared", async () => {
    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ niche: z.string() }),
    });
    const role = medium.defineRole({
      name: "Scout",
      reads: [demand],
      writes: [],
      localQuery: { types: ["demand"] },
    });
    const agent = medium.defineAgent({ id: "s", roles: [role] });
    await medium.migrate();

    const ctx = await buildAgentContext({ client, agent });
    await expect(ctx.writeMemory("x")).rejects.toThrow(/no memory document declared/);
  });

  it("errors when the agent's memory was declared inline (no backing path)", async () => {
    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ niche: z.string() }),
    });
    const role = medium.defineRole({
      name: "Scout",
      reads: [demand],
      writes: [],
      localQuery: { types: ["demand"] },
    });
    const agent = medium.defineAgent({
      id: "s",
      memory: "# inline memory\n",
      roles: [role],
    });
    await medium.migrate();

    const ctx = await buildAgentContext({ client, agent });
    expect(ctx.memory).toBe("# inline memory\n");
    await expect(ctx.writeMemory("x")).rejects.toThrow(/inline-origin/);
  });
});

describe("ctx.as(role)", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });

  afterEach(async () => {
    await db.close();
  });

  it("returns a bounded RoleContext for an agent's declared role", async () => {
    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ niche: z.string() }),
    });
    const role = medium.defineRole({
      name: "Scout",
      reads: [demand],
      writes: [demand],
      localQuery: { types: ["demand"] },
    });
    const agent = medium.defineAgent({ id: "s", roles: [role] });
    await medium.migrate();

    const ctx = await buildAgentContext({ client, agent });
    const roleCtx = ctx.as(role);
    await roleCtx.deposit("demand", { niche: "x" });
    const rows = await roleCtx.view();
    expect(rows).toHaveLength(1);
  });

  it("throws when asked to act as a role the agent wasn't declared with", async () => {
    const client = pgliteClient(db);
    const medium = defineMedium({ client });
    const demand = medium.defineSignal({
      type: "demand",
      decay: { kind: "expiry", after: "1h" },
      shape: z.object({ niche: z.string() }),
    });
    const scoutRole = medium.defineRole({
      name: "Scout",
      reads: [demand],
      writes: [],
      localQuery: { types: ["demand"] },
    });
    const workerRole = medium.defineRole({
      name: "Worker",
      reads: [demand],
      writes: [],
      localQuery: { types: ["demand"] },
    });
    const agent = medium.defineAgent({ id: "s", roles: [scoutRole] });
    await medium.migrate();

    const ctx = await buildAgentContext({ client, agent });
    // Passing a role the agent wasn't declared with: runtime rejects it
    // even though the structural type is compatible.
    expect(() => ctx.as(workerRole)).toThrow(/not declared with role/);
  });
});
