const players = [
    { name: "Zaki", level: 178, vocation: "Knight" },
    { name: "Basilisk", level: 133, vocation: "Sorcerer" },
    { name: "Druid", level: 131, vocation: "Druid" },
    { name: "Bksonn", level: 999, vocation: "Sorcerer" }
];

const table = document.querySelector(".table");

players
    .sort((a, b) => b.level - a.level)
    .forEach(player => {
        const row = document.createElement("div");

        row.className = "row";
        row.innerHTML = `
            <div class="character">${player.name}</div>
            <div class="level">${player.level}</div>
            <div class="vocation">${player.vocation}</div>
        `;

        table.appendChild(row);
    });