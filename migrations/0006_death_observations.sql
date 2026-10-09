ALTER TABLE deaths ADD COLUMN after_level INTEGER;
ALTER TABLE deaths ADD COLUMN after_observed_at TEXT;

-- Only preserve decreases, not a snapshot for every online heartbeat.
CREATE TABLE level_drops (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  from_level INTEGER NOT NULL,
  to_level INTEGER NOT NULL,
  previous_observed_at TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX idx_level_drops_character_time ON level_drops(character_id, observed_at);
CREATE INDEX idx_level_drops_time ON level_drops(observed_at);

CREATE TRIGGER record_level_drop
AFTER UPDATE OF tracked_experience ON characters
WHEN OLD.tracked_experience IS NOT NULL AND NEW.tracked_experience < OLD.tracked_experience
  AND OLD.level_observed_at IS NOT NULL
BEGIN
  INSERT INTO level_drops (character_id, from_level, to_level, previous_observed_at, observed_at)
  VALUES (NEW.id, OLD.level, NEW.level, OLD.level_observed_at, NEW.level_observed_at);

  DELETE FROM level_drops WHERE id IN (
    SELECT id FROM level_drops
    WHERE observed_at < strftime('%Y-%m-%dT%H:%M:%fZ', NEW.level_observed_at, '-48 hours')
    ORDER BY observed_at LIMIT 100
  );
END;
