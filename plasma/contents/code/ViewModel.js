.pragma library

var providers = {gpt: "ChatGPT / Codex", claude: "Claude Code", kimi: "Kimi Code", glm: "GLM / Z.AI",
    openai: "OpenAI API", anthropic: "Anthropic API", moonshot: "Moonshot API", copilot: "GitHub Copilot", gemini: "Gemini CLI"};

function favorite(account, favorites) {
    return favorites.indexOf(account.id) >= 0 || (account.aliases || []).some(function(id) { return favorites.indexOf(id) >= 0; });
}

function canonicalFavorites(snapshot, favorites) {
    var all = snapshot && Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
    var result = [];
    favorites.forEach(function(id) {
        var account = all.find(function(item) { return (item.aliases || []).indexOf(id) >= 0; });
        var mapped = account ? account.id : id;
        if (result.indexOf(mapped) < 0) result.push(mapped);
    });
    return result;
}

function toggleFavorite(account, favorites) {
    var selected = favorite(account, favorites);
    var handles = [account.id].concat(account.aliases || []);
    var next = favorites.filter(function(id) { return handles.indexOf(id) < 0; });
    if (!selected && next.length < 512) next.push(account.id);
    return next;
}

function accounts(snapshot, provider, view, favorites) {
    var all = snapshot && Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
    var groups = [], result = [];
    all.forEach(function(account) {
        if (!providers[account.provider] || (provider !== "all" && provider !== account.provider) ||
            (view === "favorites" && !favorite(account, favorites))) return;
        if (groups.indexOf(account.provider) < 0) groups.push(account.provider);
    });
    groups.forEach(function(group) {
        var peers = all.filter(function(account) {
            return account.provider === group && (view !== "favorites" || favorite(account, favorites));
        });
        peers.sort(function(a, b) { return Number(favorite(b, favorites)) - Number(favorite(a, favorites)); });
        peers.forEach(function(account) { result.push(account); });
    });
    return result;
}

function remaining(window) {
    return typeof window.remainingPercent === "number" && isFinite(window.remainingPercent) &&
        window.remainingPercent >= 0 && window.remainingPercent <= 100 ? window.remainingPercent : null;
}

function stale(window, snapshot, disconnected, now) {
    var measured = Date.parse(window.measuredAt);
    return disconnected || window.status !== "current" || !isFinite(measured) ||
        now - measured > ((snapshot && snapshot.staleAfterMs) || 900000) || measured > now + 60000 ||
        (window.resetsAt && Date.parse(window.resetsAt) <= now);
}
