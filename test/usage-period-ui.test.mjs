import assert from "node:assert/strict";
import vm from "node:vm";
import { readDashboardSource } from "./fixtures/dashboard-source.mjs";

const elements = new Map();
const timers = [], timeoutControllers = [];
const context = vm.createContext({
  document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", closest() { return null; } }); return elements.get(id); },
    querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {} },
  window: { requestAnimationFrame(callback) { callback(); } },
  navigator: { language: "en-US", languages: ["en-US"] },
  localStorage: { getItem() { return null; }, setItem() {} },
  setTimeout(callback, ms) { const timer = { callback, ms }; timers.push(timer); return timer; },
  clearTimeout(timer) { if (timer) timer.cancelled = true; },
  AbortSignal: { timeout(ms) { assert.equal(ms, 20_000); const controller = new AbortController(); timeoutControllers.push(controller); return controller.signal; } },
  timers, timeoutControllers,
  Intl, Date, URLSearchParams, console
});
vm.runInContext((await readDashboardSource()).replace("\ninit();", "\n// isolated UI test"), context);
const result = JSON.parse(await vm.runInContext(`(async () => {
  const now = Date.now(), iso = (at) => new Date(at).toISOString(), day = 86400000;
  const current = { startsAt: iso(now - day), scheduledResetAt: iso(now + 6 * day), startEstimated: true };
  const previous = { startsAt: iso(now - 8 * day), scheduledResetAt: current.startsAt, closedAt: current.startsAt };
  const history = { current, windows: [previous] };
  state.usage = { codex: {}, codexSpark: {} };
  state.pricingPeriodCatalog = { codex: { ...history, accounts: [{ accountRef: "gpt-aaaaaaaaaaaaaaaa", label: "Fixture", history }] }, windows: [] };
  state.pricingCatalogAt = now;
  refreshPricingPeriodView = () => {};
  const pending = [];
  fetchJson = (url) => new Promise((resolve) => pending.push({ url, resolve }));
  const providers = [{ id: "codex" }, { id: "codexSpark" }], local = { updatedAt: "fixture" };
  const first = renderPricingPeriodControls(local, providers);
  const stableRefresh = first.key === renderPricingPeriodControls({ updatedAt: "new scan" }, providers).key && pending.length === 1;
  const defaults = { kind: state.pricingPeriodKind, from: first.from, accountId: first.accountId,
    allAccountsSelected: els.pricingPeriodControls.innerHTML.includes('<option value="" selected>') };
  state.pricingPeriodOffset = -1;
  const second = renderPricingPeriodControls(local, providers);
  pending[0].resolve({ totals: { totalTokens: 999 } });
  await Promise.resolve(); await Promise.resolve();
  const staleIgnored = state.pricingPeriodReport === null;
  pending[1].resolve({ totals: { totalTokens: 123 } });
  await Promise.resolve(); await Promise.resolve();
  const selectedTokens = state.pricingPeriodReport.value.totals.totalTokens;
  const request = new URLSearchParams(pending[1].url.split("?")[1]);
  state.pricingPeriodOffset = 0;
  handlePricingPeriodChange({ target: { closest: () => ({ dataset: { pricingPeriodField: "account" }, value: "gpt-aaaaaaaaaaaaaaaa" }) } });
  const account = renderPricingPeriodControls(local, providers);
  const accountRequest = new URLSearchParams(pending.at(-1).url.split("?")[1]);
  state.pricingResetAccount = "removed-account";
  const removedAccount = renderPricingPeriodControls(local, providers);
  state.pricingPeriodKind = "all";
  const all = renderPricingPeriodControls(local, providers);
  const stableAllKey = all.key === renderPricingPeriodControls(local, providers).key;
  state.pricingPeriodKind = "billing";
  const missingAnchor = renderPricingPeriodControls(local, providers) === null;
  state.pricingPeriodKind = "reset"; state.pricingPeriodOffset = 0;
  state.syncDeviceFilter = "b".repeat(32);
  const remoteUnavailable = renderPricingPeriodControls(local, providers) === null;
  state.syncDeviceFilter = "all"; state.pricingProvider = "codexSpark";
  state.usage.codex.spark = { limits: { weekly: { resetsAt: current.scheduledResetAt, windowMinutes: 10080 } } };
  const spark = renderPricingPeriodControls(local, providers);
  return JSON.stringify({ defaults, currentFrom: current.startsAt, previousFrom: second.from,
    expectedPreviousFrom: previous.startsAt, staleIgnored, selectedTokens,
    requestProvider: request.get("provider"), requestAccount: request.get("accountId"),
    explicitAccount: account.accountId, explicitRequestAccount: accountRequest.get("accountId"),
    removedAccountCleared: !removedAccount.accountId && state.pricingResetAccount === "",
    stableRefresh, stableAllKey, missingAnchor, remoteUnavailable, sparkReset: spark.to });
})()`, context));
assert.equal(result.defaults.kind, "reset");
assert.equal(result.defaults.from, result.currentFrom);
assert.equal(result.defaults.accountId, undefined, "the provider reset period includes logs without account attribution by default");
assert.equal(result.defaults.allAccountsSelected, true);
assert.equal(result.previousFrom, result.expectedPreviousFrom);
assert.equal(result.staleIgnored, true, "a slow previous request cannot overwrite the currently selected period");
assert.equal(result.stableRefresh, true, "a dashboard refresh cannot discard or duplicate an in-flight period result");
assert.equal(result.selectedTokens, 123);
assert.equal(result.requestProvider, "codex");
assert.equal(result.requestAccount, null, "browsing previous reset periods preserves the complete provider scope");
assert.equal(result.explicitAccount, "gpt-aaaaaaaaaaaaaaaa");
assert.equal(result.explicitRequestAccount, "gpt-aaaaaaaaaaaaaaaa", "an explicitly chosen account still filters usage strictly");
assert.equal(result.removedAccountCleared, true, "a removed account cannot silently select another account");
assert.equal(result.stableAllKey, true, "all-time rendering cannot trigger an endless request loop");
assert.equal(result.missingAnchor, true);
assert.equal(result.remoteUnavailable, true, "remote installations cannot borrow local reset metadata");
assert.ok(result.sparkReset, "Spark uses its own nested quota windows");
const coverage = JSON.parse(vm.runInContext(`(() => {
  state.syncDeviceFilter = "all"; state.pricingProvider = "codex"; state.pricingResetAccount = "";
  state.pricingPeriodKind = "reset"; state.pricingPeriodOffset = 0; state.pricingView = "models";
  const local = { updatedAt: "fixture" }, providers = [{ id: "codex" }];
  const selection = renderPricingPeriodControls(local, providers);
  const usage = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, totalTokens: 120 };
  state.pricingPeriodReport = { key: selection.key, revision: local.updatedAt, value: {
    includedUnassignedTokens: 120, unassignedTokens: 0, totals: usage,
    daily: [{ date: selection.from.slice(0, 10), ...usage, sources: [{ id: "codex", ...usage,
      models: [{ model: "gpt-5.3-codex", ...usage }] }] }]
  } };
  renderPricing(local, [], providers);
  const included = els.pricingPeriodStatus.textContent.includes("pricing.periods.unassignedIncluded");
  const modelsVisible = !els.pricingUsedModels.hidden && els.pricingUsedModels.innerHTML.includes("gpt-5.3-codex") &&
    els.pricingUsedModels.innerHTML.includes('data-status="complete"');
  state.pricingPeriodReport.value.includedUnassignedTokens = 0;
  state.pricingPeriodReport.value.unassignedTokens = 120;
  renderPricing(local, [], providers);
  return JSON.stringify({ included, modelsVisible, excluded: els.pricingPeriodStatus.textContent.includes("pricing.periods.unassigned") &&
    !els.pricingPeriodStatus.textContent.includes("pricing.periods.unassignedIncluded") });
})()`, context));
assert(coverage.included, "provider costs disclose included usage without claiming an account identity");
assert(coverage.modelsVisible, "unattributed provider usage renders model rows and an API-equivalent amount");
assert(coverage.excluded, "excluded account usage has a distinct coverage label");
const recovery = JSON.parse(await vm.runInContext(`(async () => {
  state.pricingPeriodKey = "timeout-fixture";
  fetchJson = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout"))));
  const task = loadPricingPeriod({ key: state.pricingPeriodKey, from: "2026-10-01", to: "2026-10-02" });
  timeoutControllers.at(-1).abort();
  await task;
  const timedOut = state.pricingPeriodError && state.pricingPeriodPending === "";
  let retries = 0;
  refreshPricingPeriodView = () => { retries++; };
  const retry = timers.at(-1);
  retry.callback();
  const retried = retries === 1 && !state.pricingPeriodError && retry.ms === 15000;
  state.pricingPeriodCatalog = null; state.pricingCatalogAt = 0;
  const requests = [];
  fetchJson = (url) => new Promise(resolve => requests.push({ url, resolve }));
  const catalogTask = loadPricingPeriodCatalog();
  requests.find(row => row.url.includes("codex-reset-history")).resolve({ current: { startsAt: "fixture" } });
  await Promise.resolve(); await Promise.resolve();
  const independentHistory = state.pricingPeriodCatalog.codex.current.startsAt === "fixture" && state.pricingCatalogPending;
  requests.find(row => row.url.includes("quota-history")).resolve({ windows: [] });
  await catalogTask;
  return JSON.stringify({ timedOut, retried, independentHistory });
})()`, context));
assert(recovery.timedOut, "requests leave the loading state when their deadline expires");
assert(recovery.retried, "transient failures recover automatically after a bounded backoff");
assert(recovery.independentHistory, "Codex reset history does not wait behind the generic quota archive");
console.log("Cost period UI: reset default, previous period, account scope, stale requests, stable all-time, missing anchors and remote/Spark scopes passed");
