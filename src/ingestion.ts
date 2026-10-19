import { reconcileDeathObservations } from "./death-loss";
import { parseHighscores, parseOnline, parseProfiles, type Skill } from "./import-validation";

// Each import is a transaction. The unique token gates every mutation, so a
// concurrent request cannot apply an older snapshot after a newer one commits.
function watermark(db: D1Database, feed: string, time: string, token: string) {
	return db.prepare(`INSERT INTO ingestion_state (feed, observed_at, import_id) VALUES (?, ?, ?)
		ON CONFLICT(feed) DO UPDATE SET observed_at = excluded.observed_at, import_id = excluded.import_id
		WHERE excluded.observed_at > ingestion_state.observed_at`).bind(feed, time, token);
}

function metrics(results: D1Result[]) {
	return results.reduce((total, result) => ({
		writes: total.writes + Number(result.meta.rows_written > 0),
		rowsRead: total.rowsRead + result.meta.rows_read,
		rowsWritten: total.rowsWritten + result.meta.rows_written,
	}), { writes: 0, rowsRead: 0, rowsWritten: 0 });
}

async function reconcile(db: D1Database, results: D1Result[], names: string[], time: string) {
	const totals = metrics(results);
	if (names.length) {
		const extra = await reconcileDeathObservations(db, names, time);
		totals.rowsRead += extra.rowsRead;
		totals.rowsWritten += extra.rowsWritten;
	}
	return totals;
}

export async function importOnline(db: D1Database, raw: unknown) {
	const { players, observedAt } = parseOnline(raw);
	const token = crypto.randomUUID();
	const data = JSON.stringify(players);
	const rows = `WITH p AS (SELECT value ->> '$.name' AS name, value ->> '$.level' AS level,
		value ->> '$.experience' AS experience FROM json_each(?1))`;
	const gate = `EXISTS (SELECT 1 FROM ingestion_state WHERE feed = 'online' AND import_id = ?3)`;
	const fresh = `(c.profile_observed_at IS NULL OR c.profile_observed_at < ?2)
		AND (c.level_observed_at IS NULL OR c.level_observed_at <= ?2)`;
	// Profiles can contain an older saved level even with a fresh capture time.
	// Once tracking starts, only the online feed may move the EXP baseline.
	const levelFresh = `(c.level_observed_at IS NULL OR c.level_observed_at <= ?2)
		AND (c.tracked_experience IS NOT NULL OR c.profile_observed_at IS NULL OR c.profile_observed_at <= ?2)`;
	const statement = (sql: string) => db.prepare(sql).bind(data, observedAt, token);
	const results = await db.batch<{ name: string }>([
		watermark(db, "online", observedAt, token),
		statement(`${rows} INSERT INTO characters (name, level, first_seen, last_seen, tracked_experience, level_observed_at)
			SELECT p.name, p.level, ?2, ?2, p.experience, ?2 FROM p
			WHERE ${gate} AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.name = p.name)`),
		statement(`${rows} UPDATE characters AS c SET level = p.level, tracked_experience = p.experience, level_observed_at = ?2
			FROM p WHERE c.name = p.name AND ${gate} AND ${levelFresh}
			AND (c.level != p.level OR c.tracked_experience IS NULL) RETURNING name`),
		statement(`${rows} UPDATE characters AS c SET last_online = ?2
			WHERE ${gate} AND ${fresh}
			AND c.name IN (SELECT character_name FROM online) AND c.name NOT IN (SELECT name FROM p)`),
		statement(`${rows} DELETE FROM online WHERE ${gate} AND character_name NOT IN (SELECT name FROM p)
			AND EXISTS (SELECT 1 FROM characters c WHERE c.name = online.character_name AND ${fresh}) RETURNING character_name AS name`),
		statement(`${rows} INSERT INTO online (character_name, since)
			SELECT p.name, ?2 FROM p JOIN characters c ON c.name = p.name
			WHERE ${gate} AND ${fresh} AND NOT EXISTS (SELECT 1 FROM online o WHERE o.character_name = p.name)
			RETURNING character_name AS name`),
	]);
	return { ok: true, count: players.length, ignored: results[0].meta.changes === 0,
		added: results[5].results.length, removed: results[4].results.length, levelChanges: results[2].results.length,
		...await reconcile(db, results, results[2].results.map(row => row.name), observedAt) };
}

