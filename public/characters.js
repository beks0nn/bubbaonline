const list = document.querySelector("#character-list");
const search = document.querySelector("#search");

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

    list.innerHTML = "";

    for (const character of filtered) {
        const row = document.createElement("div");

        row.className = "row";

        row.innerHTML = `
            <a class="character" href="/characters/${encodeURIComponent(character.name)}">${character.name}</a>
            <div class="level">${character.level}</div>
            <div class="vocation">${character.vocation}</div>
        `;

        list.appendChild(row);
    }
}

search.addEventListener("input", renderCharacters);

loadCharacters();