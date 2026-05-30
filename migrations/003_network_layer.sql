-- Stigmergy framework schema — network layer.
--
-- Everything here is required to run Stigmergy as a *server* that agents
-- living in other processes / languages / environments connect to. The
-- embedded reference implementation never needed any of it; a colony you run
-- as shared infrastructure does.
--
-- Three additions:
--
--   1. stigmergy_agent_tokens — bearer-token credentials. The server maps a
--      presented token (by sha256 hash; plaintext is never stored) to an
--      agent id. This is how a remote agent authenticates as a specific
--      colony member. Tokens can be revoked; last_used_at is a liveness hint.
--
--   2. A UNIQUE index on stigmergy_reinforcements over the *trigger* columns.
--      The validator dispatcher already dedups in SQL ("has this trigger been
--      validated by this validator yet?"), but that check-then-insert is not
--      atomic across *concurrent* dispatchers. Production runs more than one
--      server instance, and two instances could each process the same trigger
--      and double-apply its verdict — a duplicated boost is a silent
--      correctness bug. This index makes "each validator reinforces each
--      trigger at most once" a database invariant, so applyVerdict can
--      INSERT ... ON CONFLICT DO NOTHING and skip the target mutation when it
--      loses the race. Exactly-once, enforced by Postgres.
--
--   3. stigmergy_worker_leases — a tiny lease table for leader election among
--      background workers (decay sweep, validator dispatch). At most one
--      instance holds each lease at a time; a dead holder's lease expires and
--      another takes over on its next tick. This is an *optimization* (the
--      unique index above is the correctness backstop) — it stops N instances
--      from all calling an expensive or human-in-the-loop validate()
--      simultaneously.

-- ---------------------------------------------------------------------------
-- stigmergy_agent_tokens
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stigmergy_agent_tokens (
  token_hash   text PRIMARY KEY,
  agent_id     text NOT NULL REFERENCES stigmergy_agents(id),
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_stigmergy_agent_tokens_agent
  ON stigmergy_agent_tokens (agent_id);

-- ---------------------------------------------------------------------------
-- stigmergy_reinforcements — exactly-once-per-trigger-per-validator invariant
-- ---------------------------------------------------------------------------
-- Drop any historical duplicates first (the pre-002 re-fire bug could have
-- produced them), keeping the earliest row per (trigger, validator). ctid is
-- the physical-row tiebreaker so groups with identical created_at still
-- collapse to one survivor.
DELETE FROM stigmergy_reinforcements
 WHERE ctid IN (
   SELECT ctid FROM (
     SELECT ctid,
            row_number() OVER (
              PARTITION BY trigger_signal_type, trigger_signal_id, validated_by
              ORDER BY created_at, ctid
            ) AS rn
       FROM stigmergy_reinforcements
      WHERE validated_by IS NOT NULL
   ) ranked
   WHERE ranked.rn > 1
 );

CREATE UNIQUE INDEX IF NOT EXISTS uq_stigmergy_reinforcements_trigger
  ON stigmergy_reinforcements (trigger_signal_type, trigger_signal_id, validated_by);

-- ---------------------------------------------------------------------------
-- stigmergy_worker_leases
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stigmergy_worker_leases (
  worker      text PRIMARY KEY,
  holder      text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
