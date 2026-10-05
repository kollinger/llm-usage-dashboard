import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const load = source.slice(source.indexOf("async function loadUsage("), source.indexOf("\nfunction setUsageLoading("));
async function checkSwitch(honorAbort) {
const requests = [], rendered = [];
let resolveFirst;
const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
const state = { auth: null, loadingUsage: false, queuedUsageForce: false, queuedUsageIndicator: false,
  subscriptionHistory: {}, subscriptionHistoryFetchedAt: Date.now(), codexResetFetchedAt: Date.now() };
const connectionState = { selectedDevice: "all" };
const context = vm.createContext({ state, connectionState, URLSearchParams, Date, AbortController,
  DEFAULT_LANGUAGE: "en", SUBSCRIPTION_HISTORY_REFRESH_MS: 60_000,
  loadCodexResetHistory() {}, setRefreshIndicator() {},
  setUsageLoading(value) { state.loadingUsage = value; },
  renderUsageIfChanged() { rendered.push(state.usage.scope); },
  fetchJson(url, options) {
    if (url === "/api/subscription-history") return Promise.resolve({});
    const params = new URL(url, "http://localhost").searchParams;
    requests.push({ device: params.get("device"), force: params.has("force") });
    if (requests.length !== 1) return Promise.resolve({ scope: params.get("device") });
    if (!honorAbort) return firstResponse;
    return new Promise((resolve, reject) => {
      firstResponse.then(resolve);
      options.signal.addEventListener("abort", () => reject(new Error("AbortError")), { once: true });
    });
  }
});
vm.runInContext(load, context);
const first = context.loadUsage();
connectionState.selectedDevice = "local";
await context.loadUsage();
if (!honorAbort) resolveFirst({ scope: "all" });
let deadline;
try {
  await Promise.race([first, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("device switch waited for obsolete response")), 500); })]);
} finally { clearTimeout(deadline); }
assert.deepEqual(requests, [{ device: "all", force: false }, { device: "local", force: false }], "a device switch during a request must immediately load the latest scope without rescanning provider logs");
assert.deepEqual(rendered, ["local"], "a late response must not render another device's tokens under the new selection");
assert.equal(state.usage.scope, "local");
}
await checkSwitch(false);
await checkSwitch(true);
console.log("Usage device switch: latest scope loads immediately after an in-flight request; obsolete scope never renders.");
