"use strict";

const crypto = require("node:crypto");

const DEFAULT_SLOT_MINUTES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_ID = /^(?:gpt|claude|kimi|glm|openai|anthropic|moonshot)-[a-f0-9]{16,64}$/;
const safeLabel = (value) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f<>]/g, "").trim().slice(0, 100) || null : null;

function normalizeAttribution(value = {}) {
  const observedOn = [...new Map((Array.isArray(value.observedOn) ? value.observedOn : []).slice(0, 40)
    .filter((device) => device && /^(?:local|[a-f0-9]{32})$/.test(device.id || ""))
    .map((device) => [device.id, { id: device.id, label: safeLabel(device.label || device.name) }])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const conflict = value.accountQuality === "conflict" || value.accountConflict === true;
  const accountId = !conflict && ACCOUNT_ID.test(value.accountId || "") ? value.accountId : null;
  const providerLabel = { gpt: "GPT", claude: "Claude", kimi: "Kimi", glm: "GLM", openai: "OpenAI", anthropic: "Anthropic", moonshot: "Moonshot" }[accountId?.split("-")[0]];
  return { observedOn, accountId, accountLabel: accountId ? safeLabel(value.accountLabel) || `${providerLabel} · ${accountId.slice(-6)}` : null,
    accountQuality: conflict ? "conflict" : accountId ? "recorded" : "unknown" };
}

// Explicit identity recorded with a provider event/session. Never consult the
// current login: credentials observed today cannot identify historical usage.
function recordedAccountAttribution(providerId, record) {
  if (!record || typeof record !== "object") return null;
  const account = record.account && typeof record.account === "object" ? record.account : {};
  const fields = providerId === "codex" ? ["chatgpt_account_id", "account_id", "accountId"] : ["account_uuid", "account_id", "accountId"];
  if (!fields.some((key) => Object.hasOwn(record, key)) && !Object.hasOwn(account, "id") && !Object.hasOwn(account, "uuid")) return null;
  const id = fields.map((key) => record[key]).find((value) => typeof value === "string" && value.trim()) || account.uuid || account.id;
  if (typeof id !== "string" || !id.trim() || id.length > 320 || /[\x00-\x1f\x7f]/.test(id)) return normalizeAttribution();
  const normalized = id.trim();
  let accountId;
  if (providerId === "codex" || providerId === "openCode") {
    const email = typeof account.email === "string" && /^[^\s@]+@[^\s@]+$/.test(account.email.trim()) ? account.email.trim().toLowerCase() : null;
    accountId = `gpt-${crypto.createHash("sha256").update(`llm-usage-dashboard:${email ? `email:${email}` : `account:${normalized}`}`).digest("hex").slice(0, 16)}`;
  } else if (providerId === "claudeCode") {
    const org = record.orgId || record.organization_id || account.orgId || account.organization_id || null;
    accountId = `claude-${crypto.createHash("sha256").update(JSON.stringify([normalized, typeof org === "string" ? org : null])).digest("hex").slice(0, 24)}`;
  } else return null;
  return normalizeAttribution({ accountId });
}

function mergeAttribution(left, right) {
  const a = normalizeAttribution(left), b = normalizeAttribution(right);
  const conflict = a.accountQuality === "conflict" || b.accountQuality === "conflict" || (a.accountId && b.accountId && a.accountId !== b.accountId);
  return normalizeAttribution({ observedOn: [...a.observedOn, ...b.observedOn], accountId: conflict ? null : a.accountId || b.accountId,
    accountLabel: conflict ? null : a.accountLabel || b.accountLabel, accountQuality: conflict ? "conflict" : "recorded" });
}

function attributionBucket(event) {
  const value = event.attribution || normalizeAttribution();
  const devices = value.observedOn;
  return { deviceId: devices.length > 1 ? "shared" : devices[0]?.id || "unknown",
    deviceLabel: devices.length === 1 ? devices[0].label : null,
    deviceQuality: devices.length > 1 ? "ambiguous" : devices.length ? "observed" : "unknown",
    accountId: value.accountId || "unknown", accountLabel: value.accountLabel, accountQuality: value.accountQuality,
    observedOn: devices };
}

function addAttribution(map, event) {
  const bucket = attributionBucket(event);
  const key = JSON.stringify([bucket.deviceId, bucket.accountId, bucket.accountQuality]);
  if (!map.has(key)) map.set(key, { ...bucket, ...createUsageTotals(), modelMap: new Map() });
  const current = map.get(key);
  if (bucket.observedOn.some((device) => !current.observedOn.some((existing) => existing.id === device.id))) {
    current.observedOn = mergeAttribution({ observedOn: current.observedOn }, { observedOn: bucket.observedOn }).observedOn;
  }
  addUsage(current, event.usage);
  addAttributedModel(current.modelMap, { sourceId: event.metadata?.sourceGroupId || event.providerId, model: event.model }, event.usage);
}

function addAttributedModel(map, model, usage) {
  const key = JSON.stringify([model.sourceId, model.model || null]);
  if (!map.has(key)) map.set(key, { sourceId: model.sourceId, model: model.model || null, ...createUsageTotals() });
  addUsage(map.get(key), usage);
}

function sortedAttributedModels(map) {
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens || JSON.stringify([a.sourceId, a.model]).localeCompare(JSON.stringify([b.sourceId, b.model])));
}

function buildAttribution(map = new Map()) {
  const devices = new Map(), accounts = new Map();
  const combinations = [...map.values()].map(({ modelMap, ...row }) => ({ ...row, models: sortedAttributedModels(modelMap) }));
  for (const row of combinations) {
    if (!devices.has(row.deviceId)) devices.set(row.deviceId, { id: row.deviceId, label: row.deviceLabel, quality: row.deviceQuality, observedOn: [], ...createUsageTotals(), modelMap: new Map() });
    const device = devices.get(row.deviceId);
    device.observedOn = mergeAttribution({ observedOn: device.observedOn }, { observedOn: row.observedOn }).observedOn;
    addUsage(device, row);
    for (const model of row.models) addAttributedModel(device.modelMap, model, model);
    const key = row.accountId;
    if (!accounts.has(key)) accounts.set(key, { id: row.accountId, label: row.accountLabel, quality: row.accountQuality, ...createUsageTotals(), devices: new Map() });
    const account = accounts.get(key); addUsage(account, row);
    if (row.accountQuality === "conflict") account.quality = "conflict";
    if (!account.devices.has(row.deviceId)) account.devices.set(row.deviceId, { id: row.deviceId, label: row.deviceLabel, quality: row.deviceQuality, totalTokens: 0 });
    account.devices.get(row.deviceId).totalTokens += row.totalTokens;
  }
  const sorted = (rows) => rows.sort((a, b) => b.totalTokens - a.totalTokens || String(a.id || a.deviceId).localeCompare(String(b.id || b.deviceId)));
  return { devices: sorted([...devices.values()].map(({ modelMap, ...row }) => ({ ...row, models: sortedAttributedModels(modelMap) }))), accounts: sorted([...accounts.values()].map((row) => ({ ...row, devices: sorted([...row.devices.values()]) }))),
    combinations: sorted(combinations), coverage: {
      totalTokens: combinations.reduce((sum, row) => sum + row.totalTokens, 0),
      knownAccountTokens: combinations.filter((row) => row.accountQuality === "recorded").reduce((sum, row) => sum + row.totalTokens, 0),
      unknownAccountTokens: combinations.filter((row) => row.accountQuality !== "recorded").reduce((sum, row) => sum + row.totalTokens, 0),
      ambiguousDeviceTokens: combinations.filter((row) => row.deviceQuality === "ambiguous").reduce((sum, row) => sum + row.totalTokens, 0)
    } };
}

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
    attribution: normalizeAttribution(raw.attribution || raw.metadata?.attribution),
    evidence: normalizeEvidence(raw.evidence),
    metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}
  };
  event.dedupeKey = eventDedupeKey(event);
  return event;
}

