import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const crypto = require("node:crypto");
const {
  LocalSyncClient,
  buildSyncUploadEvent,
  retryDelay,
  safeDelayUntil
} = require("../lib/sync-client.js");
const { syncEventKey } = require("../lib/sync-ledger.js");

const root = await mkdtemp(path.join(os.tmpdir(), "llm-sync-client-test-"));
let nowMs = Date.parse("2026-08-20T08:00:00.000Z");
let failUpload = true;
let conflictUpload = false;
const requests = [];

const fetchImpl = async (url, options = {}) => {
  requests.push({ url, options });
  if (url.endsWith("/api/sync/usage") && failUpload) throw new Error("collector offline");
  const body = options.body ? JSON.parse(options.body) : null;
  if (url.endsWith("/api/sync/usage")) {
    const accepted = body.events.map((event) => syncEventKey(event.providerId, event.sourceEventSha256));
    if (conflictUpload) {
      return response(409, {
        accepted: [],
        duplicates: [],
        conflicts: accepted.map((eventKey) => ({
          eventKey,
          existingPayloadSha256: digest("existing"),
          receivedPayloadSha256: digest("received")
        }))
      });
    }
    return response(200, { accepted, duplicates: [], conflicts: [] });
  }
  if (url.includes("/api/sync/usage?")) {
    return response(200, { usage: { totals: { allTime: { totalTokens: 10 } } } });
  }
  if (url.endsWith("/api/sync/devices")) return response(200, { devices: [{ id: "device_remote" }] });
  if (url.endsWith("/api/sync/pairing-codes")) return response(200, { code: "ABCD-EFGH" });
  return response(404, { error: "not_found" });
};

