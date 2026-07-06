"use strict";

const crypto = require("node:crypto");

function normalizeUsageEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const providerId = String(raw.providerId || "").trim();
  const sourceId = String(raw.sourceId || "").trim();
  const timestampMs = Number(raw.timestampMs);
  if (!providerId || !sourceId || !Number.isFinite(timestampMs)) return null;
  const usage = normalizeUsage(raw.usage || {});
  if (!usage.totalTokens) return null;
  const event = {
    providerId,
    sourceId,
    eventId: String(raw.eventId || "").trim() || null,
    timestampMs,
    timestamp: new Date(timestampMs).toISOString(),
    model: raw.model ? String(raw.model).slice(0, 160) : null,
    usage,
    evidence: normalizeEvidence(raw.evidence),
    metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}
  };
  event.dedupeKey = eventDedupeKey(event);
  return event;
}

function dedupeUsageEvents(rawEvents) {
  const seen = new Set();
  const accepted = [];
  let duplicatesSkipped = 0;
  const bySource = new Map();

  for (const raw of rawEvents || []) {
    const event = normalizeUsageEvent(raw);
    if (!event) continue;
    const key = event.dedupeKey;
    const sourceStats = bySource.get(event.sourceId) || { sourceId: event.sourceId, eventsAccepted: 0, duplicatesSkipped: 0 };
    if (seen.has(key)) {
      duplicatesSkipped += 1;
      sourceStats.duplicatesSkipped += 1;
      bySource.set(event.sourceId, sourceStats);
      continue;
    }
    seen.add(key);
    accepted.push(event);
    sourceStats.eventsAccepted += 1;
    bySource.set(event.sourceId, sourceStats);
  }

  return {
    events: accepted,
    duplicatesSkipped,
    bySource: Array.from(bySource.values())
  };
}

function eventDedupeKey(event) {
  const provider = event.providerId;
  const evidence = event.evidence || {};
  const realpath = evidence.realpath || evidence.realpathHash || null;
  const line = evidence.line ?? evidence.index ?? evidence.eventIndex;
  if (realpath && line !== undefined && line !== null) {
    return `${provider}:realpath:${realpath}:${line}`;
  }

  if (provider === "codex") {
    const sessionId = evidence.sessionId || evidence.rolloutSessionId;
    if (sessionId) return `${provider}:session:${sessionId}:${eventHash(event)}`;
  }

  if (provider === "claudeCode") {
    const requestId = evidence.requestId || evidence.messageId || evidence.uuid;
    if (requestId) return `${provider}:request:${requestId}`;
  }

  if (provider === "copilot") {
    const sessionStart = evidence.sessionStart || evidence.sessionStartTime || event.timestampMs;
    if (realpath || sessionStart) return `${provider}:session:${realpath || "unknown"}:${sessionStart}:${eventHash(event)}`;
  }

  if (provider === "gemini" || provider === "ollama") {
    if (realpath) return `${provider}:file:${realpath}:${eventHash(event)}`;
  }

  if (event.eventId) return `${provider}:event:${event.eventId}`;
  return `${provider}:fallback:${event.timestampMs}:${event.model || "unknown"}:${eventHash(event)}`;
}

function aggregateUsageEvents(rawEvents, options = {}) {
  const dailyHistoryDays = Number(options.dailyHistoryDays || 180);
  const now = Number(options.now || Date.now());
  const usage = createUsageAccumulator();
  const byProvider = new Map();
  const bySource = new Map();
  const dailySourceMap = new Map();
  const deduped = dedupeUsageEvents(rawEvents);

  for (const event of deduped.events) {
    const sourceGroupId = event.metadata.sourceGroupId || event.sourceId;
    addUsageEvent(usage, event.timestampMs, event.usage, now);
    addGroupedUsage(byProvider, event.providerId, event.usage, event.timestampMs, now);
    addGroupedUsage(bySource, sourceGroupId, event.usage, event.timestampMs, now);
    const day = new Date(event.timestampMs).toISOString().slice(0, 10);
    if (!dailySourceMap.has(day)) dailySourceMap.set(day, new Map());
    const sourceTotals = addGroupedUsage(dailySourceMap.get(day), sourceGroupId, event.usage, event.timestampMs, now);
    if (event.model) {
      if (!sourceTotals.modelMap) sourceTotals.modelMap = new Map();
      addGroupedUsage(sourceTotals.modelMap, event.model, event.usage, event.timestampMs, now);
    }
  }

  return {
    totals: finalizeUsageAccumulator(usage),
    daily: buildDaily(usage.dailyMap, dailyHistoryDays).map((row) => ({
      ...row,
      sources: buildDailySources(dailySourceMap.get(row.date))
    })),
    sources: Array.from(bySource.entries()).map(([id, totals]) => ({
      id,
      status: totals.allTime.totalTokens > 0 ? "live" : "empty",
      totalTokens: totals.allTime.totalTokens,
      last24hTokens: totals.last24h.totalTokens,
      totals: finalizeUsageAccumulator(totals)
    })),
    providers: Array.from(byProvider.entries()).map(([id, totals]) => ({
      id,
      totalTokens: totals.allTime.totalTokens,
      totals: finalizeUsageAccumulator(totals)
    })),
    stats: {
      eventsAccepted: deduped.events.length,
      duplicatesSkipped: deduped.duplicatesSkipped,
      bySource: deduped.bySource
    }
  };
}

