const list = document.querySelector("#frag-list");
const playersOnly = document.querySelector("#players-only");

async function loadTopFrags() {
    try {
        const response = await fetch(`/api/top-frags?playersOnly=${playersOnly.checked}`);
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        renderTopFrags(await response.json());
    } catch (err) {
        list.innerHTML = "<div class=\"row\"><div>Failed to load top frags.</div></div>";
        console.error("Failed to load top frags:", err);
    }
}

function renderTopFrags(topFrags) {
    list.replaceChildren();

    if (topFrags.length === 0) {
        list.innerHTML = "<div class=\"row\"><div>No recorded deaths yet.</div></div>";
        return;
    }

    for (const [index, entry] of topFrags.entries()) {
        const row = document.createElement("div");
        const rank = document.createElement("div");
        const killer = document.createElement("div");
        const frags = document.createElement("div");

        row.className = "row";
        rank.textContent = String(index + 1);
        killer.textContent = entry.killer;
        frags.className = "frags";
        frags.textContent = String(entry.frags);

        row.append(rank, killer, frags);
        list.appendChild(row);
    }
}

playersOnly.addEventListener("change", loadTopFrags);

loadTopFrags();
