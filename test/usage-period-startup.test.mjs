import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { usagePeriodOptions } = require("../lib/usage-period");

// Exercise the real HTTP handler with an intentionally unfinished provider scan.
// Persisted paired-device events are already available and must remain usable.
const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
const route = source.slice(source.indexOf('app.get("/api/usage-period",'), source.indexOf('app.get("/api/chat-usage",'));
let handler, scans = 0, result = { totals: { totalTokens: 123 } };
const scanOptions = [];
const snapshot = { device: { id: "a".repeat(32) }, capturedAt: "2026-10-22T23:00:00Z" };
const sync = { enabled: true, deviceId: snapshot.device.id };
const cache = { expiresAt: 123 };
const context = vm.createContext({
  app: { get(_path, ...handlers) { handler = handlers.at(-1); } }, authMiddleware() {},
  usagePeriodOptions, readDeviceSyncStatus: async () => sync,
  deviceSync: { snapshots: new Map([[snapshot.device.id, snapshot]]), status: () => sync },
  readUsageDashboard: (options) => { scans++; scanOptions.push(options); return new Promise(() => {}); },
  usageCache: cache, usageAggregation: { period: async () => result },
  sendApiError(_res, error) { throw error; }, Date
});
vm.runInContext(route, context);
async function request(device) {
  let code = 200;
  const response = new Promise(resolve => {
    const res = { set() {}, status(value) { code = value; return this; }, json(value) { resolve({ code, value }); } };
    handler({ query: { from: "2026-10-22T00:00:00Z", to: "2026-10-23T00:00:00Z", provider: "codex", device } }, res).catch(resolve);
  });
  let timer;
  try {
    return await Promise.race([response, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("period blocked behind provider refresh")), 200); })]);
  } finally { clearTimeout(timer); }
}
const saved = await request("all");
assert.equal(saved.code, 200);
assert.equal(saved.value.totals.totalTokens, 123);
assert.equal(saved.value.dataUpdatedAt, snapshot.capturedAt);
assert.equal(scans, 0, "paired snapshots do not require a new provider scan");
assert.equal((await request("local")).code, 200, "an existing local index remains queryable during a refresh");
result = null;
const cold = await request("local");
assert.equal(cold.code, 503, "a cold index returns a retryable state rather than an unbounded request or false zero");
assert.equal(cold.value.error, "usage_period_initializing");
assert.equal(cache.expiresAt, 0, "worker recovery schedules a refresh without deleting the saved dashboard");
assert(scanOptions.every(options => options.staleWhileRefresh === true));
console.log("Period startup: saved snapshots, pending provider scan and cold-worker recovery passed");