try {
  const defaulted = new LocalSyncClient({
    dataDir: path.join(root, "default-server"),
    fetchImpl,
    serverUrl: "https://sync.private.example/"
  });
  assert.equal((await defaulted.readPublicStatus()).serverUrl, "https://sync.private.example");
  await assert.rejects(
    defaulted.updateSettings({ deviceName: "/Users/private" }),
    (error) => error.code === "invalid_device_name"
  );

  const corruptRoot = path.join(root, "corrupt-outbox");
  await mkdir(corruptRoot, { recursive: true });
  await writeFile(path.join(corruptRoot, "sync-client-outbox.json"), "{not valid json", { mode: 0o600 });
  const corruptClient = new LocalSyncClient({ dataDir: corruptRoot, fetchImpl });
  await assert.rejects(
    corruptClient.readPublicStatus(),
    SyntaxError,
    "a corrupt persisted outbox must stop sync instead of silently discarding pending events"
  );

  const client = new LocalSyncClient({
    dataDir: root,
    fetchImpl,
    now: () => nowMs,
    appVersion: "1.2.0",
    collectorVersion: "1.2.0",
    retryBaseMs: 1000,
    retryMaxMs: 8000
  });
  await client.updateSettings({
    enabled: true,
    serverUrl: "http://100.64.0.5:4177/",
    deviceName: "Mac M1"
  });
  await client.attachConnection({
    device: { id: "device_local", syncSpaceId: "space_private", displayName: "Mac M1" },
    space: { id: "space_private" },
    deviceToken: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
  }, { serverUrl: "http://100.64.0.5:4177", deviceName: "Mac M1" });

  const raw = {
    providerId: "codex",
    sourceId: "local-source",
    eventId: "provider-event-a",
    timestampMs: nowMs - 1000,
    model: "gpt-5.6",
    usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
    evidence: {
      rawLineSha256: digest("safe original event"),
      realpath: "/Users/private/.codex/sessions/rollout.jsonl",
      line: 99,
      sessionId: "session-a"
    },
    metadata: { sourceGroupId: "codex" }
  };
  const uploadEvent = buildSyncUploadEvent(raw, { collectorVersion: "1.2.0" });
  assert.equal(uploadEvent.sourceEventSha256, raw.evidence.rawLineSha256);
  assert.equal(uploadEvent.evidence, undefined);
  assert.equal(uploadEvent.source.revision, raw.evidence.rawLineSha256);
  const scrubbedValues = buildSyncUploadEvent({
    ...raw,
    evidence: { ...raw.evidence, rawLineSha256: digest("private-shaped-values") },
    model: "person@example.test",
    metadata: { projectId: "person@example.test" }
  }, { collectorVersion: "1.2.0" });
  assert.equal(scrubbedValues.model, null);
  assert.equal(scrubbedValues.lineage.projectId, null);
  const scrubbedUncModel = buildSyncUploadEvent({
    ...raw,
    evidence: { ...raw.evidence, rawLineSha256: digest("unc-model") },
    model: String.raw`\\server\share`
  }, { collectorVersion: "1.2.0" });
  assert.equal(scrubbedUncModel.model, null, "client and collector must reject UNC-style paths consistently");

  const capture = await client.captureUsageEvents([raw, raw]);
  assert.equal(capture.captured, 1);
  assert.equal(capture.duplicates, 1);
  assert.equal(capture.pending, 1);
  const outboxText = await readFile(path.join(root, "sync-client-outbox.json"), "utf8");
  assert.doesNotMatch(outboxText, /\/Users\/private|rollout\.jsonl|prompt|transcript|deviceToken/u);
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(root, "sync-client-outbox.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(root, "sync-client-credentials.json"))).mode & 0o777, 0o600);
  }

  const offline = await client.flush({ force: true });
  assert.equal(offline.flushed, false);
  assert.equal(offline.pending, 1);
  assert.equal(offline.retryInMs, 1000);
  const statusAfterFailure = await client.readPublicStatus();
  assert.equal(statusAfterFailure.lastError, "collector offline");
  assert.equal(statusAfterFailure.retryAttempt, 1);
  assert.equal(statusAfterFailure.pendingCount, 1);
  assert.equal(safeDelayUntil(statusAfterFailure.nextRetryAt, nowMs), 1000);
  assert.equal(safeDelayUntil(statusAfterFailure.nextRetryAt, nowMs + 2000), 0, "past retry deadlines must never create negative sleeps");
  assert.equal(retryDelay(1, 1000, 8000), 1000);
  assert.equal(retryDelay(99, 1000, 8000), 8000);

  const backoff = await client.flush();
  assert.equal(backoff.skipped, "retry_backoff");
  failUpload = false;
  nowMs += 1000;
  const success = await client.flush();
  assert.equal(success.flushed, true);
  assert.equal(success.accepted, 1);
  assert.equal(success.pending, 0);
  assert.match(requests.at(-1).options.headers.authorization, /^Bearer /u);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).options.body), /\/Users\/private/u);

  const restarted = new LocalSyncClient({ dataDir: root, fetchImpl, now: () => nowMs, appVersion: "1.2.0" });
  const recapture = await restarted.captureUsageEvents([raw]);
  assert.equal(recapture.captured, 0, "the full acknowledged-key set must survive restart");
  assert.equal(recapture.duplicates, 1);
  assert.equal(recapture.pending, 0);

  const conflictingRaw = {
    ...raw,
    eventId: "provider-event-conflict",
    timestampMs: nowMs,
    evidence: { ...raw.evidence, rawLineSha256: digest("conflicting original event") }
  };
  assert.equal((await restarted.captureUsageEvents([conflictingRaw])).captured, 1);
  conflictUpload = true;
  const quarantined = await restarted.flush({ force: true });
  conflictUpload = false;
  assert.equal(quarantined.conflicts, 1);
  assert.equal(quarantined.pending, 0, "conflicts must leave the retry queue instead of looping forever");
  assert.equal((await restarted.readPublicStatus()).conflictCount, 1);

  assert.deepEqual(await restarted.listDevices(), [{ id: "device_remote" }]);
  assert.equal((await restarted.createPairingCode()).code, "ABCD-EFGH");
  assert.equal((await restarted.queryUsage({ deviceId: "unknown" })).usage.totals.allTime.totalTokens, 10);

  const publicStatus = await restarted.readPublicStatus();
  assert.equal(publicStatus.connected, true);
  assert.equal(publicStatus.deviceId, "device_local");
  assert.equal(publicStatus.deviceToken, undefined);
  const disconnected = await restarted.disconnect();
  assert.equal(disconnected.enabled, false);
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.pendingCount, 0);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("sync client tests passed");

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}
