import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const source = await readFile(new URL("public/chat-usage.js", root), "utf8");
const appSource = await readFile(new URL("public/app.js", root), "utf8");
const billingHelpers = appSource.slice(appSource.indexOf("function normalizeBillingTotals("), appSource.indexOf("\nconst CHART_FILTERS"));
const english = JSON.parse(await readFile(new URL("public/i18n/en.json", root), "utf8"));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const prices = {
  cheap: { inputUsd: 2, cacheWriteUsd: 2.5, cachedInputUsd: 0.2, outputUsd: 8 },
  expensive: { inputUsd: 20, cacheWriteUsd: 25, cachedInputUsd: 2, outputUsd: 80 },
  partial: { inputUsd: 2, cachedInputUsd: null, outputUsd: 8 },
  "cheap-latest": { inputUsd: 2, cachedInputUsd: 0.2, outputUsd: 8 }
};

function harness(responder = () => ({ rows: [], coverage: {} })) {
  const nodes = new Map();
  const listeners = new Map();
  const requests = [];
  let rowElements = [];
  let locale = "en-US";
  let authReloads = 0;
  let lockedRenders = 0;
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      innerHTML: "", value: "", hidden: false, dataset: {}, classList: { toggle() {} },
      setAttribute() {}, scrollIntoView() {}, replaceChildren() { this.innerHTML = ""; }
    });
    return nodes.get(selector);
  };
  const panel = {
    innerHTML: "", hidden: true, setAttribute() {},
    replaceChildren() { this.innerHTML = ""; nodes.clear(); rowElements = []; },
    querySelector(selector) {
      if (!this.innerHTML) return null;
      return node(selector);
    },
    querySelectorAll(selector) {
      if (selector === "[data-chat-view]") return ["top", "all"].map((name) => ({ dataset: { chatView: name }, classList: { toggle() {} }, setAttribute() {} }));
      if (selector === ".chat-usage-row") {
        const markup = node(".chat-usage-results").innerHTML;
        const ids = [...markup.matchAll(/data-chat-id="([^"]+)"([^>]*)/gu)];
        rowElements = ids.map((match) => {
          const previous = rowElements.find((row) => row.dataset.chatId === match[1]);
          return previous || { dataset: { chatId: match[1] }, open: match[2].includes("open"),
            matches: (value) => value === ".chat-usage-row", detail: { innerHTML: "" },
            querySelector() { return this.detail; } };
        });
        return rowElements;
      }
      return [];
    },
    addEventListener(name, listener) { listeners.set(name, listener); }
  };
  const context = vm.createContext({
    window: {}, document: { getElementById: () => panel }, AbortController, URLSearchParams, Intl, Date,
    USD_PER_EUR: 1.1298, MILLION: 1_000_000, PRICING_DATE: "2026-10-01", FX_DATE: "2026-10-01",
    currentLocale: () => locale,
    t(key, values = {}) {
      const value = key.split(".").reduce((acc, segment) => acc?.[segment], english) ?? key;
      return value.replace(/\{(\w+)\}/gu, (_, name) => values[name] ?? "");
    },
    escapeHtml: (value) => String(value).replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]),
    formatEuro: (value) => `EUR ${value.toFixed(6)}`,
    formatNumber: (value) => new Intl.NumberFormat(locale).format(Number(value || 0)),
    sourceLabel: (value) => value,
    pricingModelForUsageModel: (model) => prices[model] || null,
    async fetchJson(url, options) { requests.push({ url, options }); return responder(url, options); },
    async loadAuth() { authReloads += 1; }, renderLocked() { lockedRenders += 1; }
  });
  vm.runInContext(billingHelpers + "\n" + source, context);
  const api = context.window.ChatUsagePanel;
  return {
    api, panel, requests, nodes,
    results: () => node(".chat-usage-results").innerHTML,
    status: () => node(".chat-usage-status").innerHTML,
    ids: () => [...node(".chat-usage-results").innerHTML.matchAll(/data-chat-id="([^"]+)"/gu)].map((match) => match[1]),
    input(name, value) { listeners.get(name === "search" ? "input" : "change")({ target: { dataset: { chatFilter: name }, value } }); },
    click(dataset) { listeners.get("click")({ target: { closest: () => ({ dataset, hasAttribute: (name) => ({ "data-chat-page": "chatPage", "data-chat-retry": "chatRetry" })[name] in dataset }) } }); },
    toggle(id) {
      const row = panel.querySelectorAll(".chat-usage-row").find((row) => row.dataset.chatId === id);
      assert(row, "expand an existing row");
      row.open = true; listeners.get("toggle")({ target: row }); return row;
    },
    language(value) { locale = value; },
    authCounts: () => ({ authReloads, lockedRenders })
  };
}

