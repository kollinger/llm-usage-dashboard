"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { stableStringify, syncEventKey, TOKEN_FIELDS } = require("./sync-ledger");

const CLIENT_SETTINGS_VERSION = 1;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 60 * 60 * 1000;
const MAX_OUTBOX_EVENTS = 250_000;

class LocalSyncClient {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error("LocalSyncClient requires dataDir.");
    this.dataDir = path.resolve(options.dataDir);
    this.settingsFile = path.join(this.dataDir, "sync-client-settings.json");
    this.credentialsFile = path.join(this.dataDir, "sync-client-credentials.json");
    this.outboxFile = path.join(this.dataDir, "sync-client-outbox.json");
    this.ackedFile = path.join(this.dataDir, "sync-client-acked.json");
    this.statusFile = path.join(this.dataDir, "sync-client-status.json");
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.platform = safePlatform(options.platform || process.platform);
    this.appVersion = shortText(options.appVersion, "unknown", 80);
    this.collectorVersion = shortText(options.collectorVersion || options.appVersion, "unknown", 80);
    this.defaultServerUrl = options.serverUrl ? normalizeServerUrl(options.serverUrl) : "";
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;
    this.retryBaseMs = positiveInteger(options.retryBaseMs) || DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = positiveInteger(options.retryMaxMs) || DEFAULT_RETRY_MAX_MS;
    this._mutation = Promise.resolve();
  }

  async readSettings() {
    return readJson(this.settingsFile, defaultSettings({ serverUrl: this.defaultServerUrl })).then(normalizeSettings);
  }

  async updateSettings(patch = {}) {
    return this._mutate(async () => {
      const current = await this.readSettings();
      const next = normalizeSettings({
        ...current,
        ...(Object.hasOwn(patch, "enabled") ? { enabled: Boolean(patch.enabled) } : {}),
        ...(Object.hasOwn(patch, "serverUrl") ? { serverUrl: patch.serverUrl } : {}),
        ...(Object.hasOwn(patch, "deviceName") ? { deviceName: patch.deviceName } : {}),
        updatedAt: isoNow(this.now)
      });
      if (next.enabled && !next.serverUrl) {
        throw validationError("sync_server_required", "A sync server URL is required before enabling sync.");
      }
      await writeJsonAtomic(this.settingsFile, next);
      return this.readPublicStatusFrom(next);
    });
  }

  async attachConnection(connection, options = {}) {
    return this._mutate(async () => {
      const credentials = normalizeCredentials(connection);
      const current = await this.readSettings();
      const next = normalizeSettings({
        ...current,
        enabled: true,
        serverUrl: options.serverUrl || current.serverUrl,
        deviceName: options.deviceName || connection.device?.displayName || current.deviceName,
        updatedAt: isoNow(this.now)
      });
      if (!next.serverUrl) throw validationError("sync_server_required", "A sync server URL is required.");
      await writeJsonAtomic(this.credentialsFile, credentials);
      await writeJsonAtomic(this.settingsFile, next);
      await writeJsonAtomic(this.statusFile, defaultStatus());
      return this.readPublicStatusFrom(next, credentials);
    });
  }

  async join(input = {}) {
    const current = await this.readSettings();
    const settings = normalizeSettings({
      ...current,
      serverUrl: input.serverUrl || current.serverUrl,
      deviceName: input.deviceName || current.deviceName
    });
    if (!settings.serverUrl) throw validationError("sync_server_required", "A sync server URL is required.");
    const code = String(input.pairingCode || input.code || "").trim();
    if (!code) throw validationError("pairing_code_required", "A pairing code is required.");
    const connection = await this._request(settings.serverUrl, "/api/sync/devices", {
      method: "POST",
      body: {
        code,
        deviceName: settings.deviceName,
        platform: this.platform,
        appVersion: this.appVersion
      }
    });
    return this.attachConnection(connection, settings);
  }

  async createPairingCode(options = {}) {
    const { settings, credentials } = await this._requireConnection();
    return this._request(settings.serverUrl, "/api/sync/pairing-codes", {
      method: "POST",
      token: credentials.deviceToken,
      body: options.ttlMs ? { ttlMs: options.ttlMs } : {}
    });
  }

  async listDevices() {
    const { settings, credentials } = await this._requireConnection();
    const result = await this._request(settings.serverUrl, "/api/sync/devices", {
      token: credentials.deviceToken
    });
    return Array.isArray(result.devices) ? result.devices : [];
  }

  async queryUsage(options = {}) {
    const { settings, credentials } = await this._requireConnection();
    const query = new URLSearchParams();
    if (options.deviceId) query.set("device_id", String(options.deviceId));
    if (options.providerId) query.set("provider", String(options.providerId));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this._request(settings.serverUrl, `/api/sync/usage${suffix}`, {
      token: credentials.deviceToken
    });
  }

  async captureUsageEvents(rawEvents) {
    return this._mutate(async () => {
      const settings = await this.readSettings();
      const credentials = await readJson(this.credentialsFile, null).then(normalizeOptionalCredentials);
      if (!settings.enabled || !settings.serverUrl || !credentials) {
        return { captured: 0, pending: (await this._readOutbox()).pending.length, skipped: "sync_disabled_or_unpaired" };
      }
      const [outbox, acked] = await Promise.all([this._readOutbox(), this._readAcked()]);
      const pending = new Map(outbox.pending.map((entry) => [entry.eventKey, entry]));
      const acknowledged = new Set(acked.eventKeys);
      let captured = 0;
      let duplicates = 0;
      for (const raw of Array.isArray(rawEvents) ? rawEvents : []) {
        const event = buildSyncUploadEvent(raw, { collectorVersion: this.collectorVersion });
        if (!event) continue;
        const eventKey = syncEventKey(event.providerId, event.sourceEventSha256);
        if (acknowledged.has(eventKey) || pending.has(eventKey)) {
          duplicates += 1;
          continue;
        }
        if (pending.size >= MAX_OUTBOX_EVENTS) {
          throw validationError("sync_outbox_full", "Sync outbox reached its safety limit.", 507);
        }
        pending.set(eventKey, { eventKey, event, queuedAt: isoNow(this.now) });
        captured += 1;
      }
      const next = {
        version: CLIENT_SETTINGS_VERSION,
        pending: Array.from(pending.values()),
        conflicts: outbox.conflicts,
        updatedAt: isoNow(this.now)
      };
      if (captured || !outbox.updatedAt) await writeJsonAtomic(this.outboxFile, next);
      const status = await this._readStatus();
      const nextStatus = {
        ...status,
        lastCaptureAt: isoNow(this.now),
        pendingCount: next.pending.length
      };
      await writeJsonAtomic(this.statusFile, nextStatus);
      return { captured, duplicates, pending: next.pending.length };
    });
  }

  async flush(options = {}) {
    return this._mutate(async () => {
      const settings = await this.readSettings();
      const credentials = await readJson(this.credentialsFile, null).then(normalizeOptionalCredentials);
      const outbox = await this._readOutbox();
      let status = await this._readStatus();
      if (!settings.enabled || !settings.serverUrl || !credentials) {
        return { flushed: false, pending: outbox.pending.length, skipped: "sync_disabled_or_unpaired" };
      }
      const nowMs = this.now();
      const waitMs = safeDelayUntil(status.nextRetryAt, nowMs);
      if (!options.force && waitMs > 0) {
        return { flushed: false, pending: outbox.pending.length, skipped: "retry_backoff", retryInMs: waitMs };
      }
      if (!outbox.pending.length) {
        status = { ...status, pendingCount: 0, nextRetryAt: null, retryAttempt: 0 };
        await writeJsonAtomic(this.statusFile, status);
        return { flushed: true, pending: 0, accepted: 0, duplicates: 0, conflicts: 0 };
      }

      const batchSize = Math.min(positiveInteger(options.batchSize) || DEFAULT_BATCH_SIZE, DEFAULT_BATCH_SIZE);
      const batch = outbox.pending.slice(0, batchSize);
      const attemptedAt = isoNow(this.now);
      status = { ...status, lastAttemptAt: attemptedAt };
      await writeJsonAtomic(this.statusFile, status);
      try {
        const result = await this._request(settings.serverUrl, "/api/sync/usage", {
          method: "POST",
          token: credentials.deviceToken,
          body: { events: batch.map((entry) => entry.event) },
          allowConflict: true
        });
        const accepted = new Set([...(result.accepted || []), ...(result.duplicates || [])]);
        const conflicts = new Map((result.conflicts || []).map((entry) => [entry.eventKey, entry]));
        const acknowledgedKeys = batch
          .map((entry) => entry.eventKey)
          .filter((eventKey) => accepted.has(eventKey));
        const conflictKeys = batch
          .map((entry) => entry.eventKey)
          .filter((eventKey) => conflicts.has(eventKey));
        const completed = new Set([...acknowledgedKeys, ...conflictKeys]);
        const pending = outbox.pending.filter((entry) => !completed.has(entry.eventKey));
        const acked = await this._readAcked();
        const ackedKeys = new Set(acked.eventKeys);
        for (const eventKey of acknowledgedKeys) ackedKeys.add(eventKey);
        const localConflicts = conflictKeys.map((eventKey) => ({
          eventKey,
          detectedAt: isoNow(this.now),
          existingPayloadSha256: conflicts.get(eventKey)?.existingPayloadSha256 || null,
          receivedPayloadSha256: conflicts.get(eventKey)?.receivedPayloadSha256 || null
        }));
        await Promise.all([
          writeJsonAtomic(this.outboxFile, {
            version: CLIENT_SETTINGS_VERSION,
            pending,
            conflicts: [...outbox.conflicts, ...localConflicts].slice(-1000),
            updatedAt: isoNow(this.now)
          }),
          writeJsonAtomic(this.ackedFile, {
            version: CLIENT_SETTINGS_VERSION,
            eventKeys: Array.from(ackedKeys).sort(),
            updatedAt: isoNow(this.now)
          })
        ]);
        const hasConflict = conflictKeys.length > 0;
        status = {
          ...status,
          lastSuccessAt: isoNow(this.now),
          lastError: hasConflict ? `Server rejected ${conflictKeys.length} conflicting event(s).` : null,
          pendingCount: pending.length,
          nextRetryAt: null,
          retryAttempt: 0,
          lastUpload: {
            accepted: Number(result.accepted?.length || 0),
            duplicates: Number(result.duplicates?.length || 0),
            conflicts: conflictKeys.length
          }
        };
        await writeJsonAtomic(this.statusFile, status);
        return {
          flushed: true,
          pending: pending.length,
          accepted: Number(result.accepted?.length || 0),
          duplicates: Number(result.duplicates?.length || 0),
          conflicts: conflictKeys.length
        };
      } catch (error) {
        const retryAttempt = Math.max(0, Number(status.retryAttempt) || 0) + 1;
        const retryDelayMs = retryDelay(retryAttempt, this.retryBaseMs, this.retryMaxMs);
        status = {
          ...status,
          lastError: sanitizeError(error),
          pendingCount: outbox.pending.length,
          retryAttempt,
          nextRetryAt: new Date(this.now() + retryDelayMs).toISOString()
        };
        await writeJsonAtomic(this.statusFile, status);
        return {
          flushed: false,
          pending: outbox.pending.length,
          error: status.lastError,
          retryInMs: retryDelayMs
        };
      }
    });
  }

  async readPublicStatus() {
    return this.readPublicStatusFrom(await this.readSettings());
  }

  async recordError(error) {
    return this._mutate(async () => {
      const status = await this._readStatus();
      const next = { ...status, lastError: sanitizeError(error) };
      await writeJsonAtomic(this.statusFile, next);
      return next;
    });
  }

  async readPublicStatusFrom(settings, providedCredentials = undefined) {
    const [credentials, outbox, status] = await Promise.all([
      providedCredentials === undefined
        ? readJson(this.credentialsFile, null).then(normalizeOptionalCredentials)
        : Promise.resolve(providedCredentials),
      this._readOutbox(),
      this._readStatus()
    ]);
    return {
      version: CLIENT_SETTINGS_VERSION,
      enabled: Boolean(settings.enabled),
      connected: Boolean(credentials),
      serverUrl: settings.serverUrl,
      deviceName: settings.deviceName,
      deviceId: credentials?.deviceId || null,
      syncSpaceId: credentials?.syncSpaceId || null,
      platform: this.platform,
      pendingCount: outbox.pending.length,
      conflictCount: outbox.conflicts.length,
      lastCaptureAt: status.lastCaptureAt,
      lastAttemptAt: status.lastAttemptAt,
      lastSuccessAt: status.lastSuccessAt,
      lastError: status.lastError,
      nextRetryAt: status.nextRetryAt,
      retryAttempt: status.retryAttempt,
      lastUpload: status.lastUpload,
      privacy: {
        normalizedUsageOnly: true,
        forbidden: [
          "prompts",
          "transcripts",
          "raw_provider_payloads",
          "credentials",
          "account_ids",
          "email_addresses",
          "absolute_paths",
          "usernames",
          "command_lines"
        ]
      }
    };
  }

  async disconnect(options = {}) {
    return this._mutate(async () => {
      const settings = await this.readSettings();
      const next = { ...settings, enabled: false, updatedAt: isoNow(this.now) };
      await writeJsonAtomic(this.settingsFile, next);
      const files = [this.credentialsFile, this.statusFile];
      if (options.clearQueue !== false) files.push(this.outboxFile, this.ackedFile);
      await Promise.all(files.map((file) => fsp.unlink(file).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      })));
      return this.readPublicStatusFrom(next, null);
    });
  }

  async _requireConnection() {
    const settings = await this.readSettings();
    const credentials = await readJson(this.credentialsFile, null).then(normalizeOptionalCredentials);
    if (!settings.enabled || !settings.serverUrl || !credentials) {
      throw validationError("sync_not_connected", "This device is not connected to a sync space.", 409);
    }
    return { settings, credentials };
  }

  async _readOutbox() {
    const raw = await readJson(this.outboxFile, defaultOutbox());
    return {
      version: CLIENT_SETTINGS_VERSION,
      pending: Array.isArray(raw?.pending) ? raw.pending.filter(validOutboxEntry) : [],
      conflicts: Array.isArray(raw?.conflicts) ? raw.conflicts.filter(Boolean) : [],
      updatedAt: optionalIso(raw?.updatedAt)
    };
  }

  async _readAcked() {
    const raw = await readJson(this.ackedFile, { version: CLIENT_SETTINGS_VERSION, eventKeys: [] });
    return {
      version: CLIENT_SETTINGS_VERSION,
      eventKeys: Array.isArray(raw?.eventKeys)
        ? Array.from(new Set(raw.eventKeys.filter(validSha256))).sort()
        : []
    };
  }

  async _readStatus() {
    return normalizeStatus(await readJson(this.statusFile, defaultStatus()));
  }

  async _request(serverUrl, endpoint, options = {}) {
    if (typeof this.fetchImpl !== "function") throw new Error("Fetch is unavailable.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    if (typeof timeout.unref === "function") timeout.unref();
    let response;
    try {
      response = await this.fetchImpl(`${normalizeServerUrl(serverUrl)}${endpoint}`, {
        method: options.method || "GET",
        headers: {
          accept: "application/json",
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    if (!response.ok && !(options.allowConflict && response.status === 409 && body?.conflicts)) {
      const error = new Error(body.message || body.error || `Sync server returned HTTP ${response.status}.`);
      error.statusCode = response.status;
      error.code = body.error || "sync_request_failed";
      throw error;
    }
    return body;
  }

  _mutate(operation) {
    const run = this._mutation.then(operation, operation);
    this._mutation = run.catch(() => {});
    return run;
  }
}

function buildSyncUploadEvent(raw, options = {}) {
  if (!raw || typeof raw !== "object") return null;
  const providerId = safeIdentifier(raw.providerId, 80);
  const timestampMs = Number(raw.timestampMs ?? Date.parse(raw.timestamp));
  if (!providerId || !Number.isFinite(timestampMs)) return null;
  const usage = normalizedClientUsage(raw.usage);
  if (!(usage.totalTokens > 0)) return null;
  const evidence = raw.evidence && typeof raw.evidence === "object" ? raw.evidence : {};
  const metadata = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {};
  const suppliedDigest = evidence.sourceEventSha256 || evidence.rawLineSha256 || metadata.sourceEventSha256;
  const sourceEventSha256 = validSha256(suppliedDigest)
    ? String(suppliedDigest).toLowerCase()
    : sha256(stableStringify({
        version: 1,
        providerId,
        eventId: safeIdentityValue(raw.eventId),
        timestampMs,
        model: safeTextValue(raw.model, 160),
        usage,
        sessionId: safeIdentityValue(evidence.sessionId || evidence.rolloutSessionId),
        requestId: safeIdentityValue(evidence.requestId || evidence.messageId || evidence.uuid),
        sessionStart: safeIdentityValue(evidence.sessionStart || evidence.sessionStartTime),
        sourceRevision: safeIdentityValue(metadata.sourceRevision)
      }));
  const model = safeTextValue(raw.model, 160);
  const priceStatus = ["priced", "unpriced", "unknown"].includes(metadata.priceCoverage?.status)
    ? metadata.priceCoverage.status
    : model
      ? "unknown"
      : "unpriced";
  return {
    schemaVersion: 1,
    kind: "usage_event",
    sourceEventSha256,
    sourceTimestamp: new Date(timestampMs).toISOString(),
    providerId,
    model,
    usage,
    usageFieldCoverage: usageFieldCoverage(raw.usage, metadata.usageFieldCoverage),
    lineage: {
      taskId: safeIdentityValue(metadata.taskId),
      threadId: safeIdentityValue(metadata.threadId),
      turnId: safeIdentityValue(metadata.turnId),
      sessionId: safeIdentityValue(metadata.sessionId || evidence.sessionId || evidence.rolloutSessionId),
      runId: safeIdentityValue(metadata.runId),
      parentRunId: safeIdentityValue(metadata.parentRunId),
      projectId: safeIdentityValue(metadata.projectId),
      ticketId: safeIdentityValue(metadata.ticketId),
      assignmentStrength: ["confirmed", "strong", "weak", "unassigned", "unknown"].includes(metadata.assignmentStrength)
        ? metadata.assignmentStrength
        : "unknown"
    },
    runtime: {
      aiRuntimeMs: finiteNonNegativeOrNull(metadata.aiRuntimeMs),
      startedAt: safeIso(metadata.runtimeStartedAt),
      endedAt: safeIso(metadata.runtimeEndedAt)
    },
    source: {
      revision: safeIdentityValue(metadata.sourceRevision || evidence.sourceRevision || suppliedDigest),
      schemaVersion: positiveInteger(metadata.sourceSchemaVersion) || 1,
      collectorVersion: shortText(options.collectorVersion, "unknown", 80)
    },
    priceCoverage: {
      status: priceStatus,
      catalogVersion: safeIdentityValue(metadata.priceCoverage?.catalogVersion),
      asOf: safeIso(metadata.priceCoverage?.asOf)
    },
    deviceAttribution: metadata.deviceAttribution === "unknown" ? "unknown" : "uploader"
  };
}

function normalizedClientUsage(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const inputTokens = finiteNonNegative(value.inputTokens ?? value.input_tokens);
  const cachedInputTokens = finiteNonNegative(value.cachedInputTokens ?? value.cached_input_tokens ?? value.cache_read_input_tokens);
  const combinedCacheWrite = finiteNonNegative(value.cacheCreationInputTokens ?? value.cache_creation_input_tokens);
  const cacheWrite5mTokens = finiteNonNegative(value.cacheWrite5mTokens ?? value.cache_write_5m_tokens ?? combinedCacheWrite);
  const cacheWrite1hTokens = finiteNonNegative(value.cacheWrite1hTokens ?? value.cache_write_1h_tokens);
  const outputTokens = finiteNonNegative(value.outputTokens ?? value.output_tokens);
  const reasoningOutputTokens = finiteNonNegative(
    value.reasoningOutputTokens ?? value.reasoning_output_tokens ?? value.thoughts_token_count
  );
  const derived = inputTokens + cachedInputTokens + cacheWrite5mTokens + cacheWrite1hTokens + outputTokens + reasoningOutputTokens;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    cacheCreationInputTokens: cacheWrite5mTokens + cacheWrite1hTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: finiteNonNegative(value.totalTokens ?? value.total_tokens ?? derived)
  };
}

function usageFieldCoverage(raw, provided) {
  if (Array.isArray(provided)) {
    return Array.from(new Set(provided.filter((field) => TOKEN_FIELDS.includes(field)))).sort();
  }
  const value = raw && typeof raw === "object" ? raw : {};
  const aliases = {
    inputTokens: ["inputTokens", "input_tokens"],
    cachedInputTokens: ["cachedInputTokens", "cached_input_tokens", "cache_read_input_tokens"],
    cacheWrite5mTokens: ["cacheWrite5mTokens", "cache_write_5m_tokens", "cacheCreationInputTokens", "cache_creation_input_tokens"],
    cacheWrite1hTokens: ["cacheWrite1hTokens", "cache_write_1h_tokens"],
    outputTokens: ["outputTokens", "output_tokens"],
    reasoningOutputTokens: ["reasoningOutputTokens", "reasoning_output_tokens", "thoughts_token_count"],
    totalTokens: ["totalTokens", "total_tokens"]
  };
  return Object.entries(aliases)
    .filter(([, names]) => names.some((name) => Object.hasOwn(value, name)))
    .map(([field]) => field)
    .sort();
}

function defaultSettings(options = {}) {
  return {
    version: CLIENT_SETTINGS_VERSION,
    enabled: false,
    serverUrl: options.serverUrl || "",
    deviceName: safeDefaultDeviceName(),
    updatedAt: null
  };
}

function normalizeSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    version: CLIENT_SETTINGS_VERSION,
    enabled: Boolean(value.enabled),
    serverUrl: value.serverUrl ? normalizeServerUrl(value.serverUrl) : "",
    deviceName: displayName(value.deviceName || safeDefaultDeviceName()),
    updatedAt: optionalIso(value.updatedAt)
  };
}

function normalizeCredentials(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const device = value.device && typeof value.device === "object" ? value.device : value;
  const space = value.space && typeof value.space === "object" ? value.space : value;
  const credentials = {
    version: CLIENT_SETTINGS_VERSION,
    deviceId: requiredIdentity(device.id || value.deviceId, "device_id"),
    syncSpaceId: requiredIdentity(space.id || value.syncSpaceId || device.syncSpaceId, "sync_space_id"),
    deviceToken: String(value.deviceToken || "").trim(),
    connectedAt: safeIso(value.connectedAt) || new Date().toISOString()
  };
  if (credentials.deviceToken.length < 32 || credentials.deviceToken.length > 256) {
    throw validationError("invalid_device_token", "Sync server returned an invalid device token.");
  }
  return credentials;
}

function normalizeOptionalCredentials(raw) {
  if (!raw) return null;
  try {
    return normalizeCredentials(raw);
  } catch {
    return null;
  }
}

function defaultOutbox() {
  return { version: CLIENT_SETTINGS_VERSION, pending: [], conflicts: [], updatedAt: null };
}

function defaultStatus() {
  return {
    version: CLIENT_SETTINGS_VERSION,
    lastCaptureAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    pendingCount: 0,
    nextRetryAt: null,
    retryAttempt: 0,
    lastUpload: null
  };
}

function normalizeStatus(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    ...defaultStatus(),
    lastCaptureAt: optionalIso(value.lastCaptureAt),
    lastAttemptAt: optionalIso(value.lastAttemptAt),
    lastSuccessAt: optionalIso(value.lastSuccessAt),
    lastError: value.lastError ? shortText(value.lastError, null, 240) : null,
    pendingCount: Math.max(0, Number(value.pendingCount) || 0),
    nextRetryAt: optionalIso(value.nextRetryAt),
    retryAttempt: Math.max(0, Number(value.retryAttempt) || 0),
    lastUpload: value.lastUpload && typeof value.lastUpload === "object" ? {
      accepted: Math.max(0, Number(value.lastUpload.accepted) || 0),
      duplicates: Math.max(0, Number(value.lastUpload.duplicates) || 0),
      conflicts: Math.max(0, Number(value.lastUpload.conflicts) || 0)
    } : null
  };
}

