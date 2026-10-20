import assert from "node:assert/strict";
import "./quota-labels.test.mjs";
import fs from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildDesktopWidgetSnapshot, STALE_AFTER_MS } = require("../lib/desktop-widget");
const { claudeAccountIdentity, mergeClaudeLocalAccounts } = require("../lib/claude-accounts");
const { safeMeasurement } = require("../lib/provider-account-store");
const { claudeUsageFixture } = require("./fixtures/desktop-widget.cjs");
const now = Date.now();
const fixture = claudeUsageFixture(now);
const source = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
function serverFunction(name, context) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf("\n}", start) + 2;
  assert(start >= 0 && end > start);
  return vm.runInNewContext(`${source.slice(start, end)}; ${name}`, context);
}
const project = (value) => buildDesktopWidgetSnapshot(value, now);
const localOnly = { generatedAt: fixture.generatedAt, claudeCode: fixture.claudeCode, connectedAccounts: [] };
let snapshot = project(localOnly);
assert.equal(snapshot.accounts.length, 1, "dashboard Claude quota appears without a connection or CLI auth");
const local = snapshot.accounts[0];
assert.equal(local.provider, "claude");
assert.deepEqual(local.sources, ["local"], "uncertain identity is visibly a local source");
assert.equal(local.windows[0].remainingPercent, 0);
assert.equal(local.windows[0].status, "current");
assert.equal(local.windows[1].remainingPercent, null);
assert.equal(local.windows[1].status, "unavailable");
assert.equal(local.windows[0].resetsAt, fixture.claudeCode.limits.rows[0].resetsAt);
assert.equal(local.windows[0].measuredAt, fixture.claudeCode.limitsUpdatedAt);

snapshot = project(fixture);
assert.equal(snapshot.accounts.length, 3, "ambiguous local data is never borrowed by either managed account");
assert.deepEqual(snapshot.accounts.map((account) => account.windows[0].remainingPercent), [73, 41, 0]);
assert.equal(snapshot.accounts[0].windows[0].status, "stale");
const managedId = snapshot.accounts[0].id;
fixture.claudeCode.quotaAccountId = fixture.connectedAccounts[0].accountId;
snapshot = project(fixture);
assert.equal(snapshot.accounts.length, 2, "verified account identity merges managed and local quota once");
assert.equal(snapshot.accounts[0].id, managedId, "a newer source keeps the favorite handle stable");
assert.equal(snapshot.accounts[0].label, "Claude · Personal");
assert.deepEqual(snapshot.accounts.map((account) => account.windows[0].remainingPercent), [0, 41]);
assert.equal(snapshot.accounts[0].windows[0].status, "current");
fixture.connectedAccounts.push({ ...fixture.connectedAccounts[0], id: "synthetic-mirrored-profile", limits: null });
assert.equal(project(fixture).accounts.length, 2, "multiple profiles with the same identity deduplicate");
fixture.claudeCode.quotaAccountId = null;
fixture.connectedAccounts[1].label = fixture.connectedAccounts[0].label;
assert.equal(project(fixture).accounts.length, 3, "same display labels do not merge identities");
fixture.connectedAccounts.push({ ...fixture.connectedAccounts[0], id: "synthetic-other-provider", provider: "gpt" });
assert.equal(project(fixture).accounts.length, 4, "cross-provider identity overlap cannot hide Claude");
fixture.connectedAccounts.push({ id: "detected:claude", provider: "claude", accountId: null, localSource: true,
  status: "connected", limits: fixture.claudeCode.limits, updatedAt: fixture.claudeCode.limitsUpdatedAt });
assert.equal(project(fixture).accounts.length, 4, "server-projected local quota and provider fallback appear once");
assert.equal(project(fixture).accounts.find((account) => account.sources.includes("local")).id, local.id);

