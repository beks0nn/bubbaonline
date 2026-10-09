const list = document.querySelector("#power-list");
const updated = document.querySelector("#updated");
const numbers = new Intl.NumberFormat("en-GB");
const signedNumbers = new Intl.NumberFormat("en-GB", { signDisplay: "exceptZero" });
let loading = false;

function renderNetExperience(player) {
    const cell = document.createElement("td");
    const sign = player.net_experience < 0 ? "negative" : player.net_experience > 0 ? "positive" : "neutral";
    cell.className = `number experience ${sign}`;
    cell.textContent = `~${signedNumbers.format(player.net_experience)}`;
    return cell;
}

function showMessage(message) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "message";
    cell.textContent = message;
    row.appendChild(cell);
    list.replaceChildren(row);
}

function renderPowerGamers(players) {
    list.replaceChildren();
    if (players.length === 0) {
        showMessage("No level gains or deaths recorded in the last 24 hours yet.");
        return;
    }

    for (const [index, player] of players.entries()) {
        const row = document.createElement("tr");
        const values = [String(index + 1), player.name, numbers.format(player.level),
            `${player.levels_gained > 0 ? "+" : ""}${numbers.format(player.levels_gained)}`];

        for (const [column, value] of values.entries()) {
            const cell = document.createElement("td");
            if (column === 1) {
                const link = document.createElement("a");
                link.className = "character";
                link.href = `/characters/${encodeURIComponent(player.name)}`;
                link.textContent = value;
                cell.appendChild(link);
            } else {
                cell.textContent = value;
                if (column >= 2) cell.className = "number";
            }
            row.appendChild(cell);
        }
        row.appendChild(renderNetExperience(player));
        list.appendChild(row);
    }
}

async function loadPowerGamers() {
    if (loading || document.hidden) return;
    loading = true;
    try {
        const response = await fetch("/api/power-gamers");
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        const data = await response.json();
        renderPowerGamers(data.players);
        updated.textContent = `Updated ${new Date(data.until).toLocaleTimeString("en-GB")} · Refreshes every 5 minutes`;
    } catch (err) {
        showMessage("Failed to load Power Gamers. Retrying in 5 minutes.");
        updated.textContent = "Rankings unavailable";
        console.error("Failed to load Power Gamers:", err);
    } finally {
        loading = false;
    }
}

loadPowerGamers();
setInterval(loadPowerGamers, 5 * 60_000);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadPowerGamers();
});
