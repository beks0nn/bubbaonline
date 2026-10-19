import { experienceAtLevel } from "./experience";

export class InputError extends Error {}

export const SKILLS = ["magic", "sword", "axe", "club", "shielding", "distance"] as const;
export type Skill = typeof SKILLS[number];

const VOCATIONS: Record<string, string> = {
	k: "Knight", knight: "Knight", ek: "Elite Knight", "elite knight": "Elite Knight",
	p: "Paladin", paladin: "Paladin", rp: "Royal Paladin", "royal paladin": "Royal Paladin",
	s: "Sorcerer", sorcerer: "Sorcerer", ms: "Master Sorcerer", "master sorcerer": "Master Sorcerer",
	d: "Druid", druid: "Druid", ed: "Elder Druid", "elder druid": "Elder Druid",
	none: "None", unknown: "Unknown",
};

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Expected a JSON object");
	return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 100): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\x00-\x1f]/.test(value)) {
		throw new InputError(`${field} must be a non-empty string of at most ${max} characters`);
	}
	return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
	return value === undefined || value === null ? null : text(value, field);
}

export function vocation(value: unknown): string {
	const key = text(value, "vocation").toLowerCase();
	if (!Object.hasOwn(VOCATIONS, key)) throw new InputError("Unsupported vocation");
	return VOCATIONS[key];
}

export function skill(value: unknown): Skill {
	if (typeof value !== "string" || !SKILLS.includes(value as Skill)) {
		throw new InputError(`skill must be one of: ${SKILLS.join(", ")}`);
	}
	return value as Skill;
}

export function timestamp(value: unknown, field: string, latest = Date.now() + 60_000): string {
	if (typeof value !== "string") throw new InputError(`${field} must be an ISO timestamp with a timezone`);
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
	const time = Date.parse(value);
	if (!match || !Number.isFinite(time) || time > latest) throw new InputError(`Invalid or future ${field}`);
	const [, y, m, d, hh, mm, ss] = match.map(Number);
	if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate() || hh > 23 || mm > 59 || ss > 59) {
		throw new InputError(`Invalid ${field}`);
	}
	return new Date(time).toISOString();
}

function level(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
		!Number.isSafeInteger(experienceAtLevel(value + 1))) throw new InputError("level must be a valid positive integer");
	return value;
}

function uniqueNames(rows: { name: string }[]) {
	if (new Set(rows.map(row => row.name.toLowerCase())).size !== rows.length) throw new InputError("Duplicate character name");
}

export function parseOnline(value: unknown) {
	const payload = object(value);
	if (!Array.isArray(payload.players)) throw new InputError("players must be an array");
	const observedAt = payload.observed_at === undefined ? new Date().toISOString() : timestamp(payload.observed_at, "observed_at");
	const players = payload.players.map(value => {
		const row = object(value);
		const playerLevel = level(row.level);
		return { name: text(row.name, "name", 64), level: playerLevel, experience: experienceAtLevel(playerLevel) };
	});
	uniqueNames(players);
	return { observedAt, players };
}

export function parseProfiles(value: unknown) {
	const payload = object(value);
	const observedAt = timestamp(payload.observed_at, "observed_at");
	if (!Array.isArray(payload.characters) || payload.characters.length < 1 || payload.characters.length > 100) {
		throw new InputError("characters must contain 1–100 full profiles");
	}
	const characters = payload.characters.map(value => {
		const row = object(value);
		const observed_at = row.observed_at === undefined ? observedAt : timestamp(row.observed_at, "observed_at");
		const playerLevel = level(row.level);
		if (row.status !== "online" && row.status !== "offline") throw new InputError("status must be online or offline");
		const sex = optionalText(row.sex, "sex")?.toLowerCase() ?? null;
		if (sex !== null && sex !== "male" && sex !== "female") throw new InputError("sex must be male, female or null");
		const account_type = optionalText(row.account_type, "account_type")?.toLowerCase() ?? null;
		if (account_type !== null && account_type !== "premium" && account_type !== "free") throw new InputError("account_type must be premium, free or null");
		const guild = optionalText(row.guild, "guild");
		return { name: text(row.name, "name", 64), level: playerLevel, experience: experienceAtLevel(playerLevel),
			vocation: vocation(row.vocation), city: optionalText(row.city, "city"),
			guild: guild?.toLowerCase() === "none" ? null : guild, sex, account_type,
			last_online: row.last_online === null ? null : timestamp(row.last_online, "last_online", Date.parse(observed_at)),
			status: row.status, observed_at };
	});
	uniqueNames(characters);
	return characters;
}

export function parseHighscores(value: unknown) {
	const payload = object(value);
	const category = skill(payload.skill);
	const observedAt = timestamp(payload.observed_at, "observed_at");
	if (!Array.isArray(payload.entries) || payload.entries.length > 50) throw new InputError("entries must contain 0–50 ranked players");
	const entries = payload.entries.map(value => {
		const row = object(value);
		if (typeof row.rank !== "number" || !Number.isInteger(row.rank) || row.rank < 1 || row.rank > 50) throw new InputError("rank must be an integer from 1 to 50");
		if (typeof row.value !== "number" || !Number.isSafeInteger(row.value) || row.value < 0) throw new InputError("value must be a non-negative integer");
		return { name: text(row.name, "name", 64), rank: row.rank, value: row.value, vocation: vocation(row.vocation) };
	}).sort((a, b) => a.rank - b.rank);
	uniqueNames(entries);
	if (entries.some((entry, index) => entry.rank !== index + 1)) throw new InputError("Ranks must be unique and consecutive starting at 1");
	return { skill: category, observedAt, entries };
}
