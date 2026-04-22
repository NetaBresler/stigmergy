-- Stigmergy framework schema.
-- These tables are the same in every Stigmergy deployment, independent of
-- what signals the developer registers. Per-signal-type tables are created
-- dynamically by defineSignal() at runtime; this migration only stands up
-- the framework-level infrastructure.

-- ---------------------------------------------------------------------------
-- stigmergy_agents
-- ---------------------------------------------------------------------------
-- Registry of agent identities. A row is upserted the first time an agent
-- starts its run loop. Every signal deposit foreign-keys here so that the
-- origin is always traceable and agent lifecycle is visible.
CREATE TABLE IF NOT EXISTS stigmergy_agents (
  id            text PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- stigmergy_signal_registry
-- ---------------------------------------------------------------------------
-- One row per signal type the developer has registered via defineSignal().
-- Stores the decay policy and a hash of the Zod shape so the runtime can
-- detect drift between code and the deployed schema and refuse to run
-- against a stale database.
CREATE TABLE IF NOT EXISTS stigmergy_signal_registry (
  type          text PRIMARY KEY,
  table_name    text NOT NULL UNIQUE,
  decay_kind    text NOT NULL CHECK (decay_kind IN ('expiry', 'strength', 'reinforcement')),
  decay_config  jsonb NOT NULL,
  shape_hash    text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- stigmergy_reinforcements
-- ---------------------------------------------------------------------------
-- Audit log of every validator verdict. Two roles:
--   1. For signals with decay kind 'reinforcement', effective strength is
--      computed from this table — count of approvals in the trailing window.
--   2. For all signals, this table is the inspectable record of "why did
--      this signal get stronger / weaker." The medium is queryable by plain
--      SQL; so is the reasoning behind any signal's current state.
-- Note: signal_id is uuid-typed but not foreign-keyed, because per-signal-
-- type tables are created dynamically and we cannot statically reference
-- all of them.
CREATE TABLE IF NOT EXISTS stigmergy_reinforcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_type   text NOT NULL REFERENCES stigmergy_signal_registry(type),
  signal_id     uuid NOT NULL,
  approved      boolean NOT NULL,
  boost         numeric,
  penalty       numeric,
  extend_until  timestamptz,
  validated_by  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stigmergy_reinforcements_signal
  ON stigmergy_reinforcements (signal_type, signal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stigmergy_reinforcements_created
  ON stigmergy_reinforcements (created_at DESC);
