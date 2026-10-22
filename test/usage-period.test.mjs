import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
const require = createRequire(import.meta.url);
const { usagePeriodOptions, queryUsagePeriod } = require("../lib/usage-period");
const { createChatUsageIndex } = require("../lib/chat-usage");
const { createUsageAggregation } = require("../lib/usage-aggregation");
const { calendarPeriod, resetPeriods } = require("../public/usage-periods");

process.env.TZ = "Europe/Vienna";
const from = Date.parse("2026-10-18T12:34:56Z"), to = from + 7 * 86400000;
const accountId = `gpt-${"a".repeat(16)}`;
const event = (id, at, providerId = "codex", account = accountId) => ({
  eventId: id, providerId, timestampMs: at, model: "gpt-6.1-sol",
  attribution: { accountId: account }, usage: { inputTokens: 100, cachedInputTokens: 40,
    outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 }
});
const index = createChatUsageIndex([
  event("before", from - 1), event("start", from), event("middle", from + 1000), event("end", to),
  event("middle", from + 1000), event("claude", from + 2000, "claudeCode"),
  event("other-account", from + 3000, "codex", "gpt-bbbbbbbbbbbbbbbb"), event("unknown-account", from + 4000, "codex", null)
]);
const options = usagePeriodOptions({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), provider: "codex", accountId });
const result = queryUsagePeriod(index, options);
assert.equal(result.eventCount, 2, "half-open boundaries, provider, account and duplicates are respected");
assert.equal(result.totals.totalTokens, 240);
assert.equal(result.totals.cachedInputTokens, 80);
assert.equal(result.totals.outputTokens, 40, "reasoning is not added a second time");
assert.equal(result.unassignedTokens, 120, "unknown account coverage is explicit");
assert.equal(result.daily[0].sources[0].models[0].totalTokens, 240);
assert.equal(queryUsagePeriod(index, { ...options, accountId: null }).totals.totalTokens, 480);
assert.equal(queryUsagePeriod(index, { ...options, from: to + 1, to: to + 2 }).totals.totalTokens, 0);
assert.ok(!JSON.stringify(result).includes(accountId), "no account identity, event, chat or source paths leave the query");
for (const query of [{ from: "bad", to: new Date(to).toISOString() }, { from: "2026-01-02", to: "2026-01-01" },
  { from: "2026-01-01", to: "2026-01-02", provider: "unknown" }, { from: "2026-01-01", to: "2026-01-02", accountId: "../secret" }]) {
  assert.throws(() => usagePeriodOptions(query), /invalid_usage_period/);
}

const billing = calendarPeriod("billing", 0, new Date("2026-03-10T12:00:00Z"), "2026-01-31");
assert.equal(billing.from, "2026-02-27T23:00:00.000Z");
assert.equal(billing.to, "2026-03-30T22:00:00.000Z", "month end clamping preserves the original anchor and DST");
const week = calendarPeriod("week", 0, new Date("2026-10-25T12:00:00Z"));
assert.equal(week.from, "2026-10-18T22:00:00.000Z");
assert.equal(week.to, "2026-10-25T23:00:00.000Z", "calendar weeks include the 25-hour autumn DST day");
assert.equal(calendarPeriod("billing", 0, new Date(), "2026-02-31"), null);
const periods = resetPeriods(null, [
  { windowKey: "weekly", startsAt: "2026-10-01T12:00:00Z", resetsAt: "2026-10-08T12:00:00Z" },
  { windowKey: "weekly", startsAt: "2026-10-05T12:00:00Z", resetsAt: "2026-10-12T12:00:00Z" }
], "weekly", Date.parse("2026-10-07T12:00:00Z"));
assert.equal(periods[1].to, periods[0].from, "an early reset cannot double count the overlapping nominal days");

const aggregation = createUsageAggregation({ createWorker: () => new Worker(new URL("../lib/usage-aggregation-worker.js", import.meta.url)) });
try {
  await aggregation.aggregateLocal([{ _usageEvents: [event("local", from + 1000)] }], {
    device: { id: "a".repeat(32), label: "Fixture" }, snapshots: [], accounts: [], dailyHistoryDays: 180
  });
  const report = await aggregation.period([], "local", options);
  assert.equal(report.totals.totalTokens, 120, "the native aggregation worker answers an exact period from its existing private index");
  const copied = { key: "e".repeat(64), providerId: "codex", sourceGroupId: "codex", timestamp: new Date(from + 1000).toISOString(),
    model: "gpt-6.1-sol", accountId, usage: event("copy", from).usage };
  const snapshots = ["a", "b"].map((letter) => ({ device: { id: letter.repeat(32), name: letter },
    capturedAt: new Date().toISOString(), revision: "1", events: [copied] }));
  assert.equal((await aggregation.period(snapshots, "all", options)).totals.totalTokens, 120, "copied events on paired devices count once");
  assert.equal((await aggregation.period(snapshots, "b".repeat(32), options)).totals.totalTokens, 120, "selected-device periods keep their own scope");

} finally { await aggregation.close(); }
console.log("usage periods: boundaries, accounts, cache tokens, DST, billing anchors, early resets and worker verified");
