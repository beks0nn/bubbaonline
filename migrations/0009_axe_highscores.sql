-- Rebuild the table to extend its CHECK constraint, preserving existing rankings.
CREATE TABLE highscore_entries_new (
  skill TEXT NOT NULL CHECK (skill IN ('magic', 'sword', 'axe', 'club', 'shielding', 'distance')),
  character_name TEXT NOT NULL REFERENCES characters(name),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 50),
  value INTEGER NOT NULL CHECK (value >= 0),
  vocation TEXT NOT NULL,
  PRIMARY KEY (skill, character_name)
) WITHOUT ROWID;

INSERT INTO highscore_entries_new (skill, character_name, rank, value, vocation)
SELECT skill, character_name, rank, value, vocation FROM highscore_entries;

DROP TABLE highscore_entries;
ALTER TABLE highscore_entries_new RENAME TO highscore_entries;
CREATE INDEX idx_highscores_character ON highscore_entries(character_name);
