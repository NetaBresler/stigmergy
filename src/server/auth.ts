import { resolveToken } from "../tokens.js";
import type { MediumClient } from "../types.js";

/**
 * Server-side authentication. A request carries `Authorization: Bearer <token>`;
 * we resolve the token to the agent id it was issued for. Unknown or revoked
 * tokens resolve to undefined and the caller returns 401.
 *
 * Tokens are the *only* thing the network boundary trusts. Everything else —
 * which roles the agent may enact, which signals it may read or write — is
 * derived server-side from the registered Agent, never from the request.
 */

export interface Authenticated {
  readonly agentId: string;
}

/** Pull the bearer credential out of an Authorization header. */
export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

/** Resolve an Authorization header to an agent id, or undefined if invalid. */
export async function authenticate(
  client: MediumClient,
  authorizationHeader: string | undefined
): Promise<Authenticated | undefined> {
  const token = parseBearer(authorizationHeader);
  if (!token) return undefined;
  const resolved = await resolveToken(client, token);
  return resolved ? { agentId: resolved.agentId } : undefined;
}
