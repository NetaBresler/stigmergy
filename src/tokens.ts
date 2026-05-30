import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MediumClient } from "./types.js";

/**
 * Agent tokens — the credential a remote agent presents to act as a colony
 * member over the network.
 *
 * A token is an opaque bearer string (`stg_` + 256 bits of base64url). The
 * server never stores the plaintext: it stores a sha256 hash and compares
 * hashes on each request. Minting returns the plaintext exactly once — the
 * caller is responsible for handing it to the agent (env var, secret store).
 *
 * This module is pure data access against `stigmergy_agent_tokens`. The
 * Medium-level wrappers (`issueToken` / `revokeToken`) live in src/admin.ts.
 */

const TOKEN_PREFIX = "stg_";

/** Mint a fresh, cryptographically-random token string. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** sha256 hex of a token. The only form we persist or compare. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two hex hashes of equal length. */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface IssuedToken {
  /** Plaintext token — shown once, never stored. Hand it to the agent. */
  readonly token: string;
  readonly agentId: string;
  readonly label?: string;
}

/**
 * Issue a token bound to an agent id. Upserts the agent row first so the
 * foreign key resolves even if the agent hasn't started a run loop yet.
 */
export async function issueAgentToken(
  client: MediumClient,
  agentId: string,
  label?: string
): Promise<IssuedToken> {
  await client.query(`INSERT INTO stigmergy_agents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [
    agentId,
  ]);
  const token = generateToken();
  await client.query(
    `INSERT INTO stigmergy_agent_tokens (token_hash, agent_id, label) VALUES ($1, $2, $3)`,
    [hashToken(token), agentId, label ?? null]
  );
  return label === undefined ? { token, agentId } : { token, agentId, label };
}

export interface ResolvedToken {
  readonly agentId: string;
}

/**
 * Resolve a presented token to the agent id it authenticates, or undefined
 * if the token is unknown or revoked. Stamps `last_used_at` on success.
 *
 * We fetch by hash, then verify in constant time, so a row's existence isn't
 * leaked through timing on the index probe path.
 */
export async function resolveToken(
  client: MediumClient,
  token: string
): Promise<ResolvedToken | undefined> {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const hash = hashToken(token);
  const rows = await client.query<{ token_hash: string; agent_id: string }>(
    `SELECT token_hash, agent_id FROM stigmergy_agent_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash]
  );
  const row = rows[0];
  if (!row || !hashesEqual(row.token_hash, hash)) return undefined;
  await client.query(
    `UPDATE stigmergy_agent_tokens SET last_used_at = now() WHERE token_hash = $1`,
    [hash]
  );
  return { agentId: row.agent_id };
}

/** Revoke a token by its plaintext. Returns true if a live token was revoked. */
export async function revokeAgentToken(client: MediumClient, token: string): Promise<boolean> {
  const rows = await client.query<{ token_hash: string }>(
    `UPDATE stigmergy_agent_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL RETURNING token_hash`,
    [hashToken(token)]
  );
  return rows.length > 0;
}
