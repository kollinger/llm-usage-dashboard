import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { aggregateUsageEvents, normalizeAttribution, recordedAccountAttribution } = require("../lib/usage-events");
const { exportUsageEvents, combinedUsage, createCombinedUsageCache, sanitizeEvent, hash } = require("../lib/device-sync-data");
const { createIdentity, verifySnapshot } = require("../lib/device-sync");
const { createGptAccountObservation } = require("../lib/gpt-account-registry");
const { _test } = require("../server.js");

const now = Date.now();
const timestampMs = now - 60_000;
const a = { id: "a".repeat(32), label: "Computer A" };
const b = { id: "b".repeat(32), label: "Computer B" };
const accountA = recordedAccountAttribution("codex", { account_id: "fixture-account-a" });
const accountB = recordedAccountAttribution("codex", { account: { id: "fixture-account-b" } });
assert.equal(accountA.accountId, createGptAccountObservation({ sourceId: "codex", accountId: "fixture-account-a" }).id);
assert.equal(recordedAccountAttribution("codex", { email: "current@login.invalid" }), null);
assert.equal(recordedAccountAttribution("codex", { account_id: "\ninvalid" }).accountId, null);
assert.equal(recordedAccountAttribution("gemini", { account_id: "unsupported schema" }), null);
const raw = (id, amount, attribution = {}, providerId = "codex") => ({ providerId, sourceId: providerId, timestampMs, model: "fixture-model", eventId: id,
  usage: { inputTokens: amount - 1, outputTokens: 1, totalTokens: amount }, evidence: { sessionId: id }, attribution, metadata: {} });
const events = [raw("one", 10, { ...accountA, observedOn: [a] }), raw("two", 20, { ...accountB, observedOn: [a] }), raw("three", 30, { observedOn: [b] })];
const summary = aggregateUsageEvents(events, { now });
assert.equal(summary.totals.allTime.totalTokens, 60);
assert.equal(summary.attribution.coverage.knownAccountTokens, 30);
assert.equal(summary.attribution.coverage.unknownAccountTokens, 30);
assert.equal(summary.attribution.combinations.length, 3);
for (const row of [summary.daily[0], summary.slots.today.find((row) => row.totalTokens), summary.slots.last24h.find((row) => row.totalTokens)]) {
  if (!row) continue; // The fixture can straddle midnight for the today slice.
  assert.equal(row.attribution.devices.reduce((sum, value) => sum + value.totalTokens, 0), row.totalTokens);
  assert.equal(row.attribution.accounts.reduce((sum, value) => sum + value.totalTokens, 0), row.totalTokens);
  assert.equal(row.attribution.combinations.reduce((sum, value) => sum + value.totalTokens, 0), row.totalTokens);
}
assert.equal(summary.attribution.accounts.find((row) => row.id === accountA.accountId).devices[0].id, a.id);
assert.equal(summary.attribution.accounts.find((row) => row.id === "unknown").quality, "unknown");
assert(!JSON.stringify(summary).includes("fixture-account"));

