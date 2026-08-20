"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { aggregateUsageEvents } = require("./usage-events");

const REGISTRY_VERSION = 1;
const LEDGER_EVENT_VERSION = 1;
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_UPLOAD_EVENTS = 500;
const MAX_LEDGER_ERRORS = 20;
const TOKEN_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWrite5mTokens",
  "cacheWrite1hTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens"
];
const ALLOWED_PRICE_STATUSES = new Set(["priced", "unpriced", "unknown"]);
const ALLOWED_ASSIGNMENT_STRENGTHS = new Set(["confirmed", "strong", "weak", "unassigned", "unknown"]);
const ALLOWED_DEVICE_ATTRIBUTIONS = new Set(["uploader", "unknown"]);
const ALLOWED_EVENT_KINDS = new Set(["usage_event", "usage_snapshot"]);
const EVENT_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "sourceEventSha256",
  "sourceTimestamp",
  "timestamp",
  "timestampMs",
  "providerId",
  "model",
  "usage",
  "usageFieldCoverage",
  "lineage",
  "runtime",
  "source",
  "priceCoverage",
  "deviceAttribution",
  "snapshot"
]);
const USAGE_FIELDS = new Set([
  "input_tokens",
  "inputTokens",
  "cached_input_tokens",
  "cache_read_input_tokens",
  "cachedInputTokens",
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  "cache_write_5m_tokens",
  "cacheWrite5mTokens",
  "cache_write_1h_tokens",
  "cacheWrite1hTokens",
  "output_tokens",
  "outputTokens",
  "reasoning_output_tokens",
  "thoughts_token_count",
  "reasoningOutputTokens",
  "total_tokens",
  "totalTokens"
]);
const LINEAGE_FIELDS = new Set([
  "taskId",
  "threadId",
  "turnId",
  "sessionId",
  "runId",
  "parentRunId",
  "projectId",
  "ticketId",
  "assignmentStrength"
]);
const RUNTIME_FIELDS = new Set(["aiRuntimeMs", "startedAt", "endedAt"]);
const SOURCE_FIELDS = new Set(["revision", "collectorVersion", "schemaVersion"]);
const PRICE_FIELDS = new Set(["status", "catalogVersion", "asOf"]);
const SNAPSHOT_FIELDS = new Set(["windowKey", "startedAt", "endedAt", "capturedAt"]);
const FORBIDDEN_KEYS = new Set([
  "prompt",
  "prompts",
  "transcript",
  "transcripts",
  "content",
  "message",
  "messages",
  "raw",
  "rawlog",
  "rawlogs",
  "rawpayload",
  "providerpayload",
  "cookie",
  "cookies",
  "secret",
  "secrets",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "devicetoken",
  "accountid",
  "email",
  "username",
  "filepath",
  "absolutepath",
  "commandline",
  "command"
]);

