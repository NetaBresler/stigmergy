/**
 * Stigmergy — public API entry point.
 *
 * Exports the runtime factories a colony developer needs (`defineMedium`
 * plus the DB-client adapters), plus the full Phase-0 type surface. The
 * low-level runtime helpers (`buildRoleContext`, `sweepSignal`) are not
 * re-exported; they're wired up by `medium.run()` in Phase 1.8.
 */

// Runtime
export { defineMedium } from "./medium.js";
export { pgliteClient } from "./adapters/pglite.js";
export { postgresJsClient } from "./adapters/postgres.js";

// Types
export type {
  Agent,
  AgentContext,
  AgentHandler,
  Decay,
  DepositedSignal,
  Duration,
  Filter,
  LocalQuery,
  Medium,
  MediumClient,
  PayloadOf,
  Role,
  RoleContext,
  Signal,
  TypeOf,
  Validator,
  ValidatorContext,
  Verdict,
} from "./types.js";
