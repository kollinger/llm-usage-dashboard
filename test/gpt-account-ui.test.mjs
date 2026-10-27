import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { createRequire } from "node:module";
import { createGptAccountLifecycle } from "./fixtures/gpt-account-lifecycle.mjs";
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

// Overview uses canonical accounts; consumption/pricing keep their source view.
const require = createRequire(import.meta.url);
const { gptDuplicateUsageFixture } = require("./fixtures/gpt-duplicate.cjs");
context.overviewFixture = gptDuplicateUsageFixture();
const overview = JSON.parse(vm.runInContext(`
const overviewUsage = overviewFixture;
overviewUsage.gptAccounts.accounts[0].label = "Personal <fixture>";
overviewUsage.gptAccounts.accounts[1].label = "Work fixture";
overviewUsage.codex = { limits: { fiveHour: { usedPercent: 91 } },
  totals: { allTime: { totalTokens: 900 }, last24h: { totalTokens: 90 } } };
overviewUsage.openCode = { status: "live", totals: { allTime: { totalTokens: 155 }, last24h: { totalTokens: 15 } } };
overviewUsage.local = { totals: { allTime: { totalTokens: 1055 } }, daily: [{ date: "2026-10-20", totalTokens: 1055 }] };
const beforeOverview = JSON.stringify(overviewUsage);
const sourceCards = buildProviders(overviewUsage);
const cards = buildProviderCards(overviewUsage);
const accountCards = cards.filter(card => card.accountId);
state.usage = overviewUsage;
state.providerOrder = ["ollama", "codex", "copilot", "openCode", "codexSpark", "claudeCode"];
const ordered = orderProviders(cards).map(card => card.id);
const accountIds = accountCards.map(card => card.id);
const moved = moveProviderRelativeToTarget(accountIds[1], "ollama");
const customOrder = state.providerOrder.slice();
overviewUsage.gptAccounts.accounts.reverse();
const afterReorder = orderProviders(buildProviderCards(overviewUsage)).map(card => card.id);
overviewUsage.gptAccounts.accounts.reverse();
JSON.stringify({ accountCards, ordered, accountIds, moved, customOrder, afterReorder,
  names: accountIds.map(providerName), html: accountCards.map(card => renderProvider(card)).join(""),
  active: cards.filter(providerHasUsage).filter(card => card.accountId).length,
  sourceTokens: sourceCards.filter(card => ["codex", "openCode"].includes(card.id)).map(card => card.allTimeTokens),
  unchanged: beforeOverview === JSON.stringify(overviewUsage), sourceIds: sourceCards.map(card => card.id),
  ids: cards.map(card => card.id) });
`, context));
assert.equal(overview.accountCards.length, 2);
assert(!overview.ids.includes("codex") && !overview.ids.includes("openCode"), "source cards must not duplicate account cards");
assert(overview.sourceIds.includes("codex") && overview.sourceIds.includes("openCode"), "pricing retains both historical source choices");
assert.deepEqual(overview.sourceTokens, [900, 155]);
assert.equal(overview.unchanged, true, "overview cannot mutate historical totals, attribution or charts");
const personal = overview.accountCards.find(card => card.name.includes("Personal"));
const work = overview.accountCards.find(card => card.name.includes("Work"));
assert.deepEqual(personal.limitRows.map(row => row.remainingPercent), [0, 40, null], "select each window by its own freshness; never sum source percentages");
assert.deepEqual(work.limitRows.map(row => row.remainingPercent), [65]);
assert.equal(work.todayTokens, undefined, "provider-wide consumption cannot be assigned to an account");
assert.equal(overview.active, 2);
assert(overview.html.includes("Personal &lt;fixture&gt;") && overview.html.includes("Work fixture"));
assert(overview.html.includes("provider-mark-codex"), "canonical IDs keep the Codex brand");
assert(overview.html.includes("quota-pace-card"), "canonical account cards retain recent-pace controls");
assert(overview.html.includes(english.limits.recentPace.collecting), "missing account history stays explicitly unavailable");
assert(overview.html.includes(english.liveMetrics.unavailable), "missing window value stays unavailable");
assert(overview.ordered.indexOf(overview.accountIds[0]) > overview.ordered.indexOf("ollama"));
assert(overview.ordered.indexOf(overview.accountIds[1]) < overview.ordered.indexOf("copilot"));
assert.equal(overview.moved, true, "account cards can still be reordered");
assert.deepEqual(overview.afterReorder, overview.customOrder, "quota identity and custom order survive registry reordering");
assert(overview.names.every(name => name.startsWith("Codex · ")));

