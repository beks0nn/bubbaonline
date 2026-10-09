import { describe, expect, it } from "vitest";
import { estimateDeathLoss } from "../src/death-loss";
import { experienceAtLevel } from "../src/experience";

describe("promoted stock TFS 1.2 death estimates", () => {
    it("allows all blessing counts instead of assuming full blessings", () => {
        const estimate = estimateDeathLoss(100, "a dragon")!;
        expect(estimate.min).toBe(Math.floor(713100 * 0.7 * 0.92 ** 5));
        expect(estimate.max).toBeGreaterThan(499170);
        expect(estimate).toMatchObject({ experience_before_min: 15694800, experience_before_max: 16179999,
            observation_used: false, pvp_possible: false });
    });

    it("widens the range for possible PvP deaths", () => {
        const monster = estimateDeathLoss(100, "a dragon")!;
        const player = estimateDeathLoss(100, "Other Player")!;
        expect(player.min).toBeLessThan(monster.min);
        expect(player.max).toBe(monster.max);
        expect(player.pvp_possible).toBe(true);
    });

    it("narrows loss and pre-death EXP using a compatible lower observed level", () => {
        const estimate = estimateDeathLoss(100, "a dragon", 98)!;
        expect(estimate.observation_used).toBe(true);
        expect(estimate.min).toBe(475401);
        expect(estimate.experience_before_max).toBeLessThan(16179999);
    });

    it("falls back when an observation contradicts the assumed death model", () => {
        expect(estimateDeathLoss(100, "a dragon", 50)).toEqual(estimateDeathLoss(100, "a dragon"));
    });

    it("handles the low-level protection and invalid inputs", () => {
        expect(estimateDeathLoss(7, "a rat")).toMatchObject({ min: 0, max: 0 });
        expect(estimateDeathLoss(8, "a rat")!.min).toBeGreaterThan(0);
        expect(estimateDeathLoss(0, "a rat")).toBeNull();
        expect(estimateDeathLoss(2.5, "a rat")).toBeNull();
    });

    it("contains simulated stock losses and EXP across blessings and within-level progress", () => {
        for (const level of [8, 24, 25, 100, 300]) {
            for (const fraction of [0, 0.25, 0.5, 0.99, 0.999]) {
                const exp = experienceAtLevel(level) + Math.floor(
                    (experienceAtLevel(level + 1) - experienceAtLevel(level)) * fraction);
                const percent = Math.floor((exp - experienceAtLevel(level)) * 100 /
                    (experienceAtLevel(level + 1) - experienceAtLevel(level)));
                for (let blessings = 0; blessings <= 5; blessings++) {
                    // Evaluate the upstream percentage calculation independently.
                    const fractionalLevel = level + percent / 100;
                    const percentLoss = level < 25 ? 10 :
                        (fractionalLevel + 50) * 50 * (fractionalLevel ** 2 - 5 * fractionalLevel + 8) / exp;
                    const loss = Math.floor(exp * (percentLoss * 0.7 * 0.92 ** blessings / 100));
                    let afterLevel = level;
                    while (afterLevel > 1 && experienceAtLevel(afterLevel) > exp - loss) afterLevel--;
                    const estimate = estimateDeathLoss(level, "a dragon", afterLevel)!;
                    // Permit a single EXP rounding difference from rearranged floating point operations.
                    expect(loss).toBeGreaterThanOrEqual(estimate.min - 1);
                    expect(loss).toBeLessThanOrEqual(estimate.max + 1);
                    expect(exp).toBeGreaterThanOrEqual(estimate.experience_before_min - 1);
                    expect(exp).toBeLessThanOrEqual(estimate.experience_before_max + 1);
                }
            }
        }
    });
});
