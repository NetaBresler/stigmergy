import { z } from "zod";
import type { DepositedSignal } from "../types.js";

/**
 * The Stigmergy wire protocol — the JSON shapes exchanged between a server
 * (src/server) and a client (src/client, or any HTTP client in any language).
 *
 * This is the "API" half of "SDK or API": everything here is plain JSON over
 * HTTP, so an agent written in Python, Go, or a shell script speaks it just as
 * well as the TypeScript SDK. See docs/connect.md for the full reference.
 *
 * All endpoints are POST under `/v1` except `GET /v1/health`, take and return
 * `application/json`, and carry `Authorization: Bearer <token>`.
 */

export const API_BASE = "/v1";

// ---------------------------------------------------------------------------
// Resource shapes
// ---------------------------------------------------------------------------

/** A role as seen by a connected agent: name + the signal types it touches. */
export interface RoleDescriptor {
  readonly name: string;
  readonly reads: ReadonlyArray<string>;
  readonly writes: ReadonlyArray<string>;
}

/**
 * A deposited signal, JSON-encoded. Equivalent to DepositedSignal, with Dates
 * rendered as ISO strings on the wire. The client rehydrates createdAt /
 * expiresAt back to Date; payload timestamp fields arrive as ISO strings
 * (the client has no schema to coerce them with).
 */
export interface WireSignal {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly originAgentId: string;
  readonly strength?: number;
  readonly expiresAt?: string | null;
}

export interface SessionResponse {
  readonly agentId: string;
  readonly charter?: string;
  readonly soul?: string;
  readonly skills: Record<string, string>;
  readonly memory?: string;
  readonly roles: ReadonlyArray<RoleDescriptor>;
}

export interface ViewResponse {
  readonly signals: ReadonlyArray<WireSignal>;
}

export interface DepositResponse {
  readonly signal: WireSignal;
}

export interface ClaimResponse {
  readonly claimed: boolean;
}

export interface OkResponse {
  readonly ok: true;
}

export interface HealthResponse {
  readonly ok: true;
  readonly signals: number;
  readonly agents: number;
  readonly instanceId?: string;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

// ---------------------------------------------------------------------------
// Request validators — every authenticated POST body is parsed through one of
// these, so the server never trusts the wire shape.
// ---------------------------------------------------------------------------

export const viewRequestSchema = z.object({ role: z.string().min(1) });
export const depositRequestSchema = z.object({
  role: z.string().min(1),
  type: z.string().min(1),
  payload: z.record(z.unknown()),
});
export const claimRequestSchema = z.object({
  role: z.string().min(1),
  signalId: z.string().min(1),
  until: z.string().min(1),
});
export const releaseRequestSchema = z.object({
  role: z.string().min(1),
  signalId: z.string().min(1),
});
export const memoryRequestSchema = z.object({ text: z.string() });

export type ViewRequest = z.infer<typeof viewRequestSchema>;
export type DepositRequest = z.infer<typeof depositRequestSchema>;
export type ClaimRequest = z.infer<typeof claimRequestSchema>;
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;
export type MemoryRequest = z.infer<typeof memoryRequestSchema>;

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Render a DepositedSignal for the wire (Dates → ISO strings). */
export function toWireSignal(d: DepositedSignal): WireSignal {
  const wire: {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
    originAgentId: string;
    strength?: number;
    expiresAt?: string | null;
  } = {
    id: d.id,
    type: d.type,
    payload: d.payload as Record<string, unknown>,
    createdAt: toIso(d.createdAt),
    originAgentId: d.originAgentId,
  };
  if (d.strength !== undefined) wire.strength = d.strength;
  if (d.expiresAt !== undefined) wire.expiresAt = d.expiresAt ? toIso(d.expiresAt) : null;
  return wire;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
