"use strict";

const assert = require("node:assert/strict");
const { createUsageAggregation } = require("../../lib/usage-aggregation");
const { createUsageWorker } = require("../../lib/usage-aggregation-worker-client");

module.exports = async function verifyNativeUsageAggregation() {
  let worker;
  const aggregation = createUsageAggregation({ createWorker: () => {
    worker = createUsageWorker();
    assert.equal(worker.kind, "utility", "native history must have its own process");
    return worker;
  } });
  const events = Array.from({ length: 20_000 }, (_, index) => ({ providerId: "codex", sourceId: "fixture",
    timestampMs: Date.now() - 1000, model: "fixture-model", usage: { inputTokens: 2, totalTokens: 2 },
    evidence: { sessionId: `native-fixture-${index}`, line: 1 }, metadata: {} }));
  try {
    const local = await aggregation.aggregateLocal([{ _usageEvents: events }], {
      device: { id: "a".repeat(32), label: "Fixture" }, snapshots: [], accounts: [], dailyHistoryDays: 400, exportEvents: true
    });
    assert.equal(local.local.totals.allTime.totalTokens, 40_000);
    assert.equal(local.exported.events.length, 20_000);
    assert(worker.pid && worker.pid !== process.pid, "history process must not share the main process");
    const snapshot = { device: { id: "a".repeat(32), name: "Fixture" }, events: local.exported.events,
      capturedAt: new Date().toISOString(), revision: "native-fixture", accounts: [], excludedEvents: 0 };
    const combined = await aggregation.get({ generatedAt: new Date().toISOString(), gptAccounts: { accounts: [] }, connectedAccounts: [] }, [snapshot]);
    assert.equal(combined.local.totals.allTime.totalTokens, 40_000);
    const chats = await aggregation.chats([snapshot], "all", { period: "all", timeZone: "UTC" });
    assert.equal(chats.coverage.totalTokens, 40_000);
  } finally {
    await aggregation.close();
  }
  assert.equal(worker.pid, undefined, "closing the aggregation must reap its child process");
  const closing = createUsageAggregation();
  const pending = closing.aggregateLocal([], { snapshots: [], accounts: [], dailyHistoryDays: 400 });
  const rejected = assert.rejects(pending, /closed/);
  await closing.close();
  await rejected;
  console.log("Native aggregation: separate process, local and combined totals, chat coverage and shutdown passed.");
};
