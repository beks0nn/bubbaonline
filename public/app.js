const list = document.querySelector("#online-list");
const search = document.querySelector("#search");
const countEl = document.querySelector("#online-count");

let players = [];

async function loadOnline() {
    try {
        const response = await fetch("/api/online");
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        players = await response.json();
        renderPlayers(players);
    } catch (err) {
        console.error("Failed to load online players:", err);
    }
}

function renderPlayers(players) {
    const query = search.value.trim().toLowerCase();
    const filtered = players
        .filter(player => player.name.toLowerCase().includes(query))
        .sort((a, b) => b.level - a.level);

    countEl.textContent = `(${filtered.length})`;
    list.innerHTML = "";

    filtered
        .forEach(player => {
            const row = document.createElement("div");

            row.className = "row";
            row.innerHTML = `
                <a class="character" href="/characters/${encodeURIComponent(player.name)}">${player.name}</a>
                <div class="level">${player.level}</div>
                <div class="vocation">${player.vocation}</div>
            `;

            list.appendChild(row);
        });
}

search.addEventListener("input", () => renderPlayers(players));

loadOnline();