function validOutboxEntry(entry) {
  return Boolean(entry && validSha256(entry.eventKey) && entry.event && typeof entry.event === "object");
}

function normalizeServerUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw validationError("invalid_sync_server", "Sync server URL is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw validationError("invalid_sync_server", "Sync server URL must be an HTTP(S) origin without credentials, query, or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function safeDefaultDeviceName() {
  const type = os.type();
  if (type === "Darwin") return "Mac";
  if (type === "Windows_NT") return "Windows PC";
  if (type === "Linux") return "Linux device";
  return "This device";
}

function displayName(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 80 || /[\u0000-\u001f\u007f]/u.test(text) ||
      /^\/(?:[^/]+\/)*[^/]*$/u.test(text) || /^[a-zA-Z]:[\\/]/u.test(text) || /^\\\\/u.test(text) ||
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)) {
    throw validationError("invalid_device_name", "Device name is invalid.");
  }
  return text;
}

function requiredIdentity(value, field) {
  const result = safeIdentityValue(value, 160);
  if (!result) throw validationError(`invalid_${field}`, `${field} is invalid.`);
  return result;
}

function safeIdentifier(value, maxLength) {
  return safeIdentityValue(value, maxLength);
}

function safeIdentityValue(value, maxLength = 160) {
  const text = String(value || "").trim();
  return text && text.length <= maxLength && !looksLikeEmail(text) &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]*$/u.test(text) ? text : null;
}