class SyncLedger {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error("SyncLedger requires dataDir.");
    this.dataDir = path.resolve(options.dataDir);
    this.registryFile = path.join(this.dataDir, "registry.json");
    this.ledgerFile = path.join(this.dataDir, "events.jsonl");
    this.conflictsFile = path.join(this.dataDir, "conflicts.jsonl");
    this.backupDir = path.join(this.dataDir, "reconcile-backups");
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;
    this._readJsonLines = typeof options.readJsonLines === "function" ? options.readJsonLines : readJsonLines;
    this.pairingTtlMs = positiveInteger(options.pairingTtlMs) || DEFAULT_PAIRING_TTL_MS;
    this.collectorVersion = shortText(options.collectorVersion, "unknown", 80);
    this._mutation = Promise.resolve();
    this._index = null;
  }

  async createSpace(input = {}) {
    return this._mutate(async () => {
      const registry = await this._readRegistry();
      const createdAt = isoNow(this.now);
      const space = {
        id: randomId("space", this.randomBytes),
        displayName: displayName(input.displayName, "Private sync space"),
        createdAt
      };
      const device = createDeviceRecord(input, space.id, createdAt, this.randomBytes);
      registry.spaces.push(space);
      registry.devices.push(device.record);
      await this._writeRegistry(registry);
      return {
        space: publicSpace(space),
        device: publicDevice(device.record),
        deviceToken: device.token
      };
    });
  }

  async createPairingCode(deviceToken, options = {}) {
    return this._mutate(async () => {
      const registry = await this._readRegistry();
      const device = findDeviceByToken(registry.devices, deviceToken);
      if (!device || device.revokedAt) throw authError();
      const nowMs = this.now();
      const ttlMs = Math.min(positiveInteger(options.ttlMs) || this.pairingTtlMs, 60 * 60 * 1000);
      const code = pairingCode(this.randomBytes);
      const salt = this.randomBytes(16).toString("hex");
      registry.pairingCodes = registry.pairingCodes.filter((entry) => {
        return !entry.usedAt && Date.parse(entry.expiresAt) > nowMs - 24 * 60 * 60 * 1000;
      });
      registry.pairingCodes.push({
        codeHash: saltedSecretHash(code, salt),
        salt,
        syncSpaceId: device.syncSpaceId,
        createdByDeviceId: device.id,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
        usedAt: null
      });
      touchDeviceRecord(device, nowMs);
      await this._writeRegistry(registry);
      return {
        code,
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
        syncSpaceId: device.syncSpaceId
      };
    });
  }

  async joinWithPairingCode(input = {}) {
    return this._mutate(async () => {
      const code = normalizePairingCode(input.code);
      if (!code) throw validationError("invalid_pairing_code", "Pairing code is invalid.");
      const registry = await this._readRegistry();
      const nowMs = this.now();
      const pairing = registry.pairingCodes.find((entry) => {
        return !entry.usedAt &&
          Date.parse(entry.expiresAt) > nowMs &&
          safeSecretEqual(entry.codeHash, saltedSecretHash(code, entry.salt));
      });
      if (!pairing) throw validationError("pairing_code_expired", "Pairing code is invalid or expired.", 410);
      const createdAt = new Date(nowMs).toISOString();
      const device = createDeviceRecord(input, pairing.syncSpaceId, createdAt, this.randomBytes);
      pairing.usedAt = createdAt;
      registry.devices.push(device.record);
      await this._writeRegistry(registry);
      return {
        space: publicSpace(registry.spaces.find((space) => space.id === pairing.syncSpaceId)),
        device: publicDevice(device.record),
        deviceToken: device.token
      };
    });
  }

  async authenticateDevice(deviceToken, options = {}) {
    const registry = await this._readRegistry();
    const device = findDeviceByToken(registry.devices, deviceToken);
    if (!device || device.revokedAt) throw authError();
    if (options.touch !== false) {
      await this._mutate(async () => {
        const nextRegistry = await this._readRegistry();
        const current = nextRegistry.devices.find((entry) => entry.id === device.id);
        if (current && !current.revokedAt) {
          touchDeviceRecord(current, this.now());
          await this._writeRegistry(nextRegistry);
        }
      });
    }
    return publicDevice(device);
  }

  async listDevices(deviceToken) {
    const device = await this.authenticateDevice(deviceToken);
    const registry = await this._readRegistry();
    return registry.devices
      .filter((entry) => entry.syncSpaceId === device.syncSpaceId && !entry.revokedAt)
      .map(publicDevice)
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  async upload(deviceToken, payload = {}) {
    return this._mutate(async () => {
      const registry = await this._readRegistry();
      const device = findDeviceByToken(registry.devices, deviceToken);
      if (!device || device.revokedAt) throw authError();
      const rawEvents = normalizedUploadRows(payload);
      if (!rawEvents.length) throw validationError("events_required", "At least one event or snapshot is required.");
      if (rawEvents.length > MAX_UPLOAD_EVENTS) {
        throw validationError("too_many_events", `At most ${MAX_UPLOAD_EVENTS} events may be uploaded at once.`, 413);
      }
      const normalized = rawEvents.map((entry) => normalizeLedgerEvent(entry.raw, {
        kind: entry.kind,
        deviceId: device.id,
        syncSpaceId: device.syncSpaceId,
        ingestedAt: isoNow(this.now),
        collectorVersion: this.collectorVersion
      }));
      const index = await this._loadIndex();
      if (!index.verification.valid) {
        throw validationError(
          "ledger_integrity_invalid",
          "Ledger integrity verification failed; reconcile before accepting uploads.",
          409
        );
      }

      const accepted = [];
      const duplicates = [];
      const conflicts = [];
      const pendingKeys = new Map();
      for (const event of normalized) {
        const scopedKey = scopedEventKey(event);
        const existing = pendingKeys.get(scopedKey) || index.byKey.get(scopedKey);
        if (!existing) {
          pendingKeys.set(scopedKey, event);
          accepted.push(event);
        } else if (existing.payloadSha256 === event.payloadSha256) {
          duplicates.push(event.eventKey);
        } else {
          conflicts.push({
            eventKey: event.eventKey,
            existingPayloadSha256: existing.payloadSha256,
            receivedPayloadSha256: event.payloadSha256
          });
        }
      }

      if (accepted.length) {
        let previousCommitSha256 = index.headCommitSha256;
        const committed = accepted.map((event) => {
          const record = commitLedgerEvent(event, previousCommitSha256);
          previousCommitSha256 = record.commitSha256;
          return record;
        });
        await appendJsonLines(this.ledgerFile, committed);
        for (const record of committed) index.byKey.set(scopedEventKey(record), record);
        index.records.push(...committed);
        index.headCommitSha256 = previousCommitSha256;
        index.verification = verifyLedgerRecords(index.records);
      }
      if (conflicts.length) {
        await appendJsonLines(this.conflictsFile, conflicts.map((conflict) => ({
          schemaVersion: 1,
          detectedAt: isoNow(this.now),
          syncSpaceId: device.syncSpaceId,
          uploaderDeviceId: device.id,
          ...conflict
        })));
      }
      touchDeviceRecord(device, this.now());
      await this._writeRegistry(registry);
      return {
        accepted: accepted.map((event) => event.eventKey),
        duplicates,
        conflicts,
        totals: {
          received: normalized.length,
          accepted: accepted.length,
          duplicates: duplicates.length,
          conflicts: conflicts.length
        },
        integrity: publicVerification(index.verification)
      };
    });
  }

  async queryUsage(deviceToken, options = {}) {
    const device = await this.authenticateDevice(deviceToken);
    const registry = await this._readRegistry();
    const activeDevices = registry.devices.filter((entry) => entry.syncSpaceId === device.syncSpaceId && !entry.revokedAt);
    const filter = normalizeDeviceFilter(options.deviceId, device.id, activeDevices);
    const providerId = options.providerId ? safeIdentifier(options.providerId, "provider_id", 80) : null;
    const index = await this._loadIndex();
    if (!index.verification.valid) {
      throw validationError(
        "ledger_integrity_invalid",
        "Ledger integrity verification failed; reconcile before querying usage.",
        409
      );
    }
    const events = index.records.filter((event) => {
      if (event.syncSpaceId !== device.syncSpaceId) return false;
      if (providerId && event.providerId !== providerId) return false;
      if (filter.mode === "unknown" && event.deviceId !== null) return false;
      if (filter.mode === "device" && event.deviceId !== filter.deviceId) return false;
      return true;
    });
    const aggregate = aggregateLedgerEvents(events, options);
    return {
      syncSpaceId: device.syncSpaceId,
      filter: filter.publicValue,
      usage: aggregate,
      devices: activeDevices.map(publicDevice),
      deviceTotals: aggregateDeviceTotals(index.records.filter((event) => event.syncSpaceId === device.syncSpaceId), activeDevices, options),
      coverage: ledgerCoverage(events),
      integrity: publicVerification(index.verification)
    };
  }

  async verify() {
    return this._mutate(async () => {
      const records = await this._readJsonLines(this.ledgerFile);
      const verification = verifyLedgerRecords(records.records, records.malformed);
      this._index = buildIndex(records.records, verification);
      return publicVerification(verification);
    });
  }

  async reconcile() {
    return this._mutate(async () => {
      const beforeRead = await this._readJsonLines(this.ledgerFile);
      const before = verifyLedgerRecords(beforeRead.records, beforeRead.malformed);
      let backupFile = null;
      if (fs.existsSync(this.ledgerFile)) {
        await fsp.mkdir(this.backupDir, { recursive: true, mode: 0o700 });
        await fsp.chmod(this.backupDir, 0o700).catch(() => {});
        backupFile = path.join(
          this.backupDir,
          `events-${safeTimestamp(isoNow(this.now))}-${this.randomBytes(4).toString("hex")}.jsonl`
        );
        await fsp.copyFile(this.ledgerFile, backupFile);
        await fsp.chmod(backupFile, 0o600).catch(() => {});
      }
      const invalidParsedRecords = beforeRead.records.filter((record) => !record || typeof record !== "object");
      const ordered = beforeRead.records
        .filter((record) => record && typeof record === "object")
        .sort(compareLedgerEvents);
      const selected = new Map();
      const duplicates = [];
      const conflicts = [];
      const invalidRecords = beforeRead.malformed.map((entry) => ({
        kind: "malformed_json",
        line: entry.line,
        recordSha256: entry.rawSha256
      })).concat(invalidParsedRecords.map((record) => ({
        kind: "invalid_record",
        recordSha256: sha256(stableStringify(record)),
        errorCode: "invalid_record"
      })));
      for (const record of ordered) {
        let event;
        try {
          event = normalizeStoredLedgerEvent(record, this.collectorVersion);
          if (!safeSecretEqual(record.eventKey, event.eventKey) ||
              !safeSecretEqual(record.payloadSha256, event.payloadSha256)) {
            throw validationError("stored_digest_mismatch", "Stored event identity or payload digest is invalid.");
          }
        } catch (error) {
          invalidRecords.push({
            kind: "invalid_record",
            recordSha256: sha256(stableStringify(record)),
            errorCode: shortText(error?.code, "invalid_record", 80)
          });
          continue;
        }
        const key = scopedEventKey(event);
        const existing = selected.get(key);
        if (!existing) {
          selected.set(key, event);
        } else if (existing.payloadSha256 === event.payloadSha256) {
          duplicates.push(event.eventKey);
        } else {
          conflicts.push({
            eventKey: event.eventKey,
            keptPayloadSha256: existing.payloadSha256,
            rejectedPayloadSha256: event.payloadSha256
          });
        }
      }
      const canonical = Array.from(selected.values()).sort(compareLedgerEvents);
      let previousCommitSha256 = null;
      const committed = canonical.map((event) => {
        const record = commitLedgerEvent(event, previousCommitSha256);
        previousCommitSha256 = record.commitSha256;
        return record;
      });
      await writeJsonLinesAtomic(this.ledgerFile, committed);
      const reconcileAudit = [
        ...conflicts.map((conflict) => ({ kind: "conflicting_event", ...conflict })),
        ...invalidRecords
      ];
      if (reconcileAudit.length) {
        await appendJsonLines(this.conflictsFile, reconcileAudit.map((entry) => ({
          schemaVersion: 1,
          detectedAt: isoNow(this.now),
          source: "reconcile",
          ...entry
        })));
      }
      const after = verifyLedgerRecords(committed);
      this._index = buildIndex(committed, after);
      return {
        before: publicVerification(before),
        after: publicVerification(after),
        duplicatesRemoved: duplicates.length,
        conflicts: conflicts.length,
        invalidRecordsDropped: invalidRecords.length,
        recordsPreservedInBackup: beforeRead.records.length + beforeRead.malformed.length,
        backupCreated: Boolean(backupFile)
      };
    });
  }

  async revokeDevice(deviceToken, deviceId) {
    return this._mutate(async () => {
      const registry = await this._readRegistry();
      const actor = findDeviceByToken(registry.devices, deviceToken);
      if (!actor || actor.revokedAt) throw authError();
      const targetId = safeIdentifier(deviceId || actor.id, "device_id", 100);
      const target = registry.devices.find((entry) => entry.id === targetId && entry.syncSpaceId === actor.syncSpaceId);
      if (!target || target.revokedAt) throw validationError("device_not_found", "Device was not found.", 404);
      target.revokedAt = isoNow(this.now);
      await this._writeRegistry(registry);
      return { revoked: true, deviceId: target.id };
    });
  }

  async _readRegistry() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.registryFile, "utf8"));
      return normalizeRegistry(raw);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return emptyRegistry();
    }
  }

  async _writeRegistry(registry) {
    await writeJsonAtomic(this.registryFile, normalizeRegistry(registry));
  }

  async _loadIndex() {
    if (this._index) return this._index;
    const parsed = await this._readJsonLines(this.ledgerFile);
    const verification = verifyLedgerRecords(parsed.records, parsed.malformed);
    if (this._index) return this._index;
    this._index = buildIndex(parsed.records, verification);
    return this._index;
  }

  _mutate(operation) {
    const run = this._mutation.then(operation, operation);
    this._mutation = run.catch(() => {});
    return run;
  }
}

