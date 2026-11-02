import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src";
import { deathTimeToUtc } from "../src/death-time";

// First two rows deliberately put the later death first: shifting it would
// collide with the second row if the migration kept the unique index in place.
const fixtures = [
    ["2026-11-02T21:48:02", "2026-11-02T20:48:02Z"],
    ["2026-11-02T20:48:02", "2026-11-02T19:48:02Z"],
    ["2026-10-25T16:02:02", "2026-10-25T15:02:02Z"],
    ["2026-10-19T21:17:01", "2026-10-19T19:17:01Z"],
    ["2026-03-29T01:59:59", "2026-03-29T00:59:59Z"],
    ["2026-03-29T03:00:00", "2026-03-29T01:00:00Z"],
    ["2026-10-25T02:30:00", "2026-10-25T00:30:00Z"],
    ["2026-10-25T03:00:00", "2026-10-25T02:00:00Z"],
    ["2026-01-01T00:30:00", "2025-12-31T23:30:00Z"],
    ["2024-02-29T12:00:00", "2024-02-29T11:00:00Z"],
    ["2029-03-25T03:00:00", "2029-03-25T01:00:00Z"],
] as const;
const sample = "Deathlist for player, Dakooria. 02nd November 2026 21:48:02 Died at Level 146 by a cyclops.";
const migrations = (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS;

async function send(path: string, text?: string) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://example.com${path}`, {
        method: text === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-death-secret" },
        body: text === undefined ? undefined : JSON.stringify({ text }),
    }), { ...env, OTCLIENT_SECRET: "test-death-secret" }, ctx);
    await waitOnExecutionContext(ctx);
    return response;
}

beforeAll(async () => {
    const index = migrations.findIndex(m => m.name === "0010_death_times_utc.sql");
    expect(index).toBeGreaterThan(0);
    await applyD1Migrations(env.DB, migrations.slice(0, index));
    await env.DB.prepare(`INSERT INTO characters (name, level, first_seen, last_seen)
        VALUES ('Dakooria', 146, '2026-10-01T00:00:00Z', '2026-11-02T22:00:00Z')`).run();
    const character = await env.DB.prepare("SELECT id FROM characters WHERE name = 'Dakooria'").first<{ id: number }>();
    await env.DB.batch(fixtures.map(([local], i) => env.DB.prepare(`INSERT INTO deaths
        (id, character_id, date, level, killer, after_level, after_observed_at)
        VALUES (?, ?, ?, 146, 'a cyclops', 145, ?)`)
        .bind(i + 1, character!.id, `${local}Z`, `${local}Z`)));
    await applyD1Migrations(env.DB, migrations);
});

describe("Swedish deathlist clock", () => {
    it.each(fixtures)("converts %s to %s", (local, utc) => {
        expect(deathTimeToUtc(local)).toBe(utc);
    });

    it.each(["2026-03-29T02:30:00", "2026-02-30T12:00:00", "2026-11-02T25:00:00"])("rejects impossible time %s", local => {
        expect(() => deathTimeToUtc(local)).toThrow("Invalid Europe/Stockholm death time");
    });

    it("repairs stored dates once, preserves rows and clears unreliable correlations", async () => {
        await applyD1Migrations(env.DB, migrations);
        const rows = await env.DB.prepare("SELECT id, date, level, killer, after_level, after_observed_at FROM deaths ORDER BY id").all();
        expect(rows.results).toEqual(fixtures.map(([, date], i) => ({
            id: i + 1, date, level: 146, killer: "a cyclops", after_level: null, after_observed_at: null,
        })));
        expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_deaths_unique'").first()).not.toBeNull();
    });

    it("deduplicates a replay against migrated rows and returns correct UTC to the browser", async () => {
        const imported = await send("/api/deathlist", sample);
        expect(imported.status).toBe(200);
        expect(await imported.json()).toMatchObject({ inserted: 0 });
        const detail = await (await send("/api/characters/Dakooria")).json<{ deaths: { date: string }[] }>();
        const death = detail.deaths.find(row => row.date === "2026-11-02T20:48:02Z");
        expect(death).toBeDefined();
        expect(new Date(death!.date).toLocaleTimeString("en-GB", { timeZone: "Europe/Stockholm" })).toBe("21:48:02");
    });

    it("normalizes new imports before inserting and deduplicating", async () => {
        const text = sample.replace("Dakooria", "New death");
        expect(await (await send("/api/deathlist", text)).json()).toMatchObject({ inserted: 1 });
        expect(await (await send("/api/deathlist", text)).json()).toMatchObject({ inserted: 0 });
        const row = await env.DB.prepare(`SELECT d.date FROM deaths d JOIN characters c ON c.id = d.character_id
            WHERE c.name = 'New death'`).first();
        expect(row).toEqual({ date: "2026-11-02T20:48:02Z" });
    });

    it("rejects invalid times before writing any deaths", async () => {
        const response = await send("/api/deathlist", sample.replace("21:48:02", "25:48:02"));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: expect.stringContaining("Europe/Stockholm") });
    });
});
