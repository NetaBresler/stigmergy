import type { MediumClient } from "./types.js";

/**
 * Lease-based leader election for background workers.
 *
 * Stigmergy's background work — the decay sweep and the validator dispatch —
 * should run from exactly one place even when several server instances are up.
 * A lease is a row in `stigmergy_worker_leases` keyed by worker name. An
 * instance "holds" a worker if its id is in the holder column and the lease
 * hasn't expired. The acquire is a single atomic upsert:
 *
 *   - no row yet                 → insert, we hold it
 *   - row held by us             → renew, we still hold it
 *   - row held by someone, live  → conflict WHERE fails, we don't hold it
 *   - row held by someone, stale → we take it over
 *
 * This is connection-pool friendly (no session-level advisory locks to keep
 * alive across a pooled client) and self-healing (a crashed holder's lease
 * simply expires). It is an optimization, not a correctness mechanism — the
 * unique index on stigmergy_reinforcements is what actually prevents a
 * double-applied verdict if two instances ever race past the lease.
 */

/**
 * Try to acquire or renew a lease. Returns true if this `holder` owns the
 * worker for roughly the next `ttlSeconds`.
 */
export async function tryAcquireLease(
  client: MediumClient,
  worker: string,
  holder: string,
  ttlSeconds: number
): Promise<boolean> {
  const ttl = Math.max(1, Math.floor(ttlSeconds));
  const rows = await client.query<{ holder: string }>(
    `INSERT INTO stigmergy_worker_leases (worker, holder, acquired_at, expires_at)
       VALUES ($1, $2, now(), now() + interval '${ttl} seconds')
     ON CONFLICT (worker) DO UPDATE
       SET holder = EXCLUDED.holder,
           acquired_at = now(),
           expires_at = EXCLUDED.expires_at
       WHERE stigmergy_worker_leases.holder = $2
          OR stigmergy_worker_leases.expires_at < now()
     RETURNING holder`,
    [worker, holder]
  );
  return rows[0]?.holder === holder;
}

/** Release a lease we hold, so another instance can take over immediately. */
export async function releaseLease(
  client: MediumClient,
  worker: string,
  holder: string
): Promise<void> {
  await client.query(`DELETE FROM stigmergy_worker_leases WHERE worker = $1 AND holder = $2`, [
    worker,
    holder,
  ]);
}
