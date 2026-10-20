.pragma library

var providers = {gpt: "ChatGPT / Codex", claude: "Claude Code", kimi: "Kimi Code", glm: "GLM / Z.AI",
    openai: "OpenAI API", anthropic: "Anthropic API", moonshot: "Moonshot API", copilot: "GitHub Copilot", gemini: "Gemini CLI"};

function accounts(snapshot, provider, view, favorites) {
    var all = snapshot && Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
    var groups = [], result = [];
    all.forEach(function(account) {
        if (!providers[account.provider] || (provider !== "all" && provider !== account.provider) ||
            (view === "favorites" && favorites.indexOf(account.id) < 0)) return;
        if (groups.indexOf(account.provider) < 0) groups.push(account.provider);
    });
    groups.forEach(function(group) {
        var peers = all.filter(function(account) {
            return account.provider === group && (view !== "favorites" || favorites.indexOf(account.id) >= 0);
        });
        peers.sort(function(a, b) { return Number(favorites.indexOf(b.id) >= 0) - Number(favorites.indexOf(a.id) >= 0); });
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