function normalizedUploadRows(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const events = Array.isArray(body.events) ? body.events.map((raw) => ({ kind: "usage_event", raw })) : [];
  const snapshots = Array.isArray(body.snapshots) ? body.snapshots.map((raw) => ({ kind: "usage_snapshot", raw: snapshotAsEvent(raw) })) : [];
  return [...events, ...snapshots];
}

function snapshotAsEvent(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  assertAllowedFields(value, new Set([
    "schemaVersion",
    "sourceEventSha256",
    "dedupKey",
    "providerId",
    "model",
    "windowKey",
    "snapshotStartedAt",
    "snapshotEndedAt",
    "capturedAt",
    "usage",
    "usageFieldCoverage",
    "lineage",
    "runtime",
    "source",
    "priceCoverage",
    "deviceAttribution"
  ]), "snapshot");
  const sourceEventSha256 = validSha256(value.sourceEventSha256)
    ? value.sourceEventSha256.toLowerCase()
    : sha256(stableStringify({
        kind: "usage_snapshot",
        providerId: value.providerId,
        dedupKey: value.dedupKey,
        windowKey: value.windowKey
      }));
  if (!value.dedupKey && !validSha256(value.sourceEventSha256)) {
    throw validationError("snapshot_identity_required", "Snapshot requires sourceEventSha256 or dedupKey.");
  }
  return {
    schemaVersion: value.schemaVersion,
    kind: "usage_snapshot",
    sourceEventSha256,
    sourceTimestamp: value.capturedAt || value.snapshotEndedAt,
    providerId: value.providerId,
    model: value.model,
    usage: value.usage,
    usageFieldCoverage: value.usageFieldCoverage,
    lineage: value.lineage,
    runtime: value.runtime,
    source: value.source,
    priceCoverage: value.priceCoverage,
    deviceAttribution: value.deviceAttribution,
    snapshot: {
      windowKey: value.windowKey,
      startedAt: value.snapshotStartedAt,
      endedAt: value.snapshotEndedAt,
      capturedAt: value.capturedAt
    }
  };
}

