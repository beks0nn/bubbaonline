import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { experienceAtLevel } from "../src/experience";
import { estimateDeathLoss } from "../src/death-loss";

interface Character {
    name: string;
    is_online: number;
    last_online: string | null;
}

const secret = "test-online-secret";
let migratedCharacter: { last_online: string | null; last_seen: string } | null;
let migratedProgress: { tracked_experience: number; level_observed_at: string } | null;

async function request(path: string, body?: unknown) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://example.com${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    }), { ...env, OTCLIENT_SECRET: secret }, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    return response;
}

async function character(name = "Legacy") {
    return (await request(`/api/characters/${name}`)).json<Character>();
}

beforeAll(async () => {
    const { TEST_MIGRATIONS: migrations } = env as unknown as {
        TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
    };
    await applyD1Migrations(env.DB, migrations.slice(0, 2));
    await env.DB.prepare(`INSERT INTO characters (name, level, first_seen, last_seen)
        VALUES ('Historical', 20, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`).run();
    await applyD1Migrations(env.DB, migrations.slice(0, 4));
    await env.DB.prepare(`INSERT INTO character_progress (character_name, level, experience, observed_at)
        VALUES ('Historical', 20, 98800, '2026-10-01T09:00:00.000Z')`).run();
    await applyD1Migrations(env.DB, migrations);
    migratedProgress = await env.DB.prepare(
        `SELECT tracked_experience, level_observed_at FROM characters WHERE name = 'Historical'`
    ).first();
    migratedCharacter = await env.DB.prepare(
        `SELECT last_online, last_seen FROM characters WHERE name = 'Historical'`
    ).first();
});

beforeEach(async () => {
    await caches.default.delete("https://example.com/api/power-gamers?model=net-v1");
    await env.DB.batch([
        env.DB.prepare("DELETE FROM level_drops"),
        env.DB.prepare("DELETE FROM level_changes"),
        env.DB.prepare("DELETE FROM online"),
        env.DB.prepare("DELETE FROM deaths"),
        env.DB.prepare("DELETE FROM characters"),
        env.DB.prepare(`INSERT INTO characters (name, level, first_seen, last_seen)
            VALUES ('Legacy', 20, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`),
    ]);
});

afterEach(() => vi.useRealTimers());

describe("last online", () => {
    it("leaves historical and death-only characters unknown", async () => {
        expect(migratedCharacter).toEqual({ last_online: null, last_seen: "2025-01-01T00:00:00Z" });
        expect(await character()).toMatchObject({ is_online: 0, last_online: null });
        await request("/api/deathlist", {
            text: "Deathlist for player, Deathonly. 1st September 2026 12:00:00 Died at Level 20 by a dragon.",
        });
        expect(await character("Deathonly")).toMatchObject({ is_online: 0, last_online: null });
    });

    it("tracks logout and reconnects without writing on unchanged heartbeats", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
        const players = [{ name: "Legacy", level: 20 }, { name: "Newcomer", level: 15 }];
        await request("/api/online", { players });
        expect(await character()).toMatchObject({ is_online: 1, last_online: null });
        expect(await character("Newcomer")).toMatchObject({ is_online: 1, last_online: null });
        expect(await (await request("/api/online", { players })).json()).toMatchObject({ writes: 0 });

        vi.setSystemTime(new Date("2026-10-01T11:00:00Z"));
        await request("/api/online", { players: [] });
        const offline = { is_online: 0, last_online: "2026-10-01T11:00:00.000Z" };
        expect(await character()).toMatchObject(offline);
        expect(await character("Newcomer")).toMatchObject(offline);
        const list = await (await request("/api/characters")).json<Character[]>();
        expect(list).toHaveLength(2);
        for (const row of list) expect(row).toMatchObject(offline);

        vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
        await request("/api/online", { players });
        expect(await character()).toMatchObject({ ...offline, is_online: 1 });
        vi.setSystemTime(new Date("2026-10-01T13:00:00Z"));
        await request("/api/online", { players: [] });
        expect(await character()).toMatchObject({ is_online: 0, last_online: "2026-10-01T13:00:00.000Z" });
    });

    it("records logout for a session that started before deployment", async () => {
        await env.DB.prepare(`INSERT INTO online (character_name, since)
            VALUES ('Legacy', '2026-09-30T10:00:00Z')`).run();
        expect(await character()).toMatchObject({ is_online: 1, last_online: null });
        await request("/api/online", { players: [] });
        const result = await character();
        expect(result.is_online).toBe(0);
        expect(result.last_online).not.toBeNull();
        expect(Number.isNaN(Date.parse(result.last_online!))).toBe(false);
    });
});