export async function importProfiles(db: D1Database, raw: unknown) {
	const characters = parseProfiles(raw);
	const data = JSON.stringify(characters);
	const token = crypto.randomUUID();
	const rows = `WITH p AS (SELECT value ->> '$.name' AS name, value ->> '$.level' AS level,
		value ->> '$.experience' AS experience, value ->> '$.vocation' AS vocation,
		value ->> '$.city' AS city, value ->> '$.guild' AS guild, value ->> '$.sex' AS sex,
		value ->> '$.account_type' AS account_type, value ->> '$.last_online' AS last_online,
		value ->> '$.observed_at' AS observed_at, value ->> '$.status' AS status FROM json_each(?1))`;
	const activityFresh = `p.observed_at >= COALESCE((SELECT observed_at FROM ingestion_state WHERE feed = 'online'), '')
		AND p.observed_at >= COALESCE(c.level_observed_at, '')`;
	const statusFresh = `c.profile_import_id = ?2 AND ${activityFresh}`;
	const statement = (sql: string) => db.prepare(sql).bind(data, token);
	const results = await db.batch<{ name: string }>([
		statement(`${rows} INSERT INTO characters
			(name, level, first_seen, last_seen, vocation, vocation_observed_at,
			city, guild, sex, account_type, last_online, profile_observed_at, profile_import_id)
			SELECT name, level, observed_at, observed_at, vocation, observed_at,
			city, guild, sex, account_type, last_online,
			observed_at, ?2 FROM p WHERE NOT EXISTS (SELECT 1 FROM characters c WHERE c.name = p.name)
			RETURNING name`),
		statement(`${rows} UPDATE characters AS c SET
			level = CASE WHEN c.tracked_experience IS NULL AND ${activityFresh} THEN p.level ELSE c.level END,
			vocation = p.vocation, vocation_observed_at = p.observed_at,
			city = p.city, guild = p.guild, sex = p.sex, account_type = p.account_type,
			last_online = CASE WHEN p.last_online > COALESCE(c.last_online, '') THEN p.last_online ELSE c.last_online END,
			profile_observed_at = p.observed_at, profile_import_id = ?2
			FROM p WHERE c.name = p.name AND (c.profile_observed_at IS NULL OR p.observed_at > c.profile_observed_at)
			RETURNING name`),
		statement(`${rows} DELETE FROM online WHERE character_name IN
			(SELECT c.name FROM p JOIN characters c ON c.name = p.name WHERE ${statusFresh} AND p.status = 'offline')`),
		statement(`${rows} INSERT INTO online (character_name, since)
			SELECT p.name, p.observed_at FROM p JOIN characters c ON c.name = p.name
			WHERE ${statusFresh} AND p.status = 'online'
			AND NOT EXISTS (SELECT 1 FROM online o WHERE o.character_name = p.name)`),
	]);
	return { ok: true, count: characters.length, updated: results[0].results.length + results[1].results.length,
		...metrics(results) };
}

export async function importHighscores(db: D1Database, raw: unknown) {
	const payload = parseHighscores(raw);
	const { skill, observedAt, entries } = payload;
	const token = crypto.randomUUID();
	const feed = `highscores:${skill}`;
	const rows = `WITH p AS (SELECT value ->> '$.name' AS name, value ->> '$.rank' AS rank,
		value ->> '$.value' AS value, value ->> '$.vocation' AS vocation FROM json_each(?1))`;
	const gate = `EXISTS (SELECT 1 FROM ingestion_state WHERE feed = 'highscores:' || ?2 AND import_id = ?4)`;
	// Use one JSON parameter for the whole ranking, below D1's bind limit even at 50 entries.
	const statement = (sql: string) => db.prepare(sql).bind(JSON.stringify(entries), skill, observedAt, token);
	const results = await db.batch([
		watermark(db, feed, observedAt, token),
		statement(`${rows} INSERT INTO characters (name, level, vocation, first_seen, last_seen, vocation_observed_at)
			SELECT name, 0, vocation, ?3, ?3, ?3 FROM p WHERE ${gate}
			AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.name = p.name)`),
		statement(`${rows} UPDATE characters AS c SET vocation = p.vocation, vocation_observed_at = ?3
			FROM p WHERE c.name = p.name AND ${gate} AND c.profile_observed_at IS NULL
			AND c.vocation != p.vocation AND COALESCE(c.vocation_observed_at, '') < ?3
			AND NOT EXISTS (SELECT 1 FROM highscore_entries h JOIN ingestion_state s ON s.feed = 'highscores:' || h.skill
				WHERE h.character_name = c.name AND s.observed_at > ?3)`),
		statement(`${rows} DELETE FROM highscore_entries WHERE skill = ?2 AND ${gate}
			AND character_name NOT IN (SELECT name FROM p) AND ?3 IS NOT NULL`),
		statement(`${rows} INSERT INTO highscore_entries (skill, character_name, rank, value, vocation)
			SELECT ?2, name, rank, value, vocation FROM p WHERE ${gate} AND ?3 IS NOT NULL
			ON CONFLICT(skill, character_name) DO UPDATE SET rank = excluded.rank, value = excluded.value, vocation = excluded.vocation
			WHERE highscore_entries.rank != excluded.rank OR highscore_entries.value != excluded.value
			OR highscore_entries.vocation != excluded.vocation`),
	]);
	return { ok: true, skill, count: entries.length, ignored: results[0].meta.changes === 0, ...metrics(results) };
}

export async function getHighscores(db: D1Database, skill: Skill) {
	const results = await db.batch<Record<string, unknown>>([
		db.prepare("SELECT observed_at FROM ingestion_state WHERE feed = ?").bind(`highscores:${skill}`),
		db.prepare(`SELECT h.rank, h.character_name AS name, h.value, h.vocation
			FROM highscore_entries h WHERE h.skill = ? ORDER BY h.rank`).bind(skill),
	]);
	return { skill, observed_at: results[0].results[0]?.observed_at ?? null, entries: results[1].results };
}