function createUsageAccumulator() {
  return {
    allTime: createUsageTotals(),
    last5h: createUsageTotals(),
    last24h: createUsageTotals(),
    last7d: createUsageTotals(),
    dailyMap: new Map()
  };
}

function addUsageEvent(accumulator, timestampMs, usage, now = Date.now()) {
  addUsage(accumulator.allTime, usage);
  if (now - timestampMs <= 5 * 60 * 60 * 1000) addUsage(accumulator.last5h, usage);
  if (now - timestampMs <= 24 * 60 * 60 * 1000) addUsage(accumulator.last24h, usage);
  if (now - timestampMs <= 7 * 24 * 60 * 60 * 1000) addUsage(accumulator.last7d, usage);
  const day = new Date(timestampMs).toISOString().slice(0, 10);
  if (!accumulator.dailyMap.has(day)) accumulator.dailyMap.set(day, createUsageTotals());
  addUsage(accumulator.dailyMap.get(day), usage);
}

function finalizeUsageAccumulator(accumulator) {
  return {
    allTime: accumulator.allTime,
    last5h: accumulator.last5h,
    last24h: accumulator.last24h,
    last7d: accumulator.last7d
  };
}

function buildDaily(dailyMap, dailyHistoryDays) {
  return Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-dailyHistoryDays)
    .map(([date, usage]) => ({ date, ...usage }));
}

function buildDailySources(sourceMap) {
  if (!sourceMap) return [];
  return Array.from(sourceMap.entries())
    .map(([id, totals]) => {
      const models = buildModelBreakdown(totals.modelMap);
      return {
        id,
        ...totals.allTime,
        ...(models.length ? { models } : {})
      };
    })
    .filter((source) => source.totalTokens > 0);
}

function addGroupedUsage(map, id, usage, timestampMs, now) {
  if (!map.has(id)) map.set(id, createUsageAccumulator());
  const accumulator = map.get(id);
  addUsageEvent(accumulator, timestampMs, usage, now);
  return accumulator;
}

function buildModelBreakdown(modelMap) {
  if (!modelMap) return [];
  return Array.from(modelMap.entries())
    .map(([model, totals]) => ({ model, ...totals.allTime }))
    .filter((row) => row.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens || String(a.model).localeCompare(String(b.model)));
}

function createUsageTotals() {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function normalizeUsage(usage) {
  const totals = createUsageTotals();
  addUsage(totals, usage);
  return totals;
}

function addUsage(target, usage) {
  const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0);
  const cached = Number(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cachedInputTokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
  const reasoning = Number(usage.reasoning_output_tokens ?? usage.thoughts_token_count ?? usage.reasoningOutputTokens ?? 0);
  const explicitTotal = usage.total_tokens ?? usage.totalTokens;
  const total = Number(explicitTotal ?? input + cacheCreation + cached + output + reasoning);
  target.inputTokens += Number.isFinite(input) ? input : 0;
  target.cacheCreationInputTokens += Number.isFinite(cacheCreation) ? cacheCreation : 0;
  target.cachedInputTokens += Number.isFinite(cached) ? cached : 0;
  target.outputTokens += Number.isFinite(output) ? output : 0;
  target.reasoningOutputTokens += Number.isFinite(reasoning) ? reasoning : 0;
  target.totalTokens += Number.isFinite(total) ? total : 0;
}

function normalizeEvidence(evidence) {
  const value = evidence && typeof evidence === "object" ? evidence : {};
  return {
    realpath: value.realpath ? String(value.realpath) : null,
    realpathHash: value.realpathHash ? String(value.realpathHash) : null,
    line: normalizeOptionalNumber(value.line),
    index: normalizeOptionalNumber(value.index),
    eventIndex: normalizeOptionalNumber(value.eventIndex),
    sessionId: value.sessionId ? String(value.sessionId) : null,
    rolloutSessionId: value.rolloutSessionId ? String(value.rolloutSessionId) : null,
    requestId: value.requestId ? String(value.requestId) : null,
    messageId: value.messageId ? String(value.messageId) : null,
    uuid: value.uuid ? String(value.uuid) : null,
    sessionStart: value.sessionStart ? String(value.sessionStart) : null,
    sessionStartTime: value.sessionStartTime ? String(value.sessionStartTime) : null
  };
}

function normalizeOptionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function eventHash(event) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      timestampMs: event.timestampMs,
      model: event.model || null,
      usage: event.usage,
      eventId: event.eventId || null
    }))
    .digest("hex")
    .slice(0, 20);
}

function hashEvidencePath(filePath) {
  return crypto.createHash("sha256").update(String(filePath || "")).digest("hex").slice(0, 24);
}

module.exports = {
  aggregateUsageEvents,
  createUsageTotals,
  dedupeUsageEvents,
  eventDedupeKey,
  hashEvidencePath,
  normalizeUsage,
  normalizeUsageEvent
};