const states = JSON.parse(vm.runInContext(`
const directUsage = JSON.parse(JSON.stringify(overviewUsage));
directUsage.gptAccounts.accounts.forEach(account => { account.sources = account.sources.filter(source => source.id === "codex"); });
const directCards = buildProviderCards(directUsage).filter(card => card.accountId);
const directResets = directCards.map(card => card.limitRows.map(row => row.resetsAt));
directUsage.gptAccounts.accounts[1].sources[0].limits.rows[0].resetsAt = "2099-02-03T04:05:00.000Z";
const distinctResets = buildProviderCards(directUsage).filter(card => card.accountId).map(card => card.limitRows.map(row => row.resetsAt));
const newAccount = directUsage.gptAccounts.accounts[1];
newAccount.sources[0].limits = null;
newAccount.sources[0].quotaStatus = "unavailable";
const missing = buildProviderCards(directUsage).find(card => card.id === newAccount.id);
newAccount.sources[0].limits = { rows: [{ key: "fiveHour", usedPercent: 0, updatedAt: new Date().toISOString() }] };
newAccount.sources[0].quotaStatus = "ready";
const zero = buildProviderCards(directUsage).find(card => card.id === newAccount.id);
newAccount.sources[0].limits.rows[0].updatedAt = "2020-01-01T00:00:00.000Z";
newAccount.sources[0].limits.rows[0].resetsAt = "2099-02-03T04:05:00.000Z";
const stale = buildProviderCards(directUsage).find(card => card.id === newAccount.id);
newAccount.sources[0].limits.rows[0].updatedAt = new Date().toISOString();
newAccount.sources[0].quotaStatus = "unavailable";
newAccount.sources[0].quotaReason = "auth_required";
const failedOverview = buildProviderCards(directUsage).find(card => card.id === newAccount.id);
directUsage.gptAccounts.accounts.push(JSON.parse(JSON.stringify(newAccount)));
const duplicateCount = buildProviderCards(directUsage).filter(card => card.accountId).length;
directUsage.gptAccounts.accounts.forEach(account => { account.active = false; });
const historicalCards = buildProviderCards(directUsage).filter(card => card.accountId);
directUsage.gptAccounts.accounts.forEach(account => { account.label = "Same masked label"; });
const sameLabels = buildProviderCards(directUsage).filter(card => card.accountId).map(card => card.name);
JSON.stringify({ directCount: directCards.length, distinctResets, duplicateCount,
  sameLabels, historicalActive: historicalCards.filter(providerHasUsage).length, historicalAll: historicalCards.length,
  missing: { card: missing, shown: providerHasUsage(missing), html: renderProvider(missing) },
  zero: { card: zero, shown: providerHasUsage(zero), html: renderProvider(zero) },
  stale: { card: stale, html: renderProvider(stale) }, failed: { card: failedOverview, html: renderProvider(failedOverview) },
  fallback: buildProviderCards({}).map(card => card.id) });
`, context));
assert.equal(states.directCount, 2, "both direct accounts appear without OpenCode login or token history");
assert.notDeepEqual(states.distinctResets[0], states.distinctResets[1], "each account keeps its own reset times");
assert.equal(states.duplicateCount, 2, "the same canonical ID only appears once");
assert.equal(new Set(states.sameLabels).size, 2, "equal masked labels remain distinguishable using stable opaque suffixes");
assert.equal(states.historicalActive, 0, "inactive account snapshots stay out of the active filter");
assert.equal(states.historicalAll, 2, "Show all retains both historical accounts");
assert.equal(states.missing.shown, true);
assert.deepEqual(states.missing.card.limitRows, []);
assert.equal(states.missing.card.fiveHour, null, "missing quota cannot inherit the first account/provider limit");
assert(states.missing.html.includes(english.gptAccounts.quotaUnavailable));
assert(!states.missing.html.includes("0%"));
assert.equal(states.zero.shown, true);
assert.equal(states.zero.card.fiveHour.usedPercent, 0);
assert.equal(states.zero.card.fiveHour.remainingPercent, 100);
assert.equal(states.zero.card.limitRows[0].status, "current");
for (const sample of [states.stale, states.failed]) {
  assert.equal(sample.card.fiveHour, null, "saved values cannot enter current quota summary");
  assert.equal(sample.card.limitRows[0].status, "stale");
  assert(sample.html.includes(english.gptAccounts.savedLimits));
  assert(!sample.html.includes('role="meter"'), "stale quota cannot drive a current pace projection");
}
assert(states.failed.html.includes(english.connections.status.auth_required));
assert(states.fallback.includes("codex") && states.fallback.includes("openCode"), "keep legacy sources before any account is detected");

// Feed the overview with the production collector/registry lifecycle across scans,
// duplicate login, persistence and process-style reload; no real provider requests.
const lifecycle = await createGptAccountLifecycle();
try {
  await lifecycle.scan();
  let stableIds;
  for (let cycle = 0; cycle < 3; cycle++) {
    context.lifecycleUsage = await lifecycle.usage();
    const cards = JSON.parse(vm.runInContext("JSON.stringify(buildProviderCards(lifecycleUsage).filter(card => card.accountId))", context));
    assert.equal(cards.length, 2);
    const ids = cards.map(card => card.id).sort();
    stableIds ??= ids;
    assert.deepEqual(ids, stableIds);
    await lifecycle.login(); await lifecycle.scan(); await lifecycle.reload();
  }
} finally { await lifecycle.close(); }

context.recheckRegistry = { accounts: [] };
await vm.runInContext(`
fetchJson = async () => ({ gptAccounts: recheckRegistry });
renderGptAccounts = () => {};
globalThis.overviewRefreshCount = 0;
renderUsageIfChanged = () => { overviewRefreshCount++; };
recheckGptAccounts();`, context);
assert.equal(vm.runInContext("overviewRefreshCount", context), 1, "re-scan immediately refreshes the overview");
assert.equal(vm.runInContext("state.usage.gptAccounts === recheckRegistry", context), true);
console.log("GPT overview: distinct direct accounts/limits/resets, shared-source dedupe, unknown/zero/stale/failed values, order/filter, scan/login/restart and consumption preservation passed.");