interface PowerGamer {
    name: string;
    level: number;
    experience_gained: number;
    levels_gained: number;
    experience_lost: number;
    experience_lost_min: number;
    experience_lost_max: number;
    net_experience: number;
    net_experience_min: number;
    net_experience_max: number;
    deaths: number;
}

async function rankings() {
    // Most tests exercise fresh aggregation; cache behaviour is tested separately.
    await caches.default.delete("https://example.com/api/power-gamers?model=net-v1");
    return (await request("/api/power-gamers")).json<{
        since: string; until: string; players: PowerGamer[];
    }>();
}

async function observe(players: { name: string; level: number }[], time: string) {
    vi.setSystemTime(new Date(time));
    return (await request("/api/online", { players })).json<{ writes: number; rowsRead: number; rowsWritten: number }>();
}

describe("Power Gamers", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));

    it("preserves existing baselines when moving them onto character rows", () => {
        expect(migratedProgress).toEqual({ tracked_experience: 98800, level_observed_at: "2026-10-01T09:00:00.000Z" });
    });

    it("returns only the top 10, resolving equal gains by name", async () => {
        const players = Array.from({ length: 12 }, (_, index) => ({
            name: `Player${String(index).padStart(2, "0")}`, level: 20,
        }));
        await observe(players, "2026-10-01T09:00:00Z");
        await observe(players.map(player => ({ ...player, level: 21 })), "2026-10-01T10:00:00Z");
        expect((await rankings()).players.map(player => player.name)).toEqual(players.slice(0, 10).map(player => player.name));
    });

    it("uses cached rankings without accessing D1, including across query strings", async () => {
        await observe([{ name: "Legacy", level: 20 }], "2026-10-01T09:00:00Z");
        await observe([{ name: "Legacy", level: 21 }], "2026-10-01T10:00:00Z");
        const fresh = await request("/api/power-gamers");
        expect(fresh.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=300");
        const original = await fresh.json();
        await observe([{ name: "Legacy", level: 22 }], "2026-10-01T10:01:00Z");

        const ctx = createExecutionContext();
        const prepare = vi.fn(() => { throw new Error("Cache hit must not query D1"); });
        const cached = await worker.fetch(new Request("https://example.com/api/power-gamers?visitor=2"), {
            ...env, OTCLIENT_SECRET: secret, DB: { prepare } as unknown as D1Database,
        }, ctx);
        await waitOnExecutionContext(ctx);
        expect(await cached.json()).toEqual(original);
        expect(prepare).not.toHaveBeenCalled();
        // Eviction is safe: the next miss recomputes the latest ranking.
        expect((await rankings()).players[0].levels_gained).toBe(2);
    });

    it("adds no reads or writes to unchanged online polls", async () => {
        const players = [{ name: "Legacy", level: 20 }];
        await observe(players, "2026-10-01T09:00:00Z");
        const original = await env.DB.prepare(`SELECT o.character_name, c.level
            FROM online o JOIN characters c ON c.name = o.character_name`).all();
        expect(await observe(players, "2026-10-01T09:01:00Z")).toEqual(expect.objectContaining({
            writes: 0, rowsWritten: 0, rowsRead: original.meta.rows_read,
        }));
    });

    it("prunes old gain history in bounded batches while keeping the ranking window", async () => {
        await observe([{ name: "Legacy", level: 20 }], "2026-10-01T09:00:00Z");
        const insert = env.DB.prepare(`INSERT INTO level_changes
            (character_name, observed_at, level_delta, experience_delta) VALUES ('Legacy', ?, 1, 100)`);
        await env.DB.batch(Array.from({ length: 101 }, () => insert.bind("2026-09-28T09:00:00.000Z")));
        await insert.bind("2026-09-30T12:00:00.000Z").run();
        await observe([{ name: "Legacy", level: 21 }], "2026-10-01T10:00:00Z");
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM level_changes").first("count")).toBe(3);
        expect((await rankings()).players[0].experience_gained).toBe(17300);
        await observe([{ name: "Legacy", level: 22 }], "2026-10-01T11:00:00Z");
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM level_changes").first("count")).toBe(3);
        expect((await rankings()).players[0].experience_gained).toBe(36400);
    });

    it("serves the tab and its script", async () => {
        const page = await request("/power-gamers");
        expect(await page.text()).toContain('id="power-list"');
        const script = await request("/power-gamers.js");
        expect(await script.text()).toContain('fetch("/api/power-gamers"');
    });

    it("starts fresh baselines for existing online, new, and death-only characters", async () => {
        await env.DB.prepare(`INSERT INTO online (character_name, since)
            VALUES ('Legacy', '2025-01-01T00:00:00Z')`).run();
        await request("/api/deathlist", {
            text: "Deathlist for player, Deathonly. 1st September 2026 12:00:00 Died at Level 50 by a dragon.",
        });
        const players = [{ name: "Legacy", level: 30 }, { name: "New", level: 100 },
            { name: "Deathonly", level: 80 }];
        await observe(players, "2026-10-01T10:00:00Z");
        expect((await rankings()).players).toEqual([]);
        expect(await observe(players, "2026-10-01T10:01:00Z")).toMatchObject({ writes: 0 });
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM level_changes").first("count")).toBe(0);
        await observe(players.map(player => ({ ...player, level: player.level + 1 })), "2026-10-01T10:02:00Z");
        expect((await rankings()).players).toHaveLength(3);
    });

    it("counts regained levels after losses without subtracting earned EXP", async () => {
        const start = [{ name: "High", level: 100 }, { name: "Low", level: 20 },
            { name: "Recovery", level: 50 }];
        await observe(start, "2026-10-01T10:00:00Z");
        await observe([{ name: "High", level: 102 }, { name: "Low", level: 25 },
            { name: "Recovery", level: 49 }], "2026-10-01T11:00:00Z");
        await observe([{ name: "High", level: 101 }, { name: "Low", level: 25 },
            { name: "Recovery", level: 50 }], "2026-10-01T12:00:00Z");
        expect((await rankings()).players).toEqual([
            expect.objectContaining({ name: "High", level: 101, levels_gained: 2, experience_gained: 980300 }),
            expect.objectContaining({ name: "Recovery", level: 50, levels_gained: 1, experience_gained: 112900 }),
            expect.objectContaining({ name: "Low", level: 25, levels_gained: 5, experience_gained: 106000 }),
        ]);
        // Unchanged observations must not award the same gain twice.
        expect(await observe([{ name: "High", level: 101 }, { name: "Low", level: 25 },
            { name: "Recovery", level: 50 }], "2026-10-01T12:01:00Z")).toMatchObject({ writes: 0 });
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM level_changes").first("count")).toBe(3);
    });

    it("uses a rolling 24-hour window, expiring gains at the boundary", async () => {
        await observe([{ name: "Legacy", level: 20 }], "2026-10-01T09:00:00Z");
        await observe([{ name: "Legacy", level: 21 }], "2026-10-01T10:00:00Z");
        await observe([{ name: "Legacy", level: 22 }], "2026-10-01T11:00:00Z");
        vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
        expect(await rankings()).toMatchObject({
            since: "2026-10-01T10:00:00.000Z",
            until: "2026-10-02T10:00:00.000Z",
            players: [expect.objectContaining({ name: "Legacy", levels_gained: 1, experience_gained: 19100 })],
        });
        vi.setSystemTime(new Date("2026-10-02T11:00:00Z"));
        expect((await rankings()).players).toEqual([]);
    });

    it("preserves baselines across reconnects and ignores death imports", async () => {
        await observe([{ name: "Legacy", level: 20 }], "2026-10-01T09:00:00Z");
        await observe([], "2026-10-01T10:00:00Z");
        await request("/api/deathlist", {
            text: "Deathlist for player, Legacy. 1st September 2026 12:00:00 Died at Level 100 by a dragon.",
        });
        expect((await rankings()).players).toEqual([]);
        await observe([{ name: "Legacy", level: 22 }], "2026-10-01T11:00:00Z");
        expect((await rankings()).players).toEqual([
            expect.objectContaining({ name: "Legacy", experience_gained: experienceAtLevel(22) - experienceAtLevel(20) }),
        ]);
        await observe([], "2026-10-01T12:00:00Z");
        await observe([{ name: "Legacy", level: 22 }], "2026-10-01T13:00:00Z");
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM level_changes").first("count")).toBe(1);
        await observe([], "2026-10-01T14:00:00Z");
        await observe([{ name: "Legacy", level: 20 }], "2026-10-01T15:00:00Z");
        expect((await rankings()).players).toEqual([
            expect.objectContaining({ name: "Legacy", experience_gained: experienceAtLevel(22) - experienceAtLevel(20) }),
        ]);
    });
});

