import { mediumState } from "./medium.js";
import { type IssuedToken, issueAgentToken, revokeAgentToken } from "./tokens.js";
import type { Medium } from "./types.js";

/**
 * Colony administration — minting and revoking the bearer tokens that remote
 * agents authenticate with. These are the Medium-level wrappers; the raw
 * client-level functions live in src/tokens.ts.
 *
 * Requires migrations to have run (the token table is created in migration
 * 003). The agent need not have started a run loop — issuing a token upserts
 * the agent row so the credential is valid the moment it's minted.
 */

/**
 * Issue a token for an agent. Returns the plaintext exactly once — store it
 * somewhere the agent can read (an env var, a secret manager). Stigmergy keeps
 * only a hash.
 */
export async function issueToken(
  medium: Medium,
  agentId: string,
  label?: string
): Promise<IssuedToken> {
  const state = requireState(medium);
  return issueAgentToken(state.client, agentId, label);
}

/** Revoke a token by its plaintext value. Returns true if it was live. */
export async function revokeToken(medium: Medium, token: string): Promise<boolean> {
  const state = requireState(medium);
  return revokeAgentToken(state.client, token);
}

function requireState(medium: Medium) {
  const state = mediumState(medium);
  if (!state) throw new Error("issueToken/revokeToken: not a valid Stigmergy medium");
  return state;
}
