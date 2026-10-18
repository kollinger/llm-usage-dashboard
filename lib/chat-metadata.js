"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const CACHE_MS = 60_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SESSION_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const ISSUE_IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]{0,30}-\d{1,12}$/;

// These values are labels, never transcript text. Keep all other Multica fields,
// especially result.output, work_dir, attribution and credentials, private.
function safeTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\x00-\x1f\x7f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return title || null;
}

function safeId(value) {
  return typeof value === "string" && SESSION_ID.test(value) ? value : null;
}

async function readJson(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch { return null; }
}

function safeRun(run) {
  const id = safeId(run?.id);
  if (!id) return null;
  return { id, kind: safeTitle(run.kind), status: safeTitle(run.status),
    startedAt: validDate(run.started_at), completedAt: validDate(run.completed_at) };
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function createChatMetadataReader(options = {}) {
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const fetcher = options.fetch || globalThis.fetch;
  const configOptions = options.multica || {};
  const now = options.now || Date.now;
  const apiCache = new Map();
  const taskMetadataCache = new Map();
  const runScans = new Map();
  let cachedIndex = null;
  let cachedIndexAt = 0;
  let cachedIndexKey = "";
  let enrichment = null;
  let enrichmentKey = "";
  let enriched = null;
  let enrichedAt = 0;

  async function apiJson(config, suffix, signal) {
    const url = new URL(suffix, config.serverUrl);
    url.searchParams.set("workspace_id", config.workspaceId);
    const key = `${config.serverUrl}|${config.workspaceId}|${url.pathname}${url.search}`;
    const cached = apiCache.get(key);
    if (cached && now() - cached.at < CACHE_MS) {
      if (cached.failed) throw new Error("metadata_unavailable");
      return cached.value;
    }
    let response;
    try {
      response = await fetcher(url, { method: "GET", redirect: "error",
        headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000) });
    } catch {
      apiCache.set(key, { at: now(), failed: true });
      throw new Error("metadata_unavailable");
    }
    if (!response.ok) throw new Error("metadata_unavailable");
    const length = Number(response.headers?.get?.("content-length") || 0);
    if (length > MAX_FILE_BYTES) throw new Error("metadata_too_large");
    let value;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_FILE_BYTES) throw new Error("metadata_too_large");
          chunks.push(Buffer.from(part.value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } else value = await response.json();
    // Do not retain full issue descriptions or agent output in a metadata cache.
    if (url.pathname === "/api/issues") {
      const rows = Array.isArray(value) ? value : value?.issues;
      if (Array.isArray(rows)) value = { issues: rows.map((row) => ({ id: row.id, identifier: row.identifier, title: row.title,
        updated_at: row.updated_at, last_activity_at: row.last_activity_at })), total: Array.isArray(value) ? rows.length : value.total };
    } else if (url.pathname.endsWith("/task-runs")) {
      const rows = Array.isArray(value) ? value : value?.runs;
      if (Array.isArray(rows)) value = rows.map((row) => ({ id: row.id, kind: row.kind, status: row.status,
        started_at: row.started_at, completed_at: row.completed_at, session_id: row.session_id,
        result: { session_id: row.result?.session_id } }));
    }
    apiCache.set(key, { at: now(), value });
    // Cache only metadata endpoints and keep a bounded history in long sessions.
    if (apiCache.size > 150) apiCache.delete(apiCache.keys().next().value);
    return value;
  }

  async function multicaConfig() {
    if (configOptions.enabled === false || env.LLM_USAGE_MULTICA_ENABLED === "0") return null;
    const profile = configOptions.profile || env.LLM_USAGE_MULTICA_PROFILE || env.MULTICA_PROFILE;
    const configFile = configOptions.configFile || env.LLM_USAGE_MULTICA_CONFIG_FILE
      || (profile && /^[a-zA-Z0-9_.-]{1,100}$/.test(profile)
        ? path.join(home, ".multica", "profiles", profile, "config.json") : path.join(home, ".multica", "config.json"));
    const disk = await readJson(configFile) || {};
    const serverUrl = configOptions.serverUrl || env.LLM_USAGE_MULTICA_SERVER_URL || disk.server_url;
    const workspaceId = safeId(configOptions.workspaceId || env.LLM_USAGE_MULTICA_WORKSPACE_ID || disk.workspace_id);
    const token = configOptions.token || env.LLM_USAGE_MULTICA_TOKEN || disk.token;
    if (!serverUrl || !workspaceId || typeof token !== "string" || !token.trim()) return null;
    try {
      const url = new URL(serverUrl);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
      return { serverUrl: `${url.origin}/`, workspaceId, token };
    } catch { return null; }
  }

  async function nativeTitles(codexHomes) {
    const roots = [...new Set((codexHomes || []).filter((entry) => typeof entry === "string" && entry))];
    const key = JSON.stringify(roots);
    if (cachedIndex && cachedIndexKey === key && now() - cachedIndexAt < CACHE_MS) return cachedIndex;
    const result = Object.create(null);
    for (const root of roots) {
      try {
        const file = path.join(root, "session_index.jsonl");
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        for (const line of (await fs.readFile(file, "utf8")).split(/\r?\n/)) {
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          const id = safeId(row.id || row.thread_id);
          const title = safeTitle(row.thread_name || row.title);
          if (id && title) result[`codex:${id}`] = { title };
        }
      } catch { /* Missing native index is an honest title coverage gap. */ }
    }
    cachedIndex = result; cachedIndexAt = now(); cachedIndexKey = key;
    return result;
  }

  async function nearbyTaskMetadata(file) {
    if (typeof file !== "string" || !file) return null;
    let current = path.dirname(path.resolve(file));
    for (let depth = 0; depth < 8; depth += 1) {
      const metaFile = path.join(current, ".gc_meta.json");
      let cached = taskMetadataCache.get(metaFile);
      if (!cached || now() - cached.at >= CACHE_MS) {
        cached = { at: now(), value: readJson(metaFile) };
        taskMetadataCache.set(metaFile, cached);
        if (taskMetadataCache.size > 6000) taskMetadataCache.delete(taskMetadataCache.keys().next().value);
      }
      const meta = await cached.value;
      if (meta && safeId(meta.issue_id)) return { issueId: safeId(meta.issue_id), workspaceId: safeId(meta.workspace_id), runId: safeId(meta.task_id) };
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return null;
  }

  async function read(input = {}) {
    const codexHomes = input.codexHomes || options.codexHomes || [env.CODEX_HOME || path.join(home, ".codex")];
    const sessions = { ...await nativeTitles(codexHomes) };
    const files = Object.create(null);
    const records = (input.sessions || []).filter((row) => row && ["codex", "claudeCode"].includes(row.providerId) && safeId(row.sessionId));
    const candidates = new Set();
    const knownSessions = new Map();
    const taskMemo = new Map();
    for (const row of records) {
      const key = `${row.providerId}:${row.sessionId}`;
      knownSessions.set(row.sessionId, row.providerId);
      const directory = typeof row.file === "string" ? path.dirname(row.file) : null;
      if (directory && !taskMemo.has(directory)) taskMemo.set(directory, nearbyTaskMetadata(row.file));
      let task = directory ? await taskMemo.get(directory) : null;
      if (!task && typeof row.cwd === "string" && row.cwd) {
        const cwdKey = `cwd:${row.cwd}`;
        if (!taskMemo.has(cwdKey)) taskMemo.set(cwdKey, nearbyTaskMetadata(path.join(row.cwd, ".metadata-probe")));
        task = await taskMemo.get(cwdKey);
      }
      const isMultica = row.originator === "multica-agent-sdk" || Boolean(task)
        || typeof row.file === "string" && /(?:^|[\\/])multica-sessions(?:[\\/]|$)/.test(row.file);
      if (isMultica) sessions[key] = { ...sessions[key], kind: "multica", ...(task || {}) };
      if (task?.issueId) candidates.add(task.issueId);
      // A path only selects an API candidate; it never proves the final join.
      const hints = String(row.cwd || "").match(/\b[a-zA-Z][a-zA-Z0-9_]{0,30}-\d{1,12}\b/g) || [];
      for (const hint of hints) candidates.add(hint.toUpperCase());
      if (directory && task) files[path.resolve(row.file)] = sessions[key];
    }
    const config = await multicaConfig();
    if (!config) return { sessions, files, multicaStatus: "not_configured" };
    if (typeof fetcher !== "function") return { sessions, files, multicaStatus: "unavailable" };
    const configKey = `${config.serverUrl}|${config.workspaceId}`;
    const cachedResult = () => {
      if (enriched && enrichmentKey === configKey) {
        for (const [key, value] of Object.entries(enriched.sessions)) {
          if (value.kind === "multica") sessions[key] = { ...sessions[key], ...value };
        }
        return { sessions, files, multicaStatus: enriched.multicaStatus };
      }
      return { sessions, files, multicaStatus: "partial" };
    };
    if (enrichment && enrichmentKey === configKey) return cachedResult();
    if (enriched && enrichmentKey === configKey && enriched.multicaStatus !== "partial" && now() - enrichedAt < CACHE_MS) return cachedResult();
    if (enrichmentKey === configKey) cachedResult();
    else { enriched = null; enrichedAt = 0; }
    enrichmentKey = configKey;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 12_000);
    deadline.unref?.();
    async function enrich() {
    let partial = false;
    let failed = false;
    const issues = [];
    const maxIssues = Math.max(1, Math.min(2000, Number(configOptions.maxIssues) || 1000));
    try {
      for (let offset = 0; offset < maxIssues; offset += 100) {
        const data = await apiJson(config, `/api/issues?limit=100&offset=${offset}`, controller.signal);
        const rows = Array.isArray(data) ? data : data?.issues;
        if (!Array.isArray(rows)) throw new Error("metadata_shape");
        issues.push(...rows);
        const total = Number(data?.total);
        if (rows.length < 100 || Number.isFinite(total) && issues.length >= total) break;
        if (offset + 100 >= maxIssues) partial = true;
      }
    } catch { failed = true; }
    const issueMap = new Map();
    for (const issue of issues) {
      const id = safeId(issue.id);
      const identifier = typeof issue.identifier === "string" && ISSUE_IDENTIFIER.test(issue.identifier) ? issue.identifier : null;
      if (!id) continue;
      const descriptor = { issueId: id, identifier, title: safeTitle(issue.title), workspaceId: config.workspaceId };
      issueMap.set(id, descriptor);
      if (identifier) issueMap.set(identifier.toUpperCase(), descriptor);
    }
    // .gc_meta is exact even when a task has not yet produced result.session_id.
    for (const value of Object.values(sessions)) {
      const issue = issueMap.get(value.issueId);
      if (issue && (!value.workspaceId || value.workspaceId === config.workspaceId)) Object.assign(value, issue, { kind: "multica" });
    }
    const selected = [];
    const selectedIds = new Set();
    const issueVersions = new Map(issues.map((issue) => [issue.id, JSON.stringify([issue.updated_at || "", issue.last_activity_at || ""])]));
    const scanKey = (id) => `${configKey}|${id}`;
    const needsVersion = (id) => {
      const scan = runScans.get(scanKey(id));
      return !scan || scan.version !== issueVersions.get(id) || !scan.ok;
    };
    const canScan = (id) => {
      const scan = runScans.get(scanKey(id));
      return !scan || scan.ok || now() - scan.at >= CACHE_MS;
    };
    for (const candidate of candidates) {
      const issue = issueMap.get(candidate);
      if (issue && needsVersion(issue.issueId) && canScan(issue.issueId) && !selectedIds.has(issue.issueId)) { selected.push(issue); selectedIds.add(issue.issueId); }
    }
    // Recent candidates help sessions with a stable project cwd. A fixed cap
    // keeps an optional integration from turning refresh into a workspace crawl.
    const maxRunIssues = Math.max(1, Math.min(100, Number(configOptions.maxRunIssues) || 24));
    if (records.length) {
      for (const issue of [...issues].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))) {
        if (selected.length >= maxRunIssues) break;
        if (issueMap.has(issue.id) && needsVersion(issue.id) && canScan(issue.id) && !selectedIds.has(issue.id)) { selected.push(issueMap.get(issue.id)); selectedIds.add(issue.id); }
      }
    }
    // Refresh old successful joins after unseen/changed tickets. Remembered
    // versions give every ticket a turn across bounded background batches.
    for (const issue of [...issues].sort((a, b) => (runScans.get(scanKey(a.id))?.at || 0) - (runScans.get(scanKey(b.id))?.at || 0))) {
      if (selected.length >= maxRunIssues) break;
      const scan = runScans.get(scanKey(issue.id));
      if (issueMap.has(issue.id) && scan?.ok && now() - scan.at >= CACHE_MS && !selectedIds.has(issue.id)) { selected.push(issueMap.get(issue.id)); selectedIds.add(issue.id); }
    }
    if (selected.length > maxRunIssues) partial = true;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, selected.length, maxRunIssues) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= Math.min(selected.length, maxRunIssues)) break;
        const issue = selected[index];
        try {
          const data = await apiJson(config, `/api/issues/${encodeURIComponent(issue.issueId)}/task-runs`, controller.signal);
          const runs = Array.isArray(data) ? data : data?.runs;
          if (!Array.isArray(runs)) throw new Error("metadata_shape");
          runScans.set(scanKey(issue.issueId), { at: now(), version: issueVersions.get(issue.issueId), ok: true });
          for (const run of runs) {
            const sessionId = safeId(run.result?.session_id || run.session_id);
            const descriptor = safeRun(run);
            if (!sessionId || !descriptor) continue;
            const provider = knownSessions.get(sessionId);
            // UUID namespace does not identify the provider. Without a local
            // session match, retain both candidates for a future parser lookup.
            for (const providerId of provider ? [provider] : ["codex", "claudeCode"]) {
              const key = `${providerId}:${sessionId}`;
              const previous = sessions[key] || {};
              if (previous.issueId && previous.issueId !== issue.issueId) { sessions[key] = { kind: "multica", conflict: true }; partial = true; continue; }
              if (previous.conflict) continue;
              const joinedRuns = [...(previous.runs || [])];
              if (!joinedRuns.some((entry) => entry.id === descriptor.id)) joinedRuns.push(descriptor);
              sessions[key] = { ...previous, ...issue, kind: "multica", runId: descriptor.id, runTitle: descriptor.kind, runs: joinedRuns };
            }
          }
        } catch { failed = true; runScans.set(scanKey(issue.issueId), { at: now(), version: issueVersions.get(issue.issueId), ok: false }); }
      }
    }));
    if (issues.some((issue) => issueMap.has(issue.id) && needsVersion(issue.id))) partial = true;
    if (records.some((row) => sessions[`${row.providerId}:${row.sessionId}`]?.kind === "multica" && !sessions[`${row.providerId}:${row.sessionId}`]?.issueId)) partial = true;
    return { sessions, files, multicaStatus: failed ? issues.length ? "partial" : "unavailable" : partial ? "partial" : "ready" };
    }
    const job = enrich().catch(() => ({ sessions, files, multicaStatus: "unavailable" })).then((result) => {
      if (enrichmentKey === configKey) {
        const priorSessions = enriched?.sessions || {};
        for (const [key, value] of Object.entries(priorSessions)) {
          if (value.kind === "multica" && !result.sessions[key]?.issueId && !result.sessions[key]?.conflict) result.sessions[key] = { ...result.sessions[key], ...value };
        }
        enriched = result; enrichedAt = now();
      }
      return result;
    }).finally(() => { clearTimeout(deadline); if (enrichment === job) enrichment = null; });
    enrichment = job;
    // The optional service must not hold up a provider scan. Subsequent scans
    // receive progressive cached joins while the bounded read finishes.
    let timer;
    const early = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 750); });
    const result = await Promise.race([job, early]);
    clearTimeout(timer);
    return result || cachedResult();
  }

  return { read };
}

module.exports = { createChatMetadataReader, safeTitle };