const ui = harness();
const cost = (sourceId, model, usage) => ui.api.estimateRowCost({ models: [{ sourceId, model, ...usage }], usage });
const near = (value, expected) => assert(Math.abs(value - expected) < 1e-10, `${value} should equal ${expected}`);
const codexUsage = { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 100_000, reasoningOutputTokens: 50_000, totalTokens: 1_100_000 };
const codex = cost("codex", "cheap", codexUsage);
near(codex.eur, 1.36 / 1.1298);
assert.equal(codex.pricedTokens, 1_100_000, "Codex cached input is a subset of input; reasoning is a subset of output");
assert.equal(codex.unpricedTokens, 0);

const claudeUsage = { inputTokens: 200_000, cachedInputTokens: 800_000, cacheCreationInputTokens: 100_000, outputTokens: 100_000, totalTokens: 1_200_000 };
const claude = cost("claudeCode", "cheap", claudeUsage);
near(claude.eur, 1.61 / 1.1298);
assert.equal(claude.pricedTokens, 1_200_000, "Claude cache reads and writes are additive input categories");
assert.equal(claude.unpricedTokens, 0);

const partial = cost("codex", "partial", codexUsage);
near(partial.eur, 1.2 / 1.1298);
assert.equal(partial.pricedTokens, 300_000);
assert.equal(partial.unpricedTokens, 800_000, "a missing cache price keeps the known amount and identifies the unpriced tokens");
for (const model of ["cheap-latest", "unknown", "missing-model"]) {
  const unknown = cost("codex", model, codexUsage);
  assert.equal(unknown.eur, null, `${model} must not silently become zero or be priced as a mutable alias`);
  assert.equal(unknown.unpricedTokens, 1_100_000);
}
assert.equal(ui.api.estimateRowCost({ usage: { totalTokens: 99 } }).unpricedTokens, 99);

function fixtureRow(index, overrides = {}) {
  const sourceId = index % 3 === 0 ? "claudeCode" : "codex";
  const usage = { inputTokens: (index + 1) * 1000, outputTokens: 0, totalTokens: (index + 1) * 1000 };
  return { id: `chat-${index}`, title: `Ticket ${index}`, kind: index % 3 === 0 ? "multica" : sourceId,
    providers: [sourceId], models: [{ sourceId, model: index % 2 ? "expensive" : "cheap", ...usage }], usage,
    firstAt: "2026-10-18T08:00:00Z", lastAt: "2026-10-18T09:00:00Z", eventCount: 1, sessionCount: 1, ...overrides };
}
const rows = Array.from({ length: 65 }, (_, index) => fixtureRow(index));
const ranked = harness((url) => new URL(url, "http://localhost").searchParams.has("id")
  ? { row: { ...rows[64], title: "<script>not markup</script>", runs: [{ ...rows[64], title: "<img src=x onerror=alert(1)>", providerId: "codex" }] } }
  : { rows, coverage: { totalTokens: 2_145_100, assignedTokens: 2_145_000, unassignedTokens: 100, duplicatesSkipped: 2, multicaStatus: "unavailable" } });
ranked.api.sync({ device: "local" }); await flush();
assert.equal(ranked.ids().length, 10);
assert.equal(ranked.ids()[0], "chat-64");
assert.equal(ranked.requests.length, 1, "details are not fetched until a row is expanded");
assert.match(ranked.nodes.get(".chat-usage-coverage").innerHTML, /assignment is incomplete/u);
const expanded = ranked.toggle("chat-64"); await flush();
assert.equal(ranked.requests.length, 2);
assert.match(expanded.detail.innerHTML, /&lt;img/u, "run titles are escaped");
assert.doesNotMatch(expanded.detail.innerHTML, /<img/u);
assert.match(expanded.detail.innerHTML, /Input excluding cache/u);

