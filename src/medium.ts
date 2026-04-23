import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import type { z } from "zod";
import { postgresJsClient } from "./adapters/postgres.js";
import { decayColumnsDDL, decayInsertValues } from "./decay.js";
import { migrate as runMigrations } from "./migrator.js";
import { shapeHash, shapeToColumns } from "./shape.js";
import type {
  Agent,
  AgentHandler,
  Decay,
  Medium,
  MediumClient,
  Role,
  Signal,
  Validator,
} from "./types.js";

/**
 * Runtime side of the Medium primitive. Owns:
 *   - the DB client connection
 *   - the in-memory registry (signals / roles / validators / agents)
 *   - the charter text
 *
 * Shape:
 *   - `defineMedium({ url | client, charter? })` returns a Medium.
 *   - Each `defineSignal` / `defineRole` / `defineValidator` / `defineAgent`
 *     records the definition and returns a typed handle; the underlying
 *     Medium object is shared and mutated in place (no global state —
 *     state lives on the Medium instance).
 *   - `medium.migrate()` applies framework migrations, then for each
 *     registered signal either (a) creates the per-type table and records
 *     it in `stigmergy_signal_registry`, or (b) verifies the stored shape
 *     hash matches the code and refuses to run otherwise.
 *
 * Run, validator dispatch, and the role-enforcement machinery arrive in
 * subsequent steps (1.5–1.8). For now those methods are minimal stubs
 * that preserve the registry but do not yet execute.
 */

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface MediumState {
  readonly client: MediumClient;
  readonly ownsClient: boolean;
  readonly signals: Map<string, Signal>;
  readonly roles: Map<string, Role>;
  readonly validators: Validator[];
  readonly agents: Map<string, Agent>;
  readonly charterPathOrInline?: string;
  charter?: string;
  closed: boolean;
}

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations"
);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function defineMedium(
  connection: { url: string; charter?: string } | { client: MediumClient; charter?: string }
): Medium {
  let client: MediumClient;
  let ownsClient: boolean;

  if ("client" in connection) {
    client = connection.client;
    ownsClient = false;
  } else {
    client = postgresJsClient(postgres(connection.url));
    ownsClient = true;
  }

  const state: MediumState = {
    client,
    ownsClient,
    signals: new Map(),
    roles: new Map(),
    validators: [],
    agents: new Map(),
    charterPathOrInline: connection.charter,
    closed: false,
  };

  return buildMedium(state);
}

// ---------------------------------------------------------------------------
// Medium object
// ---------------------------------------------------------------------------

function buildMedium(state: MediumState): Medium {
  const medium: Medium = {
    defineSignal(def) {
      validateSignalType(def.type);
      const existing = state.signals.get(def.type);
      if (existing && existing !== def) {
        throw new Error(`Signal type "${def.type}" is already defined on this medium.`);
      }
      state.signals.set(def.type, def);
      return def;
    },

    defineRole(def) {
      if (state.roles.has(def.name)) {
        throw new Error(`Role name "${def.name}" is already defined on this medium.`);
      }
      state.roles.set(def.name, def);
      return def;
    },

    defineValidator(def) {
      state.validators.push(def);
      return def;
    },

    defineAgent(def) {
      if (state.agents.has(def.id)) {
        throw new Error(`Agent id "${def.id}" is already defined on this medium.`);
      }
      state.agents.set(def.id, def);
      return def;
    },

    async migrate() {
      await runMigrations(state.client, MIGRATIONS_DIR);
      for (const signal of state.signals.values()) {
        await migrateSignal(state.client, signal);
      }
    },

    async run(_agent, _handler) {
      throw new Error("Medium.run() is not implemented yet — lands in Phase 1.8.");
    },

    updateValidator(validator, nextValidate) {
      // Replace the validator's `validate` by identity.
      const idx = state.validators.indexOf(validator);
      if (idx < 0) {
        throw new Error("updateValidator: validator is not registered on this medium.");
      }
      const current = state.validators[idx];
      if (!current) return;
      state.validators[idx] = { ...current, validate: nextValidate } as Validator;
    },

    async query(sql) {
      return state.client.query(sql);
    },

    async close() {
      if (state.closed) return;
      state.closed = true;
      if (state.ownsClient && state.client.close) {
        await state.client.close();
      }
    },
  };

  return medium;
}

