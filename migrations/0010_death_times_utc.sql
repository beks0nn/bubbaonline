-- Pause deathlist uploads while applying this migration and deploying the
-- corrected importer. Existing dates are Swedish wall times mislabeled as UTC.
-- EU rules (since 1996): summer time starts/ends on the last Sunday of March/
-- October. Choose the earlier occurrence of the repeated autumn 02:xx hour,
-- matching deathTimeToUtc. The imported text cannot distinguish occurrences.
-- Temporarily remove uniqueness so deaths an hour apart can shift safely,
-- regardless of their insertion order. The migration is applied atomically.
DROP INDEX idx_deaths_unique;

UPDATE deaths
SET date = strftime('%Y-%m-%dT%H:%M:%SZ', date,
    CASE WHEN date >= strftime('%Y-%m-%dT03:00:00Z', substr(date, 1, 4) || '-04-01', 'weekday 0', '-7 days')
          AND date < strftime('%Y-%m-%dT03:00:00Z', substr(date, 1, 4) || '-11-01', 'weekday 0', '-7 days')
         THEN '-2 hours' ELSE '-1 hours' END),
    -- Matches made against the old timestamps are no longer trustworthy.
    after_level = NULL,
    after_observed_at = NULL;

CREATE UNIQUE INDEX idx_deaths_unique ON deaths(character_id, date);