ranked.input("sort", "cost");
assert.equal(ranked.ids()[0], "chat-63", "cost ranking uses model prices rather than assuming token order");
ranked.click({ chatView: "all" });
assert.equal(ranked.ids().length, 50);
ranked.click({ chatPage: "1" });
assert.equal(ranked.ids().length, 15);
ranked.input("search", "Ticket 64");
assert.deepEqual(ranked.ids(), ["chat-64"], "search resets pagination");
ranked.input("kind", "multica");
assert.equal(ranked.ids().length, 0);
ranked.input("search", "");
assert.equal(ranked.ids().length, 22);
ranked.input("kind", "all");
ranked.input("provider", "claudeCode");
assert.equal(ranked.ids().length, 22);
ranked.input("provider", "all");
ranked.input("model", "cheap");
assert.equal(ranked.ids().length, 33);
ranked.input("period", "today"); await flush();
assert.equal(new URL(ranked.requests.at(-1).url, "http://localhost").searchParams.get("period"), "today");
assert(new URL(ranked.requests.at(-1).url, "http://localhost").searchParams.get("timeZone"));
const requestsBefore = ranked.requests.length;
ranked.api.sync({ device: "local" }); await flush();
assert.equal(ranked.requests.length, requestsBefore, "normal dashboard render does not refetch within the one-minute cadence");
ranked.language("ar"); ranked.api.sync({ device: "local" }); await flush();
assert.equal(ranked.requests.length, requestsBefore, "language switches rerender without unnecessary data reads");

let oldResponse;
const delayed = new Promise((resolve) => { oldResponse = resolve; });
const switched = harness((url) => new URL(url, "http://localhost").searchParams.get("device") === "old" ? delayed : { rows: [fixtureRow(1, { id: "new-scope", title: "New private title" })] });
switched.api.sync({ device: "old" });
switched.api.sync({ device: "new" }); await flush();
assert(switched.requests[0].options.signal.aborted);
assert.deepEqual(switched.ids(), ["new-scope"]);
oldResponse({ rows: [fixtureRow(2, { id: "old-scope", title: "Old private title" })] }); await flush();
assert.deepEqual(switched.ids(), ["new-scope"], "late old-device data must never render under the new device");
switched.api.sync({ device: "new", authenticated: false });
assert(switched.panel.hidden);
assert.equal(switched.panel.innerHTML, "", "locking clears private titles, model details, filters and cached results from the DOM");

let lockedResponse;
const pending = new Promise((resolve) => { lockedResponse = resolve; });
const locked = harness(() => pending);
locked.api.sync({ device: "local" }); locked.api.lock();
lockedResponse({ rows: [fixtureRow(1)] }); await flush();
assert(locked.panel.hidden);
assert.equal(locked.panel.innerHTML, "", "a response arriving after lock cannot restore private rows");
const unauthorized = harness(() => { const error = new Error("Unauthorized"); error.status = 401; throw error; });
unauthorized.api.sync({ device: "local" }); await flush();
assert(unauthorized.panel.hidden);
assert.deepEqual(unauthorized.authCounts(), { authReloads: 1, lockedRenders: 1 });

const englishKeys = Object.keys(english.chatUsage).sort();
const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
for (const file of await readdir(new URL("public/i18n/", root))) {
  if (!file.endsWith(".json")) continue;
  const locale = JSON.parse(await readFile(new URL(`public/i18n/${file}`, root), "utf8")).chatUsage;
  assert.deepEqual(Object.keys(locale).sort(), englishKeys, `${file}: all chat-usage keys`);
  for (const key of englishKeys) {
    assert(locale[key].trim(), `${file}: ${key}`);
    assert.deepEqual(placeholders(locale[key]), placeholders(english.chatUsage[key]), `${file}: ${key} placeholders`);
  }
}
console.log("Chat usage UI: catalog equivalents, partial/unknown prices, cache/reasoning semantics, ranking, filtering, pagination, lazy detail, stale/auth privacy and all translations passed.");
