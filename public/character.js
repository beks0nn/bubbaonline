const nameEl = document.querySelector("#char-name");
const metaEl = document.querySelector("#char-meta");
const lastOnlineEl = document.querySelector("#char-last-online");
const deathList = document.querySelector("#death-list");
const expNumbers = new Intl.NumberFormat("en-GB");

function renderDeathLoss(death) {
    const cell = document.createElement("div");
    cell.className = "loss";
    const estimate = death.estimated_loss;
    if (!estimate) {
        cell.textContent = "Unknown";
        return cell;
    }
    cell.textContent = `~${expNumbers.format(Math.round((estimate.min + estimate.max) / 2))}`;
    return cell;
}

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
    lastOnlineEl.textContent = `Last online: ${formatLastOnline(character)}`;
    lastOnlineEl.title = "Dates use your local time zone.";
    metaEl.textContent = `Level ${character.level ?? "Unknown"} · ${character.vocation}`;
    const profileEl = document.querySelector("#char-profile");
    const details = [character.city && `City: ${character.city}`,
        character.profile_observed_at && `Guild: ${character.guild ?? "None"}`,
        character.sex && `Sex: ${character.sex === "male" ? "Male" : "Female"}`,
        character.account_type && (character.account_type === "premium" ? "Premium Account" : "Free Account")].filter(Boolean);
    profileEl.textContent = details.join(" · ");
    profileEl.hidden = details.length === 0;
    const skillsEl = document.querySelector("#char-skills");
    const labels = { magic: "Magic level", sword: "Sword", club: "Club", shielding: "Shielding", distance: "Distance" };
    const skills = character.skills ?? [];
    skillsEl.textContent = skills.map(entry => `${labels[entry.skill]}: ${entry.value} (#${entry.rank})`).join(" · ");
    skillsEl.hidden = skills.length === 0;

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

        const dateCell = document.createElement("div");
        dateCell.textContent = formatted;
        const levelCell = document.createElement("div");
        levelCell.className = "level";
        levelCell.textContent = death.level;
        const killerCell = document.createElement("div");
        killerCell.className = "killer";
        killerCell.textContent = death.killer;
        row.append(dateCell, levelCell, killerCell, renderDeathLoss(death));

        deathList.appendChild(row);
    }
}

loadCharacter();
