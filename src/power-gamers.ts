import { estimateDeathLoss } from "./death-loss";

interface CharacterRow {
	name: string;
	level: number;
	vocation: string;
}

interface GainRow extends CharacterRow {
	experience_gained: number;
	levels_gained: number;
}

interface DeathRow extends CharacterRow {
	death_level: number;
	killer: string;
	after_level: number | null;
}

interface PowerGamer extends GainRow {
	experience_lost: number;
	experience_lost_min: number;
	experience_lost_max: number;
	deaths: number;
	net_experience: number;
	net_experience_min: number;
	net_experience_max: number;
}

export async function getPowerGamers(db: D1Database, now: Date) {
	const until = now.toISOString();
	const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
	const [gains, deaths] = await Promise.all([
		db.prepare(`
			WITH gains AS (
				SELECT character_name, SUM(experience_delta) AS experience_gained,
					SUM(level_delta) AS levels_gained
				FROM level_changes
				WHERE observed_at > ? AND observed_at <= ? AND experience_delta > 0
				GROUP BY character_name
			)
			SELECT c.name, c.level, c.vocation, g.experience_gained, g.levels_gained
			FROM gains g JOIN characters c ON c.name = g.character_name
		`).bind(since, until).all<GainRow>(),
		db.prepare(`
			SELECT c.name, c.level, c.vocation, d.level AS death_level, d.killer, d.after_level
			FROM deaths d JOIN characters c ON c.id = d.character_id
			WHERE d.date > ? AND d.date <= ?
		`).bind(since.replace(/\.\d{3}Z$/, "Z"), until.replace(/\.\d{3}Z$/, "Z")).all<DeathRow>(),
	]);

	const players = new Map<string, PowerGamer>();
	function getPlayer(character: CharacterRow): PowerGamer {
		let player = players.get(character.name);
		if (!player) {
			player = { name: character.name, level: character.level, vocation: character.vocation,
				experience_gained: 0, levels_gained: 0, experience_lost: 0,
				experience_lost_min: 0, experience_lost_max: 0, deaths: 0,
				net_experience: 0, net_experience_min: 0, net_experience_max: 0 };
			players.set(character.name, player);
		}
		return player;
	}
	for (const gain of gains.results) {
		const player = getPlayer(gain);
		player.experience_gained = gain.experience_gained;
		player.levels_gained = gain.levels_gained;
	}
	for (const death of deaths.results) {
		const loss = estimateDeathLoss(death.death_level, death.killer, death.after_level);
		if (!loss) continue;
		const player = getPlayer(death);
		player.deaths++;
		// A transparent ranking convention, not a claim about likely blessings.
		player.experience_lost += Math.round((loss.min + loss.max) / 2);
		player.experience_lost_min += loss.min;
		player.experience_lost_max += loss.max;
	}
	for (const player of players.values()) {
		player.net_experience = player.experience_gained - player.experience_lost;
		player.net_experience_min = player.experience_gained - player.experience_lost_max;
		player.net_experience_max = player.experience_gained - player.experience_lost_min;
	}
	// Include death-only players and negative totals. Apply the limit after losses,
	// since a gross-gain leader may fall out of the top 10 after their deaths.
	const ranked = [...players.values()].sort((a, b) => b.net_experience - a.net_experience ||
		(a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return { since, until, players: ranked.slice(0, 10) };
}
