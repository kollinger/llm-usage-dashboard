import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DeviceSync, createIdentity, signedSnapshot, verifySnapshot, legacySnapshot, readStoredSnapshots } = require("../lib/device-sync");
const { sanitizeAccounts, sanitizeConnections, hash, exportUsageEvents } = require("../lib/device-sync-data");
const { conversationDescriptor } = require("../lib/chat-usage");

// Freeze the pre-chat event allowlist and field order. An older receiver hashes
// this representation rather than accepting unknown fields in a signed body.
const counters = ["inputTokens", "cacheCreationInputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
function oldEvent(raw) {
  const number = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const event = { key: raw.key, providerId: raw.providerId, timestamp: new Date(raw.timestamp).toISOString(),
    model: typeof raw.model === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(raw.model) ? raw.model : null,
    usage: Object.fromEntries(counters.map((key) => [key, number(raw.usage?.[key])])),
    sourceGroupId: raw.sourceGroupId === "codexSpark" && raw.providerId === "codex" ? "codexSpark" : raw.providerId,
    reasoningEffort: /^[a-z0-9_-]{1,32}$/.test(raw.reasoningEffort || "") ? raw.reasoningEffort : null };
  if (Object.hasOwn(raw, "accountId")) event.accountId = raw.accountId;
  if (Object.hasOwn(raw, "accountConflict")) event.accountConflict = raw.accountConflict === true;
  return event;
}
function oldVerify(snapshot) {
  const body = { device: snapshot.device, capturedAt: new Date(snapshot.capturedAt).toISOString(), excludedEvents: snapshot.excludedEvents,
    accounts: sanitizeAccounts({ accounts: snapshot.accounts }), events: snapshot.events.map(oldEvent) };
  if (Object.hasOwn(snapshot, "connections")) body.connections = sanitizeConnections(snapshot.connections);
  const revision = hash(JSON.stringify(body));
  const key = crypto.createPublicKey({ key: Buffer.from(body.device.signingKey, "base64"), type: "spki", format: "der" });
  assert.equal(revision, snapshot.revision, "old canonical revision must match");
  assert(crypto.verify(null, Buffer.from(revision), key, Buffer.from(snapshot.signature, "base64")), "old origin signature must verify");
  return body;
}

const raw = { providerId: "codex", sourceId: "codex", timestampMs: Date.now() - 1000, model: "fixture-model",
  usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 }, evidence: { sessionId: "fixture-session" },
  conversation: conversationDescriptor("codex", "fixture-session", { title: "Fixture chat title" }) };
const payload = { ...exportUsageEvents([{ _usageEvents: [raw] }]), accounts: [], connections: [] };
const identity = createIdentity();
const primary = signedSnapshot(identity, "Fixture", payload);
assert(primary.legacy, "chat snapshots also carry an origin-signed legacy header");
assert.throws(() => oldVerify(primary), /old canonical revision/);
const compatible = legacySnapshot(primary);
assert.equal(compatible.events[0].conversation, undefined);
assert.equal(compatible.legacy, undefined);
oldVerify(compatible);
assert.equal(legacySnapshot(primary), compatible, "legacy event projection is cached per immutable snapshot");
assert.equal(verifySnapshot(primary).events[0].conversation.title, "Fixture chat title");
assert.equal(verifySnapshot(compatible).revision, compatible.revision, "old snapshots remain valid on new readers");
const restored = verifySnapshot(JSON.parse(JSON.stringify(primary)));
oldVerify(legacySnapshot(restored));
assert.throws(() => verifySnapshot({ ...primary, legacy: { ...primary.legacy, revision: "f".repeat(64) } }), /invalid_snapshot_signature/);
assert.throws(() => verifySnapshot({ ...primary, legacy: { ...primary.legacy, signature: "invalid" } }), /invalid_snapshot_signature/);
assert.throws(() => verifySnapshot({ ...primary, events: [{ ...primary.events[0], conversation: { ...primary.events[0].conversation, title: "Tampered" } }] }), /invalid_snapshot_signature/);
assert.throws(() => verifySnapshot({ ...compatible, legacy: { revision: "f".repeat(64), signature: "invalid" } }), /invalid_snapshot_signature/);
const noHeader = { ...primary };
delete noHeader.legacy;
assert.equal(legacySnapshot(verifySnapshot(noHeader)), null, "forwarders cannot invent missing origin signatures");

