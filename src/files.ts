import { readFile, writeFile } from "node:fs/promises";

/**
 * File conventions for Stigmergy identity documents (CHARTER, SOUL,
 * SKILL, MEMORY). Pure file I/O; no interpretation of the markdown
 * content. Stigmergy hands text to the LLM — it does not parse it.
 *
 * Path-or-inline heuristic: if the source string contains a newline,
 * treat it as inline markdown. Otherwise, treat it as a filesystem
 * path and read the file. This covers the common cases:
 *
 *   defineAgent({ soul: "./agents/scout/SOUL.md" })   // path
 *   defineAgent({ soul: "# Scout\n\nCurious..." })    // inline
 *
 * An inline string without a newline is rare and ambiguous; callers
 * wanting that should add a trailing "\n". The heuristic is
 * documented; an explicit discriminator can land if it proves needed.
 */

export type LoadedDoc =
  | { readonly origin: "path"; readonly path: string; readonly text: string }
  | { readonly origin: "inline"; readonly text: string };

function looksLikePath(source: string): boolean {
  return !source.includes("\n") && source.length <= 1000;
}

/**
 * Resolve a path-or-inline source into a LoadedDoc. Paths are read
 * from disk; inline strings are returned verbatim. Errors on a missing
 * file bubble up as ENOENT.
 */
export async function loadMarkdown(source: string): Promise<LoadedDoc> {
  if (looksLikePath(source)) {
    const text = await readFile(source, "utf8");
    return { origin: "path", path: source, text };
  }
  return { origin: "inline", text: source };
}

/**
 * Load an array of skill sources into a name-keyed map. Path-origin
 * skills are keyed by their filename without extension; inline skills
 * are keyed as `skill_0`, `skill_1`, ... in declaration order. A
 * developer who wants a specific inline key writes a small file.
 */
export async function loadSkills(
  sources: ReadonlyArray<string>
): Promise<Record<string, LoadedDoc>> {
  const entries = await Promise.all(sources.map((s) => loadMarkdown(s)));
  const out: Record<string, LoadedDoc> = {};
  entries.forEach((doc, idx) => {
    const key = doc.origin === "path" ? basenameWithoutExt(doc.path) : `skill_${idx}`;
    out[key] = doc;
  });
  return out;
}

/**
 * Persist new text to a path-origin doc. Inline-origin docs have no
 * backing file, so this throws — consolidation-of-inline is a
 * conceptual contradiction and Stigmergy should tell the developer so
 * loudly rather than silently discarding their writeMemory() call.
 */
export async function writeMarkdown(doc: LoadedDoc, text: string): Promise<LoadedDoc> {
  if (doc.origin !== "path") {
    throw new Error(
      "writeMarkdown: cannot persist inline-origin doc. Declare the identity " +
        "document as a filesystem path (e.g. MEMORY: './agents/scout/MEMORY.md') " +
        "if the agent needs to write to it."
    );
  }
  await writeFile(doc.path, text, "utf8");
  return { origin: "path", path: doc.path, text };
}

function basenameWithoutExt(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}
