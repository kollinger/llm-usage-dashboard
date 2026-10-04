import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DeviceSync, createIdentity, seal, open, signedSnapshot, verifySnapshot, safeEndpoint } = require("../lib/device-sync");
const { exportUsageEvents, combinedUsage, sanitizeAccounts, hash } = require("../lib/device-sync-data");

const identities = [createIdentity(), createIdentity(), createIdentity()];
const box = seal(identities[0], identities[1], { secret: "test-only" });
assert.equal(open(identities[1], box).secret, "test-only");
assert.throws(() => open(identities[2], box));
assert.throws(() => open(identities[1], { ...box, body: Buffer.from("tampered").toString("base64") }));
assert.throws(() => open(identities[1], { ...box, at: Date.now() - 600_000 }));
for (const endpoint of ["http://example.com:80", "http://8.8.8.8:80", "https://127.0.0.1:80", "http://user:pass@127.0.0.1:80", "http://127.0.0.1:80/path"]) assert.throws(() => safeEndpoint(endpoint));
assert.equal(safeEndpoint("http://100.70.20.10:4177"), "http://100.70.20.10:4177");

const timestampMs = Date.now() - 60_000;
const raw = { providerId: "codex", sourceId: "local", timestampMs, model: "gpt-test", usage: { totalTokens: 100, inputTokens: 90, outputTokens: 10 }, evidence: { realpath: "/private/secret", sessionId: "test-session" }, metadata: { prompt: "SECRET_PROMPT", reasoningEffort: "high" } };
const exported = exportUsageEvents([{ _usageEvents: [raw, { ...raw, evidence: { ...raw.evidence, realpath: "/other/path" } }, { ...raw, evidence: {} }] }]);
assert.equal(exported.events.length, 1);
assert.equal(exported.excludedEvents, 1);
assert.equal(exportUsageEvents([{ _usageEvents: [{ ...raw, timestampMs: NaN }, { ...raw, timestampMs: 1e100 }] }]).excludedEvents, 2);
assert(!JSON.stringify(exported).includes("SECRET_PROMPT"));
assert(!JSON.stringify(exported).includes("/private"));
assert(!JSON.stringify(exported).includes("test-session"));
const accounts = [{ id: `gpt-${"a".repeat(16)}`, label: "private@example.com", accessToken: "SECRET_TOKEN", planType: "pro", lastSeenAt: new Date().toISOString(), sources: [{ id: "codex", usage: { summary: { lifetimeTokens: 123, secret: "SECRET" }, raw: "SECRET" }, active: true, limitsUpdatedAt: new Date().toISOString(), quotaStatus: "ready", profileRefs: ["private-profile"], limits: { rows: [{ key: "weekly", usedPercent: 60, remainingPercent: 40, windowMinutes: 10080, resetsAt: new Date(Date.now() + 60000).toISOString(), label: "SECRET_LABEL" }] } }] }];
assert(!JSON.stringify(sanitizeAccounts({ accounts })).includes("SECRET"));
assert(!JSON.stringify(sanitizeAccounts({ accounts })).includes("example.com"));
const snapshot = signedSnapshot(identities[0], "A", { ...exported, accounts });
assert.equal(verifySnapshot(snapshot).events.length, 1);
assert.throws(() => verifySnapshot({ ...snapshot, events: [{ ...snapshot.events[0], usage: { totalTokens: 999 } }] }));

const tmp = await mkdtemp(path.join(os.tmpdir(), "llm-direct-sync-"));
const devices = [];
try {
  for (let i = 0; i < 3; i++) {
    const device = new DeviceSync({ dataDir: path.join(tmp, String(i)), port: 0, discovery: false, host: "127.0.0.1", intervalMs: 1_000_000 });
    await device.initialize();
    assert.equal(device.server, undefined, "disabled installs must have no network listener");
    await device.configure({ enabled: true, name: `Device ${i}` });
    devices.push(device);
  }
  const [a,b,c] = devices;
  const first = { ...exported, excludedEvents: 0, accounts };
  await a.capture(first);
  await b.capture({ ...first, events: [...first.events, ...Array.from({ length: 450 }, (_, i) => ({ ...first.events[0], key: hash(`test-${i}`), usage: { ...first.events[0].usage, totalTokens: 2 } }))] });
  await c.capture({ events: [], excludedEvents: 0, accounts: [] });
  const pair = async (inviter, joiner) => {
    const invite = inviter.createInvite();
    const parsed = JSON.parse(Buffer.from(invite.code.split(":")[1], "base64url"));
    parsed.endpoints = [`http://127.0.0.1:${inviter.port}`];
    const code = `llm-device-v1:${Buffer.from(JSON.stringify(parsed)).toString("base64url")}`;
    await joiner.join(code);
    return code;
  };
  const code = await pair(a, b);
  await assert.rejects(c.join(code), "pairing codes must be one-use");
  await a.sync();
  assert.equal(a.snapshots.get(b.identity.id).events.length, 451, "all pages must arrive before publishing a snapshot");
  await pair(b, c);
  await b.sync(); await c.sync(); await a.sync();
  assert.equal(c.snapshots.size, 3, "a trusted own device can carry an authenticated snapshot from another own device");
  const aggregate = combinedUsage({ gptAccounts: { accounts: [] } }, [...c.snapshots.values()]);
  assert.equal(aggregate.local.totals.allTime.totalTokens, 1000);
  assert.equal(aggregate.syncCoverage.duplicatesSkipped, 1);
  assert.equal(aggregate.gptAccounts.accounts.length, 1, "the same account and its quota must not multiply across devices");
  assert.equal(aggregate.gptAccounts.accounts[0].sources[0].limits.rows[0].usedPercent, 60);
  assert.equal(aggregate.gptAccounts.accounts[0].sources[0].usage.summary.lifetimeTokens, 123);
  assert(aggregate.codex.byModel.some((model) => model.model === "gpt-test"));
  assert.equal(combinedUsage({ gptAccounts: { accounts } }, [...c.snapshots.values()], c.identity.id).gptAccounts.accounts.length, 0);
  const stolen = seal(identities[2], a.identity, { type: "manifest" });
  const denied = await fetch(`http://127.0.0.1:${a.port}/v1/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(stolen) });
  assert.equal(denied.status, 403);
  const request = seal(b.identity, a.identity, { type: "manifest" });
  const send = () => fetch(`http://127.0.0.1:${a.port}/v1/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 403, "replayed packets must be rejected");
  const stored = await readFile(path.join(tmp, "2/device-sync/snapshots.json"), "utf8");
  assert(!stored.includes("gpt-test"), "snapshots are encrypted at rest");
  await c.stop();
  const restarted = new DeviceSync({ dataDir: path.join(tmp, "2"), port: 0, discovery: false, host: "127.0.0.1", intervalMs: 1_000_000 });
  devices.push(restarted); await restarted.initialize();
  assert.equal(restarted.snapshots.size, 3);
  await restarted.forget(b.identity.id);
  assert(!restarted.snapshots.has(b.identity.id));
  assert.equal(restarted.config.peers.length, 0);
  await restarted.configure({ enabled: false, name: "Device 2" });
  assert.equal(restarted.server, null);
  assert.equal(restarted.snapshots.size, 2, "turning sync off keeps already received data local");
} finally {
  await Promise.all(devices.map((device) => device.stop()));
  await rm(tmp, { recursive: true, force: true });
}
console.log("Direct sync: encryption, pairing, privacy, paging, deduplication, forwarding, restart and revocation passed.");