class LegacyDevice extends DeviceSync {
  // Original senders have no chat metadata capability. Original servers ignore
  // the new request flag and expose only their pre-chat representation.
  exchange(peer, value) {
    if (value.type === "manifest") value = { type: "manifest" };
    return super.exchange(peer, value);
  }
  manifest() { return super.manifest(false); }
  capture(value) { return super.capture({ ...value, events: value.events.map(oldEvent) }); }
  async sync() {
    const result = await super.sync();
    for (const snapshot of this.snapshots.values()) oldVerify(snapshot);
    return result;
  }
}

const directory = await mkdtemp(path.join(os.tmpdir(), "llm-chat-sync-compat-"));
const devices = [];
const pair = async (inviter, joiner) => {
  const invitation = JSON.parse(Buffer.from(inviter.createInvite().code.split(":")[1], "base64url"));
  invitation.endpoints = [`http://127.0.0.1:${inviter.port}`];
  await joiner.join(`llm-device-v1:${Buffer.from(JSON.stringify(invitation)).toString("base64url")}`);
};
try {
  for (const [index, Type] of [DeviceSync, LegacyDevice, DeviceSync].entries()) {
    const device = new Type({ dataDir: path.join(directory, String(index)), port: 0, host: "127.0.0.1", discovery: false, intervalMs: 1_000_000 });
    await device.configure({ enabled: true, name: `Fixture ${index}` });
    devices.push(device);
  }
  const [modern, old, receiver] = devices;
  await modern.capture(payload);
  await old.capture(payload);
  await pair(modern, old);
  await old.sync();
  const oldCopy = old.snapshots.get(modern.identity.id);
  assert.equal(oldCopy.events[0].conversation, undefined, "old clients receive exact signed usage without unsupported metadata");
  oldVerify(oldCopy);
  await modern.sync();
  assert.equal(modern.snapshots.get(old.identity.id).events[0].usage.totalTokens, 100, "new clients continue reading old servers");
  assert.equal(modern.snapshots.get(old.identity.id).events[0].conversation, undefined);
  await pair(old, receiver);
  await receiver.sync();
  assert.equal(receiver.snapshots.get(modern.identity.id).revision, oldCopy.revision, "an old forwarder carries the legacy origin signature");
  await pair(modern, receiver);
  await receiver.sync();
  const upgraded = receiver.snapshots.get(modern.identity.id);
  assert.equal(upgraded.capturedAt, oldCopy.capturedAt);
  assert.equal(upgraded.events[0].conversation.title, "Fixture chat title", "same-time primary snapshot upgrades a previously forwarded legacy copy");
  assert.equal(upgraded.revision, modern.snapshots.get(modern.identity.id).revision);
  oldVerify(legacySnapshot(upgraded));
  assert(modern.manifest(true).find((entry) => entry.device.id === modern.identity.id).legacy, "modern manifests preserve the downgrade signature for forwarding");
  assert.equal(modern.manifest().find((entry) => entry.device.id === modern.identity.id).revision, oldCopy.revision);
  const owned = modern.snapshots.get(modern.identity.id);
  const unsignedLegacy = { ...owned };
  delete unsignedLegacy.legacy;
  modern.snapshots.set(modern.identity.id, verifySnapshot(unsignedLegacy));
  assert(!modern.manifest().some((entry) => entry.device.id === modern.identity.id), "old manifests omit metadata snapshots lacking a verified downgrade signature");
  assert(modern.manifest(true).some((entry) => entry.device.id === modern.identity.id));
  modern.snapshots.set(modern.identity.id, owned);
  const saved = await readStoredSnapshots(path.join(directory, "0", "device-sync", "snapshots.json"), modern.identity.storageKey);
  const savedOwned = saved.find((entry) => entry.device.id === modern.identity.id);
  assert.equal(savedOwned.events[0].conversation.title, "Fixture chat title");
  oldVerify(legacySnapshot(savedOwned));
  await receiver.sync();
  assert.equal(receiver.snapshots.get(modern.identity.id).revision, upgraded.revision, "old forwarder does not downgrade an upgraded copy");
  await modern.forget(old.identity.id);
  assert.throws(() => modern.transferSnapshot(old.identity.id, oldCopy.revision, old.identity.id), /snapshot_changed/);
  assert(!modern.manifest().some((entry) => entry.device.id === old.identity.id), "revocation also removes legacy manifest origins");
} finally {
  for (const device of devices) await device.stop();
  await rm(directory, { recursive: true, force: true });
}
console.log("Chat sync compatibility: independent old canonical verification, dual signatures, tamper rejection, old/new transfers, forwarding, same-time metadata upgrades and revocation passed.");
