import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "llm-sync-api-test-"));
process.env.LLM_USAGE_DATA_DIR = dataDir;
process.env.LLM_USAGE_SYNC_COLLECTOR_ENABLED = "true";
process.env.LLM_USAGE_SYNC_COLLECTOR_ADMIN_TOKEN = "test-admin-token-never-persist";
process.env.CODEX_LIVE_RATE_LIMITS = "false";
process.env.COPILOT_LIVE_QUOTA_ENABLED = "false";
process.env.GLM_CODING_PLAN_QUOTA_ENABLED = "false";

const require = createRequire(import.meta.url);
const { startDashboard } = require("../server.js");
const { dashboardServer, ollamaProxyServer } = startDashboard({ port: 0, ollamaProxy: false });
await onceListening(dashboardServer);
const address = dashboardServer.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const forbiddenAdmin = await api("POST", "/api/sync/spaces", {
    body: { displayName: "Private test", deviceName: "Device A" }
  });
  assert.equal(forbiddenAdmin.status, 401);

  const created = await api("POST", "/api/sync/spaces", {
    token: process.env.LLM_USAGE_SYNC_COLLECTOR_ADMIN_TOKEN,
    body: { displayName: "Private test", deviceName: "Device A", platform: "darwin", appVersion: "test" }
  });
  assert.equal(created.status, 201);
  assert(created.body.deviceToken);

  const pairing = await api("POST", "/api/sync/pairing-codes", {
    token: created.body.deviceToken,
    body: {}
  });
  assert.equal(pairing.status, 201);

  const joined = await api("POST", "/api/sync/devices", {
    body: { code: pairing.body.code, deviceName: "Device B", platform: "linux", appVersion: "test" }
  });
  assert.equal(joined.status, 201);
  assert.notEqual(joined.body.device.id, created.body.device.id);

  const firstEvent = event("device-a-event", 100, "2026-08-20T08:00:00.000Z");
  const firstUpload = await api("POST", "/api/sync/usage", {
    token: created.body.deviceToken,
    body: { events: [firstEvent] }
  });
  assert.equal(firstUpload.status, 200);
  assert.equal(firstUpload.body.totals.accepted, 1);

  const retry = await api("POST", "/api/sync/usage", {
    token: joined.body.deviceToken,
    body: { events: [firstEvent] }
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.totals.duplicates, 1);

  const secondEvent = event("device-b-event", 40, "2026-08-20T08:10:00.000Z");
  const unknownEvent = {
    ...event("unknown-device-event", 10, "2026-08-20T08:20:00.000Z"),
    deviceAttribution: "unknown"
  };
  const secondUpload = await api("POST", "/api/sync/usage", {
    token: joined.body.deviceToken,
    body: { events: [secondEvent, unknownEvent] }
  });
  assert.equal(secondUpload.body.totals.accepted, 2);

  const all = await api("GET", "/api/sync/usage?device_id=all", { token: created.body.deviceToken });
  assert.equal(all.body.usage.totals.allTime.totalTokens, 150);
  const firstOnly = await api("GET", "/api/sync/usage?device_id=this", { token: created.body.deviceToken });
  assert.equal(firstOnly.body.usage.totals.allTime.totalTokens, 100);
  const secondOnly = await api("GET", `/api/sync/usage?device_id=${joined.body.device.id}`, {
    token: created.body.deviceToken
  });
  assert.equal(secondOnly.body.usage.totals.allTime.totalTokens, 40);
  const unknownOnly = await api("GET", "/api/sync/usage?device_id=unknown", { token: created.body.deviceToken });
  assert.equal(unknownOnly.body.usage.totals.allTime.totalTokens, 10);

  const conflict = await api("POST", "/api/sync/usage", {
    token: created.body.deviceToken,
    body: { events: [{ ...firstEvent, usage: { ...firstEvent.usage, outputTokens: 999, totalTokens: 1099 } }] }
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.conflicts.length, 1);

  const privacyViolation = await api("POST", "/api/sync/usage", {
    token: created.body.deviceToken,
    body: { events: [{ ...event("private-event", 1), transcript: "private raw text" }] }
  });
  assert.equal(privacyViolation.status, 400);
  assert.equal(privacyViolation.body.error, "forbidden_event_field");

  const devices = await api("GET", "/api/sync/devices", { token: created.body.deviceToken });
  assert.equal(devices.body.devices.length, 2);
  const integrity = await api("GET", "/api/sync/integrity", { token: created.body.deviceToken });
  assert.equal(integrity.body.valid, true);
  assert.equal(integrity.body.recordCount, 3);

  const storedLedger = await readFile(path.join(dataDir, "cloud-sync", "events.jsonl"), "utf8");
  const registry = await readFile(path.join(dataDir, "cloud-sync", "registry.json"), "utf8");
  assert.doesNotMatch(storedLedger, /private raw text|transcript|deviceToken|test-admin-token-never-persist/u);
  assert.doesNotMatch(registry, new RegExp(escapeRegex(created.body.deviceToken), "u"));
  assert.doesNotMatch(registry, new RegExp(escapeRegex(joined.body.deviceToken), "u"));

  const localPairing = await api("POST", "/api/sync/pairing-codes", {
    token: created.body.deviceToken,
    body: {}
  });
  const localJoin = await api("POST", "/api/sync/local/join", {
    body: {
      serverUrl: baseUrl,
      deviceName: "Dashboard client",
      pairingCode: localPairing.body.code
    }
  });
  assert.equal(localJoin.status, 201);
  assert.equal(localJoin.body.connected, true);
  assert.equal(localJoin.body.deviceToken, undefined, "browser-facing local APIs must never return the device token");
  const localStatus = await api("GET", "/api/sync/local/status");
  assert.equal(localStatus.body.connected, true);
  assert.equal(localStatus.body.collectorEnabled, true);
  assert.equal(localStatus.body.deviceToken, undefined);
  const localDevices = await api("GET", "/api/sync/local/devices");
  assert.equal(localDevices.body.devices.length, 3);
  const localUsage = await api("GET", "/api/sync/local/usage?device_id=all");
  assert.equal(localUsage.body.usage.totals.allTime.totalTokens, 150);
  const localPairingResult = await api("POST", "/api/sync/local/pairing-code", { body: {} });
  assert.equal(localPairingResult.status, 201);
  assert.match(localPairingResult.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
  const disconnected = await api("DELETE", "/api/sync/local/connection");
  assert.equal(disconnected.body.connected, false);
  assert.equal(disconnected.body.pendingCount, 0);

  const forbiddenReconcile = await api("POST", "/api/sync/reconcile", { body: {} });
  assert.equal(forbiddenReconcile.status, 401);
  const reconciled = await api("POST", "/api/sync/reconcile", {
    token: process.env.LLM_USAGE_SYNC_COLLECTOR_ADMIN_TOKEN,
    body: {}
  });
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.after.valid, true);

  const revoked = await api("DELETE", `/api/sync/devices/${joined.body.device.id}`, {
    token: created.body.deviceToken
  });
  assert.equal(revoked.status, 200);
  const revokedAccess = await api("GET", "/api/sync/devices", { token: joined.body.deviceToken });
  assert.equal(revokedAccess.status, 401);
} finally {
  await closeServer(dashboardServer);
  await closeServer(ollamaProxyServer);
  await rm(dataDir, { recursive: true, force: true });
}

console.log("two-device sync API smoke passed");

async function api(method, endpoint, options = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

function event(seed, totalTokens, timestamp = "2026-08-20T07:00:00.000Z") {
  return {
    schemaVersion: 1,
    sourceEventSha256: crypto.createHash("sha256").update(seed).digest("hex"),
    sourceTimestamp: timestamp,
    providerId: "codex",
    model: "gpt-5.6",
    usage: {
      inputTokens: Math.max(0, totalTokens - 10),
      cachedInputTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: Math.min(10, totalTokens),
      reasoningOutputTokens: 0,
      totalTokens
    },
    usageFieldCoverage: [
      "inputTokens",
      "cachedInputTokens",
      "cacheWrite5mTokens",
      "cacheWrite1hTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens"
    ],
    lineage: { assignmentStrength: "unassigned" },
    priceCoverage: { status: "unpriced" }
  };
}

function onceListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
