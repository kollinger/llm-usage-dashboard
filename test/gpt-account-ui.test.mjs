import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { readDashboardSource } from "./fixtures/dashboard-source.mjs";

const source = (await readDashboardSource()).replace("\ninit();", "\n// Account rendering tested without collectors or provider requests.");
const element = () => ({ classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; }, setAttribute() {} });
const document = { getElementById: element, querySelector: element, querySelectorAll: () => [], documentElement: element(), addEventListener() {} };
const context = vm.createContext({ document, window: {}, navigator: { language: "en", languages: ["en"] },
  localStorage: { getItem() { return null; } }, console });
vm.runInContext(source, context);
const english = JSON.parse(await fs.readFile(new URL("../public/i18n/en.json", import.meta.url), "utf8"));
context.dictionary = english;
const result = JSON.parse(vm.runInContext(`
state.translations = dictionary;
const at = new Date().toISOString();
const fresh = { id: "openCode", active: true, quotaStatus: "ready", limitsUpdatedAt: at,
  limits: { rows: [{ key: "fiveHour", remainingPercent: 0, resetsAt: "2099-01-01T00:00:00.000Z" },
    { key: "weekly", remainingPercent: 78, resetsAt: "2099-01-08T00:00:00.000Z" },
    { key: "custom", label: "Other window", remainingPercent: 45, resetsAt: "2099-02-01T00:00:00.000Z" }] } };
const failed = { ...fresh, id: "codex", quotaStatus: "unavailable", quotaReason: "auth_required", limitsUpdatedAt: new Date(Date.now() + 1000).toISOString() };
const old = { ...fresh, limitsUpdatedAt: "2020-01-01T00:00:00.000Z" };
const reset = { ...fresh, limits: { rows: [{ key: "weekly", remainingPercent: 1, resetsAt: "2020-01-01T00:00:00.000Z" }] } };
const account = { id: "gpt-0123456789abcdef", label: "Private <fixture>", identityQuality: "account_id", active: true, sources: [failed, fresh], lastSeenAt: at };
const unknown = { ...account, sources: [{ id: "openCode", active: true, quotaStatus: "unavailable", quotaReason: "request_failed" }] };
const quota = normalizeLocalProvider("openCode", { status: "live", totals: { allTime: { totalTokens: 155 }, last24h: { totalTokens: 155 } }, latest: { timestamp: at }, message: "No local OpenAI/GPT usage events found in OpenCode." });
JSON.stringify({ selected: gptAccountLimitSource([failed, fresh]).id,
  nullPercent: formatLimitRemainingPercent({ remainingPercent: null, usedPercent: null }),
  derivedPercent: formatLimitRemainingPercent({ remainingPercent: null, usedPercent: 20 }),
  current: gptAccountLimitSource([old], { currentOnly: true }), reset: gptAccountLimitsCurrent(reset),
  future: gptAccountLimitsCurrent({ ...fresh, limitsUpdatedAt: "2099-01-01T00:00:00.000Z" }),
  html: renderGptAccount(account), unknown: renderGptAccount(unknown),
  failed: renderGptAccount({ ...account, sources: [failed] }),
  old: renderGptAccount({ ...account, sources: [old] }),
  legacy: renderGptAccount({ ...account, identityQuality: "email", active: false, sources: [{ ...old, active: false }] }),
  provider: { message: quota.message, allTimeTokens: quota.allTimeTokens, limitRows: quota.limitRows }
});`, context));
assert.equal(result.selected, "openCode", "a newer failed snapshot cannot hide another source's live quota");
assert.equal(result.nullPercent, "--");
assert.equal(result.derivedPercent, "80%");
assert.equal(result.current, null);
assert.equal(result.reset, false, "an elapsed reset never invents a refill");
assert.equal(result.future, false);
assert.match(result.html, /Private &lt;fixture&gt;/);
for (const text of ["0%", "78%", "45%", "Other window", "2099", "OpenCode", english.gptAccounts.profileNote]) assert(result.html.includes(text), text);
assert(!result.html.includes(english.gptAccounts.savedLimits));
assert(result.unknown.includes(english.liveMetrics.unavailable));
assert(result.unknown.includes(english.gptAccounts.quotaUnavailable));
assert(!result.unknown.includes("0%"), "unknown must never be rendered as zero");
assert(result.failed.includes(english.connections.status.auth_required));
assert(result.failed.includes(english.gptAccounts.savedLimits));
assert(result.old.includes(english.gptAccounts.savedLimits));
assert(result.legacy.includes(english.gptAccounts.identityUnverified));
assert.equal(result.provider.message, english.gptAccounts.openCodeUsage);
assert.equal(result.provider.allTimeTokens, 155);
assert.deepEqual(result.provider.limitRows, [], "OpenCode usage cannot create a second account quota pool");