for (const value of [null, "unknown", fixture.connectedAccounts[0].label]) {
  localOnly.claudeCode.quotaAccountId = value;
  assert.equal(project(localOnly).accounts[0].id, local.id);
}
for (const updatedAt of [null, "invalid", new Date(now - STALE_AFTER_MS - 1).toISOString(), new Date(now + 120_000).toISOString()]) {
  assert.equal(project({ claudeCode: { ...localOnly.claudeCode, limitsUpdatedAt: updatedAt } }).accounts[0].windows[0].status, "stale");
}
assert.equal(project({ claudeCode: { ...localOnly.claudeCode, setup: { staleLimits: true } } }).accounts[0].windows[0].status, "stale");
const elapsed = structuredClone(localOnly);
elapsed.claudeCode.limits.rows[0].resetsAt = new Date(now - 1).toISOString();
assert.equal(project(elapsed).accounts[0].windows[0].status, "stale");
assert.equal(project(elapsed).accounts[0].windows[0].remainingPercent, 0, "elapsed resets do not invent a refill");
assert.equal(project({ claudeCode: { status: "live", limits: null } }).accounts.length, 0);

const authIdentity = claudeAccountIdentity({ accountId: "synthetic-account", orgId: "synthetic-org" });
assert.equal(claudeAccountIdentity({ accountId: "synthetic-account", organization_uuid: "synthetic-org" }), authIdentity);
assert.notEqual(claudeAccountIdentity({ accountId: "synthetic-account", orgId: "synthetic-other-org" }), authIdentity);
assert.equal(claudeAccountIdentity({ email: " Fixture@Example.invalid ", orgId: "synthetic-org" }),
  claudeAccountIdentity({ email: "fixture@example.invalid", orgId: "synthetic-org" }));
assert.equal(claudeAccountIdentity({}), null);
const auth = { loggedIn: true, authMethod: "claude.ai", accountId: authIdentity };
const unscoped = mergeClaudeLocalAccounts([], localOnly.claudeCode, auth, now)[0];
assert.equal(unscoped.accountId, null, "current auth never retroactively identifies an unscoped measurement");
assert.equal(mergeClaudeLocalAccounts([], null, auth, now)[0].accountId, authIdentity);

// Execute the production discovery and snapshot orchestration with isolated
// dependencies. No collectors, credentials, real CLI or provider calls run.
let failed = "", received;
const context = {
  usageCache: { value: { claudeCode: { ...localOnly.claudeCode, limits: { rows: [{ remainingPercent: 99 }] } } } },
  readManagedGptProfiles: async () => { if (failed === "gpt") throw Error(); return []; },
  gptAccountsCache: { value: { accounts: [] } }, claudeLogin: { profiles: async () => { if (failed === "claude") throw Error(); return []; } },
  kimiLogin: { profiles: async () => { if (failed === "kimi") throw Error(); return []; }, refresh: async () => {} },
  readClaudeAuthStatus: async () => { if (failed === "auth") throw Error(); return {}; },
  readClaudeProfileMeasurement: async () => ({}), safeMeasurement, mergeClaudeLocalAccounts, DATA_DIR: "/synthetic", path,
  connectedAccountStore: { refresh: async () => { if (failed === "keys") throw Error(); return []; } },
  Date, Promise
};
context.readBrowserConnections = serverFunction("readBrowserConnections", context);
vm.runInNewContext("let connectedBrowserRefreshAt = 0; let connectedBrowserRefresh = null;", context);
const readSnapshots = serverFunction("readConnectedAccountSnapshots", context);
for (failed of ["", "gpt", "claude", "kimi", "auth", "keys"]) {
  const connections = await readSnapshots({ claudeCode: localOnly.claudeCode });
  assert.equal(connections.length, 1, `${failed || "cold start"}: independent failure cannot hide local Claude`);
  assert.equal(connections[0].limits.rows[0].remainingPercent, 0, "use this scan rather than stale usageCache");
}
context.usageCache.value = null;
failed = "auth";
assert.equal((await readSnapshots({ claudeCode: localOnly.claudeCode })).length, 1, "cold cache plus failed auth still exposes quota");
context.readBrowserConnections = async ({ usage }) => { received = usage; throw Error(); };
context.connectedAccountStore.refresh = async () => [{ id: "synthetic-key", provider: "glm" }];
assert.equal((await readSnapshots(localOnly)).length, 1, "healthy keys survive browser discovery failure");
assert.equal(received, localOnly);

