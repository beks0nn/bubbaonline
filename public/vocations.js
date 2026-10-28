const list = document.querySelector("#class-list");
const status = document.querySelector("#status");
const distribution = document.querySelector("#distribution");
const promotions = document.querySelector("#promotions");
const retry = document.querySelector("#retry");
const numbers = new Intl.NumberFormat("en-GB");
const percentages = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 1 });
const colors = { Knight: "#dc9a72", Paladin: "#dfc56f", Sorcerer: "#a99ae2", Druid: "#83bea0" };
const refreshMs = 15 * 60_000;
let snapshot = null;
let fetchedAt = 0;
let loading = false;

function showMessage(message) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.className = "message";
    cell.textContent = message;
    row.append(cell);
    list.replaceChildren(row);
}

function render() {
    if (!snapshot) return;
    document.querySelector("#total").textContent = numbers.format(snapshot.total);
    document.querySelector("#known").textContent = numbers.format(snapshot.total - snapshot.unknown);
    document.querySelector("#unknown").textContent = numbers.format(snapshot.unknown);
    if (!snapshot.total) {
        showMessage("No characters recorded yet.");
        return;
    }
    const rows = snapshot.classes.flatMap(group => promotions.checked ? [
        { name: group.name, count: group.base, color: colors[group.name] },
        { name: group.promotion, count: group.promoted, color: colors[group.name] },
    ] : [{ name: group.name, count: group.count, color: colors[group.name] }]);
    rows.push({ name: "No vocation", count: snapshot.no_vocation, color: "#93b4c6" },
        { name: "Unknown", count: snapshot.unknown, color: "#888" });
    const fragment = document.createDocumentFragment();
    for (const entry of rows) {
        const row = document.createElement("tr");
        const name = document.createElement("th");
        name.scope = "row";
        name.textContent = entry.name;
        const track = document.createElement("div");
        track.className = "track";
        track.setAttribute("aria-hidden", "true");
        const fill = document.createElement("div");
        fill.className = "fill";
        fill.style.width = `${entry.count / snapshot.total * 100}%`;
        fill.style.setProperty("--class-color", entry.color);
        track.append(fill);
        name.append(track);
        const count = document.createElement("td");
        count.className = "number";
        count.textContent = numbers.format(entry.count);
        const share = document.createElement("td");
        share.className = "number";
        share.textContent = percentages.format(entry.count / snapshot.total);
        row.append(name, count, share);
        fragment.append(row);
    }
    list.replaceChildren(fragment);
}

async function load() {
    if (document.hidden || loading || (snapshot && Date.now() - fetchedAt < refreshMs)) return;
    loading = true;
    retry.hidden = true;
    distribution.setAttribute("aria-busy", "true");
    status.textContent = snapshot ? "Updating vocation distribution…" : "Loading vocation distribution…";
    try {
        const response = await fetch("/api/class-distribution");
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        snapshot = await response.json();
        fetchedAt = Date.now();
        render();
        status.textContent = `Updated ${new Date(snapshot.generated_at).toLocaleString("en-GB")} · Refreshes every 15 minutes`;
    } catch (error) {
        status.textContent = snapshot ? "Could not refresh. Showing the last loaded distribution." : "Could not load vocation distribution.";
        if (!snapshot) showMessage("Please try again.");
        retry.hidden = false;
        console.error("Failed to load vocation distribution:", error);
    } finally {
        loading = false;
        distribution.setAttribute("aria-busy", "false");
    }
}

promotions.addEventListener("change", render);
retry.addEventListener("click", load);
load();
setInterval(load, refreshMs);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
