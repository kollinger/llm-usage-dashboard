import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DeviceSync } = require("../lib/device-sync");

// Regression for an observed 306,006-event installation. Keep this heavier
// network/storage test out of the lightweight cross-platform check command.
const root = await mkdtemp(path.join(os.tmpdir(), "llm-large-sync-"));
const a = new DeviceSync({ dataDir: path.join(root, "a"), port: 0, host: "127.0.0.1", discovery: false, intervalMs: 1_000_000 });
const b = new DeviceSync({ dataDir: path.join(root, "b"), port: 0, host: "127.0.0.1", discovery: false, intervalMs: 1_000_000 });
try {
  await a.initialize(); await b.initialize();
  await a.configure({ enabled: true, name: "A" }); await b.configure({ enabled: true, name: "B" });
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const events = Array.from({ length: 306006 }, (_, i) => ({ key: i.toString(16).padStart(64, "0"), providerId: "codex", timestamp,
    model: "gpt-test", usage: { totalTokens: 2, inputTokens: 1, outputTokens: 1 }, sourceGroupId: "codex", reasoningEffort: null }));
  await a.capture({ events, excludedEvents: 0, accounts: [] });
  const invite = a.createInvite();
  const value = JSON.parse(Buffer.from(invite.code.split(":")[1], "base64url"));
  value.endpoints = [`http://127.0.0.1:${a.port}`];
  await b.join(`llm-device-v1:${Buffer.from(JSON.stringify(value)).toString("base64url")}`);
  assert.equal(b.snapshots.get(a.identity.id).events.length, 306006);
  let pages = 0;
  const exchange = b.exchange.bind(b);
  b.exchange = (peer, request) => { if (request.type === "page") pages += 1; return exchange(peer, request); };
  await a.configure({ enabled: true, name: "A renamed" });
  await a.capture({ events, excludedEvents: 0, accounts: [] });
  await b.sync();
  assert.equal(pages, 0, "metadata changes must not resend the large history");
  const next = { ...events[0], key: events.length.toString(16).padStart(64, "0"), timestamp: new Date().toISOString() };
  await a.capture({ events: [...events, next], excludedEvents: 0, accounts: [] });
  await b.sync();
  assert.equal(pages, 1, "one appended event transfers only the final block");
  assert.equal(b.snapshots.get(a.identity.id).events.length, 306007);
  console.log("Large sync: 306,006 events transferred; metadata 0 blocks; appended event 1 block; full signature verified.");
} finally {
  await a.configure({ enabled: false, name: "A" }); await b.configure({ enabled: false, name: "B" });
  await rm(root, { recursive: true, force: true });
}