context.readBrowserConnections = serverFunction("readBrowserConnections", context);
context.connectedAccountStore.refresh = async () => [];
let collected = false;
const scan = {
  usageCache: { value: null }, USAGE_CACHE_MS: 1, usageViewCache: { context: async () => "synthetic", read: async () => null, write: async () => {} },
  readThroughCache: async (_cache, _age, load) => load(), readSourceSettings: async () => ({ sources: [] }), DATA_DIR: "/synthetic",
  buildReaderSources: () => ({ claudeCode: [], codex: [], openCode: [] }), claudeLogin: { profileSources: async () => [] },
  readGptAccounts: async () => ({ accounts: [] }), readSubscriptionSettings: async () => ({}),
  readAccountBillingSnapshots: async () => ({}), readOfficialSubscriptionPricing: async () => ({}),
  readClaudeCodeUsage: async () => { await Promise.resolve(); collected = true; return localOnly.claudeCode; },
  readConnectedAccountSnapshots: async (inputs) => {
    assert(collected, "production dashboard waits for the current Claude measurement");
    assert.equal(inputs.claudeCode, localOnly.claudeCode);
    return readSnapshots(inputs);
  },
  mergeProviderSubscription: (value) => value, applyConnectedAccountQuota: (value) => value,
  recordProviderQuotaSnapshots: async () => [], updateQuotaPace: async () => ({}),
  chatMetadataReader: { read: async () => ({ sessions: {} }) }, uniquePaths: (values) => values, CODEX_HOMES: [],
  sourcePathEntries: () => [], deviceSync: { config: {}, snapshots: new Map() }, DAILY_HISTORY_DAYS: 180,
  usageAggregation: { aggregateLocal: async () => ({ local: {} }) }, buildLocalAggregate: () => ({}), stripProviderUsageEvents: (value) => value,
  localSyncClient: { captureUsageEvents: async () => ({ skipped: "sync_disabled_or_unpaired" }) },
  overlayRestoredClaudeQuota: (value) => value, overlayCurrentCodexQuota: (value) => value, codexLiveRateLimitsCache: {}, applyCodexCreditExpiry: async (value) => value
};
for (const name of ["readCodexUsage", "readOpenCodeGptUsage", "readCopilotUsage", "readGeminiUsage", "readGlmUsage", "readOllamaUsage", "readOpenAiUsage", "readAnthropicUsage"])
  scan[name] = async () => ({});
const dashboard = await serverFunction("readUsageDashboard", scan)();
assert.equal(dashboard.connectedAccounts.length, 1);
assert.equal(project(dashboard).accounts[0].windows[0].remainingPercent, 0, "the production first scan includes local Claude in both data paths");
collected = false;
scan.claudeLogin.profileSources = async () => { throw Error("synthetic unreadable profiles"); };
assert.equal(project(await serverFunction("readUsageDashboard", scan)()).accounts.length, 1, "unreadable managed profiles do not hide the default local source");

const sentinel = "PRIVATE_CLAUDE_FIXTURE_SENTINEL";
const privateFixture = structuredClone(fixture);
privateFixture.claudeCode.raw = privateFixture.claudeCode.path = privateFixture.claudeCode.accessToken = sentinel;
privateFixture.claudeCode.limits.rows[0].payload = sentinel;
const serialized = JSON.stringify(project(privateFixture));
assert(!serialized.includes(sentinel));
assert(!serialized.includes("accountId"));
assert(!serialized.includes("claude-" + "a".repeat(24)));
console.log("Claude widgets: local-only/cold-start discovery, scoped deduplication, separate accounts, provider collisions, isolated failures, stable handles, zero/missing/stale/reset and privacy passed.");
