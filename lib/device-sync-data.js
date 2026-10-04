"use strict";

const crypto = require("node:crypto");
const { aggregateUsageEvents, createUsageTotals } = require("./usage-events");

const PROVIDERS = new Set(["codex", "openCode", "copilot", "claudeCode", "gemini", "glm", "ollama"]);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const number = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function sanitizeEvent(raw) {
  if (!raw || !PROVIDERS.has(raw.providerId) || !/^[a-f0-9]{64}$/.test(raw.key || "")) return null;
  const timestamp = iso(raw.timestamp);
  if (!timestamp || Date.parse(timestamp) > Date.now() + 300_000) return null;
  const usage = Object.fromEntries(Object.keys(createUsageTotals()).map((key) => [key, number(raw.usage?.[key])]));
  if (!usage.totalTokens) return null;
  return {
    key: raw.key, providerId: raw.providerId, timestamp,
    model: typeof raw.model === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(raw.model) ? raw.model : null,
    usage,
    sourceGroupId: raw.sourceGroupId === "codexSpark" && raw.providerId === "codex" ? "codexSpark" : raw.providerId,
    reasoningEffort: /^[a-z0-9_-]{1,32}$/.test(raw.reasoningEffort || "") ? raw.reasoningEffort : null
  };
}

function exportUsageEvents(providers) {
  const events = new Map();
  let excludedEvents = 0;
  for (const provider of providers || []) {
    for (const raw of provider?._usageEvents || []) {
      const evidence = raw.evidence || {};
      // A file path is never a cross-device identity. Without a stable source
      // identifier we keep the event local rather than claim exact deduplication.
      const stableId = raw.providerId === "codex"
        ? evidence.sessionId || evidence.rolloutSessionId
        : evidence.requestId || evidence.messageId || evidence.uuid || raw.eventId;
      if (!stableId || (raw.providerId === "openCode" && /^(opencode-session-\d+|opencode:)/.test(String(stableId)))) { excludedEvents += 1; continue; }
      const usage = Object.fromEntries(Object.keys(createUsageTotals()).map((key) => [key, number(raw.usage?.[key] ?? raw.usage?.[{
        inputTokens: "input_tokens", cacheCreationInputTokens: "cache_creation_input_tokens",
        cachedInputTokens: "cached_input_tokens", outputTokens: "output_tokens",
        reasoningOutputTokens: "reasoning_output_tokens", totalTokens: "total_tokens"
      }[key]])]));
      const timestamp = Number.isFinite(new Date(raw.timestampMs).getTime()) ? new Date(raw.timestampMs).toISOString() : null;
      const identity = raw.providerId === "codex"
        ? [raw.providerId, stableId, timestamp, raw.model || null, usage]
        : [raw.providerId, stableId];
      const event = sanitizeEvent({ key: hash(JSON.stringify(identity)), providerId: raw.providerId,
        timestamp, model: raw.model, usage, sourceGroupId: raw.metadata?.sourceGroupId,
        reasoningEffort: raw.metadata?.reasoningEffort });
      if (event) events.set(event.key, event);
      else excludedEvents += 1;
    }
  }
  return { events: [...events.values()].sort((a, b) => a.key.localeCompare(b.key)), excludedEvents };
}

function sanitizeAccounts(registry) {
  return (Array.isArray(registry?.accounts) ? registry.accounts : []).slice(0, 100).flatMap((account) => {
    if (!/^gpt-[a-f0-9]{16}$/.test(account?.id || "")) return [];
    // Only opaque identities and allowlisted numeric quota fields leave a device.
    // A masked display label may be shown locally, but does not need to sync.
    return [{
      id: account.id, planType: /^[a-zA-Z0-9_-]{1,32}$/.test(account.planType || "") ? account.planType : null,
      lastSeenAt: iso(account.lastSeenAt),
      sources: (account.sources || []).filter((source) => ["codex", "openCode"].includes(source.id)).map((source) => ({
        id: source.id, active: Boolean(source.active), lastSeenAt: iso(source.lastSeenAt),
        limitsUpdatedAt: iso(source.limitsUpdatedAt),
        usage: source.usage?.summary ? { summary: { lifetimeTokens: typeof source.usage.summary.lifetimeTokens === "number" && Number.isSafeInteger(source.usage.summary.lifetimeTokens) && source.usage.summary.lifetimeTokens >= 0 ? source.usage.summary.lifetimeTokens : null } } : null,
        quotaStatus: source.quotaStatus === "ready" ? "ready" : "unavailable",
        limits: { rows: (source.limits?.rows || []).slice(0, 12).flatMap((row) => {
          if (!["fiveHour", "weekly"].includes(row.key)) return [];
          return [{ key: row.key, usedPercent: finitePercent(row.usedPercent),
            remainingPercent: finitePercent(row.remainingPercent), windowMinutes: number(row.windowMinutes), resetsAt: iso(row.resetsAt) }];
        }) }
      }))
    }];
  });
}

