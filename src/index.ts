import { experienceAtLevel } from "./experience";
import { estimateDeathLoss, reconcileDeathObservations } from "./death-loss";
import { getPowerGamers } from "./power-gamers";

interface WorkerEnv extends Env {
	OTCLIENT_SECRET: string;
}

interface OnlinePlayer {
	name: string;
	level: number;
}

interface OnlinePayload {
	players: OnlinePlayer[];
}

interface DeathlistPayload {
	text: string;
}

interface Death {
	date: string;
	level: number;
	killer: string;
}

const D1_MAX_BOUND_PARAMETERS = 100;
const DEATH_SELECT_BATCH_SIZE = D1_MAX_BOUND_PARAMETERS - 1; // character ID occupies one parameter
const DEATH_INSERT_BATCH_SIZE = Math.floor(D1_MAX_BOUND_PARAMETERS / 4);

const MONTHS: Record<string, string> = {
	January: "01", February: "02", March: "03", April: "04",
	May: "05", June: "06", July: "07", August: "08",
	September: "09", October: "10", November: "11", December: "12",
};

function parseDeathlistText(text: string): { name: string; deaths: Death[] } {
	const nameMatch = text.match(/^Deathlist for player,\s*([^.]+)\./);
	if (!nameMatch) throw new Error("Could not parse character name from deathlist text");
	const name = nameMatch[1].trim();

	const deaths: Death[] = [];
	const lineRegex = /(\d{1,2})\w{0,2}\s+(\w+)\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+Died at Level (\d+) by (.+?)\./g;

	let match: RegExpExecArray | null;
	while ((match = lineRegex.exec(text)) !== null) {
		const [, day, monthName, year, hh, mm, ss, level, killer] = match;
		const month = MONTHS[monthName];
		if (!month) continue; // unrecognized month name, skip rather than crash the whole batch

		const paddedDay = day.padStart(2, "0");
		const isoDate = `${year}-${month}-${paddedDay}T${hh}:${mm}:${ss}Z`;

		deaths.push({ date: isoDate, level: parseInt(level, 10), killer: killer.trim() });
	}

	return { name, deaths };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}


async function upsertCharacterFromDeath(db: D1Database, name: string, level: number): Promise<number> {
	const existingCharacter = await db
		.prepare(`SELECT id FROM characters WHERE name = ?`)
		.bind(name)
		.first<{ id: number }>();
	if (existingCharacter) return existingCharacter.id;

	const now = new Date().toISOString();

	// Only sets level/vocation on first insert; never overwrites an existing row's level,
	// since online heartbeat data is the source of truth for current level, not deathlist.
	const insertResult = await db
		.prepare(
			`INSERT INTO characters (name, level, vocation, first_seen, last_seen)
			 VALUES (?, ?, 'Unknown', ?, ?)
			 ON CONFLICT(name) DO NOTHING`
		)
		.bind(name, level, now, now)
		.run();

	if (insertResult.meta.changes > 0) return insertResult.meta.last_row_id;

	// Another request created the character after the initial lookup.
	const row = await db.prepare(`SELECT id FROM characters WHERE name = ?`).bind(name).first<{ id: number }>();
	if (!row) throw new Error(`Failed to upsert character: ${name}`);
	return row.id;
}