// ---------------------------------------------------------------------------
// Per-signal-type migration: CREATE TABLE + registry row, or drift check
// ---------------------------------------------------------------------------

async function migrateSignal(client: MediumClient, signal: Signal): Promise<void> {
  const tableName = tableNameFor(signal.type);
  const hash = shapeHash(signal.shape);
  const decayConfig = JSON.stringify(signal.decay);

  const existing = await client.query<{
    table_name: string;
    decay_kind: string;
    decay_config: unknown;
    shape_hash: string;
  }>(`SELECT table_name, decay_kind, decay_config, shape_hash FROM stigmergy_signal_registry WHERE type = $1`, [
    signal.type,
  ]);

  if (existing.length > 0) {
    const row = existing[0];
    if (!row) return;
    if (row.shape_hash !== hash) {
      throw new Error(
        `Schema drift detected for signal "${signal.type}": stored shape hash ` +
          `${row.shape_hash} does not match current code hash ${hash}. ` +
          `Review your changes and run a migration explicitly.`
      );
    }
    if (row.decay_kind !== signal.decay.kind) {
      throw new Error(
        `Schema drift detected for signal "${signal.type}": stored decay kind ` +
          `"${row.decay_kind}" does not match current code "${signal.decay.kind}".`
      );
    }
    // Table already exists by constraint; nothing more to do.
    return;
  }

  const createSql = buildCreateTableSQL(tableName, signal.shape, signal.decay);
  await client.exec(createSql);
  await client.query(
    `INSERT INTO stigmergy_signal_registry (type, table_name, decay_kind, decay_config, shape_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [signal.type, tableName, signal.decay.kind, decayConfig, hash]
  );
}

function buildCreateTableSQL(tableName: string, shape: z.ZodTypeAny, decay: Decay): string {
  const metaCols = [
    `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    `created_at timestamptz NOT NULL DEFAULT now()`,
    `origin_agent_id text NOT NULL REFERENCES stigmergy_agents(id)`,
  ];
  const decayCols = decayColumnsDDL(decay).map(String);
  const shapeCols = shapeToColumns(shape).map(
    (c) => `${quoteIdent(c.name)} ${c.pgType}${c.notNull ? " NOT NULL" : ""}`
  );
  const all = [...metaCols, ...decayCols, ...shapeCols].join(",\n  ");
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (\n  ${all}\n);`;
}

// ---------------------------------------------------------------------------
// Exposed for the next sub-steps (role / agent / validator runtime wiring)
// ---------------------------------------------------------------------------

/**
 * Insert a signal of a given type into its per-type table. Used by
 * RoleContext.deposit (step 1.5) and by tests that need to seed state.
 * Not part of the public Medium interface — agents deposit via their
 * role context, not the medium directly.
 */
export async function depositSignalRow(
  client: MediumClient,
  signal: Signal,
  originAgentId: string,
  payload: Record<string, unknown>
): Promise<{ id: string }> {
  const tableName = tableNameFor(signal.type);
  const decayValues = decayInsertValues(signal.decay);
  const merged = { ...decayValues, ...payload, origin_agent_id: originAgentId };
  const entries = Object.entries(merged) as ReadonlyArray<[string, unknown]>;
  const columns = entries.map(([k]) => k);
  const placeholders = entries.map((_, i) => `$${i + 1}`);
  const values = entries.map(([, v]) => v);
  const sql = `INSERT INTO ${quoteIdent(tableName)} (${columns
    .map(quoteIdent)
    .join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING id::text`;
  const rows = await client.query<{ id: string }>(sql, values);
  const first = rows[0];
  if (!first) {
    throw new Error(`INSERT into ${tableName} returned no rows.`);
  }
  return first;
}

export function tableNameFor(signalType: string): string {
  return `signal_${signalType}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

function validateSignalType(type: string): void {
  if (!TYPE_NAME_PATTERN.test(type)) {
    throw new Error(
      `Invalid signal type ${JSON.stringify(type)}. ` +
        `Must match ${TYPE_NAME_PATTERN} — lowercase, start with a letter.`
    );
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

// ---------------------------------------------------------------------------
// Handler type reference (preserves import so ts doesn't strip it)
// ---------------------------------------------------------------------------

export type { AgentHandler };
