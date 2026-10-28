import { vocation } from "./import-validation";

export async function getClassDistribution(db: D1Database) {
	const { results } = await db.prepare("SELECT vocation, COUNT(*) AS count FROM characters GROUP BY vocation")
		.all<{ vocation: string; count: number }>();
	const classes = [
		{ name: "Knight", promotion: "Elite Knight", base: 0, promoted: 0 },
		{ name: "Paladin", promotion: "Royal Paladin", base: 0, promoted: 0 },
		{ name: "Sorcerer", promotion: "Master Sorcerer", base: 0, promoted: 0 },
		{ name: "Druid", promotion: "Elder Druid", base: 0, promoted: 0 },
	];
	let total = 0, unknown = 0, noVocation = 0;
	for (const row of results) {
		total += row.count;
		let name = "Unknown";
		try { name = vocation(row.vocation); } catch { /* Unrecognized legacy values remain unknown. */ }
		const group = classes.find(group => group.name === name || group.promotion === name);
		if (group) group[group.name === name ? "base" : "promoted"] += row.count;
		else if (name === "None") noVocation += row.count;
		else unknown += row.count;
	}
	return { generated_at: new Date().toISOString(), total, unknown, no_vocation: noVocation,
		classes: classes.map(group => ({ ...group, count: group.base + group.promoted })) };
}
