const table = document.querySelector(".table");
const countEl = document.querySelector("#online-count");

async function loadOnline() {
    try {
        const response = await fetch("/api/online");
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        const players = await response.json();
        renderPlayers(players);
    } catch (err) {
        console.error("Failed to load online players:", err);
    }
}

function renderPlayers(players) {
    countEl.textContent = `(${players.length})`;

    players
        .sort((a, b) => b.level - a.level)
        .forEach(player => {
            const row = document.createElement("div");

            row.className = "row";
            row.innerHTML = `
                <a class="character" href="/characters/${encodeURIComponent(player.name)}">${player.name}</a>
                <div class="level">${player.level}</div>
                <div class="vocation">${player.vocation}</div>
            `;

            table.appendChild(row);
        });
}

loadOnline();