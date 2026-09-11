const characters = [
    { name: "Zaki", level: 178, vocation: "Knight" },
    { name: "Basilisk", level: 133, vocation: "Sorcerer" },
    { name: "Druid", level: 131, vocation: "Druid" },
    { name: "Bksonn", level: 112, vocation: "Sorcerer" },
    { name: "Alex the DragonSlayer", level: 113, vocation: "Knight" },
    { name: "Dirty Prostate Exam Hand", level: 25, vocation: "Paladin" },
    { name: "Great fireball rune", level: 45, vocation: "Sorcerer" }
];

const list = document.querySelector("#character-list");
const search = document.querySelector("#search");

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
            <div class="character">${character.name}</div>
            <div class="level">${character.level}</div>
            <div class="vocation">${character.vocation}</div>
        `;

        list.appendChild(row);
    }
}

search.addEventListener("input", renderCharacters);

renderCharacters();