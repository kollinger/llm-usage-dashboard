import assert from "node:assert/strict";
import vm from "node:vm";
import { readDashboardSource } from "./fixtures/dashboard-source.mjs";

const elements = new Map();
const context = vm.createContext({
  document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", closest() { return null; } }); return elements.get(id); },
    querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {} },
  window: { requestAnimationFrame(callback) { callback(); } },
  navigator: { language: "en-US", languages: ["en-US"] },
  localStorage: { getItem() { return null; }, setItem() {} },
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
  const defaults = { kind: state.pricingPeriodKind, from: first.from, accountId: first.accountId };
  state.pricingPeriodOffset = -1;
  const second = renderPricingPeriodControls(local, providers);
  pending[0].resolve({ totals: { totalTokens: 999 } });
  await Promise.resolve(); await Promise.resolve();
  const staleIgnored = state.pricingPeriodReport === null;
  pending[1].resolve({ totals: { totalTokens: 123 } });
  await Promise.resolve(); await Promise.resolve();
  const selectedTokens = state.pricingPeriodReport.value.totals.totalTokens;
  const request = new URLSearchParams(pending[1].url.split("?")[1]);
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
    stableAllKey, missingAnchor, remoteUnavailable, sparkReset: spark.to });
})()`, context));
assert.equal(result.defaults.kind, "reset");
assert.equal(result.defaults.from, result.currentFrom);
assert.equal(result.defaults.accountId, "gpt-aaaaaaaaaaaaaaaa");
assert.equal(result.previousFrom, result.expectedPreviousFrom);
assert.equal(result.staleIgnored, true, "a slow previous request cannot overwrite the currently selected period");
assert.equal(result.selectedTokens, 123);
assert.equal(result.requestProvider, "codex");
assert.equal(result.requestAccount, "gpt-aaaaaaaaaaaaaaaa");
assert.equal(result.stableAllKey, true, "all-time rendering cannot trigger an endless request loop");
assert.equal(result.missingAnchor, true);
assert.equal(result.remoteUnavailable, true, "remote installations cannot borrow local reset metadata");
assert.ok(result.sparkReset, "Spark uses its own nested quota windows");
console.log("Cost period UI: reset default, previous period, account scope, stale requests, stable all-time, missing anchors and remote/Spark scopes passed");