function normalizeLedgerEvent(raw, context) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw validationError("invalid_event", "Usage event must be an object.");
  }
  const forbiddenPath = findForbiddenField(raw);
  if (forbiddenPath) {
    throw validationError("forbidden_event_field", `Usage event contains forbidden field: ${forbiddenPath}.`);
  }
  assertAllowedFields(raw, EVENT_FIELDS, "event");
  assertAllowedFields(raw.usage, USAGE_FIELDS, "event.usage");
  assertAllowedFields(raw.lineage, LINEAGE_FIELDS, "event.lineage");
  assertAllowedFields(raw.runtime, RUNTIME_FIELDS, "event.runtime");
  assertAllowedFields(raw.source, SOURCE_FIELDS, "event.source");
  assertAllowedFields(raw.priceCoverage, PRICE_FIELDS, "event.priceCoverage");
  assertAllowedFields(raw.snapshot, SNAPSHOT_FIELDS, "event.snapshot");

  const providerId = safeIdentifier(raw.providerId, "provider_id", 80);
  const sourceEventSha256 = String(raw.sourceEventSha256 || "").trim().toLowerCase();
  if (!validSha256(sourceEventSha256)) {
    throw validationError("source_event_digest_required", "sourceEventSha256 must be a SHA-256 digest.");
  }
  const sourceTimestamp = normalizeIso(raw.sourceTimestamp || raw.timestamp || raw.timestampMs, "source_timestamp");
  const usage = normalizeLedgerUsage(raw.usage);
  if (!(usage.totalTokens > 0)) throw validationError("usage_required", "Usage event must contain token usage.");
  const kind = ALLOWED_EVENT_KINDS.has(context.kind || raw.kind) ? (context.kind || raw.kind) : "usage_event";
  const deviceAttribution = ALLOWED_DEVICE_ATTRIBUTIONS.has(raw.deviceAttribution)
    ? raw.deviceAttribution
    : "uploader";
  const event = {
    schemaVersion: LEDGER_EVENT_VERSION,
    kind,
    syncSpaceId: safeIdentifier(context.syncSpaceId, "sync_space_id", 100),
    eventKey: syncEventKey(providerId, sourceEventSha256),
    sourceEventSha256,
    sourceTimestamp,
    ingestedAt: normalizeIso(context.ingestedAt, "ingested_at"),
    providerId,
    model: optionalSafeText(raw.model, 160),
    deviceId: deviceAttribution === "unknown" ? null : safeIdentifier(context.deviceId, "device_id", 100),
    deviceAttribution,
    usage,
    usageFieldCoverage: normalizeUsageFieldCoverage(raw.usageFieldCoverage),
    lineage: normalizeLineage(raw.lineage),
    runtime: normalizeRuntime(raw.runtime),
    source: normalizeSource(raw.source, context.collectorVersion),
    priceCoverage: normalizePriceCoverage(raw.priceCoverage),
    snapshot: kind === "usage_snapshot" ? normalizeSnapshot(raw.snapshot, sourceTimestamp) : null
  };
  event.payloadSha256 = ledgerPayloadHash(event);
  return event;
}

