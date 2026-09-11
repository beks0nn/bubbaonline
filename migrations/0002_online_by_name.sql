DROP TABLE online;

CREATE TABLE online (
  character_name TEXT PRIMARY KEY REFERENCES characters(name),
  since TEXT NOT NULL
);