const exported = exportUsageEvents([{ _usageEvents: [events[0]] }]);
assert.equal(exported.events[0].accountId, accountA.accountId);
assert(!JSON.stringify(exported).includes("Computer A"));
assert(!JSON.stringify(exported).includes("observedOn"));
const snapshot = (device, rows, capturedAt = new Date().toISOString()) => ({ device: { id: device.id, name: device.label }, events: rows, capturedAt, accounts: [], excludedEvents: 0 });
const copied = [snapshot(a, exported.events), snapshot(b, exported.events, new Date(now + 1).toISOString())];
for (const selection of ["all", a.id, b.id]) {
  const merged = combinedUsage({ gptAccounts: { accounts: [] } }, copied, selection);
  assert.equal(merged.local.totals.allTime.totalTokens, 10, "a copied event is counted once");
  assert.equal(merged.local.attribution.devices[0].id, "shared", "filtering to an observer must not claim execution ownership");
  assert.equal(merged.local.attribution.devices[0].quality, "ambiguous");
  assert.equal(merged.local.attribution.devices[0].observedOn.length, 2);
  assert.equal(merged.local.attribution.accounts[0].devices[0].id, "shared");
}
const conflicting = combinedUsage({}, [copied[0], snapshot(b, [{ ...exported.events[0], accountId: accountB.accountId }])]);
assert.equal(conflicting.local.attribution.accounts[0].id, "unknown");
assert.equal(conflicting.local.attribution.accounts[0].quality, "conflict");
assert.equal(conflicting.local.attribution.coverage.knownAccountTokens, 0);
const exportedConflict = exportUsageEvents([{ _usageEvents: [events[0], { ...events[0], attribution: accountB }, events[0]] }]);
assert.equal(exportedConflict.events[0].accountConflict, true);
assert.equal(exportedConflict.events[0].accountId, null, "a later duplicate must not erase identity conflict");
const duplicate = aggregateUsageEvents([events[0], { ...events[0], attribution: { ...accountA, observedOn: [b] } }], { now });
assert.equal(duplicate.attribution.devices[0].id, "shared");
assert.equal(duplicate.totals.allTime.totalTokens, 10);

// Reconstruct the original signed v1 representation independently: absent new
// event fields must stay absent, otherwise installed peers lose old snapshots.
const identity = createIdentity();
const oldEvent = { key: hash("old event"), providerId: "codex", timestamp: new Date(timestampMs).toISOString(), model: "fixture-model",
  usage: { inputTokens: 9, cacheCreationInputTokens: 0, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 10 },
  sourceGroupId: "codex", reasoningEffort: null };
assert.deepEqual(sanitizeEvent(oldEvent), oldEvent);
const oldBody = { device: { id: identity.id, encryptionKey: identity.encryptionKey, signingKey: identity.signingKey, name: "Old device" },
  capturedAt: new Date().toISOString(), excludedEvents: 0, accounts: [], events: [oldEvent] };
const revision = hash(JSON.stringify(oldBody));
const signedOld = { ...oldBody, revision, signature: crypto.sign(null, Buffer.from(revision), identity.signingPrivate).toString("base64") };
assert.equal(verifySnapshot(signedOld).revision, revision);

let cacheNow = 1000, cacheComputations = 0;
const cache = createCombinedUsageCache({ maxEntries: 2, now: () => cacheNow, combine: (local, snapshots, selected) => ({ computation: ++cacheComputations, selected }) });
const cacheLocal = { generatedAt: "one", gptAccounts: { accounts: [] }, connectedAccounts: [] };
const cacheSnapshots = copied.map((row, index) => ({ ...row, revision: `revision-${index}` }));
const cachedFirst = cache.get(cacheLocal, cacheSnapshots);
assert.equal(cache.get(cacheLocal, cacheSnapshots.slice().reverse()), cachedFirst, "snapshot ordering must not defeat the cache");
assert.equal(cacheComputations, 1);
cache.get(cacheLocal, cacheSnapshots, a.id); assert.equal(cacheComputations, 2);
const changedRemote = cacheSnapshots.map((row, index) => index ? { ...row, revision: "changed-other-device" } : row);
cache.get(cacheLocal, changedRemote, a.id); assert.equal(cacheComputations, 3, "another device's revision invalidates ambiguity in a filtered view");
cache.get({ ...cacheLocal, generatedAt: "two" }, changedRemote, a.id); assert.equal(cacheComputations, 4);
cache.get({ ...cacheLocal, connectedAccounts: [{ accountId: accountA.accountId, label: "Renamed" }] }, changedRemote, a.id); assert.equal(cacheComputations, 5);
cache.get({ ...cacheLocal, gptAccounts: { accounts: [{ id: accountA.accountId, label: "Renamed GPT" }] } }, changedRemote, a.id); assert.equal(cacheComputations, 6);
assert.equal(cache.size(), 2, "view cache remains bounded");
cacheNow += 30_001;
cache.get(cacheLocal, cacheSnapshots); assert.equal(cacheComputations, 7); assert.equal(cache.size(), 1);
cache.clear(); assert.equal(cache.size(), 0);

