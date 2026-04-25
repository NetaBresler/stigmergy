-- Stigmergy framework schema — revision.
--
-- Adds trigger_signal_type / trigger_signal_id to stigmergy_reinforcements
-- so the validator dispatcher can dedup on the *triggering* signal, not the
-- target.
--
-- Why this exists:
--   The original schema stored only one (type, id) pair per audit row —
--   interpreted as the target of the verdict. For self-targeting verdicts
--   (approve signal X, applied to signal X) this was fine. For cross-signal
--   reinforcement (a triage_note triggers a verdict that targets a
--   reported_bug), the audit row recorded the reported_bug's id — so the
--   dispatcher's "have I processed this trigger yet?" query, which looked
--   for an audit row with signal_id = trigger.id, never matched. The
--   dispatcher would re-validate the same trigger every tick, compounding
--   boosts on the target forever.
--
--   Every Stigmergy colony that uses cross-signal reinforcement was affected.
--
-- Migration is additive: existing rows keep signal_type/signal_id as target,
-- backfill trigger_signal_type/trigger_signal_id from the same columns
-- (which was the implicit convention for self-targeting verdicts anyway).

ALTER TABLE stigmergy_reinforcements
  ADD COLUMN IF NOT EXISTS trigger_signal_type text,
  ADD COLUMN IF NOT EXISTS trigger_signal_id   uuid;

UPDATE stigmergy_reinforcements
   SET trigger_signal_type = signal_type,
       trigger_signal_id   = signal_id
 WHERE trigger_signal_type IS NULL;

-- Once backfilled, make them required. Future inserts must supply both.
ALTER TABLE stigmergy_reinforcements
  ALTER COLUMN trigger_signal_type SET NOT NULL,
  ALTER COLUMN trigger_signal_id   SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stigmergy_reinforcements_trigger
  ON stigmergy_reinforcements (trigger_signal_type, trigger_signal_id, validated_by);
