"use strict";

const crypto = require("node:crypto");
const { normalizeUsage, createUsageTotals, normalizeAttribution, mergeAttribution } = require("./usage-events");

const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ID = /^[a-f0-9]{64}$/;
const KINDS = new Set(["codex", "claudeCode", "multica", "other"]);

function safeChatTitle(value) {
  if (typeof value !== "string") return null;
  return value.replace(/[\x00-\x1f\x7f<>]/g, " ")
    .replace(/(?:Bearer\s+|sk-(?:ant-)?)[a-zA-Z0-9_\-.]{12,}/gi, "[redacted]")
    .replace(/(^|[\s("'=])(?:\/(?!\/)|[A-Z]:[\\/]|\\\\)[^\s"'<>]+/gi, "$1[path]")
    .replace(/\s+/g, " ").trim().slice(0, 180) || null;
}

// Only explicit session/ticket metadata is used. Message bodies are never a
// fallback title, and a path or the current login is never a ticket identity.
function conversationDescriptor(providerId, sessionId, metadata = {}) {
  if (typeof sessionId !== "string" || !sessionId.trim()) return null;
  const session = hash(["session", providerId, sessionId]);
  const issueId = typeof metadata.issueId === "string" && metadata.issueId ? metadata.issueId : null;
  const multica = metadata.kind === "multica" || Boolean(issueId);
  return sanitizeConversation({
    id: issueId ? hash(["multica", metadata.workspaceId || "", issueId]) : session,
    sessionId: session,
    runId: metadata.runId ? hash(["multica-run", metadata.workspaceId || "", metadata.runId]) : session,
    title: metadata.title,
    runTitle: metadata.runTitle,
    kind: multica ? "multica" : ["codex", "claudeCode"].includes(providerId) ? providerId : "other",
    identifier: metadata.identifier,
    linked: Boolean(issueId)
  });
}

function sanitizeConversation(value) {
  if (!value || !ID.test(value.id || "") || !ID.test(value.sessionId || "") || !KINDS.has(value.kind)) return null;
  return {
    id: value.id, sessionId: value.sessionId,
    runId: ID.test(value.runId || "") ? value.runId : value.sessionId,
    kind: value.kind, title: safeChatTitle(value.title), runTitle: safeChatTitle(value.runTitle),
    identifier: /^[A-Z][A-Z0-9]{1,19}-\d{1,12}$/.test(value.identifier || "") ? value.identifier : null,
    linked: value.kind === "multica" && value.linked === true,
    ...(value.conflict === true ? { conflict: true } : {})
  };
}

function mergeConversations(left, right) {
  const a = sanitizeConversation(left), b = sanitizeConversation(right);
  if (!a) return b;
  if (!b) return a;
  if (a.conflict || b.conflict || (a.linked && b.linked && a.id !== b.id)) {
    return { id: a.sessionId, sessionId: a.sessionId, runId: a.sessionId, kind: "multica",
      title: null, runTitle: null, identifier: null, linked: false, conflict: true };
  }
  if (b.linked && !a.linked) return b;
  return { ...a, title: a.title || b.title, runTitle: a.runTitle || b.runTitle };
}

function createChatUsageIndex(events = []) {
  const seen = new Map();
  let duplicatesSkipped = 0;
  for (const raw of events) {
    if (!raw) continue;
    const usage = normalizeUsage(raw.usage || {});
    const timestampMs = Number(raw.timestampMs);
    if (!(usage.totalTokens > 0) || !Number.isFinite(timestampMs)) continue;
    const conversation = sanitizeConversation(raw.conversation || raw.metadata?.conversation);
    const evidence = raw.evidence || {};
    // The sync identity is used locally too, so copied transcripts and paired
    // installations count the same request once. Keep unknown events in coverage.
    const stable = raw.syncKey || raw.eventId;
    const key = raw.syncKey || (raw.providerId === "claudeCode" && stable
      ? hash([raw.providerId, stable])
      : raw.providerId === "codex" && evidence.sessionId
        ? hash([raw.providerId, evidence.sessionId, timestampMs, raw.model, usage])
        : stable ? hash([raw.providerId, stable])
          : hash([raw.providerId, evidence.realpath || evidence.realpathHash, evidence.line, timestampMs, raw.model, usage]));
    const existing = seen.get(key);
    if (existing) {
      duplicatesSkipped += 1;
      existing.attribution = mergeAttribution(existing.attribution, raw.attribution);
      // A newer device may supply metadata absent in an older signed snapshot.
      existing.conversation = mergeConversations(existing.conversation, conversation);
      continue;
    }
    duplicatesSkipped += Math.max(0, Number(raw.observationCount || 1) - 1);
    seen.set(key, { timestampMs, providerId: raw.providerId,
      sourceId: raw.metadata?.sourceGroupId || raw.providerId,
      model: typeof raw.model === "string" ? raw.model.slice(0, 160) : null,
      usage, conversation, attribution: normalizeAttribution(raw.attribution) });
  }
  return { events: [...seen.values()], duplicatesSkipped, generatedAt: new Date().toISOString() };
}

function periodStart(period, timeZone, now = Date.now()) {
  if (!["all", "month", "week", "today", "h24"].includes(period)) throw Object.assign(new Error("invalid_period"), { statusCode: 400 });
  // Validate even for an all-time query; arbitrary timezone strings never reach Intl.
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  if (period === "all") return -Infinity;
  if (period !== "today") return now - ({ month: 30, week: 7, h24: 1 }[period]) * 86_400_000;
  const day = (at) => formatter.format(at);
  const today = day(now);
  let left = now - 28 * 3_600_000, right = now;
  // Find local midnight without assuming a fixed offset or 24-hour DST day.
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if (day(middle) === today) right = middle;
    else left = middle;
  }
  return right;
}

function addTotals(target, usage) {
  for (const key of Object.keys(createUsageTotals())) target[key] += usage[key] || 0;
}

function addModel(map, event) {
  const key = JSON.stringify([event.sourceId, event.model]);
  if (!map.has(key)) map.set(key, { sourceId: event.sourceId, model: event.model, ...createUsageTotals() });
  addTotals(map.get(key), event.usage);
}

function queryChatUsage(index, { period = "all", timeZone = "UTC", id = null, now = Date.now(), multicaStatus = "not_configured" } = {}) {
  const start = periodStart(period, timeZone, now);
  const rows = new Map();
  const coverage = { totalTokens: 0, assignedTokens: 0, unassignedTokens: 0, metadataUnavailableTokens: 0,
    duplicatesSkipped: index.duplicatesSkipped, multicaStatus };
  for (const event of index.events) {
    if (event.timestampMs < start || event.timestampMs > now) continue;
    coverage.totalTokens += event.usage.totalTokens;
    const chat = event.conversation;
    if (!chat) { coverage.unassignedTokens += event.usage.totalTokens; continue; }
    coverage.assignedTokens += event.usage.totalTokens;
    if (!chat.title || (chat.kind === "multica" && !chat.linked)) coverage.metadataUnavailableTokens += event.usage.totalTokens;
    if (id && chat.id !== id) continue;
    if (!rows.has(chat.id)) rows.set(chat.id, { id: chat.id, title: chat.title, kind: chat.kind,
      identifier: chat.identifier, linked: chat.linked, usage: createUsageTotals(), models: new Map(),
      providers: new Set(), sessions: new Set(), runs: new Map(), first: Infinity, last: -Infinity, eventCount: 0 });
    const row = rows.get(chat.id);
    row.title ||= chat.title;
    row.identifier ||= chat.identifier;
    row.providers.add(event.providerId);
    row.sessions.add(chat.sessionId);
    addTotals(row.usage, event.usage);
    addModel(row.models, event);
    row.first = Math.min(row.first, event.timestampMs); row.last = Math.max(row.last, event.timestampMs); row.eventCount += 1;
    if (id) {
      // A run can contain multiple provider sessions. Keep the provider edge
      // explicit instead of inventing one provider for a mixed run.
      const runKey = `${chat.runId}:${event.providerId}`;
      if (!row.runs.has(runKey)) row.runs.set(runKey, { id: chat.runId, title: chat.runTitle, providerId: event.providerId,
        usage: createUsageTotals(), models: new Map(), first: Infinity, last: -Infinity, eventCount: 0 });
      const run = row.runs.get(runKey);
      addTotals(run.usage, event.usage); addModel(run.models, event);
      run.first = Math.min(run.first, event.timestampMs); run.last = Math.max(run.last, event.timestampMs); run.eventCount += 1;
    }
  }
  const finish = (row) => ({ id: row.id, title: row.title, usage: row.usage,
    models: [...row.models.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    firstAt: new Date(row.first).toISOString(), lastAt: new Date(row.last).toISOString(), eventCount: row.eventCount });
  const summaries = [...rows.values()].map((row) => ({ ...finish(row), kind: row.kind,
    identifier: row.identifier, linked: row.linked, providers: [...row.providers].sort(), sessionCount: row.sessions.size,
    ...(id ? { runs: [...row.runs.values()].map((run) => ({ ...finish(run), providerId: run.providerId })).sort((a, b) => a.firstAt.localeCompare(b.firstAt)) } : {})
  })).sort((a, b) => b.usage.totalTokens - a.usage.totalTokens || a.id.localeCompare(b.id));
  return { ...(id ? { row: summaries[0] || null } : { rows: summaries }), coverage,
    generatedAt: index.generatedAt, period, timeZone };
}

module.exports = { conversationDescriptor, sanitizeConversation, mergeConversations, safeChatTitle, createChatUsageIndex, queryChatUsage, periodStart };
