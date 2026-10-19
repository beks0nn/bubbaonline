-- Read-only investigation. No player data or rankings are changed.
SELECT name, level, tracked_experience, level_observed_at,
       profile_observed_at, last_online,
       EXISTS (SELECT 1 FROM online o WHERE o.character_name = characters.name) AS is_online
FROM characters WHERE name COLLATE NOCASE IN ('Rooktaard', 'KEKInsane');

SELECT feed, observed_at FROM ingestion_state WHERE feed = 'online';

SELECT character_name, observed_at, level_delta, experience_delta,
       CASE WHEN observed_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
                 AND observed_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            THEN 1 ELSE 0 END AS counted_in_last_24h
FROM level_changes
WHERE observed_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-48 hours')
  AND character_name COLLATE NOCASE IN ('Rooktaard', 'KEKInsane')
ORDER BY character_name, observed_at, id LIMIT 500;

SELECT c.name, d.from_level, d.to_level, d.previous_observed_at, d.observed_at
FROM characters c JOIN level_drops d ON d.character_id = c.id
WHERE c.name COLLATE NOCASE IN ('Rooktaard', 'KEKInsane')
  AND d.observed_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-48 hours')
ORDER BY c.name, d.observed_at LIMIT 500;

SELECT c.name, d.date, d.level, d.killer, d.after_level, d.after_observed_at
FROM characters c JOIN deaths d ON d.character_id = c.id
WHERE c.name COLLATE NOCASE IN ('Rooktaard', 'KEKInsane')
  AND d.date > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-48 hours')
ORDER BY c.name, d.date LIMIT 100;
