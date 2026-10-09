import { describe, expect, it } from "vitest";
import { experienceAtLevel } from "../src/experience";

describe("cumulative EXP", () => {
    it.each([
        [1, 0], [2, 100], [3, 200], [4, 400], [8, 4200], [20, 98800],
        [50, 1847300], [51, 1965000], [75, 6489800], [100, 15694800],
        [101, 16180000], [125, 31024800], [150, 54042300], [151, 55145000],
        [175, 86309800], [200, 129389800], [201, 131360000], [225, 184844800],
        [250, 254237300], [251, 257325000], [275, 339129800], [299, 436659400],
        [300, 441084800],
    ])("matches the supplied threshold for level %i", (level, experience) => {
        expect(experienceAtLevel(level)).toBe(experience);
    });
});