function checkAuth(request: Request, env: WorkerEnv, url: URL): boolean {
	const header = request.headers.get("Authorization");
	if (header === `Bearer ${env.OTCLIENT_SECRET}`) return true;

	const queryKey = url.searchParams.get("key");
	return queryKey === env.OTCLIENT_SECRET;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		// --- GET endpoints ---

		if (pathname === "/api/online" && request.method === "GET") {
			const { results } = await env.DB.prepare(
				`SELECT c.name, c.level, c.vocation
				FROM online o
				JOIN characters c ON c.name = o.character_name
				ORDER BY c.level DESC`
			).all();
			return Response.json(results);
		}

		if (pathname === "/api/characters" && request.method === "GET") {
			const { results } = await env.DB.prepare(`
				SELECT c.name, c.level, c.vocation, c.last_online,
					o.character_name IS NOT NULL AS is_online
				FROM characters c
				LEFT JOIN online o ON o.character_name = c.name
				ORDER BY c.level DESC
			`).all();
			return Response.json(results);
		}

		if (pathname === "/api/top-frags" && request.method === "GET") {
			const playersOnly = url.searchParams.get("playersOnly") === "true";
			const { results } = await env.DB.prepare(`
				SELECT killer, COUNT(*) AS frags
				FROM deaths
				WHERE level >= 8
					AND (? = 0 OR (killer NOT LIKE 'a %' AND killer NOT LIKE 'an %'))
				GROUP BY killer
				ORDER BY frags DESC, killer ASC
				LIMIT 15
			`).bind(playersOnly ? 1 : 0).all<{ killer: string; frags: number }>();
			return Response.json(results);
		}

		if (pathname === "/api/power-gamers" && request.method === "GET") {
			// One shared cache key per origin, regardless of visitor query parameters.
			const cacheKey = new Request(new URL("/api/power-gamers?model=net-v1", url).toString());
			const cached = await caches.default.match(cacheKey);
			if (cached) return cached;

			const ranking = await getPowerGamers(env.DB, new Date());
			const response = Response.json(ranking, {
				headers: { "Cache-Control": "public, max-age=0, s-maxage=300" },
			});
			ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
			return response;
		}

		const charMatch = pathname.match(/^\/api\/characters\/([^/]+)$/);
		if (charMatch && request.method === "GET") {
			const name = decodeURIComponent(charMatch[1]);
			const character = await env.DB.prepare(
				`SELECT c.id, c.name, c.level, c.vocation, c.first_seen, c.last_seen, c.last_online,
					o.character_name IS NOT NULL AS is_online
				FROM characters c
				LEFT JOIN online o ON o.character_name = c.name
				WHERE c.name = ?`
			)
				.bind(name)
				.first();

			if (!character) return new Response("Not found", { status: 404 });

			const { results: deaths } = await env.DB.prepare(
				`SELECT date, level, killer, after_level, after_observed_at FROM deaths WHERE character_id = ? ORDER BY date DESC`
			)
				.bind(character.id)
				.all<Death & { after_level: number | null; after_observed_at: string | null }>();

			return Response.json({ ...character, deaths: deaths.map(death => ({ ...death,
				estimated_loss: estimateDeathLoss(death.level, death.killer, death.after_level),
			})) });
		}

		// --- POST endpoints (require secret) ---

		if (pathname === "/api/online" && request.method === "POST") {
			if (!checkAuth(request, env, url)) {
				return new Response("Unauthorized", { status: 401 });
			}

			const payload = await request.json<OnlinePayload>();
			if (!Array.isArray(payload?.players) || payload.players.some(player =>
				!player || typeof player.name !== "string" || !player.name.trim() ||
				!Number.isSafeInteger(player.level) || player.level < 1 ||
				!Number.isSafeInteger(experienceAtLevel(player.level))
			) || new Set(payload.players.map(player => player.name)).size !== payload.players.length) {
				return new Response("Players must have unique names and valid positive integer levels", { status: 400 });
			}
			const now = new Date().toISOString();

			// Get current online players and their stored levels.
			const { results: currentRows, meta: currentMeta } = await env.DB
				.prepare(`
					SELECT o.character_name, c.level, c.tracked_experience
					FROM online o
					JOIN characters c ON c.name = o.character_name
				`)
				.all<{ character_name: string; level: number; tracked_experience: number | null }>();

			const currentOnline = new Map(
				currentRows.map(row => [row.character_name, row.level])
			);
			const untracked = new Set(currentRows.filter(row => row.tracked_experience === null)
				.map(row => row.character_name));

			const newOnline = new Set(
				payload.players.map(player => player.name)
			);

			const statements: D1PreparedStatement[] = [];
			const changedNames: string[] = [];

			let added = 0;
			let removed = 0;
			let levelChanges = 0;

			// Players who went offline.
			for (const row of currentRows) {
				if (!newOnline.has(row.character_name)) {
					// Approximate logout time, accurate to the online polling interval.
					statements.push(
						env.DB
							.prepare(`UPDATE characters SET last_online = ? WHERE name = ?`)
							.bind(now, row.character_name)
					);
					statements.push(
						env.DB
							.prepare(`DELETE FROM online WHERE character_name = ?`)
							.bind(row.character_name)
					);

					removed++;
				}
			}

			// Players who are online now.
			for (const player of payload.players) {
				const previousLevel = currentOnline.get(player.name);

				if (previousLevel === undefined) {
					changedNames.push(player.name);
					// Newly online player.
					statements.push(
						env.DB.prepare(`
							INSERT INTO characters
								(name, level, vocation, first_seen, last_seen, tracked_experience, level_observed_at)
							VALUES (?, ?, 'Unknown', ?, ?, ?, ?)
							ON CONFLICT(name) DO UPDATE SET
								level = excluded.level,
								tracked_experience = excluded.tracked_experience,
								level_observed_at = excluded.level_observed_at
						`).bind(
							player.name,
							player.level,
							now,
							now,
							experienceAtLevel(player.level),
							now
						)
					);

					statements.push(
						env.DB
							.prepare(`
								INSERT INTO online (character_name, since)
								VALUES (?, ?)
							`)
							.bind(player.name, now)
					);

					added++;
				} else if (previousLevel !== player.level || untracked.has(player.name)) {
					changedNames.push(player.name);
					// Track changes (or establish the first baseline) in the existing write.
					statements.push(
						env.DB.prepare(`
							UPDATE characters
							SET level = ?, tracked_experience = ?, level_observed_at = ?
							WHERE name = ?
						`).bind(
							player.level,
							experienceAtLevel(player.level),
							now,
							player.name
						)
					);

					if (previousLevel !== player.level) levelChanges++;
				}
			}

			let rowsRead = currentMeta.rows_read;
			let rowsWritten = currentMeta.rows_written;
			if (statements.length > 0) {
				const results = await env.DB.batch(statements);
				for (const result of results) {
					rowsRead += result.meta.rows_read;
					rowsWritten += result.meta.rows_written;
				}
			}
			if (changedNames.length > 0) {
				const metrics = await reconcileDeathObservations(env.DB, changedNames, now);
				rowsRead += metrics.rowsRead;
				rowsWritten += metrics.rowsWritten;
			}

			return Response.json({
				ok: true,
				count: payload.players.length,
				added,
				removed,
				levelChanges,
				writes: statements.length,
				rowsRead,
				rowsWritten,
			});
		}

		if (pathname === "/api/deathlist" && request.method === "POST") {
			if (!checkAuth(request, env, url)) return new Response("Unauthorized", { status: 401 });

			const payload = await request.json<DeathlistPayload>();
			const { name, deaths } = parseDeathlistText(payload.text);

			if (deaths.length === 0) {
				return Response.json({ ok: true, name, inserted: 0 });
			}

			const characterId = await upsertCharacterFromDeath(env.DB, name, deaths[0].level);
			const uniqueDeaths = [...new Map(deaths.map(death => [death.date, death])).values()];
			const existingDates = new Set<string>();

			// Look up only dates contained in this payload. This uses the unique
			// (character_id, date) index and avoids issuing inserts for known deaths.
			for (const deathChunk of chunk(uniqueDeaths, DEATH_SELECT_BATCH_SIZE)) {
				const placeholders = deathChunk.map(() => "?").join(", ");
				const { results } = await env.DB
					.prepare(`SELECT date FROM deaths WHERE character_id = ? AND date IN (${placeholders})`)
					.bind(characterId, ...deathChunk.map(death => death.date))
					.all<{ date: string }>();

				for (const row of results) existingDates.add(row.date);
			}

			const newDeaths = uniqueDeaths.filter(death => !existingDates.has(death.date));

			let inserted = 0;
			for (const deathChunk of chunk(newDeaths, DEATH_INSERT_BATCH_SIZE)) {
				const values = deathChunk.map(() => "(?, ?, ?, ?)").join(", ");
				const parameters = deathChunk.flatMap(death => [characterId, death.date, death.level, death.killer]);
				const result = await env.DB
					.prepare(`INSERT OR IGNORE INTO deaths (character_id, date, level, killer) VALUES ${values}`)
					.bind(...parameters)
					.run();
				inserted += result.meta.changes;
			}

			if (newDeaths.length > 0) {
				await reconcileDeathObservations(env.DB, [name], new Date().toISOString());
			}
			return Response.json({ ok: true, name, inserted, total: deaths.length });
		}

		// --- PATCH endpoints (require secret) ---

		if (pathname === "/api/characters/vocation" && request.method === "PATCH") {
			if (!checkAuth(request, env, url)) return new Response("Unauthorized", { status: 401 });

			const payload = await request.json<{ name: string; vocation: string }>();

			if (!payload.name || !payload.vocation) {
				return new Response("Missing name or vocation", { status: 400 });
			}

			const VALID_VOCATIONS = ["Knight", "Paladin", "Sorcerer", "Druid"];
			if (!VALID_VOCATIONS.includes(payload.vocation)) {
				return new Response(`Invalid vocation. Must be one of: ${VALID_VOCATIONS.join(", ")}`, { status: 400 });
			}

			const result = await env.DB.prepare(`UPDATE characters SET vocation = ? WHERE name = ?`)
				.bind(payload.vocation, payload.name)
				.run();

			if (result.meta.changes === 0) {
				return new Response("Character not found", { status: 404 });
			}

			return Response.json({ ok: true, name: payload.name, vocation: payload.vocation });
		}

		// --- static page routes ---

		if (pathname === "/characters") {
			url.pathname = "/characters";
			return env.ASSETS.fetch(new Request(url, request));
		}

		if (pathname === "/top-frags") {
			url.pathname = "/top-frags";
			return env.ASSETS.fetch(new Request(url, request));
		}

		if (/^\/characters\/[^/]+$/.test(pathname)) {
			url.pathname = "/character";
			return env.ASSETS.fetch(new Request(url, request));
		}

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<WorkerEnv>;
