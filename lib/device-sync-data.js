"use strict";

const crypto = require("node:crypto");
const { aggregateUsageEvents, createUsageTotals, normalizeAttribution, mergeAttribution } = require("./usage-events");

const PROVIDERS = new Set(["codex", "openCode", "copilot", "claudeCode", "gemini", "glm", "kimi", "ollama"]);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const number = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function sanitizeEvent(raw) {
  if (!raw || !PROVIDERS.has(raw.providerId) || !/^[a-f0-9]{64}$/.test(raw.key || "")) return null;
  const timestamp = iso(raw.timestamp);
  if (!timestamp || Date.parse(timestamp) > Date.now() + 300_000) return null;
  const usage = Object.fromEntries(Object.keys(createUsageTotals()).map((key) => [key, number(raw.usage?.[key])]));
  if (!usage.totalTokens) return null;
  const event = {
    key: raw.key, providerId: raw.providerId, timestamp,
    model: typeof raw.model === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(raw.model) ? raw.model : null,
    usage,
    sourceGroupId: raw.sourceGroupId === "codexSpark" && raw.providerId === "codex" ? "codexSpark" : raw.providerId,
    reasoningEffort: /^[a-z0-9_-]{1,32}$/.test(raw.reasoningEffort || "") ? raw.reasoningEffort : null
  };
  // Optional fields must stay absent in old signed snapshots.
  if (Object.hasOwn(raw, "accountId")) event.accountId = normalizeAttribution(raw).accountId;
  if (Object.hasOwn(raw, "accountConflict")) event.accountConflict = raw.accountConflict === true;
  return event;
}

function usageEventSyncKey(raw) {
  const evidence = raw.evidence || {};
  const stableId = raw.providerId === "codex" ? evidence.sessionId || evidence.rolloutSessionId : evidence.requestId || evidence.messageId || evidence.uuid || raw.eventId;
  if (!stableId || (raw.providerId === "openCode" && /^(opencode-session-\d+|opencode:)/.test(String(stableId)))) return null;
  if (raw.providerId !== "codex") return hash(JSON.stringify([raw.providerId, stableId]));
  const timestamp = Number.isFinite(new Date(raw.timestampMs).getTime()) ? new Date(raw.timestampMs).toISOString() : null;
  const aliases = { inputTokens: "input_tokens", cacheCreationInputTokens: "cache_creation_input_tokens", cachedInputTokens: "cached_input_tokens", outputTokens: "output_tokens", reasoningOutputTokens: "reasoning_output_tokens", totalTokens: "total_tokens" };
  const usage = Object.fromEntries(Object.keys(createUsageTotals()).map((key) => [key, number(raw.usage?.[key] ?? raw.usage?.[aliases[key]])]));
  return hash(JSON.stringify([raw.providerId, stableId, timestamp, raw.model || null, usage]));
}

function attributeLocalUsageEvents(events, { device, snapshots = [] } = {}) {
  if (!events.length) return [];
  const observed = new Map();
  for (const snapshot of snapshots) {
    if (snapshot.device.id === device?.id) continue;
    for (const raw of snapshot.events || []) {
      const event = sanitizeEvent(raw);
      if (!event) continue;
      const attribution = { accountId: event.accountId, accountConflict: event.accountConflict, observedOn: [{ id: snapshot.device.id, label: snapshot.device.name }] };
      observed.set(event.key, mergeAttribution(observed.get(event.key), attribution));
    }
  }
  return events.map((event) => {
    let attribution = mergeAttribution(event.attribution || event.metadata?.attribution, { observedOn: device ? [device] : [] });
    if (observed.size) {
      const other = observed.get(usageEventSyncKey(event));
      if (other) attribution = mergeAttribution(attribution, other);
    }
    return { ...event, attribution };
  });
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
      const attribution = normalizeAttribution(raw.attribution || raw.metadata?.attribution);
      const event = sanitizeEvent({ key: usageEventSyncKey(raw), providerId: raw.providerId,
        timestamp, model: raw.model, usage, sourceGroupId: raw.metadata?.sourceGroupId,
        reasoningEffort: raw.metadata?.reasoningEffort,
        ...(attribution.accountId ? { accountId: attribution.accountId } : {}), ...(attribution.accountQuality === "conflict" ? { accountConflict: true } : {}) });
      if (event) {
        const existing = events.get(event.key);
        if (existing) {
          const merged = mergeAttribution(existing, event);
          if (merged.accountQuality === "conflict") { event.accountId = null; event.accountConflict = true; }
          else if (merged.accountId) event.accountId = merged.accountId;
        }
        events.set(event.key, event);
      }
      else excludedEvents += 1;
    }
  }
  return { events: [...events.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.key.localeCompare(b.key)), excludedEvents };
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