function finitePercent(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null; }

function mergeAccounts(localRegistry, snapshots) {
  const accounts = new Map((localRegistry?.accounts || []).map((account) => [account.id, structuredClone(account)]));
  for (const snapshot of snapshots) {
    for (const remote of sanitizeAccounts({ accounts: snapshot.accounts })) {
      let account = accounts.get(remote.id);
      if (!account) {
        account = { id: remote.id, label: `GPT · ${remote.id.slice(-6)}`, planType: remote.planType,
          active: false, lastSeenAt: remote.lastSeenAt, sources: [] };
        accounts.set(remote.id, account);
      }
      for (const source of remote.sources) {
        const existing = account.sources.find((entry) => entry.id === source.id);
        if (!existing || Date.parse(source.limitsUpdatedAt || 0) > Date.parse(existing.limitsUpdatedAt || 0)) {
          // Replicated quotas are saved measurements, never asserted to be live.
          const replacement = { ...source, active: false, deviceId: snapshot.device.id };
          if (existing) Object.assign(existing, replacement);
          else account.sources.push(replacement);
        }
      }
      if (Date.parse(remote.lastSeenAt || 0) > Date.parse(account.lastSeenAt || 0)) account.lastSeenAt = remote.lastSeenAt;
    }
  }
  return { ...localRegistry, accounts: [...accounts.values()] };
}

function combinedUsage(local, snapshots, selected = "all") {
  const seen = new Map();
  let duplicatesSkipped = 0;
  const origins = snapshots.filter((snapshot) => selected === "all" || snapshot.device.id === selected)
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt) || a.device.id.localeCompare(b.device.id));
  for (const snapshot of origins) {
    for (const raw of snapshot.events) {
      const event = sanitizeEvent(raw);
      if (!event) continue;
      if (seen.has(event.key)) { duplicatesSkipped += 1; continue; }
      seen.set(event.key, event);
    }
  }
  const events = [...seen.values()].map((event) => ({
    providerId: event.providerId, sourceId: event.providerId, eventId: event.key,
    timestampMs: Date.parse(event.timestamp), model: event.model, usage: event.usage,
    metadata: { sourceGroupId: event.sourceGroupId, reasoningEffort: event.reasoningEffort }
  }));
  const aggregate = aggregateUsageEvents(events, { dailyHistoryDays: 400 });
  const result = { ...local, gptAccounts: mergeAccounts(selected === "all" ? local.gptAccounts : { accounts: [] }, origins),
    local: { id: "local", status: events.length ? "live" : "empty", updatedAt: new Date().toISOString(),
      totals: aggregate.totals, daily: aggregate.daily, slots: aggregate.slots, sources: aggregate.sources, eventStats: aggregate.stats } };
  for (const id of PROVIDERS) {
    const rows = events.filter((event) => event.providerId === id);
    const provider = aggregateUsageEvents(rows, { dailyHistoryDays: 400 });
    // Do not attach this computer's quota, plan, cost or freshness to another
    // device's consumption. Account quotas remain in the account registry.
    result[id] = { id, status: rows.length ? "live" : "empty", updatedAt: result.local.updatedAt,
      totals: provider.totals, daily: provider.daily,
      byModel: provider.sources.flatMap((source) => source.models || []), limits: null,
      latest: rows.length ? { timestamp: new Date(rows.reduce((latest, row) => Math.max(latest, row.timestampMs), 0)).toISOString() } : null,
      source: { type: "device_sync", eventCount: rows.length } };
  }
  result.openai = { id: "openai", status: "unavailable" };
  result.anthropic = { id: "anthropic", status: "unavailable" };
  result.quotaPace = {};
  result.syncCoverage = { eventCount: events.length, duplicatesSkipped,
    excludedEvents: origins.reduce((sum, snapshot) => sum + number(snapshot.excludedEvents), 0) };
  return result;
}

module.exports = { exportUsageEvents, sanitizeAccounts, sanitizeEvent, combinedUsage, hash };