interface EstimatedDeath {
    date: string;
    after_level: number | null;
    after_observed_at: string | null;
    estimated_loss: { min: number; max: number; observation_used: boolean };
}

async function recordedDeaths() {
    return (await (await request("/api/characters/Legacy")).json<{ deaths: EstimatedDeath[] }>()).deaths;
}

function deathText(time = "10:00:30", level = 100) {
    return `Deathlist for player, Legacy. 1st October 2026 ${time} Died at Level ${level} by a dragon.`;
}

describe("death observation correlation", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));

    it("matches delayed death imports even after the player recovers levels", async () => {
        await observe([{ name: "Legacy", level: 100 }], "2026-10-01T10:00:00Z");
        await observe([{ name: "Legacy", level: 98 }], "2026-10-01T10:01:00Z");
        await observe([{ name: "Legacy", level: 100 }], "2026-10-01T10:02:00Z");
        const gainsBefore = (await rankings()).players;
        vi.setSystemTime(new Date("2026-10-01T10:05:00Z"));
        await request("/api/deathlist", { text: deathText() });
        expect((await recordedDeaths())[0]).toMatchObject({ after_level: 98,
            after_observed_at: "2026-10-01T10:01:00.000Z", estimated_loss: { min: 475401, observation_used: true } });
        const rankedAfter = (await rankings()).players[0];
        expect(rankedAfter.experience_gained).toBe(gainsBefore[0].experience_gained);
        expect(rankedAfter.experience_lost).toBeGreaterThan(0);
        expect(rankedAfter.net_experience).toBe(rankedAfter.experience_gained - rankedAfter.experience_lost);
        expect(await (await request("/api/deathlist", { text: deathText() })).json()).toMatchObject({ inserted: 0 });
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM level_drops").first("count")).toBe(1);
    });

    it("matches when the death import arrives before the lower online level", async () => {
        await observe([{ name: "Legacy", level: 100 }], "2026-10-01T10:00:00Z");
        vi.setSystemTime(new Date("2026-10-01T10:00:45Z"));
        await request("/api/deathlist", { text: deathText() });
        expect((await recordedDeaths())[0].after_level).toBeNull();
        await observe([{ name: "Legacy", level: 98 }], "2026-10-01T10:01:00Z");
        expect((await recordedDeaths())[0]).toMatchObject({ after_level: 98, estimated_loss: { observation_used: true } });
    });

    it("matches a drop first observed on reconnect", async () => {
        await observe([{ name: "Legacy", level: 100 }], "2026-10-01T10:00:00Z");
        await observe([], "2026-10-01T10:00:40Z");
        await request("/api/deathlist", { text: deathText() });
        await observe([{ name: "Legacy", level: 98 }], "2026-10-01T10:01:00Z");
        expect((await recordedDeaths())[0].after_level).toBe(98);
    });

    it("invalidates an ambiguous match when a second nearby death arrives", async () => {
        await observe([{ name: "Legacy", level: 100 }], "2026-10-01T10:00:00Z");
        await observe([{ name: "Legacy", level: 98 }], "2026-10-01T10:01:00Z");
        await request("/api/deathlist", { text: deathText("10:00:20") });
        expect((await recordedDeaths())[0].after_level).toBe(98);
        await request("/api/deathlist", { text: deathText("10:00:40", 99) });
        for (const death of await recordedDeaths()) {
            expect(death.after_level).toBeNull();
            expect(death.estimated_loss.observation_used).toBe(false);
        }
    });

    it("does not use distant observations or an untracked starting level", async () => {
        await observe([{ name: "Legacy", level: 100 }], "2026-10-01T10:00:00Z");
        await observe([{ name: "Legacy", level: 98 }], "2026-10-01T10:05:00Z");
        await request("/api/deathlist", { text: deathText() });
        expect((await recordedDeaths())[0].after_level).toBeNull();
        expect((await recordedDeaths())[0].estimated_loss.observation_used).toBe(false);
    });

    it("does not infer drops from death-only history", async () => {
        vi.setSystemTime(new Date("2026-10-01T10:00:45Z"));
        await request("/api/deathlist", { text: deathText() });
        await observe([{ name: "Legacy", level: 98 }], "2026-10-01T10:01:00Z");
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM level_drops").first("count")).toBe(0);
        expect((await recordedDeaths())[0].after_level).toBeNull();
    });

    it("keeps matched observations after old snapshot cleanup", async () => {
        await observe([{ name: "Legacy", level: 100 }], "2026-10-01T10:00:00Z");
        await observe([{ name: "Legacy", level: 98 }], "2026-10-01T10:01:00Z");
        await request("/api/deathlist", { text: deathText() });
        await observe([{ name: "Legacy", level: 100 }], "2026-10-01T11:00:00Z");
        await observe([{ name: "Legacy", level: 99 }], "2026-10-04T10:00:00Z");
        expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM level_drops").first("count")).toBe(1);
        expect((await recordedDeaths())[0].after_level).toBe(98);
    });
});

