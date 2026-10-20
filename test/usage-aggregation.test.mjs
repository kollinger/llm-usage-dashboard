import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { createServer } from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
const require = createRequire(import.meta.url);
const { createUsageAggregation } = require("../lib/usage-aggregation");
const { createTimedCache, readThroughCache, _test } = require("../server");

assert.doesNotThrow(() => _test.buildLocalAggregate([], {
  snapshots: [{ get events() { throw new Error("quota-only installation must not scan remote history synchronously"); }, device: { id: "a".repeat(32) } }]
}));

const timestamp = new Date(Date.now() - 60_000).toISOString();
const device = (letter) => ({ id: letter.repeat(32), name: `Computer ${letter}` });
const accountId = `gpt-${"d".repeat(16)}`;
const event = (index) => ({ key: index.toString(16).padStart(64, "0"), providerId: "codex", timestamp, model: "fixture-model",
  accountId,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 },
  sourceGroupId: "codex", reasoningEffort: null });
const snapshot = (letter, events, revision) => ({ device: device(letter), events, revision, capturedAt: timestamp, excludedEvents: 0,
  accounts: [{ id: accountId, sources: [], lastSeenAt: timestamp }] });
const local = (percent = 20) => ({ generatedAt: timestamp, codex: { id: "codex", status: "live", limits: { fiveHour: { usedPercent: percent } },
  source: { liveRateLimits: { status: "ready" } } },
  gptAccounts: { accounts: [{ id: accountId, label: "Work account", sources: [] }] }, connectedAccounts: [] });