function normalizeStoredLedgerEvent(record, collectorVersion) {
  return normalizeLedgerEvent({
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    sourceEventSha256: record.sourceEventSha256,
    sourceTimestamp: record.sourceTimestamp,
    providerId: record.providerId,
    model: record.model,
    usage: record.usage,
    usageFieldCoverage: record.usageFieldCoverage,
    lineage: record.lineage,
    runtime: record.runtime,
    source: record.source,
    priceCoverage: record.priceCoverage,
    deviceAttribution: record.deviceAttribution,
    snapshot: record.snapshot
  }, {
    kind: record.kind,
    syncSpaceId: record.syncSpaceId,
    deviceId: record.deviceAttribution === "unknown"
      ? "device_unknown"
      : safeIdentifier(record.deviceId, "device_id", 100),
    ingestedAt: record.ingestedAt || record.sourceTimestamp,
    collectorVersion
  });
}

function normalizeLedgerUsage(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const inputTokens = nonNegativeNumber(value.inputTokens ?? value.input_tokens);
  const cachedInputTokens = nonNegativeNumber(value.cachedInputTokens ?? value.cached_input_tokens ?? value.cache_read_input_tokens);
  const combinedCacheWrite = nonNegativeNumber(value.cacheCreationInputTokens ?? value.cache_creation_input_tokens);
  const cacheWrite5mTokens = nonNegativeNumber(value.cacheWrite5mTokens ?? value.cache_write_5m_tokens ?? combinedCacheWrite);
  const cacheWrite1hTokens = nonNegativeNumber(value.cacheWrite1hTokens ?? value.cache_write_1h_tokens);
  const outputTokens = nonNegativeNumber(value.outputTokens ?? value.output_tokens);
  const reasoningOutputTokens = nonNegativeNumber(
    value.reasoningOutputTokens ?? value.reasoning_output_tokens ?? value.thoughts_token_count
  );
  const derivedTotal = inputTokens + cachedInputTokens + cacheWrite5mTokens + cacheWrite1hTokens + outputTokens + reasoningOutputTokens;
  const totalTokens = nonNegativeNumber(value.totalTokens ?? value.total_tokens ?? derivedTotal);
  return {
    inputTokens,
    cachedInputTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    cacheCreationInputTokens: cacheWrite5mTokens + cacheWrite1hTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function normalizeUsageFieldCoverage(raw) {
  const fields = Array.isArray(raw) ? raw : ["totalTokens"];
  return Array.from(new Set(fields.map(String).filter((field) => TOKEN_FIELDS.includes(field)))).sort();
}

function normalizeLineage(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const assignmentStrength = ALLOWED_ASSIGNMENT_STRENGTHS.has(value.assignmentStrength)
    ? value.assignmentStrength
    : "unknown";
  return {
    taskId: optionalIdentifier(value.taskId),
    threadId: optionalIdentifier(value.threadId),
    turnId: optionalIdentifier(value.turnId),
    sessionId: optionalIdentifier(value.sessionId),
    runId: optionalIdentifier(value.runId),
    parentRunId: optionalIdentifier(value.parentRunId),
    projectId: optionalIdentifier(value.projectId),
    ticketId: optionalIdentifier(value.ticketId),
    assignmentStrength
  };
}

function normalizeRuntime(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    aiRuntimeMs: value.aiRuntimeMs === undefined || value.aiRuntimeMs === null
      ? null
      : nonNegativeNumber(value.aiRuntimeMs),
    startedAt: optionalIso(value.startedAt),
    endedAt: optionalIso(value.endedAt)
  };
}

function normalizeSource(raw, collectorVersion) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    revision: optionalIdentifier(value.revision, 160),
    schemaVersion: positiveInteger(value.schemaVersion) || 1,
    collectorVersion: safeVersion(value.collectorVersion, collectorVersion || "unknown")
  };
}

function normalizePriceCoverage(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    status: ALLOWED_PRICE_STATUSES.has(value.status) ? value.status : "unknown",
    catalogVersion: optionalIdentifier(value.catalogVersion, 120),
    asOf: optionalIso(value.asOf)
  };
}

function normalizeSnapshot(raw, fallbackTimestamp) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    windowKey: safeIdentifier(value.windowKey || "snapshot", "window_key", 120),
    startedAt: optionalIso(value.startedAt),
    endedAt: optionalIso(value.endedAt),
    capturedAt: optionalIso(value.capturedAt) || fallbackTimestamp
  };
}

function ledgerPayloadHash(event) {
  return sha256(stableStringify({
    schemaVersion: event.schemaVersion,
    kind: event.kind,
    sourceEventSha256: event.sourceEventSha256,
    sourceTimestamp: event.sourceTimestamp,
    providerId: event.providerId,
    model: event.model,
    usage: event.usage,
    usageFieldCoverage: event.usageFieldCoverage,
    lineage: event.lineage,
    runtime: event.runtime,
    source: {
      revision: event.source.revision,
      schemaVersion: event.source.schemaVersion
    },
    snapshot: event.snapshot
  }));
}

function commitLedgerEvent(event, previousCommitSha256) {
  const base = {
    ...event,
    previousCommitSha256: previousCommitSha256 || null
  };
  return {
    ...base,
    commitSha256: sha256(stableStringify(base))
  };
}

