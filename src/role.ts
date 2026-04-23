import { z } from "zod";
import { durationSeconds, effectiveStrengthSQL, visibilityPredicate } from "./decay.js";
import { depositSignalRow, tableNameFor } from "./medium.js";
import { quoteIdent, quoteLiteral } from "./sql.js";
import type {
  DepositedSignal,
  Duration,
  Filter,
  LocalQuery,
  MediumClient,
  Role,
  RoleContext,
  Signal,
} from "./types.js";

/**
 * Role — the runtime side of locality.
 *
 * A Role declares what signals an agent reads, what it writes, and what
 * slice of the medium it sees. This module turns those declarations into
 * a RoleContext: a bounded surface the agent's handler holds, whose
 * read/write methods cannot escape the role's declared signals.
 *
 * The guarantees:
 *   - `view()` only returns rows from signal types listed in
 *     `reads` + `localQuery.types`, and only rows whose decay
 *     considers them visible.
 *   - `deposit()` rejects at runtime any signal type not in `writes`
 *     (the type system also rejects it at compile time for free).
 *   - `tryClaim()` and `release()` touch the claim shape fields
 *     (`claimed_by`, `claimed_until`) atomically and only on read-set
 *     signals.
 *
 * Phase-1 scope: `localQuery.types` must name exactly one signal type.
 * Multi-type views are allowed by the Phase-0 types but require UNION
 * plumbing we haven't built. They throw with a clear message.
 */

// ---------------------------------------------------------------------------
// Meta-field / decay-field column vocabulary
// ---------------------------------------------------------------------------

/**
 * Column names every signal table carries regardless of shape. Filters
 * referencing these are allowed on any signal type; filters referencing
 * decay-specific columns (e.g. `expires_at`) are allowed only on signals
 * whose decay declares them.
 */
const META_COLUMNS = new Set(["id", "created_at", "origin_agent_id"]);

/**
 * The virtual column we allow in filters for every decay kind: a filter
 * on `strength` is rewritten to the effective-strength expression for
 * the signal's decay, so a handler's "show me pheromones with strength > 0.7"
 * always filters on the *decayed* value, not the stale stored one.
 */
const VIRTUAL_STRENGTH = "strength";

// ---------------------------------------------------------------------------
// Public builder: turn (role, agentId) into a RoleContext
// ---------------------------------------------------------------------------

export function buildRoleContext<R extends Role>(
  client: MediumClient,
  role: R,
  agentId: string
): RoleContext<R> {
  return {
    async view() {
      const rows = await executeLocalQuery(client, role);
      return rows as ReadonlyArray<DepositedSignal<R["reads"][number]>>;
    },

    // The generic narrowing in the Phase-0 Medium.deposit signature is
    // type-level only; the runtime dispatches on the string tag. We cast
    // back to the declared generic at the return boundary.
    deposit: (async (type: string, payload: Record<string, unknown>) => {
      const signal = role.writes.find((s) => s.type === type);
      if (!signal) {
        throw new Error(`Role "${role.name}" is not permitted to deposit signal type "${type}"`);
      }
      const parsed = (signal.shape as z.ZodTypeAny).parse(payload) as Record<string, unknown>;
      const { id } = await depositSignalRow(client, signal, agentId, parsed);
      return fetchSignalById(client, signal, id);
    }) as RoleContext<R>["deposit"],

    async tryClaim(signalId, opts) {
      return tryClaimAcrossReads(client, role, signalId, agentId, opts.until);
    },

    async release(signalId) {
      await releaseAcrossReads(client, role, signalId, agentId);
    },
  };
}

// ---------------------------------------------------------------------------
// view(): compile LocalQuery to SQL and execute
// ---------------------------------------------------------------------------

