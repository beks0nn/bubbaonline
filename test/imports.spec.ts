import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { SKILLS } from "../src/import-validation";

const secret = "test-import-secret";
const at = (minute: number) => `2026-10-14T20:${String(minute).padStart(2, "0")}:00.000Z`;
const profile = (extra: Record<string, unknown> = {}) => ({ name: "bksonn", level: 179, vocation: "EK",
	city: "Carlin", guild: "None", sex: "male", account_type: "premium", last_online: at(0), status: "online", ...extra });
const entry = (name = "addinator", rank = 1, value = 84, vocation = "MS") => ({ name, rank, value, vocation });

async function send(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", auth = true) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`https://example.com${path}`, { method,
		headers: { ...(auth ? { Authorization: `Bearer ${secret}` } : {}), "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	}), { ...env, OTCLIENT_SECRET: secret }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function json(path: string, body?: unknown): Promise<any> {
	const response = await send(path, body);
	expect(response.status, await response.clone().text()).toBe(200);
	return response.json();
}
const profiles = (minute: number, characters = [profile()]) => json("/api/characters", { observed_at: at(minute), characters });
const online = (minute: number, players: { name: string; level: number }[] = []) => json("/api/online", { observed_at: at(minute), players });
const highscores = (minute: number, entries = [entry()], skill = "magic") => json("/api/highscores", { observed_at: at(minute), skill, entries });
const character = (name = "bksonn") => json(`/api/characters/${encodeURIComponent(name)}`);

beforeAll(async () => {
	await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
});
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(at(59)));
	for (const skill of SKILLS) await caches.default.delete(`https://example.com/api/highscores?skill=${skill}`);
	await env.DB.batch(["highscore_entries", "ingestion_state", "level_drops", "level_changes", "deaths", "online", "characters"]
		.map(table => env.DB.prepare(`DELETE FROM ${table}`)));
});
afterEach(() => vi.useRealTimers());

