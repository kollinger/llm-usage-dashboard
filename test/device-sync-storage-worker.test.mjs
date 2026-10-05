import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DeviceSync, createIdentity, signedSnapshot } from "../lib/device-sync.js";

const dir = await mkdtemp(path.join(tmpdir(), "sync-storage-worker-"));
const identity = createIdentity();
const snapshot = signedSnapshot(identity, "Fixture", { accounts: [], excludedEvents: 0,
  events: Array.from({ length: 30_000 }, (_, index) => ({ key: crypto.createHash("sha256").update(String(index)).digest("hex"),
    timestamp: new Date().toISOString(), providerId: "codex", model: "fixture", usage: { totalTokens: 1 } })) });
const device = new DeviceSync({ dataDir: dir, discovery: false, host: "127.0.0.1", port: 0 });
function encryptSnapshots(snapshots) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(identity.storageKey, "base64"), nonce);
  cipher.setAAD(Buffer.from("llm-device-sync-storage-v1"));
  const body = Buffer.concat([cipher.update(JSON.stringify(snapshots)), cipher.final()]);
  return { nonce: nonce.toString("base64"), body: body.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
try {
  await mkdir(path.join(dir, "device-sync"));
  await writeFile(path.join(dir, "device-sync/identity.json"), JSON.stringify(identity));
  await writeFile(path.join(dir, "device-sync/snapshots.json"), JSON.stringify(encryptSnapshots([snapshot])));
  let responsive = 0;
  const heartbeat = setInterval(() => { if (device.restoringSnapshots) responsive += 1; }, 5);
  try { await Promise.all([device.loadIdentity(), device.loadIdentity()]); }
  finally { clearInterval(heartbeat); }
  assert.ok(responsive > 0, "the main thread remains responsive while encrypted history is parsed and verified");
  assert.equal(device.snapshots.get(identity.id).events.length, 30_000);
  assert.equal(device.restoringSnapshots, false);
  await writeFile(path.join(dir, "device-sync/snapshots.json"), JSON.stringify(encryptSnapshots([snapshot, { ...snapshot, signature: "invalid" }])));
  const broken = new DeviceSync({ dataDir: dir });
  await assert.rejects(broken.loadIdentity(), /storage_unavailable/);
  assert.equal(broken.snapshots.size, 0, "a failed signature cannot publish a partial restore");
  assert.equal(broken.restoringSnapshots, false);
  assert.equal(broken.error, "storage_unavailable");
  await writeFile(path.join(dir, "device-sync/snapshots.json"), JSON.stringify(encryptSnapshots([])));
  const stopping = new DeviceSync({ dataDir: dir, discovery: false, host: "127.0.0.1", port: 0 });
  const starting = stopping.start();
  const cancelled = assert.rejects(starting, /sync_cancelled|storage_unavailable/);
  await stopping.stop(); await cancelled;
  assert.equal(stopping.server, null, "a startup cancelled during storage restore cannot open a listener afterward");
  console.log("Sync storage worker: responsive restoration, concurrent load, signature validation, atomic publication and startup cancellation passed.");
} finally { await device.stop(); await rm(dir, { recursive: true, force: true }); }
