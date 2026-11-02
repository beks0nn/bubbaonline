import { InputError } from "./import-validation";

const serverClock = new Intl.DateTimeFormat("en-GB", {
	timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit",
	hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** The deathlist contains Swedish wall time without an offset, not UTC. */
export function deathTimeToUtc(localTime: string): string {
	const nominal = Date.parse(`${localTime}Z`);
	if (Number.isFinite(nominal)) {
		// Try summer time first: the repeated autumn hour has no distinguishing
		// offset in the source, so consistently choose its earlier occurrence.
		for (const offset of [2, 1]) {
			const candidate = new Date(nominal - offset * 3_600_000);
			const parts = Object.fromEntries(serverClock.formatToParts(candidate).map(p => [p.type, p.value]));
			const wallTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
			if (wallTime === localTime) return candidate.toISOString().replace(".000Z", "Z");
		}
	}
	// Also rejects impossible calendar dates and the skipped spring hour.
	throw new InputError(`Invalid Europe/Stockholm death time: ${localTime}`);
}