let workers = 0;
const posts = [];
const aggregation = createUsageAggregation({ maxEntries: 2, createWorker: () => {
  workers += 1;
  const worker = new Worker(new URL("../lib/usage-aggregation-worker.js", import.meta.url));
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (message) => { posts.push({ type: message.type, updates: message.updates.length }); post(message); };
  return worker;
} });
const statusServer = createServer((_req, res) => res.end("ready"));
statusServer.listen(0, "127.0.0.1");
await once(statusServer, "listening");
try {
  const events = Array.from({ length: 20_000 }, (_, index) => event(index + 1));
  const snapshots = [snapshot("a", events, "first"), snapshot("b", events, "copy")];
  let complete = false;
  const start = performance.now();
  const initial = aggregation.get(local(), snapshots).finally(() => { complete = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const pingStarted = performance.now();
  const ping = await fetch(`http://127.0.0.1:${statusServer.address().port}`);
  assert.equal(await ping.text(), "ready");
  const pingMs = performance.now() - pingStarted;
  assert.equal(complete, false, "HTTP remains responsive while real worker aggregation is still running");
  const first = await initial;
  const initialMs = performance.now() - start;
  assert.equal(first.local.totals.allTime.totalTokens, 40_000);
  assert.equal(first.local.attribution.devices[0].quality, "ambiguous");
  assert.equal(first.codex.limits.fiveHour.usedPercent, 20);
  assert.equal(workers, 1);
  assert.equal(posts[0].updates, 2);

  const hit = await aggregation.get({ ...local(27), cache: { stale: true, refreshing: true } }, snapshots);
  assert.equal(hit.codex.limits.fiveHour.usedPercent, 27, "cached consumption cannot freeze current quota");
  assert.equal(hit.cache.stale, true, "local quota refresh metadata remains visible");
  assert.equal(posts.length, 1, "fresh view avoids another computation or history clone");
  assert.equal((await aggregation.get(local(28), snapshots)).cache, undefined, "fresh local data clears stale metadata");

  const changed = [snapshot("a", [...events, event(20_001)], "second"), snapshots[1]];
  const stale = await aggregation.get(local(30), changed);
  assert.equal(stale.local.totals.allTime.totalTokens, 40_000);
  assert.equal(stale.cache.refreshing, true);
  assert.equal(stale.codex.limits.fiveHour.usedPercent, 30);
  const updated = await aggregation.get(local(31), changed, "all", { force: true });
  assert.equal(updated.local.totals.allTime.totalTokens, 40_002);
  assert.equal(updated.codex.limits.fiveHour.usedPercent, 31);
  assert.equal(updated.cache, undefined);
  assert.equal(posts[1].updates, 1, "only changed origins are cloned into the worker");

  const removed = await aggregation.get(local(), [changed[0]]);
  assert.equal(removed.local.attribution.devices[0].quality, "observed", "removed origins never survive in a stale aggregate");
  const [onlyA, onlyB] = await Promise.all([
    aggregation.get(local(), changed, device("a").id),
    aggregation.get(local(), changed, device("b").id)
  ]);
  assert.equal(onlyA.local.totals.allTime.totalTokens, 40_002);
  assert.equal(onlyB.local.totals.allTime.totalTokens, 40_000);
  assert.equal(onlyA.codex.limits, null, "remote selection cannot borrow local quotas");
  assert.equal(aggregation.size(), 2);
  assert.equal(workers, 1, "concurrent views use one worker");

  const renamed = await aggregation.get({ ...local(), gptAccounts: { accounts: [{ id: accountId, label: "Renamed account", sources: [] }] } }, changed, "all", { force: true });
  assert.equal(renamed.local.attribution.accounts[0].label, "Renamed account", "a reused history index must refresh account labels");
  assert.equal(posts.at(-1).updates, 0, "renaming an account does not resend immutable history");

  const raw = events.slice(0, 500).map((row, index) => ({ providerId: "codex", sourceId: "codex", timestampMs: Date.parse(timestamp),
    model: row.model, eventId: String(index), usage: row.usage, evidence: { sessionId: `fixture-${index}` }, metadata: {} }));
  const providers = [{ _usageEvents: raw }];
  const options = { device: { id: device("a").id, label: "Computer a" }, snapshots: [], accounts: [], dailyHistoryDays: 180, exportEvents: true };
  const expected = _test.buildLocalAggregate(providers, options);
  const actual = await aggregation.aggregateLocal(providers, options);
  assert.deepEqual(actual.local.totals, expected.totals);
  assert.deepEqual(actual.local.daily, expected.daily);
  assert.deepEqual(actual.local.slots, expected.slots);
  assert.deepEqual(actual.local.attribution, expected.attribution);
  assert.equal(actual.exported.events.length, 500);
  console.log(`Usage worker: 40k observations in ${initialMs.toFixed(0)}ms; concurrent HTTP ${pingMs.toFixed(0)}ms; fresh quotas, revision updates, revoked origins, concurrent views and local parity passed.`);
} finally {
  await aggregation.close();
  statusServer.close();
  await once(statusServer, "close");
}
await assert.rejects(aggregation.get(local(), []), /closed/);

const shutdown = createUsageAggregation();
const interrupted = shutdown.get(local(), [snapshot("a", [event(1)], "close")]);
const rejection = assert.rejects(interrupted, /closed/);
await shutdown.close();
await rejection;

const cache = createTimedCache();
cache.value = { generatedAt: "old", codex: { status: "live" } };
cache.expiresAt = 0;
let resolveLoad, loads = 0;
const loader = () => { loads += 1; return new Promise((resolve) => { resolveLoad = resolve; }); };
const previous = await readThroughCache(cache, 1000, loader, { staleWhileRefresh: true });
assert.equal(previous.generatedAt, "old");
assert.equal(previous.cache.refreshing, true);
const pending = readThroughCache(cache, 1000, loader, { force: true });
let returned = false;
pending.then(() => { returned = true; });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(returned, false, "explicit refresh awaits new values");
resolveLoad({ generatedAt: "new", codex: { status: "live" } });
assert.equal((await pending).generatedAt, "new");
assert.equal(loads, 1);
assert.equal((await readThroughCache(cache, 1000, loader)).cache, undefined);
console.log("Usage refresh: last-known timestamp retained, one loader, forced refresh awaited, shutdown clean.");
