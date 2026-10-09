function formatLastOnline(character) {
    if (character.is_online) return "Online now";
    if (!character.last_online) return "Unknown";

    const date = new Date(character.last_online);
    if (Number.isNaN(date.getTime())) return "Unknown";

    return date.toLocaleString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}