async function executeLocalQuery(
  client: MediumClient,
  role: Role
): Promise<ReadonlyArray<DepositedSignal>> {
  const signal = resolveReadSignal(role);
  const tableName = tableNameFor(signal.type);
  const shapeColumns = listShapeFieldNames(signal);

  const decayCtx = { signalType: signal.type, tableAlias: "s" };
  const effective = effectiveStrengthSQL(signal.decay, decayCtx);
  const visibility = visibilityPredicate(signal.decay, decayCtx);

  const hasExpires = signal.decay.kind === "expiry";
  const projectedMeta = [
    `s.id::text AS id`,
    `${quoteLiteral(signal.type)} AS __type`,
    `s.created_at AS created_at`,
    `s.origin_agent_id AS origin_agent_id`,
    `(${effective})::text AS __strength`,
    hasExpires ? `s.expires_at AS expires_at` : `NULL::timestamptz AS expires_at`,
  ];
  const projectedShape = shapeColumns.map((c) => `s.${quoteIdent(c)} AS ${quoteIdent(c)}`);
  const selectList = [...projectedMeta, ...projectedShape].join(", ");

  const where: string[] = [visibility];
  const params: unknown[] = [];
  const counter = { n: 0 };
  const userWhere = role.localQuery.where
    ? compileFilter(role.localQuery.where, signal, decayCtx, params, counter)
    : undefined;
  if (userWhere) where.push(userWhere);

  const orderBy = compileOrderBy(role.localQuery, signal, decayCtx);
  const limit = role.localQuery.limit
    ? ` LIMIT ${Number.parseInt(String(role.localQuery.limit), 10)}`
    : "";

  const sql =
    `SELECT ${selectList} FROM ${quoteIdent(tableName)} s ` +
    `WHERE ${where.map((w) => `(${w})`).join(" AND ")} ${orderBy}${limit}`;

  const rows = await client.query<Record<string, unknown>>(sql, params);
  return rows.map((r) => unpackRow(signal, r));
}

function compileOrderBy(
  localQuery: LocalQuery<ReadonlyArray<Signal>>,
  signal: Signal,
  decayCtx: { signalType: string; tableAlias: string }
): string {
  if (!localQuery.orderBy) return "";
  const { field, direction } = localQuery.orderBy;
  const dir = direction === "asc" ? "ASC" : "DESC";
  if (field === VIRTUAL_STRENGTH) {
    return ` ORDER BY (${effectiveStrengthSQL(signal.decay, decayCtx)}) ${dir}`;
  }
  validateFilterField(field, signal);
  return ` ORDER BY s.${quoteIdent(field)} ${dir}`;
}

// ---------------------------------------------------------------------------
// Filter compilation
// ---------------------------------------------------------------------------

function compileFilter(
  filter: Filter,
  signal: Signal,
  decayCtx: { signalType: string; tableAlias: string },
  params: unknown[],
  counter: { n: number }
): string {
  switch (filter.op) {
    case "and":
    case "or": {
      if (filter.clauses.length === 0) return filter.op === "and" ? "TRUE" : "FALSE";
      const pieces = filter.clauses.map((c) => compileFilter(c, signal, decayCtx, params, counter));
      return `(${pieces.join(filter.op === "and" ? " AND " : " OR ")})`;
    }
    case "eq":
    case "gt":
    case "lt": {
      const lhs = compileFieldRef(filter.field, signal, decayCtx);
      counter.n += 1;
      const placeholder = `$${counter.n}`;
      params.push(filter.value);
      if (filter.op === "eq") {
        if (filter.value === null) return `${lhs} IS NULL`;
        return `${lhs} = ${placeholder}`;
      }
      return `${lhs} ${filter.op === "gt" ? ">" : "<"} ${placeholder}`;
    }
  }
}

function compileFieldRef(
  field: string,
  signal: Signal,
  decayCtx: { signalType: string; tableAlias: string }
): string {
  if (field === VIRTUAL_STRENGTH) return `(${effectiveStrengthSQL(signal.decay, decayCtx)})`;
  validateFilterField(field, signal);
  return `s.${quoteIdent(field)}`;
}

function validateFilterField(field: string, signal: Signal): void {
  if (META_COLUMNS.has(field)) return;
  if (signal.decay.kind === "expiry" && field === "expires_at") return;
  if (signal.decay.kind === "strength" && (field === "strength" || field === "last_decay_at"))
    return;
  const shapeFields = listShapeFieldNames(signal);
  if (shapeFields.includes(field)) return;
  throw new Error(`Role localQuery references unknown field "${field}" on signal "${signal.type}"`);
}

// ---------------------------------------------------------------------------
// tryClaim / release
// ---------------------------------------------------------------------------

async function tryClaimAcrossReads(
  client: MediumClient,
  role: Role,
  signalId: string,
  agentId: string,
  until: Duration
): Promise<boolean> {
  const seconds = durationSeconds(until);
  for (const signal of role.reads) {
    if (!signalSupportsClaim(signal)) continue;
    const tableName = tableNameFor(signal.type);
    const rows = await client.query<{ id: string }>(
      `UPDATE ${quoteIdent(tableName)}
       SET claimed_by = $1, claimed_until = now() + (interval '1 second' * ${seconds})
       WHERE id = $2::uuid AND (claimed_by IS NULL OR claimed_until < now())
       RETURNING id::text`,
      [agentId, signalId]
    );
    if (rows.length > 0) return true;
  }
  return false;
}

