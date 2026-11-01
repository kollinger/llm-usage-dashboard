import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeviceSync, createIdentity, verifySnapshot, legacySnapshot, readStoredSnapshots } from "../lib/device-sync.js";
import { sanitizeEvent } from "../lib/device-sync-data.js";
import { conversationDescriptor } from "../lib/chat-usage.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "sync-json-memory-"));
const sync = new DeviceSync({ dataDir: directory, discovery: false });
sync.identity = createIdentity(); sync.config.enabled = true; sync.config.name = "Prüfung 🧪";
const stringify = JSON.stringify;
const timestamp = new Date().toISOString();
const payload = { excludedEvents: 0, accounts: [], connections: [], events: Array.from({ length: 5000 }, (_, index) => ({
  key: index.toString(16).padStart(64, "0"), timestamp, providerId: "codex", model: "fixture",
  usage: { totalTokens: index + 1 }, conversation: conversationDescriptor("codex", "fixture", { title: "ÄÖÜ 🧪" })
})).map(sanitizeEvent) };
try {
  // Replace a native OOM with a deterministic failure at the unsafe operation.
  // The actual crash occurred in V8 JsonStringify on a 424 MB sync store.
  JSON.stringify = (value, ...args) => {
    if (Array.isArray(value) && value.length > 400 || value && Array.isArray(value.events) && value.events.length > 400 ||
        Array.isArray(value) && value.some(row => row && Array.isArray(row.events) && row.events.length > 400)) {
      throw new Error("whole_history_json_allocation");
    }
    return stringify(value, ...args);
  };
  await sync.capture(payload);
  const first = sync.snapshots.get(sync.identity.id);
  assert.equal(verifySnapshot(first).events.length, 5000);
  const { revision, signature, legacy, ...body } = first;
  assert.equal(revision, crypto.createHash("sha256").update(stringify(body)).digest("hex"), "signed bytes stay compatible with existing peers");
  const compatible = legacySnapshot(first);
  assert(compatible);
  const { revision: oldRevision, signature: oldSignature, ...oldBody } = compatible;
  assert.equal(oldRevision, crypto.createHash("sha256").update(stringify(oldBody)).digest("hex"));
  await sync.capture(payload);
  assert.equal(sync.snapshots.get(sync.identity.id) === first, true, "unchanged history must skip capture and persistence");
  await sync.capture({ ...payload, events: [...payload.events, { ...payload.events[0], key: "f".repeat(64) }] });
  assert.equal(sync.snapshots.get(sync.identity.id).events.length, 5001);
  const restored = await readStoredSnapshots(path.join(directory, "device-sync/snapshots.json"), sync.identity.storageKey);
  assert.equal(restored[0].events.length, 5001, "the existing encrypted format remains readable");
  assert.equal(verifySnapshot(restored[0]).revision, sync.snapshots.get(sync.identity.id).revision);
  const tampered = { ...restored[0], events: restored[0].events.slice() };
  tampered.events[0] = { ...tampered.events[0], model: "changed" };
  assert.throws(() => verifySnapshot(tampered), /invalid_snapshot_signature/);
  console.log("Sync JSON memory: no whole-history strings; Unicode, unchanged capture, append, old signed bytes, encrypted restore and tampering passed.");
} finally {
  JSON.stringify = stringify;
  await rm(directory, { recursive: true, force: true });
}
