import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { combinedUsage, refreshCombinedUsageMetadata, hash } = require("../lib/device-sync-data");
const at = new Date(Date.now() - 60_000).toISOString();
const newer = new Date().toISOString();
const deviceA = "a".repeat(32), deviceB = "b".repeat(32);
const account = `gpt-${"a".repeat(16)}`, remoteAccount = `gpt-${"b".repeat(16)}`;
const connection = `claude-${"a".repeat(24)}`;
const limits = (percent) => ({ fiveHour: { key: "fiveHour", usedPercent: percent, remainingPercent: 100 - percent, windowMinutes: 300 },
  rows: [{ key: "fiveHour", usedPercent: percent, remainingPercent: 100 - percent, windowMinutes: 300 }] });
const source = (percent, updatedAt = at) => ({ id: "codex", active: true, quotaStatus: "ready", limitsUpdatedAt: updatedAt, limits: limits(percent) });
const local = {
  codex: { id: "codex", status: "live", limits: limits(34), planType: "pro", planSource: "codex_app_server",
    liveRateLimits: { status: "live", updatedAt: at }, creditRows: [{ key: "credits", valueLabel: "fixture" }],
    subscription: { status: "connected" }, source: { liveRateLimits: { status: "live", updatedAt: at } },
    spark: { status: "live", limits: limits(12), limitsUpdatedAt: at, planType: "pro" } },
  claudeCode: { id: "claudeCode", status: "auth_required", limits: null },
  gptAccounts: { accounts: [{ id: account, active: true, sources: [source(34)] }], scan: { status: "ready" } },
  connectedAccounts: [{ id: "local-profile", provider: "claude", accountId: connection, managed: true, status: "connected", updatedAt: at, limits: limits(21) }],
  openai: { id: "openai", status: "live", limits: limits(10) }, anthropic: { id: "anthropic", status: "not_configured" },
  quotaPace: { codex: { weekly: { 120: { status: "flat" } } } }
};
const event = (key, amount, group = "codex") => ({ key: hash(key), providerId: "codex", sourceGroupId: group,
  timestamp: at, model: "fixture-model", usage: { inputTokens: amount, totalTokens: amount } });
const snapshots = [
  { device: { id: deviceA, name: "A" }, capturedAt: at, events: [event("a", 10), event("spark-a", 5, "codexSpark")], accounts: [], excludedEvents: 0 },
  { device: { id: deviceB, name: "B" }, capturedAt: newer, events: [event("b", 20), event("spark-b", 7, "codexSpark")], excludedEvents: 0,
    accounts: [{ id: account, sources: [source(95, newer)] }, { id: remoteAccount, sources: [source(60, newer)] }],
    connections: [{ provider: "claude", accountId: connection, kind: "subscription", updatedAt: newer, limits: limits(95) }] }
];
const original = JSON.stringify({ local, snapshots });
const all = combinedUsage(local, snapshots, "all");
assert.deepEqual(all.codex.limits, local.codex.limits, "the all-device provider card retains the current local account's quota without adding remote percentages");
for (const key of ["status", "planType", "planSource", "liveRateLimits", "creditRows", "subscription"]) assert.deepEqual(all.codex[key], local.codex[key]);
assert.deepEqual(all.codex.source.liveRateLimits, local.codex.source.liveRateLimits);
assert.deepEqual(all.quotaPace, local.quotaPace);
assert.equal(all.claudeCode.status, "auth_required", "remote consumption cannot mask the current account's authentication state");
assert.equal(all.codex.totals.allTime.totalTokens, 42, "all-device consumption still uses the combined events");
assert.equal(all.codex.first.timestamp, at);
assert.equal(all.codex.latest.timestamp, at);
assert.equal(all.codex.spark.totals.allTime.totalTokens, 12, "Spark consumption must use the same scope as the containing Codex total");
assert.deepEqual(all.codex.spark.limits, local.codex.spark.limits);
assert.equal(all.codex.spark.limitsUpdatedAt, at);
assert.deepEqual(all.openai, local.openai);
assert.deepEqual(all.anthropic, local.anthropic);
assert.deepEqual(all.gptAccounts.accounts.find((row) => row.id === account).sources[0], local.gptAccounts.accounts[0].sources[0], "replicated observations must not downgrade an active local quota source");
assert.equal(all.gptAccounts.accounts.find((row) => row.id === remoteAccount).sources[0].active, false);
assert.equal(all.connectedAccounts.find((row) => row.accountId === connection).managed, true);
assert.equal(all.connectedAccounts.find((row) => row.accountId === connection).status, "connected");
assert.deepEqual(all.connectedAccounts.find((row) => row.accountId === connection).limits, local.connectedAccounts[0].limits);

const remote = combinedUsage(local, snapshots, deviceB);
assert.equal(remote.codex.limits, null, "a selected remote computer cannot inherit this computer's quota");
assert.equal(remote.codex.planType, undefined);
assert.equal(remote.codex.liveRateLimits, undefined);
assert.equal(remote.codex.creditRows, undefined);
assert.equal(remote.codex.totals.allTime.totalTokens, 27);
assert.equal(remote.codex.spark.totals.allTime.totalTokens, 7);
assert.equal(remote.codex.spark.limits, null);
assert.deepEqual(remote.quotaPace, {});
assert.equal(remote.openai.status, "unavailable");
assert.equal(remote.anthropic.status, "unavailable");
assert.equal(remote.gptAccounts.accounts.find((row) => row.id === account).sources[0].active, false);
assert.equal(remote.connectedAccounts.find((row) => row.accountId === connection).status, "saved");

const fresh = { ...local, generatedAt: newer, codex: { ...local.codex, limits: limits(45), planType: "plus", liveRateLimits: { status: "live", updatedAt: newer },
  spark: { ...local.codex.spark, limits: limits(25), limitsUpdatedAt: newer } } };
const withoutEventReads = snapshots.map((snapshot) => Object.defineProperty({ ...snapshot }, "events", { get() { throw new Error("metadata overlay must not scan events"); } }));
const refreshed = refreshCombinedUsageMetadata(fresh, all, withoutEventReads);
assert.equal(refreshed.codex.limits.rows[0].usedPercent, 45);
assert.equal(refreshed.codex.planType, "plus");
assert.equal(refreshed.codex.liveRateLimits.updatedAt, newer);
assert.equal(refreshed.codex.spark.limits.rows[0].usedPercent, 25);
assert.equal(refreshed.codex.totals, all.codex.totals, "cached heavy consumption is reused while quota metadata updates");
assert.equal(refreshed.local, all.local);
assert.equal(all.codex.limits.rows[0].usedPercent, 34, "refresh does not mutate a cached result");
const unavailable = refreshCombinedUsageMetadata({ ...fresh, codex: { id: "codex", status: "auth_required", limits: null } }, all, withoutEventReads);
assert.equal(unavailable.codex.limits, null, "a stale aggregate cannot retain a now-unavailable current quota");
assert.equal(unavailable.codex.planType, undefined);
assert.equal(unavailable.codex.status, "auth_required");
const remoteRefreshed = refreshCombinedUsageMetadata(fresh, remote, withoutEventReads, deviceB);
assert.equal(remoteRefreshed.codex.limits, null);
assert.equal(remoteRefreshed.codex.planType, undefined);
assert.equal(JSON.stringify({ local, snapshots }), original, "view composition does not mutate local or signed snapshot inputs");
console.log("Device sync quotas: current account status, separate limits, combined Spark usage and remote isolation passed.");