function verifyLedgerRecords(records, malformed = []) {
  const errors = [];
  const byKey = new Map();
  let duplicateEventKeys = 0;
  let conflictingEventKeys = 0;
  let chainErrors = 0;
  let eventKeyErrors = 0;
  let payloadErrors = 0;
  let invalidRecords = 0;
  let previousCommitSha256 = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const line = index + 1;
    if (!record || typeof record !== "object") {
      invalidRecords += 1;
      addVerificationError(errors, { line, code: "invalid_record" });
      continue;
    }
    try {
      const expectedEventKey = syncEventKey(record.providerId, record.sourceEventSha256);
      if (!safeSecretEqual(record.eventKey, expectedEventKey)) {
        eventKeyErrors += 1;
        addVerificationError(errors, { line, code: "event_key_mismatch", eventKey: record.eventKey });
      }
      const expectedPayloadSha256 = ledgerPayloadHash(record);
      if (!safeSecretEqual(record.payloadSha256, expectedPayloadSha256)) {
        payloadErrors += 1;
        addVerificationError(errors, { line, code: "payload_digest_mismatch", eventKey: record.eventKey });
      }
    } catch {
      payloadErrors += 1;
      addVerificationError(errors, { line, code: "invalid_payload", eventKey: record.eventKey });
    }
    const key = scopedEventKey(record);
    const existing = byKey.get(key);
    if (existing) {
      if (existing.payloadSha256 === record.payloadSha256) duplicateEventKeys += 1;
      else conflictingEventKeys += 1;
      addVerificationError(errors, { line, code: "duplicate_event_key", eventKey: record.eventKey });
    } else {
      byKey.set(key, record);
    }
    if ((record.previousCommitSha256 || null) !== previousCommitSha256) {
      chainErrors += 1;
      addVerificationError(errors, { line, code: "previous_commit_mismatch", eventKey: record.eventKey });
    }
    const { commitSha256, ...base } = record;
    const expected = sha256(stableStringify(base));
    if (!safeSecretEqual(commitSha256, expected)) {
      chainErrors += 1;
      addVerificationError(errors, { line, code: "commit_digest_mismatch", eventKey: record.eventKey });
    }
    previousCommitSha256 = commitSha256 || null;
  }
  for (const entry of malformed) addVerificationError(errors, { line: entry.line, code: "malformed_json" });
  const coverage = ledgerCoverage(records.filter((record) => record && typeof record === "object" && record.usage));
  const totalErrors = errors.total || 0;
  return {
    valid: malformed.length === 0 && duplicateEventKeys === 0 && conflictingEventKeys === 0 &&
      chainErrors === 0 && eventKeyErrors === 0 && payloadErrors === 0 && invalidRecords === 0,
    recordCount: records.length,
    uniqueEventCount: byKey.size,
    malformedRecords: malformed.length,
    duplicateEventKeys,
    conflictingEventKeys,
    chainErrors,
    eventKeyErrors,
    payloadErrors,
    invalidRecords,
    totalErrors,
    errors: errors.slice(0, MAX_LEDGER_ERRORS),
    errorsTruncated: totalErrors > MAX_LEDGER_ERRORS,
    headCommitSha256: previousCommitSha256,
    coverage
  };
}

function addVerificationError(errors, error) {
  errors.total = (errors.total || 0) + 1;
  if (errors.length < MAX_LEDGER_ERRORS) errors.push(error);
}

function ledgerCoverage(events) {
  const price = { priced: 0, unpriced: 0, unknown: 0 };
  const tokenFields = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
  const assignmentStrength = { confirmed: 0, strong: 0, weak: 0, unassigned: 0, unknown: 0 };
  const deviceAttribution = { uploader: 0, unknown: 0 };
  const models = { present: 0, missing: 0 };
  let completeTokenFields = 0;
  let projectAssigned = 0;
  let projectUnassigned = 0;
  let unknownDevice = 0;
  for (const event of events) {
    const status = ALLOWED_PRICE_STATUSES.has(event?.priceCoverage?.status) ? event.priceCoverage.status : "unknown";
    price[status] += 1;
    const fieldSet = new Set(event?.usageFieldCoverage || []);
    for (const field of TOKEN_FIELDS) {
      if (fieldSet.has(field)) tokenFields[field] += 1;
    }
    if (TOKEN_FIELDS.every((field) => fieldSet.has(field))) completeTokenFields += 1;
    const strength = ALLOWED_ASSIGNMENT_STRENGTHS.has(event?.lineage?.assignmentStrength)
      ? event.lineage.assignmentStrength
      : "unknown";
    assignmentStrength[strength] += 1;
    if (event?.lineage?.projectId && !["unassigned", "unknown"].includes(event?.lineage?.assignmentStrength)) {
      projectAssigned += 1;
    } else {
      projectUnassigned += 1;
    }
    if (!event?.deviceId) {
      unknownDevice += 1;
      deviceAttribution.unknown += 1;
    } else {
      deviceAttribution.uploader += 1;
    }
    models[event?.model ? "present" : "missing"] += 1;
  }
  const count = events.length;
  return {
    events: count,
    price,
    tokenFields,
    assignmentStrength,
    deviceAttribution,
    models,
    pricedRatio: count ? price.priced / count : null,
    completeTokenFields,
    incompleteTokenFields: count - completeTokenFields,
    projectAssigned,
    projectUnassigned,
    unknownDevice
  };
}