const placeholders = text => [...text.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
for (const file of (await fs.readdir(new URL("../public/i18n/", import.meta.url))).filter(file => file.endsWith(".json"))) {
  const locale = JSON.parse(await fs.readFile(new URL(`../public/i18n/${file}`, import.meta.url), "utf8"));
  for (const [key, value] of Object.entries(english.gptAccounts).filter(([, value]) => typeof value === "string")) {
    assert.equal(typeof locale.gptAccounts[key], "string", `${file}: ${key}`);
    assert.deepEqual(placeholders(locale.gptAccounts[key]), placeholders(value), `${file}: ${key}`);
  }
}
console.log("GPT account UI: live/stale/error/unknown limits, all resets, OpenCode attribution and locale placeholders passed.");

// Exercise the production reader after a re-scan invalidates usage. Its
// consumption-only disk cache deliberately excludes account metadata.
const serverSource = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
const readerStart = serverSource.indexOf("async function readUsageDashboard(");
const readerEnd = serverSource.indexOf("\nasync function currentCodexCreditScope", readerStart);
assert(readerStart > 0 && readerEnd > readerStart);
const consumption = { cache: { restored: true, refreshing: true }, generatedAt: "2020-01-01T00:00:00.000Z", gptAccounts: { accounts: [] }, local: { totalTokens: 155 } };
const currentRegistry = { accounts: [{ id: "gpt-0123456789abcdef", sources: [{ id: "openCode", active: true, quotaStatus: "unavailable" }] }] };
const readerContext = vm.createContext({ usageCache: { value: consumption }, gptAccountsCache: { value: currentRegistry },
  USAGE_CACHE_MS: 1000, readThroughCache: async () => consumption,
  claudeApiUsageCache: {}, readClaudeUsageSnapshot: async () => null, readClaudeStatusline: async () => null,
  codexLiveRateLimitsCache: {}, overlayRestoredClaudeQuota: value => value,
  overlayCurrentCodexQuota: value => value, applyCodexCreditExpiry: async value => value });
vm.runInContext(serverSource.slice(readerStart, readerEnd), readerContext);
const restored = await readerContext.readUsageDashboard({ staleWhileRefresh: true });
assert.equal(restored.gptAccounts, currentRegistry, "re-scanned accounts must overlay restored consumption before its refresh completes");
assert.equal(restored.generatedAt, consumption.generatedAt, "overlay cannot invent a fresh usage timestamp");
assert.equal(restored.local, consumption.local, "account metadata cannot change consumption totals");
assert.equal(consumption.gptAccounts.accounts.length, 0, "the consumption cache remains free of account data");
readerContext.gptAccountsCache.value = null;
assert.equal(await readerContext.readUsageDashboard({ staleWhileRefresh: true }), consumption, "no current registry cannot invent account metadata");
console.log("GPT account cache: completed re-scan overlays restored consumption without copying limits or changing history.");

const now = new Date().toISOString();
const liveSource = { id: "openCode", active: true, quotaStatus: "ready", limitsUpdatedAt: now,
  limits: { rows: [{ key: "fiveHour", remainingPercent: 78, resetsAt: "2099-01-01T00:00:00.000Z" }] } };
const failedSource = { ...liveSource, id: "codex", quotaStatus: "unavailable", quotaReason: "auth_required",
  limitsUpdatedAt: new Date(Date.now() + 1000).toISOString(), limits: { rows: [{ key: "fiveHour", remainingPercent: 15, resetsAt: "2099-01-01T00:00:00.000Z" }] } };
const browserContext = vm.createContext({ usageCache: {}, readManagedGptProfiles: async () => [],
  gptAccountsCache: { value: { accounts: [
    { id: "gpt-0123456789abcdef", label: "Private", planType: "plus", active: true, sources: [failedSource, liveSource] },
    { id: "gpt-fedcba9876543210", label: "Business", planType: "team", active: true, sources: [failedSource] }
  ] } }, claudeLogin: { profiles: async () => [] }, kimiLogin: { profiles: async () => [] },
  readClaudeAuthStatus: async () => ({}), safeMeasurement: value => value, mergeClaudeLocalAccounts: accounts => accounts });
const browserStart = serverSource.indexOf("async function readBrowserConnections(");
const browserEnd = serverSource.indexOf("\nasync function readClaudeProfileMeasurement", browserStart);
assert(browserStart > 0 && browserEnd > browserStart);
vm.runInContext(serverSource.slice(browserStart, browserEnd), browserContext);
const connections = await browserContext.readBrowserConnections();
assert.equal(connections[0].limits.rows[0].remainingPercent, 78);
assert.equal(connections[0].quotaStatus, "current");
assert.equal(connections[0].status, "detected");
assert.deepEqual(Array.from(connections[0].applications), ["codex", "openCode"]);
assert.equal(connections[1].limits.rows[0].remainingPercent, 15);
assert.equal(connections[1].quotaStatus, "stale");
assert.equal(connections[1].status, "auth_required");
// readDashboardSource includes connections.js alongside the dashboard scripts.
context.accountsFixture = connections;
const connectionHtml = vm.runInContext("accountsFixture.map(account => renderConnectedAccount(account)).join('')", context);
for (const text of ["plus", "team", "OpenCode", "78%", "15%", "2099", english.gptAccounts.savedLimits, english.gptAccounts.profileNote, english.connections.status.auth_required]) {
  assert(connectionHtml.includes(text), text);
}
console.log("GPT account manager: verified source preference, separate plan/application hints, auth failure, stale snapshots and resets passed.");