function sanitizeConnections(values) {
  const allowed = new Set(["claude", "kimi", "glm", "openai", "anthropic", "moonshot"]);
  const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  return (Array.isArray(values) ? values : []).slice(0, 100).flatMap((account) => {
    if (!allowed.has(account?.provider) || !/^[a-z]+-[a-f0-9]{16,64}$/.test(account.accountId || "")) return [];
    return [{ accountId: account.accountId, provider: account.provider, kind: account.kind === "api" ? "api" : "subscription",
      updatedAt: iso(account.updatedAt), planType: /^[a-zA-Z0-9_-]{1,40}$/.test(account.planType || "") ? account.planType : null,
      limits: { rows: (account.limits?.rows || []).slice(0, 12).map((row, index) => ({
        key: /^[a-zA-Z0-9_-]{1,40}$/.test(row.key) ? row.key : `window-${index}`,
        usedPercent: finitePercent(row.usedPercent), remainingPercent: finitePercent(row.remainingPercent),
        windowMinutes: finite(row.windowMinutes), resetsAt: iso(row.resetsAt)
      })) }, tokenTotal: finite(account.tokenTotal), costTotal: finite(account.costTotal), balance: finite(account.balance),
      currency: /^(USD|EUR|CNY)$/.test(account.currency || "") ? account.currency : null, periodDays: finite(account.periodDays) }];
  });
}

function mergeConnections(local, snapshots) {
  const accounts = new Map((local || []).map((account) => [account.accountId || account.id, { ...account }]));
  for (const snapshot of snapshots) {
    for (const incoming of sanitizeConnections(snapshot.connections)) {
      const existing = accounts.get(incoming.accountId);
      if (existing?.managed || existing?.status === "connected") continue;
      if (existing && Date.parse(existing.updatedAt || 0) >= Date.parse(incoming.updatedAt || 0)) continue;
      accounts.set(incoming.accountId, { ...existing, ...incoming,
        id: existing?.id || `remote:${incoming.accountId}`, label: existing?.label || `${incoming.provider} · ${incoming.accountId.slice(-6)}`,
        managed: false, status: "saved", deviceId: snapshot.device.id });
    }
  }
  return [...accounts.values()];
}

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
        if (existing?.active) continue;
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

function prepareCombinedUsage(local, snapshots) {
  const seen = new Map();
  const allOrigins = snapshots.slice()
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt) || a.device.id.localeCompare(b.device.id));
  const accounts = [...(local.gptAccounts?.accounts || []), ...(local.connectedAccounts || [])];
  const accountLabels = new Map(accounts.map((account) => [account.accountId || account.id, account.label]));
  for (const snapshot of allOrigins) {
    for (const raw of snapshot.events) {
      const event = sanitizeEvent(raw);
      if (!event) continue;
      const attribution = normalizeAttribution({ accountId: event.accountId, accountLabel: accountLabels.get(event.accountId),
        accountConflict: event.accountConflict,
        observedOn: [{ id: snapshot.device.id, label: snapshot.device.name }] });
      if (seen.has(event.key)) {
        const existing = seen.get(event.key);
        existing.observationCount += 1;
        existing.attribution = mergeAttribution(existing.attribution, attribution);
        continue;
      }
      seen.set(event.key, { ...event, attribution, observationCount: 1 });
    }
  }
  const events = [...seen.values()].map((event) => ({
    providerId: event.providerId, sourceId: event.providerId, eventId: event.key,
    timestampMs: Date.parse(event.timestamp), model: event.model, usage: event.usage,
    attribution: event.attribution, observationCount: event.observationCount,
    metadata: { sourceGroupId: event.sourceGroupId, reasoningEffort: event.reasoningEffort }
  }));
  const byDevice = new Map();
  for (const event of events) {
    for (const device of event.attribution.observedOn) {
      if (!byDevice.has(device.id)) byDevice.set(device.id, []);
      byDevice.get(device.id).push(event);
    }
  }
  return { events, byDevice };
}