describe("character imports", () => {
	it("imports full profiles, normalizes vocations and enriches list/detail responses", async () => {
		expect(await profiles(10)).toMatchObject({ updated: 1 });
		expect(await character()).toMatchObject({ name: "bksonn", level: 179, vocation: "Elite Knight", city: "Carlin",
			guild: null, sex: "male", account_type: "premium", last_online: at(0), is_online: 1, profile_observed_at: at(10), skills: [] });
		expect((await json("/api/characters"))[0]).toMatchObject({ city: "Carlin", vocation: "Elite Knight" });
		expect(await profiles(11, [profile({ vocation: "Royal Paladin", guild: "Hunters", status: "offline" })])).toMatchObject({ updated: 1 });
		expect(await character()).toMatchObject({ vocation: "Royal Paladin", guild: "Hunters", is_online: 0 });
	});

	it("ignores retries and older profiles without writes", async () => {
		await profiles(10);
		expect(await profiles(10)).toMatchObject({ updated: 0, rowsWritten: 0 });
		expect(await profiles(9, [profile({ level: 100, vocation: "D", status: "offline" })])).toMatchObject({ updated: 0, rowsWritten: 0 });
		expect(await character()).toMatchObject({ level: 179, vocation: "Elite Knight", is_online: 1 });
	});

	it("retains known last online when null is imported and never moves it backwards", async () => {
		await profiles(10, [profile({ last_online: null })]);
		expect(await character()).toMatchObject({ last_online: null });
		await profiles(11);
		await online(12);
		expect(await character()).toMatchObject({ last_online: at(12), is_online: 0 });
		await profiles(13, [profile({ last_online: at(0), status: "offline" })]);
		await profiles(14, [profile({ last_online: null, status: "offline" })]);
		expect(await character()).toMatchObject({ last_online: at(12) });
	});

	it("does not let delayed profiles undo a newer online snapshot or duplicate EXP", async () => {
		await online(10, [{ name: "bksonn", level: 179 }]);
		await online(12, [{ name: "bksonn", level: 180 }]);
		await profiles(11, [profile({ status: "offline" })]);
		expect(await character()).toMatchObject({ level: 180, is_online: 1, city: "Carlin" });
		await profiles(13, [profile({ level: 181 })]);
		await online(14, [{ name: "bksonn", level: 181 }]);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM level_changes").first("n")).toBe(2);
		expect(await env.DB.prepare("SELECT SUM(level_delta) AS n FROM level_changes").first("n")).toBe(2);
	});

	it("keeps newer individual activity through an older full snapshot, including equal timestamps", async () => {
		await profiles(12);
		await online(11);
		await online(12, [{ name: "bksonn", level: 170 }]);
		expect(await character()).toMatchObject({ level: 179, is_online: 1 });
		await online(13);
		expect(await character()).toMatchObject({ is_online: 0 });
		expect(await online(12, [{ name: "bksonn", level: 190 }])).toMatchObject({ ignored: true, rowsWritten: 0 });
	});

	it("only changes status for the named characters and supports per-profile capture times", async () => {
		await online(10, [{ name: "Other", level: 20 }]);
		await profiles(12, [profile({ observed_at: at(11) })]);
		expect(await character("Other")).toMatchObject({ is_online: 1 });
		expect(await character()).toMatchObject({ profile_observed_at: at(11), is_online: 1 });
		await profiles(13, [profile({ status: "offline" })]);
		expect(await character("Other")).toMatchObject({ is_online: 1 });
	});

	it("uses capture time for gains and counts recovery after a profile-reported loss", async () => {
		await profiles(10);
		await profiles(11, [profile({ level: 178 })]);
		await profiles(12);
		const gains = await env.DB.prepare("SELECT observed_at, level_delta FROM level_changes").all();
		expect(gains.results).toEqual([{ observed_at: at(12), level_delta: 1 }]);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM level_drops").first("n")).toBe(1);
	});

	it("handles 100 profiles with one batch rather than per-character queries", async () => {
		const characters = Array.from({ length: 100 }, (_, i) => profile({ name: `Player${i}` }));
		expect(await profiles(10, characters)).toMatchObject({ updated: 100 });
		expect(await profiles(10, characters)).toMatchObject({ updated: 0, rowsWritten: 0 });
		expect(await online(11, characters)).toMatchObject({ rowsWritten: 2 }); // first feed row plus its primary-key index
		expect(await online(12, characters)).toMatchObject({ rowsWritten: 1 });
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM online").first("n")).toBe(100);
	});

	it("does not scan offline character history on every online poll", async () => {
		const players = [{ name: "Online", level: 100 }];
		await online(10, players);
		const baseline = await online(11, players);
		await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
			INSERT INTO characters (name, level, first_seen, last_seen)
			SELECT 'Offline' || i, 20, ?1, ?1 FROM n`).bind(at(0)).run();
		const next = await online(12, players);
		expect(next.rowsWritten).toBe(1);
		expect(next.rowsRead).toBe(baseline.rowsRead);
	});
});

describe("highscores", () => {
	it("keeps skill values separate from level and establishes a baseline on first real observation", async () => {
		await highscores(10);
		expect(await character("addinator")).toMatchObject({ level: null, vocation: "Master Sorcerer", last_online: null,
			skills: [{ skill: "magic", rank: 1, value: 84, observed_at: at(10) }] });
		await online(11, [{ name: "addinator", level: 200 }]);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM level_changes").first("n")).toBe(0);
		await highscores(12, [entry("addinator", 1, 85)]);
		expect(await character("addinator")).toMatchObject({ level: 200 });
	});

	it("replaces a full snapshot, preserves other skills, and does not reset missing players to zero", async () => {
		await highscores(10, [entry("A"), entry("B", 2, 80)]);
		await highscores(10, [entry("A", 1, 100, "EK")], "sword");
		await highscores(11, [entry("B", 1, 85), entry("A", 2, 84)]);
		expect((await json("/api/highscores?skill=magic")).entries.map((e: any) => e.name)).toEqual(["B", "A"]);
		await highscores(12, [entry("B")]);
		expect(await character("A")).toMatchObject({ skills: [{ skill: "sword", value: 100 }] });
		await highscores(13, []);
		expect(await json("/api/highscores?skill=magic")).toEqual({ skill: "magic", observed_at: at(13), entries: [] });
	});

	it("retries and stale snapshots write nothing; unchanged newer snapshots write one timestamp", async () => {
		const entries = Array.from({ length: 50 }, (_, i) => entry(`Player${i}`, i + 1, 100 - i));
		await highscores(10, entries);
		expect(await highscores(10, entries)).toMatchObject({ ignored: true, rowsWritten: 0 });
		expect(await highscores(9, [])).toMatchObject({ ignored: true, rowsWritten: 0 });
		expect(await highscores(11, entries)).toMatchObject({ ignored: false, rowsWritten: 1 });
		expect((await json("/api/highscores?skill=magic")).entries).toHaveLength(50);
	});

	it("protects profile vocations and rejects older vocation updates from another skill", async () => {
		await highscores(10, [entry("bksonn", 1, 80, "K")]);
		await highscores(12, [entry("bksonn", 1, 81, "EK")]);
		await highscores(11, [entry("bksonn", 1, 90, "K")], "sword");
		expect(await character()).toMatchObject({ vocation: "Elite Knight" });
		await profiles(13, [profile({ vocation: "RP" })]);
		await highscores(14, [entry("bksonn", 1, 82, "K")]);
		expect(await character()).toMatchObject({ vocation: "Royal Paladin" });
	});

	it("serves a canonical cached response without D1 and refreshes the local cache after imports", async () => {
		await highscores(10);
		const first = await json("/api/highscores?skill=magic");
		const ctx = createExecutionContext();
		const cached = await worker.fetch(new Request("https://example.com/api/highscores?visitor=2&skill=magic"), {
			...env, OTCLIENT_SECRET: secret, DB: { batch: () => { throw new Error("Must use cache"); } } as unknown as D1Database,
		}, ctx);
		await waitOnExecutionContext(ctx);
		expect(await cached.json()).toEqual(first);
		await highscores(11, [entry("addinator", 1, 85)]);
		expect((await json("/api/highscores?skill=magic")).entries[0].value).toBe(85);
	});
});

describe("API validation and removal", () => {
	it("requires authentication for both new imports and removes the old PATCH route", async () => {
		for (const path of ["/api/characters", "/api/highscores"]) {
			expect((await send(path, {}, "POST", false)).status).toBe(401);
		}
		expect((await send("/api/characters/vocation", { name: "bksonn", vocation: "Knight" }, "PATCH")).status).toBe(404);
	});

	it.each([
		{ level: 0 }, { vocation: "invalid" }, { status: "maybe" }, { account_type: "vip" },
		{ last_online: "2026-02-30T20:00:00Z" }, { last_online: "2026-10-14T20:00:00" },
		{ observed_at: "2026-10-15T20:00:00Z" }, { last_online: at(11) },
	])("rejects invalid profiles atomically: %j", async extra => {
		const result = await send("/api/characters", { observed_at: at(10), characters: [profile(), profile({ name: "Invalid", ...extra })] });
		expect(result.status).toBe(400);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM characters").first("n")).toBe(0);
	});

	it("rejects invalid categories, duplicate names and gaps in ranks", async () => {
		for (const body of [
			{ skill: "fishing", entries: [] }, { skill: "magic", entries: [entry("A", 2)] },
			{ skill: "magic", entries: [entry("A"), entry("a", 2)] },
			{ skill: "magic", entries: [entry("A"), entry("B", 1)] },
		]) expect((await send("/api/highscores", { observed_at: at(10), ...body })).status).toBe(400);
		expect((await send("/api/highscores?skill=bad")).status).toBe(400);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ingestion_state").first("n")).toBe(0);
	});
});
