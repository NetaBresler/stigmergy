/**
 * Stigmergy — public API entry point.
 *
 * Three surfaces:
 *   - Embedded: `defineMedium` + the DB-client adapters, for agents that run
 *     in-process (see src/runtime via medium.run).
 *   - Server:   `serve` exposes a colony over HTTP so agents can live in their
 *     own processes / languages / environments.
 *   - Client:   `connect` is the SDK those remote agents use.
 *
 * Plus `issueToken` / `revokeToken` for the credentials that bind a remote
 * connection to a declared agent. The full Phase-0 type surface is re-exported
 * for consumers building against the primitives.
 */

// Embedded runtime
export { defineMedium } from "./medium.js";
export { pgliteClient } from "./adapters/pglite.js";
export { postgresJsClient } from "./adapters/postgres.js";

// Server — run a colony as network infrastructure
export { serve, createRequestListener, HttpError } from "./server/index.js";
export type {
  ServeOptions,
  ServerHandle,
  RouterOptions,
  RoleDescriptor,
  WireSignal,
  SessionResponse,
  ViewResponse,
  DepositResponse,
  ClaimResponse,
  HealthResponse,
  OkResponse,
  ApiErrorBody,
} from "./server/index.js";

// Client — the SDK remote agents connect with
export { connect, StigmergyRemoteError } from "./client/index.js";
export type {
  ConnectOptions,
  RemoteAgentSession,
  RemoteRoleContext,
  RunLoopOptions,
} from "./client/index.js";

// Colony administration — agent credentials
export { issueToken, revokeToken } from "./admin.js";
export type { IssuedToken } from "./tokens.js";

// Background workers (exposed for advanced/embedded control)
export { ensureWorkers } from "./workers.js";
export type { WorkerOptions, WorkersHandle } from "./workers.js";

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
