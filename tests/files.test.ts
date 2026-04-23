import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMarkdown, loadSkills, writeMarkdown } from "../src/files.js";

/**
 * File loader tests. Cover the path-or-inline heuristic, the skill
 * name-derivation rules, and writeMarkdown's refusal to persist inline
 * docs.
 */

describe("loadMarkdown", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stigmergy-files-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a file when the source is a path", async () => {
    const path = join(dir, "SOUL.md");
    await writeFile(path, "# Scout\n\nCurious.\n", "utf8");
    const doc = await loadMarkdown(path);
    expect(doc.origin).toBe("path");
    expect(doc.text).toBe("# Scout\n\nCurious.\n");
    if (doc.origin === "path") expect(doc.path).toBe(path);
  });

  it("returns inline when the source contains a newline", async () => {
    const doc = await loadMarkdown("# Inline\n\nHello.");
    expect(doc.origin).toBe("inline");
    expect(doc.text).toBe("# Inline\n\nHello.");
  });

  it("errors on a missing file", async () => {
    const path = join(dir, "does-not-exist.md");
    await expect(loadMarkdown(path)).rejects.toThrow();
  });
});

describe("loadSkills", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stigmergy-files-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keys path-origin skills by basename without extension", async () => {
    const a = join(dir, "web-research.md");
    const b = join(dir, "niche-analysis.md");
    await writeFile(a, "A", "utf8");
    await writeFile(b, "B", "utf8");
    const map = await loadSkills([a, b]);
    expect(Object.keys(map).sort()).toEqual(["niche-analysis", "web-research"]);
    expect(map["web-research"]?.text).toBe("A");
    expect(map["niche-analysis"]?.text).toBe("B");
  });

  it("keys inline skills as skill_N in declaration order", async () => {
    const map = await loadSkills(["# Alpha\n", "# Beta\n"]);
    expect(map.skill_0?.text).toBe("# Alpha\n");
    expect(map.skill_1?.text).toBe("# Beta\n");
  });

  it("handles a mix of paths and inlines", async () => {
    const path = join(dir, "research.md");
    await writeFile(path, "P", "utf8");
    const map = await loadSkills([path, "# inline\n"]);
    expect(map.research?.text).toBe("P");
    expect(map.skill_1?.text).toBe("# inline\n");
  });
});

describe("writeMarkdown", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stigmergy-files-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists new text to the same path", async () => {
    const path = join(dir, "MEMORY.md");
    await writeFile(path, "old", "utf8");
    const doc = await loadMarkdown(path);
    await writeMarkdown(doc, "new");
    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toBe("new");
  });

  it("refuses to persist inline-origin docs", async () => {
    const doc = await loadMarkdown("# inline\n");
    await expect(writeMarkdown(doc, "x")).rejects.toThrow(/inline-origin/);
  });
});