function dedupeUsageEvents(rawEvents) {
  const seen = new Map();
  const accepted = [];
  let duplicatesSkipped = 0;
  const bySource = new Map();

  for (const raw of rawEvents || []) {
    const event = normalizeUsageEvent(raw);
    if (!event) continue;
    const key = event.dedupeKey;
    const sourceStats = bySource.get(event.sourceId) || { sourceId: event.sourceId, eventsAccepted: 0, duplicatesSkipped: 0 };
    if (seen.has(key)) {
      const prior = seen.get(key);
      prior.attribution = mergeAttribution(prior.attribution, event.attribution);
      duplicatesSkipped += 1;
      sourceStats.duplicatesSkipped += 1;
      bySource.set(event.sourceId, sourceStats);
      continue;
    }
    seen.set(key, event);
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
  const includeAttribution = options.includeAttribution !== false;
  const dailyHistoryDays = Number(options.dailyHistoryDays || 180);
  const now = Number(options.now || Date.now());
  const usage = createUsageAccumulator();
  const byProvider = new Map();
  const bySource = new Map();
  const dailySourceMap = new Map();
  const attributionMap = new Map();
  const dailyAttribution = new Map();
  const deduped = dedupeUsageEvents(rawEvents);

  for (const event of deduped.events) {
    const sourceGroupId = event.metadata.sourceGroupId || event.sourceId;
    const day = new Date(event.timestampMs).toISOString().slice(0, 10);
    addUsageEvent(usage, event.timestampMs, event.usage, now, day);
    addGroupedUsage(byProvider, event.providerId, event.usage, event.timestampMs, now);
    const groupedSourceTotals = addGroupedUsage(bySource, sourceGroupId, event.usage, event.timestampMs, now);
    addModelUsageBreakdown(groupedSourceTotals, event);
    if (includeAttribution) {
      addAttribution(attributionMap, event);
      if (!dailyAttribution.has(day)) dailyAttribution.set(day, new Map());
      addAttribution(dailyAttribution.get(day), event);
    }
    if (!dailySourceMap.has(day)) dailySourceMap.set(day, new Map());
    const sourceTotals = addGroupedUsage(dailySourceMap.get(day), sourceGroupId, event.usage, event.timestampMs, now);
    addModelUsageBreakdown(sourceTotals, event);
  }

  return {
    totals: finalizeUsageAccumulator(usage),
    ...(includeAttribution ? { attribution: buildAttribution(attributionMap) } : {}),
    daily: buildDaily(usage.dailyMap, dailyHistoryDays).map((row) => ({
      ...row,
      sources: buildDailySources(dailySourceMap.get(row.date)),
      ...(includeAttribution ? { attribution: buildAttribution(dailyAttribution.get(row.date)) } : {})
    })),
    sources: Array.from(bySource.entries()).map(([id, totals]) => {
      const models = buildModelBreakdown(totals.modelMap);
      return {
        id,
        status: totals.allTime.totalTokens > 0 ? "live" : "empty",
        totalTokens: totals.allTime.totalTokens,
        last24hTokens: totals.last24h.totalTokens,
        totals: finalizeUsageAccumulator(totals),
        ...(models.length ? { models } : {})
      };
    }),
    providers: Array.from(byProvider.entries()).map(([id, totals]) => ({
      id,
      totalTokens: totals.allTime.totalTokens,
      totals: finalizeUsageAccumulator(totals)
    })),
    slots: options.includeSlots === false ? undefined : buildRecentSlots(deduped.events, {
      now,
      slotMinutes: options.slotMinutes
    }),
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

function addUsageEvent(accumulator, timestampMs, usage, now, day) {
  addUsage(accumulator.allTime, usage);
  if (now - timestampMs <= 5 * 60 * 60 * 1000) addUsage(accumulator.last5h, usage);
  if (now - timestampMs <= 24 * 60 * 60 * 1000) addUsage(accumulator.last24h, usage);
  if (now - timestampMs <= 7 * 24 * 60 * 60 * 1000) addUsage(accumulator.last7d, usage);
  if (day === undefined) return;
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

function buildRecentSlots(events, options = {}) {
  const now = Number(options.now || Date.now());
  const slotMinutes = normalizeSlotMinutes(options.slotMinutes);
  const slotMs = slotMinutes * 60 * 1000;
  const endExclusive = Math.floor(now / slotMs) * slotMs + slotMs;
  const nowDate = new Date(now);
  const todayStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());

  return {
    slotMinutes,
    today: buildUsageSlots(events, todayStart, endExclusive, slotMs),
    last24h: buildUsageSlots(events, endExclusive - DAY_MS, endExclusive, slotMs)
  };
}

function normalizeSlotMinutes(value) {
  const minutes = Number(value || DEFAULT_SLOT_MINUTES);
  return Number.isFinite(minutes) && minutes >= 5 && minutes <= 60 ? minutes : DEFAULT_SLOT_MINUTES;
}

function buildUsageSlots(events, startMs, endExclusive, slotMs) {
  const slotMap = new Map();
  for (let cursor = startMs; cursor < endExclusive; cursor += slotMs) {
    slotMap.set(cursor, {
      slotStartMs: cursor,
      usage: createUsageTotals(),
      attribution: new Map(),
      sources: new Map()
    });
  }

  for (const event of Array.isArray(events) ? events : []) {
    const timestampMs = Number(event?.timestampMs);
    if (!Number.isFinite(timestampMs) || timestampMs < startMs || timestampMs >= endExclusive) continue;
    const slotStartMs = Math.floor(timestampMs / slotMs) * slotMs;
    const slot = slotMap.get(slotStartMs);
    if (!slot) continue;
    addUsage(slot.usage, event.usage || {});
    addAttribution(slot.attribution, event);
    const sourceGroupId = event.metadata?.sourceGroupId || event.sourceId || event.providerId || "local";
    if (!slot.sources.has(sourceGroupId)) slot.sources.set(sourceGroupId, createUsageAccumulator());
    const sourceTotals = slot.sources.get(sourceGroupId);
    addUsage(sourceTotals.allTime, event.usage || {});
    addModelUsageBreakdown(sourceTotals, event);
  }

  return Array.from(slotMap.values()).map((slot) => ({
    date: new Date(slot.slotStartMs).toISOString().slice(0, 10),
    slotStart: new Date(slot.slotStartMs).toISOString(),
    slotEnd: new Date(slot.slotStartMs + slotMs).toISOString(),
    ...slot.usage,
    attribution: buildAttribution(slot.attribution),
    sources: buildDailySources(slot.sources)
  }));
}

function addGroupedUsage(map, id, usage, timestampMs, now) {
  if (!map.has(id)) map.set(id, createUsageAccumulator());
  const accumulator = map.get(id);
  // Grouped accumulators expose rolling totals; only the root owns daily rows.
  addUsageEvent(accumulator, timestampMs, usage, now);
  return accumulator;
}

function buildModelBreakdown(modelMap) {
  if (!modelMap) return [];
  return Array.from(modelMap.entries())
    .map(([model, totals]) => {
      const reasoningEfforts = buildReasoningEffortBreakdown(totals.reasoningEffortMap);
      return {
        model,
        ...totals.allTime,
        ...(reasoningEfforts.length ? { reasoningEfforts } : {})
      };
    })
    .filter((row) => row.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens || String(a.model).localeCompare(String(b.model)));
}

function addModelUsageBreakdown(sourceTotals, event) {
  if (!sourceTotals || !event?.model) return;
  if (!sourceTotals.modelMap) sourceTotals.modelMap = new Map();
  if (!sourceTotals.modelMap.has(event.model)) sourceTotals.modelMap.set(event.model, createUsageAccumulator());
  const modelTotals = sourceTotals.modelMap.get(event.model);
  addUsage(modelTotals.allTime, event.usage || {});

  const effort = normalizeReasoningEffort(event.metadata?.reasoningEffort);
  if (!effort) return;
  if (!modelTotals.reasoningEffortMap) modelTotals.reasoningEffortMap = new Map();
  if (!modelTotals.reasoningEffortMap.has(effort)) {
    modelTotals.reasoningEffortMap.set(effort, createUsageAccumulator());
  }
  addUsage(modelTotals.reasoningEffortMap.get(effort).allTime, event.usage || {});
}

function buildReasoningEffortBreakdown(effortMap) {
  if (!effortMap) return [];
  return Array.from(effortMap.entries())
    .map(([effort, totals]) => ({ effort, ...totals.allTime }))
    .filter((row) => row.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens || String(a.effort).localeCompare(String(b.effort)));
}

function normalizeReasoningEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/u.test(effort) ? effort : null;
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
  normalizeUsageEvent,
  normalizeAttribution,
  mergeAttribution,
  buildAttribution,
  recordedAccountAttribution
};
