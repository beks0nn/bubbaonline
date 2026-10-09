// Cumulative EXP at a level's start, following the supplied level 1–300 table.
// The same curve continues above level 300.
export function experienceAtLevel(level: number): number {
	return Math.round((50 * level ** 3 - 300 * level ** 2 + 850 * level - 600) / 3);
}
