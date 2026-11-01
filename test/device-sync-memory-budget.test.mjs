import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeviceSync, createIdentity } from "../lib/device-sync.js";
import { sanitizeEvent } from "../lib/device-sync-data.js";
import { conversationDescriptor } from "../lib/chat-usage.js";
import { writePrivateJson } from "../lib/private-json-file.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "sync-memory-budget-"));
const count = 500_000;
const timestamp = new Date().toISOString();
const identity = createIdentity();
const device = new DeviceSync({ dataDir: directory, discovery: false });
device.identity = identity; device.config.enabled = true; device.config.name = "Prüfung ÄÖÜ 🧪";
const chats = Array.from({ length: 2000 }, (_, index) => conversationDescriptor("codex", `fixture-${index}`, { title: "Prüfung ÄÖÜ 🧪" }));
const payload = { accounts: [], connections: [], excludedEvents: 0,
  events: Array.from({ length: count }, (_, index) => sanitizeEvent({
    key: index.toString(16).padStart(64, "0"), providerId: "codex", timestamp, model: "fixture",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, conversation: chats[index % chats.length]
  })) };
let restored;
try {
  await writePrivateJson(path.join(directory, "device-sync/identity.json"), identity);
  await device.capture(payload);
  const firstRevision = device.snapshots.get(identity.id).revision;
  await device.capture(payload);
  assert.equal(device.snapshots.get(identity.id).revision, firstRevision, "unchanged large history must be reused");
  payload.events.push({ ...payload.events[0], key: count.toString(16).padStart(64, "0") });
  await device.capture(payload);
  assert.equal(device.snapshots.get(identity.id).events.length, count + 1);
  const finalRevision = device.snapshots.get(identity.id).revision;
  device.snapshots.clear(); payload.events.length = 0;
  restored = new DeviceSync({ dataDir: directory, discovery: false });
  await restored.loadIdentity();
  const snapshot = restored.snapshots.get(identity.id);
  assert.equal(snapshot.revision, finalRevision);
  assert.equal(snapshot.events.length, count + 1);
  assert.equal(snapshot.events.reduce((total, event) => total + event.usage.totalTokens, 0), (count + 1) * 2);
  assert.equal(snapshot.events[0].conversation.title, "Prüfung ÄÖÜ 🧪");
  console.log(`Sync memory budget: ${count} Unicode/chat events, unchanged capture, append and encrypted restart passed on ${process.platform}/${process.arch}; peak RSS ${Math.ceil(process.resourceUsage().maxRSS / 1024)} MB.`);
} finally {
  await restored?.stop();
  await rm(directory, { recursive: true, force: true });
}
