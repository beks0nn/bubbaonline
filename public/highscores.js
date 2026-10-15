const list = document.querySelector("#highscore-list");
const table = document.querySelector("#highscore-table");
const skillSelect = document.querySelector("#skill");
const skillHeading = document.querySelector("#skill-heading");
const updated = document.querySelector("#updated");
const retry = document.querySelector("#retry");
const labels = { magic: "Magic level", sword: "Sword", club: "Club", shielding: "Shielding", distance: "Distance" };
const numbers = new Intl.NumberFormat("en-GB");
const refreshMs = 5 * 60_000;
const snapshots = new Map();
let pending = null;

const initialSkill = new URL(location.href).searchParams.get("skill");
skillSelect.value = Object.hasOwn(labels, initialSkill) ? initialSkill : "magic";

function showMessage(message) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "message";
    cell.textContent = message;
    row.appendChild(cell);
    list.replaceChildren(row);
}

function renderHighscores(data) {
    list.replaceChildren();
    if (!data.entries.length) showMessage("No highscores recorded for this skill yet.");
    for (const entry of data.entries) {
        const row = document.createElement("tr");
        const rank = document.createElement("td");
        rank.textContent = entry.rank;
        const name = document.createElement("td");
        const link = document.createElement("a");
        link.className = "character";
        link.href = `/characters/${encodeURIComponent(entry.name)}`;
        link.textContent = entry.name;
        name.appendChild(link);
        const vocation = document.createElement("td");
        vocation.className = "vocation";
        vocation.textContent = entry.vocation;
        const value = document.createElement("td");
        value.className = "number";
        value.textContent = numbers.format(entry.value);
        row.append(rank, name, vocation, value);
        list.appendChild(row);
    }
    updated.textContent = data.observed_at
        ? `Updated ${new Date(data.observed_at).toLocaleString("en-GB")} · Refreshes every 5 minutes`
        : "Waiting for the first update";
}

async function loadHighscores() {
    if (document.hidden) return;
    const skill = skillSelect.value;
    if (pending?.skill === skill) return;
    pending?.controller.abort();
    pending = null;
    retry.hidden = true;
    table.setAttribute("aria-busy", "false");
    table.setAttribute("aria-label", `${labels[skill]} highscores`);
    skillHeading.textContent = labels[skill];

    // Reuse recently viewed skills instead of fetching on every selection or tab focus.
    const snapshot = snapshots.get(skill);
    if (snapshot && Date.now() - snapshot.fetchedAt < refreshMs) {
        renderHighscores(snapshot.data);
        return;
    }

    const controller = new AbortController();
    pending = { skill, controller };
    table.setAttribute("aria-busy", "true");
    showMessage("Loading highscores...");
    updated.textContent = `Loading ${labels[skill].toLowerCase()} highscores...`;
    try {
        const response = await fetch(`/api/highscores?skill=${encodeURIComponent(skill)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        const data = await response.json();
        // A slower response for the previous skill must not replace the selected one.
        if (pending?.controller !== controller) return;
        snapshots.set(skill, { data, fetchedAt: Date.now() });
        renderHighscores(data);
    } catch (error) {
        if (pending?.controller !== controller || error.name === "AbortError") return;
        showMessage("Could not load highscores. Please try again.");
        updated.textContent = "Highscores unavailable";
        retry.hidden = false;
        console.error("Failed to load highscores:", error);
    } finally {
        if (pending?.controller === controller) {
            pending = null;
            table.setAttribute("aria-busy", "false");
        }
    }
}

skillSelect.addEventListener("change", () => {
    const url = new URL(location.href);
    url.searchParams.set("skill", skillSelect.value);
    history.replaceState(null, "", url);
    loadHighscores();
});
retry.addEventListener("click", loadHighscores);
loadHighscores();
setInterval(loadHighscores, refreshMs);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadHighscores();
});
