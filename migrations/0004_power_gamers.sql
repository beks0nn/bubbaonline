-- Baselines start with the first online observation after deployment.
-- Do not use characters.level, which can come from historical death imports.
CREATE TABLE character_progress (
  character_name TEXT PRIMARY KEY REFERENCES characters(name),
  level INTEGER NOT NULL,
  experience INTEGER NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE level_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_name TEXT NOT NULL REFERENCES characters(name),
  observed_at TEXT NOT NULL,
  level_delta INTEGER NOT NULL,
  experience_delta INTEGER NOT NULL
);

CREATE INDEX idx_level_changes_observed_at ON level_changes(observed_at);

-- Record the delta and baseline atomically; repeated observations create no event.
CREATE TRIGGER record_level_change
AFTER UPDATE OF level ON character_progress
WHEN NEW.level != OLD.level
BEGIN
  INSERT INTO level_changes (character_name, observed_at, level_delta, experience_delta)
  VALUES (NEW.character_name, NEW.observed_at, NEW.level - OLD.level,
          NEW.experience - OLD.experience);
END;