function safeTextValue(value, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text) || /^\//u.test(text) ||
      /^[a-zA-Z]:[\\/]/u.test(text) || /^\\\\/u.test(text) || looksLikeEmail(text)) {
    return null;
  }
  return text;
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(String(value));
}

function finiteNonNegative(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function finiteNonNegativeOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function retryDelay(attempt, baseMs = DEFAULT_RETRY_BASE_MS, maxMs = DEFAULT_RETRY_MAX_MS) {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(maxMs, baseMs * (2 ** Math.min(safeAttempt - 1, 20)));
}

function safeDelayUntil(target, nowMs = Date.now()) {
  const targetMs = Date.parse(target || "");
  if (!Number.isFinite(targetMs)) return 0;
  return Math.max(0, targetMs - Number(nowMs || 0));
}

function sanitizeError(error) {
  const message = String(error?.name === "AbortError" ? "Sync request timed out." : error?.message || "Sync request failed.");
  return message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 240);
}

function safePlatform(value) {
  const platform = String(value || "unknown").toLowerCase();
  return ["darwin", "linux", "win32"].includes(platform) ? platform : "unknown";
}

function safeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function optionalIso(value) {
  return safeIso(value);
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/u.test(String(value || ""));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function shortText(value, fallback, maxLength) {
  const text = String(value ?? "").trim();
  return (text || fallback || "").slice(0, maxLength);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function validationError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  const directory = path.dirname(file);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700).catch(() => {});
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, file);
  await fsp.chmod(file, 0o600).catch(() => {});
}

module.exports = {
  CLIENT_SETTINGS_VERSION,
  DEFAULT_BATCH_SIZE,
  LocalSyncClient,
  buildSyncUploadEvent,
  normalizeServerUrl,
  retryDelay,
  safeDelayUntil,
  _test: {
    defaultOutbox,
    defaultSettings,
    normalizeCredentials,
    normalizeSettings,
    normalizeStatus,
    normalizedClientUsage,
    readJson,
    sanitizeError,
    usageFieldCoverage,
    writeJsonAtomic
  }
};
