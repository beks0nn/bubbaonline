CREATE TABLE characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  level INTEGER NOT NULL,
  vocation TEXT NOT NULL DEFAULT 'Unknown',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE deaths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  date TEXT NOT NULL,
  level INTEGER NOT NULL,
  killer TEXT NOT NULL
);

CREATE TABLE online (
  character_id INTEGER PRIMARY KEY REFERENCES characters(id),
  since TEXT NOT NULL
);

CREATE INDEX idx_deaths_character_id ON deaths(character_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deaths_unique ON deaths(character_id, date);