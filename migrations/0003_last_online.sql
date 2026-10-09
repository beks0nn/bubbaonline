-- Historical last_seen values are creation timestamps, not online activity.
-- Leave existing characters unknown until an offline transition is observed.
ALTER TABLE characters ADD COLUMN last_online TEXT;
