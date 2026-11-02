const list = document.querySelector("#frag-list");
const latestList = document.querySelector("#latest-frag-list");
const playersOnly = document.querySelector("#players-only");
const statusText = document.querySelector("#frag-status");
const retry = document.querySelector("#retry");
const tabs = [...document.querySelectorAll('[role="tab"]')];
const refreshMs = 5 * 60_000;
const snapshots = new Map();
let pending = null;
let currentView = "latest";

function selectView() {
    currentView = location.hash === "#most" ? "most" : "latest";
    for (const tab of tabs) {
        const active = tab.dataset.view === currentView;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
    }
    loadFrags();
}

function renderKiller(container, name) {
    // Match the monster-name convention used by the Players only filter.
    if (/^an? /i.test(name)) {
        container.textContent = name;
        return;
    }
    const link = document.createElement("a");
    link.href = `/characters/${encodeURIComponent(name)}`;
    link.textContent = name;
    container.append(link);
}

function showMessage(message) {
    const topMessage = document.createElement("div");
    topMessage.className = "message";
    topMessage.textContent = message;
    list.replaceChildren(topMessage);
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "message";
    cell.textContent = message;
    row.append(cell);
    latestList.replaceChildren(row);
}

function render({ top, latest }) {
    showMessage(playersOnly.checked ? "No recorded player kills yet." : "No recorded deaths yet.");
    if (top.length) list.replaceChildren();
    for (const [index, entry] of top.entries()) {
        const row = document.createElement("div");
        const rank = document.createElement("div");
        const killer = document.createElement("div");
        const frags = document.createElement("div");
        row.className = "row";
        rank.textContent = String(index + 1);
        renderKiller(killer, entry.killer);
        frags.className = "frags";
        frags.textContent = String(entry.frags);
        row.append(rank, killer, frags);
        list.append(row);
    }
    if (latest.length) latestList.replaceChildren();
    for (const death of latest) {
        const row = document.createElement("tr");
        const date = document.createElement("td");
        const time = document.createElement("time");
        time.dateTime = death.date;
        time.textContent = new Date(death.date).toLocaleString("en-GB");
        date.append(time);
        const victim = document.createElement("td");
        const link = document.createElement("a");
        link.href = `/characters/${encodeURIComponent(death.name)}`;
        link.textContent = death.name;
        victim.append(link);
        const level = document.createElement("td");
        level.className = "level";
        level.textContent = String(death.level);
        const killer = document.createElement("td");
        renderKiller(killer, death.killer);
        row.append(date, victim, level, killer);
        latestList.append(row);
    }
    statusText.textContent = currentView === "latest"
        ? "Refreshes every 5 minutes · Times shown in your local time"
        : "Refreshes every 5 minutes";
}

async function loadFrags() {
    if (document.hidden) return;
    const filter = playersOnly.checked;
    const view = currentView;
    const key = `${view}:${filter}`;
    if (pending?.key === key) return;
    pending?.controller.abort();
    pending = null;
    retry.hidden = true;
    const snapshot = snapshots.get(key);
    if (snapshot && Date.now() - snapshot.fetchedAt < refreshMs) {
        render(snapshot);
        return;
    }
    const controller = new AbortController();
    pending = { key, controller };
    const label = view === "latest" ? "deaths" : "kills";
    showMessage(`Loading ${label}…`);
    statusText.textContent = `Loading ${label}…`;
    try {
        const endpoint = view === "latest" ? "latest-frags" : "top-frags";
        const response = await fetch(`/api/${endpoint}?playersOnly=${filter}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        const entries = await response.json();
        if (pending?.controller !== controller) return;
        const data = { top: view === "most" ? entries : [], latest: view === "latest" ? entries : [], fetchedAt: Date.now() };
        snapshots.set(key, data);
        render(data);
    } catch (error) {
        if (pending?.controller !== controller || error.name === "AbortError") return;
        showMessage(`Could not load ${label}. Please try again.`);
        statusText.textContent = view === "latest" ? "Deaths unavailable" : "Kills unavailable";
        retry.hidden = false;
        console.error(`Failed to load ${label}:`, error);
    } finally {
        if (pending?.controller === controller) pending = null;
    }
}

playersOnly.addEventListener("change", loadFrags);
retry.addEventListener("click", loadFrags);
for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => { location.hash = tab.dataset.view; });
    tab.addEventListener("keydown", event => {
        let next;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        else return;
        event.preventDefault();
        tabs[next].focus();
        tabs[next].click();
    });
}
window.addEventListener("hashchange", selectView);
selectView();
setInterval(loadFrags, refreshMs);
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadFrags(); });
