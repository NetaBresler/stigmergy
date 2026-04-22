/**
 * Stigmergy — public API entry point.
 *
 * Phase 1 is under construction. For now this file re-exports the Phase 0
 * type surface. Runtime implementations land module-by-module; see the
 * roadmap in docs/roadmap.md for the order.
 */

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
  PayloadOf,
  Role,
  RoleContext,
  Signal,
  TypeOf,
  Validator,
  ValidatorContext,
  Verdict,
} from "./types.js";
