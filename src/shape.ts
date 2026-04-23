import { createHash } from "node:crypto";
import type { z } from "zod";

/**
 * Zod introspection for Stigmergy. This module translates a developer's
 * `z.object({ ... })` signal shape into:
 *
 *   1. a set of Postgres column definitions (for CREATE TABLE)
 *   2. a deterministic hash (for schema-drift detection)
 *
 * Zod's API is stable enough for this to be direct; we walk the `shape`
 * record of a ZodObject and map each field's `_def.typeName` to a Postgres
 * type. Anything unrecognized becomes `jsonb` — the framework doesn't need
 * to understand every Zod node, it just needs to persist the payload
 * round-trippably.
 */

export interface ShapeColumn {
  readonly name: string;
  /** Postgres type (e.g. "text", "numeric", "jsonb"). No NULL modifier. */
  readonly pgType: string;
  /** `NOT NULL` unless the Zod field is optional or nullable. */
  readonly notNull: boolean;
}

/**
 * Turn a Zod object schema into Postgres column definitions. Only
 * ZodObject is accepted at the top level — signals are records, not
 * scalars. The returned columns do not include framework metadata
 * (id, created_at, origin_agent_id) or decay-specific columns; those
 * are added by the medium.
 */
export function shapeToColumns(shape: z.ZodTypeAny): ShapeColumn[] {
  const def = shape._def as { typeName?: string; shape?: () => Record<string, z.ZodTypeAny> };
  if (def.typeName !== "ZodObject" || typeof def.shape !== "function") {
    throw new Error(
      "Stigmergy signal shapes must be ZodObject at the top level " +
        `(got: ${def.typeName ?? "unknown"})`
    );
  }
  const fields = def.shape();
  return Object.entries(fields)
    .map(([name, field]) => fieldToColumn(name, field))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function fieldToColumn(name: string, field: z.ZodTypeAny): ShapeColumn {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid Stigmergy signal field name: ${JSON.stringify(name)}`);
  }
  const { innermost, nullable } = unwrap(field);
  const pgType = zodToPgType(innermost);
  return { name, pgType, notNull: !nullable };
}

interface Unwrapped {
  readonly innermost: z.ZodTypeAny;
  readonly nullable: boolean;
}

function unwrap(field: z.ZodTypeAny): Unwrapped {
  let current = field;
  let nullable = false;
  // Peel ZodOptional / ZodNullable / ZodDefault layers.
  for (let depth = 0; depth < 10; depth++) {
    const def = current._def as { typeName?: string; innerType?: z.ZodTypeAny };
    if (def.typeName === "ZodOptional" || def.typeName === "ZodNullable") {
      nullable = true;
      if (!def.innerType) break;
      current = def.innerType;
      continue;
    }
    if (def.typeName === "ZodDefault" && def.innerType) {
      current = def.innerType;
      continue;
    }
    break;
  }
  return { innermost: current, nullable };
}

function zodToPgType(field: z.ZodTypeAny): string {
  const def = field._def as { typeName?: string };
  switch (def.typeName) {
    case "ZodString":
      return "text";
    case "ZodNumber":
      return "numeric";
    case "ZodBigInt":
      return "bigint";
    case "ZodBoolean":
      return "boolean";
    case "ZodDate":
      return "timestamptz";
    case "ZodEnum":
    case "ZodNativeEnum":
      return "text";
    case "ZodObject":
    case "ZodArray":
    case "ZodRecord":
    case "ZodTuple":
    case "ZodMap":
    case "ZodSet":
      return "jsonb";
    default:
      return "jsonb";
  }
}

// ---------------------------------------------------------------------------
// Shape hashing
// ---------------------------------------------------------------------------

/**
 * A deterministic hash of a signal's shape, for drift detection between
 * code and the deployed `stigmergy_signal_registry`. Catches added /
 * removed / renamed fields and changed Zod type names; does not catch
 * subtle validator-predicate changes (e.g., `z.number().min(0)` →
 * `z.number().min(10)`), which intentionally don't affect storage.
 */
export function shapeHash(shape: z.ZodTypeAny): string {
  const normalized = normalize(shape);
  const json = JSON.stringify(normalized);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function normalize(shape: z.ZodTypeAny): unknown {
  const def = shape._def as {
    typeName?: string;
    shape?: () => Record<string, z.ZodTypeAny>;
    innerType?: z.ZodTypeAny;
    values?: readonly string[] | Record<string, string | number>;
    element?: z.ZodTypeAny;
  };
  switch (def.typeName) {
    case "ZodObject": {
      const fields = def.shape ? def.shape() : {};
      const entries = Object.entries(fields)
        .map(([name, field]) => [name, normalize(field)] as const)
        .sort((a, b) => a[0].localeCompare(b[0]));
      return { t: "object", f: Object.fromEntries(entries) };
    }
    case "ZodOptional":
    case "ZodNullable":
      return {
        t: def.typeName === "ZodOptional" ? "opt" : "null",
        i: def.innerType ? normalize(def.innerType) : null,
      };
    case "ZodArray":
      return { t: "array", i: def.element ? normalize(def.element) : null };
    case "ZodEnum":
      return {
        t: "enum",
        v: Array.isArray(def.values) ? [...def.values].sort() : def.values,
      };
    default:
      return { t: def.typeName ?? "unknown" };
  }
}
