import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const load = source.slice(source.indexOf("async function loadUsage("), source.indexOf("\nfunction setUsageLoading("));
const requests = [], rendered = [];
let resolveFirst;
const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
const state = { auth: null, loadingUsage: false, queuedUsageForce: false, queuedUsageIndicator: false,
  subscriptionHistory: {}, subscriptionHistoryFetchedAt: Date.now(), codexResetFetchedAt: Date.now() };
const connectionState = { selectedDevice: "all" };
const context = vm.createContext({ state, connectionState, URLSearchParams, Date,
  DEFAULT_LANGUAGE: "en", SUBSCRIPTION_HISTORY_REFRESH_MS: 60_000,
  loadCodexResetHistory() {}, setRefreshIndicator() {},
  setUsageLoading(value) { state.loadingUsage = value; },
  renderUsageIfChanged() { rendered.push(state.usage.scope); },
  fetchJson(url) {
    if (url === "/api/subscription-history") return Promise.resolve({});
    const params = new URL(url, "http://localhost").searchParams;
    requests.push({ device: params.get("device"), force: params.has("force") });
    return requests.length === 1 ? firstResponse : Promise.resolve({ scope: params.get("device") });
  }
});
vm.runInContext(load, context);
const first = context.loadUsage();
connectionState.selectedDevice = "local";
await context.loadUsage();
resolveFirst({ scope: "all" });
await first;
assert.deepEqual(requests, [{ device: "all", force: false }, { device: "local", force: false }], "a device switch during a request must immediately load the latest scope without rescanning provider logs");
assert.deepEqual(rendered, ["local"], "a late response must not render another device's tokens under the new selection");
assert.equal(state.usage.scope, "local");
console.log("Usage device switch: latest scope loads immediately after an in-flight request; obsolete scope never renders.");
