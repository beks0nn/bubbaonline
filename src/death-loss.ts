import { experienceAtLevel } from "./experience";

export interface DeathLossEstimate {
	min: number;
	max: number;
	experience_before_min: number;
	experience_before_max: number;
	observation_used: boolean;
	pvp_possible: boolean;
}

// Stock TFS 1.2, deathLosePercent = -1, promotion, unknown 0–5 blessings.
// https://github.com/otland/forgottenserver/blob/1.2/src/player.cpp#L3612
// This returns bounds, never a claim about actual blessings or exact EXP.
export function estimateDeathLoss(level: number, killer: string, afterLevel: number | null = null): DeathLossEstimate | null {
	if (!Number.isSafeInteger(level) || level < 1) return null;
	const beforeMin = experienceAtLevel(level);
	const beforeMax = experienceAtLevel(level + 1) - 1;
	if (!Number.isSafeInteger(beforeMax)) return null;

	// Article-prefixed names are the deathlist's monster convention. For other
	// names, allow the full stock PvP unfair-fight multiplier (20–100%).
	const pvpPossible = !/^(a|an) /i.test(killer);
	const minimumMultiplier = 0.7 * 0.92 ** 5 * (pvpPossible ? 0.2 : 1);
	const maximumMultiplier = 0.7;
	const baseLoss = (progress: number) => {
		const fractionalLevel = level + progress;
		return (fractionalLevel + 50) * 0.5 * (fractionalLevel ** 2 - 5 * fractionalLevel + 8);
	};
	// TFS uses integer levelPercent (0–99), then truncates the final EXP loss.
	// Promoted characters at level 7 or below do not lose EXP in stock TFS.
	let min = level <= 7 ? 0 : Math.floor((level < 25 ? beforeMin * 0.1 : baseLoss(0)) * minimumMultiplier);
	const max = level <= 7 ? 0 : Math.floor((level < 25 ? beforeMax * 0.1 : baseLoss(0.99)) * maximumMultiplier);
	let experienceBeforeMax = beforeMax;
	let observationUsed = false;
	if (afterLevel !== null && Number.isSafeInteger(afterLevel) && afterLevel >= 1 && afterLevel < level) {
		// Hunting may resume before our next poll. The observed level supplies an
		// upper bound on immediate post-death EXP, not an exact post-death value.
		const afterMax = experienceAtLevel(afterLevel + 1) - 1;
		const constrainedMin = Math.max(min, beforeMin - afterMax);
		const constrainedBeforeMax = Math.min(beforeMax, afterMax + max);
		if (constrainedMin <= max && constrainedBeforeMax >= beforeMin) {
			min = constrainedMin;
			experienceBeforeMax = constrainedBeforeMax;
			observationUsed = true;
		}
	}
	return { min, max, experience_before_min: beforeMin, experience_before_max: experienceBeforeMax,
		observation_used: observationUsed, pvp_possible: pvpPossible };
}

interface StoredDeath {
	id: number;
	character_id: number;
	date: string;
	level: number;
	after_level: number | null;
	after_observed_at: string | null;
}

interface LevelDrop {
	character_id: number;
	from_level: number;
	to_level: number;
	previous_observed_at: string;
	observed_at: string;
}

// Correlate in either arrival order: death lists can arrive before or after the
// next online poll. Only run for changed/login characters or newly imported deaths.
export async function reconcileDeathObservations(db: D1Database, names: string[], now: string) {
	const metrics = { rowsRead: 0, rowsWritten: 0 };
	const since = new Date(Date.parse(now) - 48 * 60 * 60 * 1000).toISOString();
	const uniqueNames = [...new Set(names)];
	for (let offset = 0; offset < uniqueNames.length; offset += 99) {
		const nameChunk = uniqueNames.slice(offset, offset + 99);
		const deathsResult = await db.prepare(`
			SELECT d.id, d.character_id, d.date, d.level, d.after_level, d.after_observed_at
			FROM characters c JOIN deaths d ON d.character_id = c.id
			WHERE c.name IN (${nameChunk.map(() => "?").join(", ")}) AND d.date >= ?
		`).bind(...nameChunk, since.replace(/\.\d{3}Z$/, "Z")).all<StoredDeath>();
		metrics.rowsRead += deathsResult.meta.rows_read;
		const deaths = deathsResult.results;
		if (deaths.length === 0) continue;

		const ids = [...new Set(deaths.map(death => death.character_id))];
		const dropsResult = await db.prepare(`
			SELECT character_id, from_level, to_level, previous_observed_at, observed_at
			FROM level_drops WHERE character_id IN (${ids.map(() => "?").join(", ")})
			AND observed_at >= ? ORDER BY observed_at
		`).bind(...ids, since).all<LevelDrop>();
		metrics.rowsRead += dropsResult.meta.rows_read;
		const deathsByCharacter = new Map<number, StoredDeath[]>();
		for (const death of deaths) {
			const group = deathsByCharacter.get(death.character_id) ?? [];
			group.push(death);
			deathsByCharacter.set(death.character_id, group);
		}
		const matches = new Map<number, LevelDrop>();
		for (const drop of dropsResult.results) {
			const afterTime = Date.parse(drop.observed_at);
			const beforeTime = Math.max(Date.parse(drop.previous_observed_at), afterTime - 120_000);
			const candidates = (deathsByCharacter.get(drop.character_id) ?? []).filter(death =>
				Date.parse(death.date) > beforeTime && Date.parse(death.date) <= afterTime);
			// Several deaths between observations cannot be assigned to one loss.
			if (candidates.length === 1 && candidates[0].level === drop.from_level && !matches.has(candidates[0].id)) {
				matches.set(candidates[0].id, drop);
			}
		}
		const updates: D1PreparedStatement[] = [];
		for (const death of deaths) {
			const match = matches.get(death.id);
			const level = match?.to_level ?? null;
			const observedAt = match?.observed_at ?? null;
			if (death.after_level !== level || death.after_observed_at !== observedAt) {
				updates.push(db.prepare("UPDATE deaths SET after_level = ?, after_observed_at = ? WHERE id = ?")
					.bind(level, observedAt, death.id));
			}
		}
		if (updates.length > 0) {
			for (const result of await db.batch(updates)) {
				metrics.rowsRead += result.meta.rows_read;
				metrics.rowsWritten += result.meta.rows_written;
			}
		}
	}
	return metrics;
}
