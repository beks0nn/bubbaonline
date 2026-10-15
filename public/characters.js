const list = document.querySelector("#character-list");
const search = document.querySelector("#search");
const countEl = document.querySelector("#character-count");

let characters = [];

async function loadCharacters() {
    try {
        const response = await fetch("/api/characters");
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        characters = await response.json();
    } catch (err) {
        list.innerHTML = `<div class="row"><div>Failed to load characters.</div></div>`;
        console.error("Failed to load characters:", err);
        return;
    }

    renderCharacters();
}

function renderCharacters() {
    const query = search.value.trim().toLowerCase();

    const filtered = characters
        .filter(character =>
            character.name.toLowerCase().includes(query)
        )
        .sort((a, b) => b.level - a.level);

    countEl.textContent = `(${filtered.length})`;

    list.innerHTML = "";

    for (const character of filtered) {
        const row = document.createElement("div");

        row.className = "row";

        const link = document.createElement("a");
        link.className = "character";
        link.href = `/characters/${encodeURIComponent(character.name)}`;
        link.textContent = character.name;
        const level = document.createElement("div");
        level.className = "level";
        level.textContent = character.level ?? "Unknown";
        const vocation = document.createElement("div");
        vocation.className = "vocation";
        vocation.textContent = character.vocation;
        row.append(link, level, vocation);

        const lastOnline = document.createElement("div");
        lastOnline.className = "last-online";
        lastOnline.textContent = formatLastOnline(character);
        lastOnline.title = "Dates use your local time zone.";
        row.appendChild(lastOnline);

        list.appendChild(row);
    }
}

search.addEventListener("input", renderCharacters);

loadCharacters();
