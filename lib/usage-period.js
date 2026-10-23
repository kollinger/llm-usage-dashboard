"use strict";

const { createUsageTotals } = require("./usage-events");
const PROVIDERS = new Set(["all", "codex", "codexSpark", "openCode", "copilot", "claudeCode", "gemini", "glm", "kimi", "ollama"]);

function usagePeriodOptions(query) {
  const from = Date.parse(query.from || "");
  const to = Date.parse(query.to || "");
  const provider = query.provider || "all";
  const accountId = query.accountId || null;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || !PROVIDERS.has(provider) ||
      accountId !== null && !/^[a-zA-Z0-9_-]{1,160}$/.test(accountId)) {
    throw Object.assign(new Error("invalid_usage_period"), { statusCode: 400 });
  }
  return { from, to, provider, accountId };
}

// Reuse the private, deduplicated event index. Only aggregated token counts
// leave the worker; reset boundaries can cut through a day or even a minute.
function queryUsagePeriod(index, { from, to, provider = "all", accountId = null }) {
  const daily = new Map();
  const totals = createUsageTotals();
  let eventCount = 0, unassignedTokens = 0, includedUnassignedTokens = 0;
  const add = (target, usage) => {
    for (const key of Object.keys(totals)) target[key] += Number(usage[key] || 0);
  };
  for (const event of index.events) {
    if (event.timestampMs < from || event.timestampMs >= to) continue;
    if (provider !== "all" && event.sourceId !== provider && event.providerId !== provider) continue;
    if (event.attribution?.accountQuality === "conflict" || !event.attribution?.accountId) {
      if (accountId) {
        unassignedTokens += event.usage.totalTokens;
        continue;
      }
      includedUnassignedTokens += event.usage.totalTokens;
    }
    if (accountId && event.attribution.accountId !== accountId) continue;
    const date = new Date(event.timestampMs).toISOString().slice(0, 10);
    if (!daily.has(date)) daily.set(date, { date, ...createUsageTotals(), sources: new Map() });
    const day = daily.get(date);
    const sourceId = event.sourceId || event.providerId;
    if (!day.sources.has(sourceId)) day.sources.set(sourceId, { id: sourceId, ...createUsageTotals(), models: new Map() });
    const source = day.sources.get(sourceId);
    const model = event.model || "unknown";
    if (!source.models.has(model)) source.models.set(model, { model, ...createUsageTotals() });
    add(totals, event.usage); add(day, event.usage); add(source, event.usage); add(source.models.get(model), event.usage);
    eventCount += 1;
  }
  return {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(), provider,
    totals, eventCount, unassignedTokens, includedUnassignedTokens, generatedAt: index.generatedAt,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => ({
      ...day, sources: [...day.sources.values()].map((source) => ({ ...source, models: [...source.models.values()] }))
    }))
  };
}

module.exports = { usagePeriodOptions, queryUsagePeriod };
