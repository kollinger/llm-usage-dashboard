import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SyncLedger } = require("../lib/sync-ledger.js");
const { dedupeUsageEvents } = require("../lib/usage-events.js");

const root = await mkdtemp(path.join(os.tmpdir(), "llm-sync-ledger-test-"));
let nowMs = Date.parse("2026-08-20T08:00:00.000Z");
const ledger = new SyncLedger({
  dataDir: root,
  now: () => nowMs,
  collectorVersion: "test"
});

try {
  await assert.rejects(
    ledger.createSpace({ deviceName: "person@example.test" }),
    (error) => error.code === "invalid_display_name"
  );
  const first = await ledger.createSpace({
    displayName: "Private test",
    deviceName: "Mac M1",
    platform: "darwin",
    appVersion: "1.2.0"
  });
  assert.match(first.deviceToken, /^[A-Za-z0-9_-]{40,}$/u);
  assert.equal(first.device.displayName, "Mac M1");

  const pairing = await ledger.createPairingCode(first.deviceToken, { ttlMs: 60_000 });
  assert.match(pairing.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
  const second = await ledger.joinWithPairingCode({
    code: pairing.code,
    deviceName: "Manjaro Home",
    platform: "linux",
    appVersion: "1.2.0"
  });
  await assert.rejects(
    ledger.joinWithPairingCode({ code: pairing.code, deviceName: "Replay" }),
    (error) => error.code === "pairing_code_expired" && error.statusCode === 410
  );
  const expiringPairing = await ledger.createPairingCode(first.deviceToken, { ttlMs: 1000 });
  nowMs += 1001;
  await assert.rejects(
    ledger.joinWithPairingCode({ code: expiringPairing.code, deviceName: "Too late" }),
    (error) => error.code === "pairing_code_expired" && error.statusCode === 410
  );
  await assert.rejects(
    ledger.listDevices("not-a-device-token"),
    (error) => error.code === "sync_device_forbidden" && error.statusCode === 401
  );

  const eventA = usageEvent({
    digest: digest("event-a"),
    timestamp: "2026-08-20T07:00:00.000Z",
    input: 80,
    cached: 20,
    output: 30,
    total: 130,
    projectId: "project-a",
    assignmentStrength: "confirmed"
  });
  const firstUpload = await ledger.upload(first.deviceToken, { events: [eventA] });
  assert.deepEqual(firstUpload.totals, { received: 1, accepted: 1, duplicates: 0, conflicts: 0 });

  const retry = await ledger.upload(first.deviceToken, { events: [eventA] });
  assert.deepEqual(retry.totals, { received: 1, accepted: 0, duplicates: 1, conflicts: 0 });
  const mirroredRetry = await ledger.upload(second.deviceToken, { events: [eventA] });
  assert.equal(mirroredRetry.totals.duplicates, 1, "the same source event must dedupe across devices");

  const conflict = await ledger.upload(second.deviceToken, {
    events: [{ ...eventA, usage: { ...eventA.usage, outputTokens: 99, totalTokens: 199 } }]
  });
  assert.equal(conflict.totals.conflicts, 1);
  assert.equal(conflict.totals.accepted, 0);

  const eventB = usageEvent({
    digest: digest("event-b"),
    timestamp: "2026-08-20T07:30:00.000Z",
    input: 40,
    cached: 0,
    output: 10,
    total: 50,
    priceStatus: "unpriced"
  });
  const unknown = usageEvent({
    digest: digest("event-mobile-unknown"),
    timestamp: "2026-08-20T07:45:00.000Z",
    input: 10,
    output: 5,
    total: 15,
    deviceAttribution: "unknown"
  });
  const secondUpload = await ledger.upload(second.deviceToken, { events: [eventB, unknown] });
  assert.equal(secondUpload.totals.accepted, 2);

  const snapshot = {
    providerId: "codex",
    model: "gpt-5.6",
    dedupKey: "codex-day-2026-08-19-rev-1",
    windowKey: "2026-08-19",
    snapshotStartedAt: "2026-08-19T00:00:00.000Z",
    snapshotEndedAt: "2026-08-20T00:00:00.000Z",
    capturedAt: "2026-08-20T07:50:00.000Z",
    usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }
  };
  assert.equal((await ledger.upload(first.deviceToken, { snapshots: [snapshot] })).totals.accepted, 1);
  assert.equal((await ledger.upload(first.deviceToken, { snapshots: [snapshot] })).totals.duplicates, 1);
  assert.equal((await ledger.upload(first.deviceToken, {
    snapshots: [{ ...snapshot, capturedAt: "2026-08-20T07:55:00.000Z" }]
  })).totals.conflicts, 1, "a stable snapshot key must reject changed payloads instead of double counting");

  const all = await ledger.queryUsage(first.deviceToken, { deviceId: "all", now: nowMs });
  assert.equal(all.usage.totals.allTime.totalTokens, 200, "canonical totals must count each event once");
  assert.equal(all.integrity.valid, true);
  assert.equal(all.integrity.duplicateEventKeys, 0);
  assert.equal(all.coverage.price.unpriced, 1);
  assert.equal(all.coverage.price.unknown, 3);
  assert.equal(all.coverage.unknownDevice, 1);
  assert.equal(all.coverage.tokenFields.totalTokens, 4);
  assert.equal(all.coverage.assignmentStrength.confirmed, 1);
  assert.deepEqual(all.coverage.deviceAttribution, { uploader: 3, unknown: 1 });
  assert.deepEqual(all.coverage.models, { present: 4, missing: 0 });

  const thisDevice = await ledger.queryUsage(first.deviceToken, { deviceId: "this", now: nowMs });
  assert.equal(thisDevice.usage.totals.allTime.totalTokens, 135);
  const secondDevice = await ledger.queryUsage(first.deviceToken, { deviceId: second.device.id, now: nowMs });
  assert.equal(secondDevice.usage.totals.allTime.totalTokens, 50);
  const unknownDevice = await ledger.queryUsage(first.deviceToken, { deviceId: "unknown", now: nowMs });
  assert.equal(unknownDevice.usage.totals.allTime.totalTokens, 15);

  await assert.rejects(
    ledger.upload(first.deviceToken, {
      events: [{ ...usageEvent({ digest: digest("private"), total: 1 }), prompt: "do not store me" }]
    }),
    (error) => error.code === "forbidden_event_field"
  );
  await assert.rejects(
    ledger.upload(first.deviceToken, {
      events: [{ ...usageEvent({ digest: digest("private-email"), total: 1 }), model: "person@example.test" }]
    }),
    (error) => error.code === "invalid_text"
  );
  await assert.rejects(
    ledger.upload(first.deviceToken, {
      events: [{
        ...usageEvent({ digest: digest("private-email-id"), total: 1 }),
        lineage: { projectId: "person@example.test", assignmentStrength: "confirmed" }
      }]
    }),
    (error) => error.code === "invalid_identifier"
  );
  const persisted = await readFile(path.join(root, "events.jsonl"), "utf8");
  assert.doesNotMatch(persisted, /do not store me|prompt|\/Users\/|deviceToken/u);
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(root, "events.jsonl"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(root, "registry.json"))).mode & 0o777, 0o600);
  }

  const pathIndependent = dedupeUsageEvents([
    localUsageEvent("/Users/example/.codex/sessions/a.jsonl"),
    localUsageEvent("/Users/example/.codex/archived_sessions/a.jsonl")
  ]);
  assert.equal(pathIndependent.events.length, 1);
  assert.equal(pathIndependent.duplicatesSkipped, 1);

  const ledgerFile = path.join(root, "events.jsonl");
  const lines = (await readFile(ledgerFile, "utf8")).trim().split("\n");
  const tamperedRows = lines.map(JSON.parse);
  tamperedRows[0].usage.totalTokens += 1;
  await writeFile(ledgerFile, `${tamperedRows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const tampered = await ledger.verify();
  assert.equal(tampered.valid, false);
  assert.equal(tampered.payloadErrors, 1, "verification must recompute the normalized payload digest");
  await assert.rejects(
    ledger.queryUsage(first.deviceToken, { deviceId: "all", now: nowMs }),
    (error) => error.code === "ledger_integrity_invalid" && error.statusCode === 409
  );
  await writeFile(ledgerFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  assert.equal((await ledger.verify()).valid, true);

  await writeFile(ledgerFile, `${lines.join("\n")}\n${lines[0]}\n${JSON.stringify({ bogus: true })}\n42\nnot-json\n`, { mode: 0o600 });
  const broken = await ledger.verify();
  assert.equal(broken.valid, false);
  assert.equal(broken.duplicateEventKeys, 1);
  assert(broken.chainErrors >= 1);
  assert.equal(broken.malformedRecords, 1);
  assert.equal(broken.invalidRecords, 1);

  nowMs += 60_000;
  const reconciled = await ledger.reconcile();
  assert.equal(reconciled.before.valid, false);
  assert.equal(reconciled.duplicatesRemoved, 1);
  assert.equal(reconciled.invalidRecordsDropped, 3);
  assert.equal(reconciled.after.valid, true);
  assert.equal(reconciled.recordsPreservedInBackup, 8);
  assert.equal(reconciled.backupCreated, true);
  const reconciledRows = (await readFile(ledgerFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    reconciledRows.map((row) => row.sourceTimestamp),
    reconciledRows.map((row) => row.sourceTimestamp).slice().sort(),
    "reconcile must use deterministic chronological order"
  );
} finally {
  await chmod(root, 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
}

console.log("sync ledger tests passed");

function usageEvent(options = {}) {
  const input = Number(options.input || 0);
  const cached = Number(options.cached || 0);
  const output = Number(options.output || 0);
  const reasoning = Number(options.reasoning || 0);
  const total = Number(options.total ?? input + cached + output + reasoning);
  return {
    schemaVersion: 1,
    sourceEventSha256: options.digest || digest(`event-${Math.random()}`),
    sourceTimestamp: options.timestamp || "2026-08-20T06:00:00.000Z",
    providerId: "codex",
    model: "gpt-5.6",
    usage: {
      inputTokens: input,
      cachedInputTokens: cached,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: reasoning,
      totalTokens: total
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
    lineage: {
      projectId: options.projectId || null,
      assignmentStrength: options.assignmentStrength || "unknown"
    },
    priceCoverage: { status: options.priceStatus || "unknown" },
    deviceAttribution: options.deviceAttribution || "uploader"
  };
}

function digest(value) {
  return require("node:crypto").createHash("sha256").update(value).digest("hex");
}

function localUsageEvent(realpath) {
  return {
    providerId: "codex",
    sourceId: "codex-source",
    timestampMs: Date.parse("2026-08-20T07:00:00.000Z"),
    model: "gpt-5.6",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    evidence: {
      sourceEventSha256: digest("same-original-jsonl-line"),
      realpath,
      line: 12,
      sessionId: "session-a"
    }
  };
}