describe("net Power Gamers ranking", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));

    it("includes a death-only character with a negative estimate", async () => {
        vi.setSystemTime(new Date("2026-10-01T11:00:00Z"));
        await request("/api/deathlist", { text: deathText() });
        const loss = estimateDeathLoss(100, "a dragon")!;
        const player = (await rankings()).players[0];
        expect(player).toMatchObject({ name: "Legacy", experience_gained: 0, levels_gained: 0,
            experience_lost: Math.round((loss.min + loss.max) / 2), deaths: 1,
            net_experience: -Math.round((loss.min + loss.max) / 2),
            net_experience_min: -loss.max, net_experience_max: -loss.min });
    });

    it("can show a net loss despite earning levels, without duplicating death imports", async () => {
        await observe([{ name: "Legacy", level: 100 }], "2026-10-01T09:00:00Z");
        await observe([{ name: "Legacy", level: 101 }], "2026-10-01T10:00:00Z");
        vi.setSystemTime(new Date("2026-10-01T11:00:00Z"));
        const text = deathText("10:01:00", 101) + " 1st October 2026 10:02:00 Died at Level 101 by a dragon.";
        await request("/api/deathlist", { text });
        const player = (await rankings()).players[0];
        expect(player.experience_gained).toBe(485200);
        expect(player.deaths).toBe(2);
        expect(player.net_experience).toBeLessThan(0);
        expect(player.net_experience).toBe(player.experience_gained - player.experience_lost);
        await request("/api/deathlist", { text });
        expect((await rankings()).players[0]).toEqual(player);
    });

    it("chooses the top 10 after losses, rather than limiting gross gains first", async () => {
        const players = Array.from({ length: 12 }, (_, index) => ({ name: `Player${String(index).padStart(2, "0")}`, level: 100 }));
        await observe(players, "2026-10-01T09:00:00Z");
        await observe(players.map(player => ({ ...player, level: 101 })), "2026-10-01T10:00:00Z");
        vi.setSystemTime(new Date("2026-10-01T11:00:00Z"));
        for (const player of players.slice(0, 2)) {
            await request("/api/deathlist", { text: deathText("10:01:00", 101).replace("Legacy", player.name) });
        }
        expect((await rankings()).players.map(player => player.name)).toEqual(players.slice(2).map(player => player.name));
    });

    it("orders positive and negative totals from highest to lowest", async () => {
        await observe([{ name: "Gainer", level: 20 }], "2026-10-01T09:00:00Z");
        await observe([{ name: "Gainer", level: 21 }], "2026-10-01T10:00:00Z");
        vi.setSystemTime(new Date("2026-10-01T11:00:00Z"));
        await request("/api/deathlist", { text: deathText("10:01:00", 100).replace("Legacy", "Large Loss") });
        await request("/api/deathlist", { text: deathText("10:01:00", 20).replace("Legacy", "Small Loss") });
        const players = (await rankings()).players;
        expect(players.map(player => player.name)).toEqual(["Gainer", "Small Loss", "Large Loss"]);
        expect(players[0].net_experience).toBeGreaterThan(0);
        expect(players[1].net_experience).toBeLessThan(0);
        expect(players[2].net_experience).toBeLessThan(players[1].net_experience);
    });

    it("includes only deaths within the same rolling window, excluding future entries", async () => {
        vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
        await request("/api/deathlist", { text: deathText("10:00:00") +
            " 1st October 2026 11:00:00 Died at Level 100 by a dragon." +
            " 2nd October 2026 11:00:00 Died at Level 100 by a dragon." });
        expect((await rankings()).players[0].deaths).toBe(1);
        vi.setSystemTime(new Date("2026-10-02T11:00:00Z"));
        // The earlier death expires as the formerly future death enters the window.
        expect((await rankings()).players[0].deaths).toBe(1);
        vi.setSystemTime(new Date("2026-10-03T11:00:00Z"));
        expect((await rankings()).players).toEqual([]);
    });
});
