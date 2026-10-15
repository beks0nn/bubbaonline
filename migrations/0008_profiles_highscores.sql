ALTER TABLE characters ADD COLUMN city TEXT;
ALTER TABLE characters ADD COLUMN guild TEXT;
ALTER TABLE characters ADD COLUMN sex TEXT;
ALTER TABLE characters ADD COLUMN account_type TEXT;
ALTER TABLE characters ADD COLUMN profile_observed_at TEXT;
ALTER TABLE characters ADD COLUMN profile_import_id TEXT;
ALTER TABLE characters ADD COLUMN vocation_observed_at TEXT;

-- One watermark per complete feed, rather than a write to every player per poll.
CREATE TABLE ingestion_state (
  feed TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  import_id TEXT NOT NULL
);
INSERT INTO ingestion_state (feed, observed_at, import_id)
SELECT 'online', MAX(level_observed_at), 'migration'
FROM characters HAVING MAX(level_observed_at) IS NOT NULL;

CREATE TABLE highscore_entries (
  skill TEXT NOT NULL CHECK (skill IN ('magic', 'sword', 'club', 'shielding', 'distance')),
  character_name TEXT NOT NULL REFERENCES characters(name),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 50),
  value INTEGER NOT NULL CHECK (value >= 0),
  vocation TEXT NOT NULL,
  PRIMARY KEY (skill, character_name)
) WITHOUT ROWID;
CREATE INDEX idx_highscores_character ON highscore_entries(character_name);