function aggregateLedgerEvents(events, options = {}) {
  const aggregate = aggregateUsageEvents(events.map((event) => ({
    providerId: event.providerId,
    sourceId: event.providerId,
    eventId: event.eventKey,
    timestampMs: Date.parse(event.sourceTimestamp),
    model: event.model,
    usage: event.usage,
    metadata: {
      sourceGroupId: event.providerId,
      deviceId: event.deviceId
    }
  })), {
    dailyHistoryDays: options.dailyHistoryDays,
    now: options.now,
    slotMinutes: options.slotMinutes
  });
  return {
    id: "sync",
    status: aggregate.totals.allTime.totalTokens > 0 ? "live" : "empty",
    updatedAt: new Date(Number(options.now) || Date.now()).toISOString(),
    totals: aggregate.totals,
    daily: aggregate.daily,
    slots: aggregate.slots,
    sources: aggregate.sources,
    eventStats: aggregate.stats
  };
}

function aggregateDeviceTotals(events, devices, options = {}) {
  const rows = [];
  for (const device of devices) {
    const aggregate = aggregateLedgerEvents(events.filter((event) => event.deviceId === device.id), options);
    rows.push({ device: publicDevice(device), totals: aggregate.totals, eventCount: aggregate.eventStats.eventsAccepted });
  }
  const unknown = aggregateLedgerEvents(events.filter((event) => !event.deviceId), options);
  rows.push({ device: null, totals: unknown.totals, eventCount: unknown.eventStats.eventsAccepted });
  return rows;
}

function normalizeDeviceFilter(value, currentDeviceId, devices) {
  const requested = String(value || "all").trim();
  if (requested === "all") return { mode: "all", publicValue: "all" };
  if (requested === "this") return { mode: "device", deviceId: currentDeviceId, publicValue: "this" };
  if (requested === "unknown") return { mode: "unknown", publicValue: "unknown" };
  const deviceId = safeIdentifier(requested, "device_id", 100);
  if (!devices.some((device) => device.id === deviceId)) {
    throw validationError("device_not_found", "Device was not found in this sync space.", 404);
  }
  return { mode: "device", deviceId, publicValue: deviceId };
}

function publicVerification(verification) {
  return {
    valid: verification.valid,
    recordCount: verification.recordCount,
    uniqueEventCount: verification.uniqueEventCount,
    malformedRecords: verification.malformedRecords,
    duplicateEventKeys: verification.duplicateEventKeys,
    conflictingEventKeys: verification.conflictingEventKeys,
    chainErrors: verification.chainErrors,
    eventKeyErrors: verification.eventKeyErrors,
    payloadErrors: verification.payloadErrors,
    invalidRecords: verification.invalidRecords,
    totalErrors: verification.totalErrors,
    errors: verification.errors,
    errorsTruncated: verification.errorsTruncated,
    headCommitSha256: verification.headCommitSha256,
    coverage: verification.coverage
  };
}

function buildIndex(records, verification) {
  return {
    records,
    byKey: new Map(records
      .filter((record) => record && typeof record === "object")
      .map((record) => [scopedEventKey(record), record])),
    headCommitSha256: verification.headCommitSha256 || null,
    verification
  };
}

function scopedEventKey(event) {
  return `${event.syncSpaceId}:${event.eventKey}`;
}

function syncEventKey(providerId, sourceEventSha256) {
  if (!validSha256(sourceEventSha256)) {
    throw validationError("source_event_digest_required", "sourceEventSha256 must be a SHA-256 digest.");
  }
  return sha256(stableStringify({
    version: LEDGER_EVENT_VERSION,
    providerId: safeIdentifier(providerId, "provider_id", 80),
    sourceEventSha256: String(sourceEventSha256).toLowerCase()
  }));
}

function compareLedgerEvents(left, right) {
  return String(left.sourceTimestamp || "").localeCompare(String(right.sourceTimestamp || "")) ||
    String(left.syncSpaceId || "").localeCompare(String(right.syncSpaceId || "")) ||
    String(left.eventKey || "").localeCompare(String(right.eventKey || "")) ||
    String(left.ingestedAt || "").localeCompare(String(right.ingestedAt || ""));
}

function createDeviceRecord(input, syncSpaceId, createdAt, randomBytes) {
  const token = secretToken(randomBytes);
  return {
    token,
    record: {
      id: randomId("device", randomBytes),
      syncSpaceId,
      displayName: displayName(input.deviceName || input.displayName, "Unnamed device"),
      platform: safePlatform(input.platform),
      appVersion: safeVersion(input.appVersion, "unknown"),
      tokenHash: secretHash(token),
      createdAt,
      lastSeenAt: createdAt,
      revokedAt: null
    }
  };
}

function touchDeviceRecord(device, nowMs) {
  const previous = Date.parse(device.lastSeenAt || 0);
  if (!Number.isFinite(previous) || nowMs - previous >= 30 * 1000) {
    device.lastSeenAt = new Date(nowMs).toISOString();
  }
}

function findDeviceByToken(devices, token) {
  const hash = secretHash(token);
  return devices.find((device) => safeSecretEqual(device.tokenHash, hash)) || null;
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, spaces: [], devices: [], pairingCodes: [] };
}

function normalizeRegistry(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    version: REGISTRY_VERSION,
    spaces: Array.isArray(value.spaces) ? value.spaces.filter(Boolean) : [],
    devices: Array.isArray(value.devices) ? value.devices.filter(Boolean) : [],
    pairingCodes: Array.isArray(value.pairingCodes) ? value.pairingCodes.filter(Boolean) : []
  };
}