async function releaseAcrossReads(
  client: MediumClient,
  role: Role,
  signalId: string,
  agentId: string
): Promise<void> {
  for (const signal of role.reads) {
    if (!signalSupportsClaim(signal)) continue;
    const tableName = tableNameFor(signal.type);
    await client.query(
      `UPDATE ${quoteIdent(tableName)}
       SET claimed_by = NULL, claimed_until = NULL
       WHERE id = $1::uuid AND claimed_by = $2`,
      [signalId, agentId]
    );
  }
}

/**
 * A signal supports claim if its shape declares both `claimed_by` and
 * `claimed_until`. Any other shape combination is treated as "claims not
 * applicable" and skipped. Developers who want claims declare those two
 * fields explicitly — no per-primitive magic.
 */
function signalSupportsClaim(signal: Signal): boolean {
  const fields = listShapeFieldNames(signal);
  return fields.includes("claimed_by") && fields.includes("claimed_until");
}

// ---------------------------------------------------------------------------
// Shape introspection (light — duplicated from shape.ts to avoid a cycle)
// ---------------------------------------------------------------------------

function listShapeFieldNames(signal: Signal): string[] {
  const def = (signal.shape as z.ZodTypeAny)._def as {
    typeName?: string;
    shape?: () => Record<string, unknown>;
  };
  if (def.typeName !== "ZodObject" || typeof def.shape !== "function") {
    return [];
  }
  return Object.keys(def.shape());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveReadSignal(role: Role): Signal {
  const types = role.localQuery.types;
  if (types.length !== 1) {
    throw new Error(
      `Role "${role.name}" localQuery.types has ${types.length} entries; ` +
        `Phase 1 supports exactly one read type per role`
    );
  }
  const type = types[0] as string;
  const signal = role.reads.find((s) => s.type === type);
  if (!signal) {
    throw new Error(`Role "${role.name}" localQuery targets "${type}" but it is not in reads`);
  }
  return signal;
}

async function fetchSignalById(
  client: MediumClient,
  signal: Signal,
  id: string
): Promise<DepositedSignal> {
  const tableName = tableNameFor(signal.type);
  const shapeColumns = listShapeFieldNames(signal);
  const hasExpires = signal.decay.kind === "expiry";
  const decayCtx = { signalType: signal.type, tableAlias: "s" };
  const effective = effectiveStrengthSQL(signal.decay, decayCtx);
  const projectedMeta = [
    `s.id::text AS id`,
    `${quoteLiteral(signal.type)} AS __type`,
    `s.created_at AS created_at`,
    `s.origin_agent_id AS origin_agent_id`,
    `(${effective})::text AS __strength`,
    hasExpires ? `s.expires_at AS expires_at` : `NULL::timestamptz AS expires_at`,
  ];
  const projectedShape = shapeColumns.map((c) => `s.${quoteIdent(c)} AS ${quoteIdent(c)}`);
  const selectList = [...projectedMeta, ...projectedShape].join(", ");
  const rows = await client.query<Record<string, unknown>>(
    `SELECT ${selectList} FROM ${quoteIdent(tableName)} s WHERE s.id = $1::uuid`,
    [id]
  );
  const first = rows[0];
  if (!first) throw new Error(`Signal ${id} not found in ${tableName}`);
  return unpackRow(signal, first);
}

function unpackRow(signal: Signal, row: Record<string, unknown>): DepositedSignal {
  const shapeFields = listShapeFieldNames(signal);
  const payload: Record<string, unknown> = {};
  for (const field of shapeFields) payload[field] = row[field];

  const result: DepositedSignal = {
    id: row.id as string,
    type: signal.type,
    payload,
    createdAt: row.created_at as Date,
    originAgentId: row.origin_agent_id as string,
  };
  const strengthRaw = row.__strength;
  if (strengthRaw != null) {
    (result as { strength?: number }).strength = Number.parseFloat(String(strengthRaw));
  }
  if (signal.decay.kind === "expiry" && row.expires_at != null) {
    (result as { expiresAt?: Date }).expiresAt = row.expires_at as Date;
  }
  return result;
}
