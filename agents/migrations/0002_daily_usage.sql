-- The ceiling that actually binds.
--
-- The budget was written in dollars against a monthly cap, which on the Workers
-- Free plan is unreachable — a whole day of six writers costs about a penny.
-- The real limit is 10,000 Workers AI neurons per calendar day, and the system
-- had no idea it existed until it hit it. One writer on a reasoning-heavy model
-- burned half the daily allowance in nine calls while the dollar ceiling sat at
-- 0.4% used.
--
-- A `day` column so the guard in generate() can ask the question cheaply,
-- rather than scanning created_at with a LIKE on every single call.

ALTER TABLE usage_events ADD COLUMN day TEXT;
UPDATE usage_events SET day = substr(created_at, 1, 10) WHERE day IS NULL;
CREATE INDEX IF NOT EXISTS usage_by_day ON usage_events(day, agent_id);