function combinedUsage(local, snapshots, selected = "all", prepared = prepareCombinedUsage(local, snapshots)) {
  const origins = snapshots.filter((snapshot) => selected === "all" || snapshot.device.id === selected);
  const events = selected === "all" ? prepared.events : prepared.byDevice.get(selected) || [];
  const duplicatesSkipped = events.reduce((total, event) => total + event.observationCount - 1, 0);
  const aggregate = aggregateUsageEvents(events, { dailyHistoryDays: 400 });
  const result = { ...local,
    local: { id: "local", status: events.length ? "live" : "empty", updatedAt: new Date().toISOString(),
      totals: aggregate.totals, daily: aggregate.daily, slots: aggregate.slots, sources: aggregate.sources, eventStats: aggregate.stats,
      attribution: aggregate.attribution } };
  for (const id of PROVIDERS) {
    const rows = events.filter((event) => event.providerId === id);
    const provider = aggregateUsageEvents(rows, { dailyHistoryDays: 400, includeAttribution: false, includeSlots: false });
    result[id] = { id, status: rows.length ? "live" : "empty", updatedAt: result.local.updatedAt,
      totals: provider.totals, daily: provider.daily,
      byModel: provider.sources.flatMap((source) => source.models || []), limits: null,
      ...usageEventRange(rows),
      source: { type: "device_sync", eventCount: rows.length } };
    if (id === "codex") {
      const sparkRows = rows.filter((event) => event.metadata.sourceGroupId === "codexSpark");
      const spark = aggregateUsageEvents(sparkRows, { dailyHistoryDays: 400, includeAttribution: false, includeSlots: false });
      result[id].spark = { id: "codexSpark", status: sparkRows.length ? "live" : "empty", updatedAt: result.local.updatedAt,
        totals: spark.totals, daily: spark.daily, limits: null,
        ...usageEventRange(sparkRows),
        source: { type: "device_sync", eventCount: sparkRows.length } };
    }
  }
  result.syncCoverage = { eventCount: events.length, duplicatesSkipped,
    excludedEvents: origins.reduce((sum, snapshot) => sum + number(snapshot.excludedEvents), 0) };
  return refreshCombinedUsageMetadata(local, result, snapshots, selected);
}

function usageEventRange(events) {
  let first = Infinity, latest = -Infinity;
  for (const event of events) { first = Math.min(first, event.timestampMs); latest = Math.max(latest, event.timestampMs); }
  return { first: events.length ? { timestamp: new Date(first).toISOString() } : null,
    latest: events.length ? { timestamp: new Date(latest).toISOString() } : null };
}

// Current account quotas are separate from the additive consumption aggregate.
// This cheap overlay also keeps them fresh while a cached/worker aggregate is reused.
function refreshCombinedUsageMetadata(local, combined, snapshots, selected = "all") {
  const includeLocal = selected === "all";
  const origins = snapshots.filter((snapshot) => includeLocal || snapshot.device.id === selected);
  const result = { ...combined, generatedAt: local.generatedAt, cache: local.cache,
    gptAccounts: mergeAccounts(includeLocal ? local.gptAccounts : { accounts: [] }, origins),
    connectedAccounts: mergeConnections(includeLocal ? local.connectedAccounts : [], origins),
    quotaPace: includeLocal ? local.quotaPace || {} : {} };
  const providerMetadata = (current, aggregate) => ({ ...current,
    id: aggregate.id, status: current?.status || aggregate.status, updatedAt: aggregate.updatedAt,
    totals: aggregate.totals, daily: aggregate.daily, byModel: aggregate.byModel,
    latest: aggregate.latest, first: aggregate.first, limits: current?.limits || null,
    source: { ...current?.source, type: "device_sync", eventCount: aggregate.source?.eventCount || 0 } });
  for (const id of PROVIDERS) {
    if (!combined[id]) continue;
    const current = includeLocal ? local[id] : null;
    result[id] = providerMetadata(current, combined[id]);
    if (id === "codex" && combined[id].spark) result[id].spark = providerMetadata(current?.spark, combined[id].spark);
  }
  for (const id of ["openai", "anthropic"]) result[id] = includeLocal && local[id] ? local[id] : { id, status: "unavailable" };
  return result;
}

function createCombinedUsageCache({ ttlMs = 30_000, maxEntries = 5, now = Date.now, combine = combinedUsage } = {}) {
  const cache = new Map();
  const limit = Math.min(10, Math.max(1, Number.isSafeInteger(maxEntries) ? maxEntries : 5));
  return {
    get(local, snapshots, selected = "all") {
      const at = now();
      for (const [key, value] of cache) if (value.expiresAt <= at) cache.delete(key);
      const revisions = snapshots.map((snapshot) => [snapshot.device.id, snapshot.revision || null, snapshot.capturedAt || null])
        .sort((a, b) => a[0].localeCompare(b[0]));
      // Every origin matters even in a single-device view: another computer
      // can newly reveal that one of its events is a copied observation.
      const key = hash(JSON.stringify([selected, local.generatedAt || null, local.gptAccounts || null, local.connectedAccounts || null, revisions]));
      const cached = cache.get(key);
      if (cached) { cache.delete(key); cache.set(key, cached); return cached.value; }
      const value = combine(local, snapshots, selected);
      cache.set(key, { value, expiresAt: now() + ttlMs });
      while (cache.size > limit) cache.delete(cache.keys().next().value);
      return value;
    },
    clear() { cache.clear(); },
    size() { return cache.size; }
  };
}

module.exports = { exportUsageEvents, sanitizeAccounts, sanitizeConnections, sanitizeEvent, prepareCombinedUsage, combinedUsage, refreshCombinedUsageMetadata, createCombinedUsageCache, attributeLocalUsageEvents, hash };
