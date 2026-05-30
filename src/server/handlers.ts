import { ZodError } from "zod";
import { buildAgentContext } from "../agent.js";
import { mediumState, resolvedCharter, upsertAgentId } from "../medium.js";
import { buildRoleContext } from "../role.js";
import type { Duration, Medium, Role } from "../types.js";
import { HttpError } from "./errors.js";
import {
  type ClaimResponse,
  type DepositResponse,
  type HealthResponse,
  type OkResponse,
  type RoleDescriptor,
  type SessionResponse,
  type ViewResponse,
  claimRequestSchema,
  depositRequestSchema,
  memoryRequestSchema,
  releaseRequestSchema,
  toWireSignal,
  viewRequestSchema,
} from "./protocol.js";

/**
 * Endpoint logic. Each handler receives the medium, the authenticated agent
 * id (resolved from the bearer token), and the parsed JSON body. Handlers are
 * the place where locality becomes a *trust boundary*:
 *
 *   - An agent may only enact roles it was declared with (`actingRole` checks
 *     the registered Agent, not anything in the request).
 *   - view() runs that role's localQuery — the agent can't widen it, can't
 *     send SQL, can't name another type.
 *   - deposit() is constrained to the role's writes and Zod-validated.
 *
 * The request never names a table, a column, or another agent. The only thing
 * it controls is which of *its own* roles to act as.
 */

interface HandlerDeps {
  readonly medium: Medium;
  readonly instanceId?: string;
}

/** GET /v1/health — unauthenticated liveness + colony size. */
export async function handleHealth(deps: HandlerDeps): Promise<HealthResponse> {
  const state = requireState(deps.medium);
  const body: { ok: true; signals: number; agents: number; instanceId?: string } = {
    ok: true,
    signals: state.signals.size,
    agents: state.agents.size,
  };
  if (deps.instanceId !== undefined) body.instanceId = deps.instanceId;
  return body;
}

/** POST /v1/session — bootstrap: identity documents + role descriptors. */
export async function handleSession(deps: HandlerDeps, agentId: string): Promise<SessionResponse> {
  const state = requireState(deps.medium);
  const agent = state.agents.get(agentId);
  if (!agent) throw unknownAgent(agentId);

  const ctx = await buildAgentContext({
    client: state.client,
    agent,
    charter: resolvedCharter(deps.medium),
  });

  const roles: RoleDescriptor[] = agent.roles.map((r) => ({
    name: r.name,
    reads: r.reads.map((s) => s.type),
    writes: r.writes.map((s) => s.type),
  }));

  const session: {
    agentId: string;
    skills: Record<string, string>;
    roles: RoleDescriptor[];
    charter?: string;
    soul?: string;
    memory?: string;
  } = { agentId, skills: ctx.skills, roles };
  if (ctx.charter !== undefined) session.charter = ctx.charter;
  if (ctx.soul !== undefined) session.soul = ctx.soul;
  if (ctx.memory !== undefined) session.memory = ctx.memory;
  return session;
}

/** POST /v1/view — run the agent's role-bounded local query. */
export async function handleView(
  deps: HandlerDeps,
  agentId: string,
  body: unknown
): Promise<ViewResponse> {
  const { role: roleName } = parse(viewRequestSchema, body);
  const { role, client } = await actingRole(deps.medium, agentId, roleName);
  const signals = await buildRoleContext(client, role, agentId).view();
  return { signals: signals.map(toWireSignal) };
}

/** POST /v1/deposit — deposit a signal the role is permitted to write. */
export async function handleDeposit(
  deps: HandlerDeps,
  agentId: string,
  body: unknown
): Promise<DepositResponse> {
  const { role: roleName, type, payload } = parse(depositRequestSchema, body);
  const { role, client } = await actingRole(deps.medium, agentId, roleName);
  try {
    const signal = await buildRoleContext(client, role, agentId).deposit(type, payload);
    return { signal: toWireSignal(signal) };
  } catch (err) {
    throw asClientError(err);
  }
}

/** POST /v1/claim — atomically claim a signal. */
export async function handleClaim(
  deps: HandlerDeps,
  agentId: string,
  body: unknown
): Promise<ClaimResponse> {
  const { role: roleName, signalId, until } = parse(claimRequestSchema, body);
  const { role, client } = await actingRole(deps.medium, agentId, roleName);
  try {
    const claimed = await buildRoleContext(client, role, agentId).tryClaim(signalId, {
      until: until as Duration,
    });
    return { claimed };
  } catch (err) {
    throw asClientError(err);
  }
}

/** POST /v1/release — release a claim this agent holds. */
export async function handleRelease(
  deps: HandlerDeps,
  agentId: string,
  body: unknown
): Promise<OkResponse> {
  const { role: roleName, signalId } = parse(releaseRequestSchema, body);
  const { role, client } = await actingRole(deps.medium, agentId, roleName);
  await buildRoleContext(client, role, agentId).release(signalId);
  return { ok: true };
}

/** POST /v1/memory — consolidate the agent's MEMORY document server-side. */
export async function handleMemory(
  deps: HandlerDeps,
  agentId: string,
  body: unknown
): Promise<OkResponse> {
  const { text } = parse(memoryRequestSchema, body);
  const state = requireState(deps.medium);
  const agent = state.agents.get(agentId);
  if (!agent) throw unknownAgent(agentId);
  const ctx = await buildAgentContext({
    client: state.client,
    agent,
    charter: resolvedCharter(deps.medium),
  });
  try {
    await ctx.writeMemory(text);
  } catch (err) {
    throw new HttpError(400, "memory_unavailable", (err as Error).message);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Shared resolution: agent → role, with locality enforced here.
// ---------------------------------------------------------------------------

async function actingRole(
  medium: Medium,
  agentId: string,
  roleName: string
): Promise<{ role: Role; client: ReturnType<typeof requireState>["client"] }> {
  const state = requireState(medium);
  const agent = state.agents.get(agentId);
  if (!agent) throw unknownAgent(agentId);
  const role = agent.roles.find((r) => r.name === roleName);
  if (!role) {
    throw new HttpError(
      403,
      "role_forbidden",
      `Agent "${agentId}" is not declared with role "${roleName}".`
    );
  }
  // Ensure the agent's id is present for the deposit foreign key.
  await upsertAgentId(state.client, agentId);
  return { role, client: state.client };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireState(medium: Medium) {
  const state = mediumState(medium);
  if (!state) throw new HttpError(500, "internal", "Server is not bound to a valid medium.");
  return state;
}

function unknownAgent(agentId: string): HttpError {
  // The token authenticated, but no Agent with this id is registered on the
  // running colony (e.g. the colony was redefined). Treat as unauthorized.
  return new HttpError(401, "unknown_agent", `Agent "${agentId}" is not defined on this colony.`);
}

function parse<T>(schema: { parse: (v: unknown) => T }, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpError(400, "bad_request", err.issues.map((i) => i.message).join("; "));
    }
    throw err;
  }
}

/**
 * Map a role-runtime error (Zod payload failure, write-not-permitted, unknown
 * field) to a 400/403 rather than letting it become a generic 500.
 */
function asClientError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ZodError) {
    return new HttpError(400, "bad_request", err.issues.map((i) => i.message).join("; "));
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/not permitted to deposit/.test(message)) {
    return new HttpError(403, "write_forbidden", message);
  }
  if (/unknown field|not in reads|targets/.test(message)) {
    return new HttpError(400, "bad_request", message);
  }
  throw err;
}
