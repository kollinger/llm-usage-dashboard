"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const gzip = promisify(require("node:zlib").gzip);
const gunzip = promisify(require("node:zlib").gunzip);
const PROVIDERS = ["codex", "openCode", "copilot", "claudeCode", "gemini", "glm", "kimi", "ollama"];

// Only completed consumption views survive a restart. Provider credentials,
// account sessions and live allowances must always come from current readers.
function consumptionView(value) {
  const history = (provider) => {
    if (!provider) return null;
    const result = {};
    for (const key of ["id", "status", "updatedAt", "totals", "daily", "slots", "sources", "attribution", "eventStats", "byModel"])
      if (provider[key] !== undefined) result[key] = provider[key];
    for (const key of ["first", "latest"]) if (provider[key]) result[key] = { timestamp: provider[key].timestamp };
    result.limits = null;
    result.source = { type: "history_cache", eventCount: provider.source?.eventCount || provider.eventStats?.eventsAccepted || 0 };
    if (provider.spark) result.spark = history(provider.spark);
    return result;
  };
  const result = { generatedAt: value.local?.updatedAt || value.generatedAt, local: history(value.local),
    gptAccounts: { accounts: [] }, connectedAccounts: [], quotaPace: {}, openai: { id: "openai", status: "unavailable" },
    anthropic: { id: "anthropic", status: "unavailable" } };
  for (const id of PROVIDERS) if (value[id]) result[id] = history(value[id]);
  if (value.syncCoverage) result.syncCoverage = value.syncCoverage;
  return result;
}

function createUsageViewCache({ directory, context, version = 1 }) {
  const fileFor = (scope) => path.join(directory, `${crypto.createHash("sha256").update(scope).digest("hex")}.json.gz`);
  return {
    context,
    async read(scope, fingerprint) {
      if (!fingerprint) return null;
      try {
        const entry = JSON.parse(await gunzip(await fs.readFile(fileFor(scope))));
        if (entry.version !== version || entry.fingerprint !== fingerprint || entry.scope !== scope || !entry.value?.local?.totals ||
          !Number.isFinite(Date.parse(entry.value.local.updatedAt))) return null;
        return { ...entry, expiresAt: 0, value: { ...entry.value, cache: { stale: true, refreshing: true,
          restored: true, staleReason: "usage_refresh_in_progress", aggregateUpdatedAt: entry.value.local.updatedAt } } };
      } catch { return null; }
    },
    async write(scope, fingerprint, value, input = {}) {
      if (!fingerprint) return;
      const file = fileFor(scope), temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const entry = { version, scope, fingerprint, key: input.key, origins: input.origins, devices: input.devices, value: consumptionView(value) };
        await fs.writeFile(temporary, await gzip(JSON.stringify(entry)), { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, file);
      } catch { await fs.rm(temporary, { force: true }).catch(() => {}); }
    }
  };
}

module.exports = { createUsageViewCache, consumptionView };
