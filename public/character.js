const nameEl = document.querySelector("#char-name");
const metaEl = document.querySelector("#char-meta");
const deathList = document.querySelector("#death-list");

async function loadCharacter() {
    const name = decodeURIComponent(location.pathname.split("/characters/")[1]);

    try {
        const response = await fetch(`/api/characters/${encodeURIComponent(name)}`);
        if (response.status === 404) {
            nameEl.textContent = "Character not found";
            return;
        }
        if (!response.ok) throw new Error(`API returned ${response.status}`);

        const character = await response.json();
        renderCharacter(character);
    } catch (err) {
        nameEl.textContent = "Failed to load character";
        console.error("Failed to load character:", err);
    }
}

function renderCharacter(character) {
    document.title = `${character.name} - BubbaOnline`;
    nameEl.textContent = character.name;
    metaEl.textContent = `Level ${character.level} · ${character.vocation}`;

    deathList.innerHTML = "";

    if (character.deaths.length === 0) {
        deathList.innerHTML = `<div class="row"><div>No recorded deaths.</div></div>`;
        return;
    }

    for (const death of character.deaths) {
        const row = document.createElement("div");
        row.className = "row";

        const date = new Date(death.date);
        const formatted = date.toLocaleString("en-GB", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });

        row.innerHTML = `
            <div>${formatted}</div>
            <div class="level">${death.level}</div>
            <div class="killer">${death.killer}</div>
        `;

        deathList.appendChild(row);
    }
}

loadCharacter();