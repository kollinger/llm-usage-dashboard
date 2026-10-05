import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fsp = require("node:fs/promises");
const { DeviceSync, createIdentity, signedSnapshot } = require("../lib/device-sync");
const { hash } = require("../lib/device-sync-data");
const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "llm-sync-persistence-"));
const devices = [];
const realWrite = fsp.writeFile;
let snapshotWrites = 0, settingsWrites = 0, delayWrite = null, failWrite = false;
fsp.writeFile = async (file, ...args) => {
  if (file === path.join(temporary, "device-sync", "settings.json.tmp")) settingsWrites += 1;
  if (file === path.join(temporary, "device-sync", "snapshots.json.tmp")) {
    snapshotWrites += 1;
    if (delayWrite) { const wait = delayWrite; delayWrite = null; await wait(); }
    if (failWrite) { failWrite = false; throw new Error("fixture_io_failure"); }
  }
  return realWrite(file, ...args);
};
const event = (key) => ({ key: hash(key), providerId: "codex", timestamp: new Date().toISOString(), model: "fixture-model", usage: { inputTokens: 1, totalTokens: 1 } });
const payload = (key) => ({ events: [event(key)], accounts: [], excludedEvents: 0 });
const readStored = async () => {
  const reader = new DeviceSync({ dataDir: temporary });
  await reader.loadIdentity(); return reader.snapshots;
};
try {
  const device = new DeviceSync({ dataDir: temporary, host: "127.0.0.1", port: 0, discovery: false, intervalMs: 1_000_000 });
  devices.push(device); await device.configure({ enabled: true, name: "Persistence fixture" });
  await device.capture(payload("first"));
  snapshotWrites = 0; settingsWrites = 0;
  await device.sync(); await device.persist();
  assert.equal(snapshotWrites, 0, "unchanged sync must not re-encrypt or write the snapshot blob");
  assert.equal(settingsWrites, 2, "settings and peer status remain durable on unchanged syncs");
  const peer = { ...createIdentity(), endpoint: "http://127.0.0.1:41778", name: "Peer fixture" };
  device.addPeer(peer); await device.persist();
  assert.equal(snapshotWrites, 0, "new trust does not require rewriting unchanged usage history");
  assert.equal(JSON.parse(await fsp.readFile(path.join(temporary, "device-sync/settings.json"), "utf8")).peers.length, 1);

  await device.capture(payload("second"));
  assert.equal(snapshotWrites, 1);
  assert.equal((await readStored()).get(device.identity.id).revision, device.snapshots.get(device.identity.id).revision);
  await device.stop();
  const restarted = new DeviceSync({ dataDir: temporary, host: "127.0.0.1", port: 0, discovery: false, intervalMs: 1_000_000 });
  devices.push(restarted); await restarted.initialize();
  snapshotWrites = 0; await restarted.persist();
  assert.equal(snapshotWrites, 0, "loading an unchanged saved revision must not trigger a startup rewrite");

  restarted.snapshots.set(peer.id, signedSnapshot(peer, peer.name, payload("remote")));
  await restarted.persist(); snapshotWrites = 0;
  await restarted.forget(peer.id);
  assert.equal(snapshotWrites, 1, "revoking a stored origin persists its removal");
  assert.equal((await readStored()).has(peer.id), false);
  assert(JSON.parse(await fsp.readFile(path.join(temporary, "device-sync/settings.json"), "utf8")).revoked.includes(peer.id));

  let writing, release;
  const started = new Promise((resolve) => { writing = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  delayWrite = async () => { writing(); await pending; };
  snapshotWrites = 0;
  const older = restarted.capture(payload("queued-first"));
  await started;
  const newer = restarted.capture(payload("queued-second"));
  release(); await Promise.all([older, newer]);
  assert.equal(snapshotWrites, 2, "a capture arriving during an atomic write is not incorrectly marked persisted");
  assert.equal((await readStored()).get(restarted.identity.id).revision, restarted.snapshots.get(restarted.identity.id).revision);
  await restarted.persist(); assert.equal(snapshotWrites, 2);

  failWrite = true;
  await assert.rejects(restarted.capture(payload("retry-after-failure")), /fixture_io_failure/);
  snapshotWrites = 0; await restarted.persist();
  assert.equal(snapshotWrites, 1, "a failed replacement must not suppress the next write attempt");
  assert.equal((await readStored()).get(restarted.identity.id).revision, restarted.snapshots.get(restarted.identity.id).revision);
} finally {
  fsp.writeFile = realWrite;
  await Promise.all(devices.map((device) => device.stop()));
  await fsp.rm(temporary, { recursive: true, force: true });
}
console.log("Device sync persistence: unchanged-write elision, durable trust, restart, revocation, queued revisions and retry passed.");
