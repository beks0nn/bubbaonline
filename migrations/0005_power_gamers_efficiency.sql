-- Keep the baseline on the character row already read/updated by online polling.
ALTER TABLE characters ADD COLUMN tracked_experience INTEGER;
ALTER TABLE characters ADD COLUMN level_observed_at TEXT;

UPDATE characters
SET tracked_experience = (SELECT experience FROM character_progress WHERE character_name = characters.name),
    level_observed_at = (SELECT observed_at FROM character_progress WHERE character_name = characters.name)
WHERE name IN (SELECT character_name FROM character_progress);

DROP TRIGGER record_level_change;
DROP TABLE character_progress;

-- A loss resets the baseline without creating history; regained levels count.
CREATE TRIGGER record_level_gain
AFTER UPDATE OF tracked_experience ON characters
WHEN OLD.tracked_experience IS NOT NULL AND NEW.tracked_experience > OLD.tracked_experience
BEGIN
  INSERT INTO level_changes (character_name, observed_at, level_delta, experience_delta)
  VALUES (NEW.name, NEW.level_observed_at, NEW.level - OLD.level,
          NEW.tracked_experience - OLD.tracked_experience);

  -- Prune expired history in bounded batches as new gains arrive. No heartbeat
  -- maintenance query or scheduled Worker is needed; retain a 48-hour buffer.
  DELETE FROM level_changes WHERE id IN (
    SELECT id FROM level_changes
    WHERE observed_at < strftime('%Y-%m-%dT%H:%M:%fZ', NEW.level_observed_at, '-48 hours')
    ORDER BY observed_at LIMIT 100
  );
END;