const tmp = await mkdtemp(path.join(os.tmpdir(), "usage-attribution-"));
try {
  const file = path.join(tmp, "codex.jsonl");
  const token = (payload = {}) => ({ type: "event_msg", timestamp: new Date(timestampMs).toISOString(), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } }, ...payload } });
  const records = [
    { type: "session_meta", payload: { id: "session-one", account_id: "fixture-account-a" } }, token(),
    { type: "session_meta", payload: { id: "session-two" } }, token(),
    token({ account: { id: "fixture-account-b" } }), token()
  ];
  await writeFile(file, records.map((row) => JSON.stringify(row)).join("\n"));
  const parsed = await _test.parseCodexSessionFileEvents({ file });
  assert.equal(parsed[0].attribution.accountId, accountA.accountId);
  assert.equal(parsed[1].attribution, null, "new session without account evidence must clear earlier account");
  assert.equal(parsed[2].attribution.accountId, accountB.accountId);
  assert.equal(parsed[3].attribution, null, "a per-event account must not leak into following events");
  await writeFile(file, JSON.stringify(token()));
  assert.equal((await _test.parseCodexSessionFileEvents({ file }))[0].attribution, null, "parser calls do not carry another file's account");
  const claudeFile = path.join(tmp, "claude.jsonl");
  const claudeMessage = { type: "assistant", timestamp: new Date(timestampMs).toISOString(), message: { id: "message-one", model: "claude-fixture", usage: { input_tokens: 9, output_tokens: 1 } } };
  await writeFile(claudeFile, [JSON.stringify({ ...claudeMessage, account: { id: "claude-account" }, orgId: "claude-org" }), JSON.stringify(claudeMessage)].join("\n"));
  const claude = await _test.parseClaudeTranscriptFileEvents({ file: claudeFile });
  assert.match(claude[0].attribution.accountId, /^claude-[a-f0-9]{24}$/);
  assert.equal(claude[1].attribution, null);
  const local = _test.buildLocalAggregate([{ _usageEvents: events.map((event) => ({ ...event, attribution: normalizeAttribution({ accountId: event.attribution.accountId }) })) }], {
    device: a, accounts: [{ id: accountA.accountId, label: "My work account" }]
  });
  assert.equal(local.attribution.devices[0].id, a.id);
  assert.equal(local.attribution.devices[0].quality, "observed");
  assert.equal(local.attribution.accounts.find((row) => row.id === accountA.accountId).label, "My work account");
  assert.equal(local.attribution.accounts.find((row) => row.id === "unknown").totalTokens, 30);
  const localRawEvents = events.map((event) => ({ ...event, attribution: normalizeAttribution({ accountId: event.attribution.accountId }) }));
  const withRemoteCopy = _test.buildLocalAggregate([{ _usageEvents: [...localRawEvents, { ...raw("unexportable", 40), evidence: {} }] }], {
    device: a, snapshots: [snapshot(b, exported.events)]
  });
  assert.equal(withRemoteCopy.totals.allTime.totalTokens, 100, "local attribution must preserve local-only, non-exportable events");
  assert.equal(withRemoteCopy.attribution.devices.find((row) => row.id === "shared").totalTokens, 10);
  assert.equal(withRemoteCopy.attribution.coverage.ambiguousDeviceTokens, 10);
} finally { await rm(tmp, { recursive: true, force: true }); }
console.log("Usage attribution: historical evidence, unknowns, copied-device ambiguity, filters, daily/slots, privacy and old signatures passed.");