function publicSpace(space) {
  if (!space) return null;
  return { id: space.id, displayName: space.displayName, createdAt: space.createdAt };
}

function publicDevice(device) {
  if (!device) return null;
  return {
    id: device.id,
    syncSpaceId: device.syncSpaceId,
    displayName: device.displayName,
    platform: device.platform,
    appVersion: device.appVersion,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt
  };
}

function assertAllowedFields(value, allowed, location) {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw validationError("invalid_event_field", `${location} must be an object.`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw validationError("unsupported_event_field", `${location}.${unknown} is not allowed.`);
}

function findForbiddenField(value, prefix = "event") {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (FORBIDDEN_KEYS.has(normalized)) return `${prefix}.${key}`;
    if (child && typeof child === "object") {
      const nested = findForbiddenField(child, `${prefix}.${key}`);
      if (nested) return nested;
    }
  }
  return null;
}

function displayName(value, fallback) {
  const text = shortText(value, fallback, 80);
  if (containsControl(text) || looksLikeAbsolutePath(text) || looksLikeEmail(text)) {
    throw validationError("invalid_display_name", "Display name contains private or invalid data.");
  }
  return text;
}

function safePlatform(value) {
  const platform = String(value || "unknown").trim().toLowerCase();
  return ["darwin", "linux", "win32", "unknown"].includes(platform) ? platform : "unknown";
}

function safeIdentifier(value, field, maxLength = 160) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || looksLikeEmail(text) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]*$/u.test(text)) {
    throw validationError(`invalid_${field}`, `${field} is invalid.`);
  }
  return text;
}

function optionalIdentifier(value, maxLength = 160) {
  if (value === undefined || value === null || value === "") return null;
  return safeIdentifier(value, "identifier", maxLength);
}

function optionalSafeText(value, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!text || text.length > maxLength || containsControl(text) || looksLikeAbsolutePath(text) || looksLikeEmail(text)) {
    throw validationError("invalid_text", "Event text field is invalid.");
  }
  return text;
}

function safeVersion(value, fallback = "unknown") {
  const text = String(value || fallback).trim();
  if (!text || text.length > 80 || containsControl(text) || looksLikeAbsolutePath(text) || looksLikeEmail(text) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$/u.test(text)) {
    throw validationError("invalid_version", "Version identifier is invalid.");
  }
  return text;
}

function shortText(value, fallback, maxLength) {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, maxLength);
}

function containsControl(value) {
  return /[\u0000-\u001f\u007f]/u.test(String(value));
}

function looksLikeAbsolutePath(value) {
  return /^\/(?:[^/]+\/)*[^/]*$/u.test(value) || /^[a-zA-Z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(String(value));
}

function normalizeIso(value, field) {
  const numeric = typeof value === "number" ? value : null;
  const date = new Date(numeric !== null ? numeric : value);
  if (Number.isNaN(date.getTime())) throw validationError(`invalid_${field}`, `${field} must be an ISO timestamp.`);
  return date.toISOString();
}

function optionalIso(value) {
  if (value === undefined || value === null || value === "") return null;
  return normalizeIso(value, "timestamp");
}

function nonNegativeNumber(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw validationError("invalid_usage", "Token and runtime values must be non-negative numbers.");
  return number;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function randomId(prefix, randomBytes) {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function secretToken(randomBytes) {
  return randomBytes(32).toString("base64url");
}

function pairingCode(randomBytes) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function normalizePairingCode(value) {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/gu, "");
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : "";
}

function secretHash(value) {
  return sha256(`sync-secret-v1\0${String(value || "")}`);
}

function saltedSecretHash(value, salt) {
  return sha256(`sync-pairing-v1\0${salt}\0${normalizePairingCode(value)}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/u.test(String(value || ""));
}

function safeSecretEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function stableStringify(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function safeTimestamp(value) {
  return String(value).replace(/[^0-9TZ-]/gu, "-");
}

function validationError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function authError() {
  return validationError("sync_device_forbidden", "Device token is invalid or revoked.", 401);
}

async function readJsonLines(file) {
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], malformed: [] };
    throw error;
  }
  const records = [];
  const malformed = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed.push({
        line: index + 1,
        rawSha256: sha256(line)
      });
    }
  }
  return { records, malformed };
}

async function appendJsonLines(file, rows) {
  if (!rows.length) return;
  const directory = path.dirname(file);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700).catch(() => {});
  await fsp.appendFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  await fsp.chmod(file, 0o600).catch(() => {});
}

async function writeJsonLinesAtomic(file, rows) {
  const text = rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  await writeTextAtomic(file, text);
}

async function writeJsonAtomic(file, value) {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(file, text) {
  const directory = path.dirname(file);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700).catch(() => {});
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  await fsp.writeFile(temp, text, { mode: 0o600 });
  await fsp.rename(temp, file);
  await fsp.chmod(file, 0o600).catch(() => {});
}

module.exports = {
  DEFAULT_PAIRING_TTL_MS,
  LEDGER_EVENT_VERSION,
  MAX_UPLOAD_EVENTS,
  SyncLedger,
  TOKEN_FIELDS,
  aggregateLedgerEvents,
  ledgerCoverage,
  normalizeLedgerEvent,
  normalizeLedgerUsage,
  publicVerification,
  stableStringify,
  syncEventKey,
  verifyLedgerRecords,
  _test: {
    commitLedgerEvent,
    findForbiddenField,
    ledgerPayloadHash,
    normalizePairingCode,
    readJsonLines,
    safeSecretEqual,
    snapshotAsEvent,
    writeJsonLinesAtomic
  }
};
