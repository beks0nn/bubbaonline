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

const MONTHS: Record<string, string> = {
	January: "01", February: "02", March: "03", April: "04",
	May: "05", June: "06", July: "07", August: "08",
	September: "09", October: "10", November: "11", December: "12",
};

function parseDeathlistText(text: string): { name: string; deaths: { date: string; level: number; killer: string }[] } {
	const nameMatch = text.match(/^Deathlist for player,\s*([^.]+)\./);
	if (!nameMatch) throw new Error("Could not parse character name from deathlist text");
	const name = nameMatch[1].trim();

	const deaths: { date: string; level: number; killer: string }[] = [];
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

async function upsertOnlineCharacter(db: D1Database, name: string, level: number): Promise<number> {
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO characters (name, level, vocation, first_seen, last_seen)
			 VALUES (?, ?, 'Unknown', ?, ?)
			 ON CONFLICT(name) DO UPDATE SET
			   level = excluded.level,
			   last_seen = excluded.last_seen`
		)
		.bind(name, level, now, now)
		.run();

	const row = await db.prepare(`SELECT id FROM characters WHERE name = ?`).bind(name).first<{ id: number }>();
	if (!row) throw new Error(`Failed to upsert character: ${name}`);
	return row.id;
}

async function upsertCharacterFromDeath(db: D1Database, name: string, level: number): Promise<number> {
	const now = new Date().toISOString();

	// Only sets level/vocation on first insert; never overwrites an existing row's level,
	// since online heartbeat data is the source of truth for current level, not deathlist.
	await db
		.prepare(
			`INSERT INTO characters (name, level, vocation, first_seen, last_seen)
			 VALUES (?, ?, 'Unknown', ?, ?)
			 ON CONFLICT(name) DO NOTHING`
		)
		.bind(name, level, now, now)
		.run();

	const row = await db.prepare(`SELECT id FROM characters WHERE name = ?`).bind(name).first<{ id: number }>();
	if (!row) throw new Error(`Failed to upsert character: ${name}`);
	return row.id;
}

function checkAuth(request: Request, env: Env): boolean {
	const header = request.headers.get("Authorization");
	return header === `Bearer ${env.OTCLIENT_SECRET}`;
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
				 JOIN characters c ON c.id = o.character_id
				 ORDER BY c.level DESC`
			).all();
			return Response.json(results);
		}

		if (pathname === "/api/characters" && request.method === "GET") {
			const { results } = await env.DB.prepare(`SELECT name, level, vocation FROM characters ORDER BY level DESC`).all();
			return Response.json(results);
		}

		const charMatch = pathname.match(/^\/api\/characters\/([^/]+)$/);
		if (charMatch && request.method === "GET") {
			const name = decodeURIComponent(charMatch[1]);
			const character = await env.DB.prepare(
				`SELECT id, name, level, vocation, first_seen, last_seen FROM characters WHERE name = ?`
			)
				.bind(name)
				.first();

			if (!character) return new Response("Not found", { status: 404 });

			const { results: deaths } = await env.DB.prepare(
				`SELECT date, level, killer FROM deaths WHERE character_id = ? ORDER BY date DESC`
			)
				.bind(character.id)
				.all();

			return Response.json({ ...character, deaths });
		}

		// --- POST endpoints (require secret) ---

		if (pathname === "/api/online" && request.method === "POST") {
			if (!checkAuth(request, env)) return new Response("Unauthorized", { status: 401 });

			const payload = await request.json<OnlinePayload>();

			await env.DB.prepare(`DELETE FROM online`).run();

			for (const player of payload.players) {
				const characterId = await upsertOnlineCharacter(env.DB, player.name, player.level);
				await env.DB.prepare(`INSERT INTO online (character_id, since) VALUES (?, ?)`)
					.bind(characterId, new Date().toISOString())
					.run();
			}

			return Response.json({ ok: true, count: payload.players.length });
		}

		if (pathname === "/api/deathlist" && request.method === "POST") {
			if (!checkAuth(request, env)) return new Response("Unauthorized", { status: 401 });

			const payload = await request.json<DeathlistPayload>();
			const { name, deaths } = parseDeathlistText(payload.text);

			if (deaths.length === 0) {
				return Response.json({ ok: true, name, inserted: 0 });
			}

			const characterId = await upsertCharacterFromDeath(env.DB, name, deaths[0].level);

			let inserted = 0;
			for (const death of deaths) {
				const result = await env.DB.prepare(
					`INSERT OR IGNORE INTO deaths (character_id, date, level, killer) VALUES (?, ?, ?, ?)`
				)
					.bind(characterId, death.date, death.level, death.killer)
					.run();
				if (result.meta.changes > 0) inserted++;
			}

			return Response.json({ ok: true, name, inserted, total: deaths.length });
		}

		// --- PATCH endpoints (require secret) ---

		if (pathname === "/api/characters/vocation" && request.method === "PATCH") {
			if (!checkAuth(request, env)) return new Response("Unauthorized", { status: 401 });

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

		if (/^\/characters\/[^/]+$/.test(pathname)) {
			url.pathname = "/character";
			return env.ASSETS.fetch(new Request(url, request));
		}

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;