import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import usageEventsModule from "../lib/usage-events.js";

const { aggregateUsageEvents } = usageEventsModule;
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appPath = path.join(rootDir, "public", "app.js");
const appSource = await readFile(appPath, "utf8");
const code = appSource.replace("\ninit();", "\n// init disabled for GPT-5.6 usage tests");
assert.notEqual(code, appSource, "GPT-5.6 tests must disable app bootstrap");
const translations = JSON.parse(await readFile(path.join(rootDir, "public", "i18n", "en.json"), "utf8"));

const uiResult = JSON.parse(vm.runInNewContext(
  `${code}
state.translations = ${JSON.stringify(translations)};
state.fallbackTranslations = {};

const sol = pricingModelForUsageModel("gpt-5.6-sol");
const terra = pricingModelForUsageModel("gpt-5.6-terra");
const luna = pricingModelForUsageModel("gpt-5.6-luna");
const solAlias = pricingModelForUsageModel("gpt-5.6");
const solBucketCost = estimateCost({
  inputTokens: 1_000_000,
  cacheCreationInputTokens: 1_000_000,
  cachedInputTokens: 1_000_000,
  outputTokens: 1_000_000
}, sol);

const todayRows = [{
  date: "2026-08-15",
  inputTokens: 1_200,
  cachedInputTokens: 900,
  outputTokens: 130,
  reasoningOutputTokens: 70,
  totalTokens: 1_330,
  sources: [{
    id: "codex",
    inputTokens: 1_200,
    cachedInputTokens: 900,
    outputTokens: 130,
    reasoningOutputTokens: 70,
    totalTokens: 1_330,
    models: [
      {
        model: "gpt-5.6-sol",
        inputTokens: 1_000,
        cachedInputTokens: 800,
        outputTokens: 100,
        reasoningOutputTokens: 60,
        totalTokens: 1_100,
        reasoningEfforts: [
          { effort: "xhigh", totalTokens: 800, reasoningOutputTokens: 40 },
          { effort: "max", totalTokens: 300, reasoningOutputTokens: 20 }
        ]
      },
      {
        model: "gpt-5.6-terra",
        inputTokens: 200,
        cachedInputTokens: 100,
        outputTokens: 30,
        reasoningOutputTokens: 10,
        totalTokens: 230,
        reasoningEfforts: [{ effort: "high", totalTokens: 230, reasoningOutputTokens: 10 }]
      }
    ]
  }]
}];
const models = summarizeModelUsageForDaily(todayRows);
const usedModelCost = summarizeUsedModelApiCost(models);
state.chartTimeFilter = "today";
const tokenTotalHtml = renderChartRangeTotal(todayRows, "tokens");
const costTotalHtml = renderChartRangeTotal(todayRows, "costs");
const usedModelsHtml = renderUsedModelPricingView(todayRows);
const todayBilling = billingTotalsForDaily(todayRows);

state.chartTimeFilter = "all";
const allTimeRows = usageRowsForSelectedRange({
  totals: { allTime: { inputTokens: 999, cachedInputTokens: 700, outputTokens: 99, reasoningOutputTokens: 49, totalTokens: 1_098 } },
  daily: [{ date: "2026-08-01", totalTokens: 123 }],
  sources: [{
    id: "codex",
    totals: { allTime: { inputTokens: 999, cachedInputTokens: 700, outputTokens: 99, reasoningOutputTokens: 49, totalTokens: 1_098 } },
    models: [{ model: "gpt-5.6-sol", inputTokens: 999, cachedInputTokens: 700, outputTokens: 99, reasoningOutputTokens: 49, totalTokens: 1_098 }]
  }]
}, [{ date: "2026-08-01", totalTokens: 123 }]);

JSON.stringify({
  sol: { model: sol?.model, input: sol?.inputUsd, cacheWrite: sol?.cacheWriteUsd, cached: sol?.cachedInputUsd, output: sol?.outputUsd },
  terra: { model: terra?.model, input: terra?.inputUsd, cacheWrite: terra?.cacheWriteUsd, cached: terra?.cachedInputUsd, output: terra?.outputUsd },
  luna: { model: luna?.model, input: luna?.inputUsd, cacheWrite: luna?.cacheWriteUsd, cached: luna?.cachedInputUsd, output: luna?.outputUsd },
  solAlias: solAlias?.model,
  solBucketUsd: solBucketCost.usd,
  usedModelCostStatus: usedModelCost.status,
  modelEfforts: models.map((row) => ({ model: row.model, efforts: row.reasoningEfforts.map((effort) => effort.effort) })),
  tokenTotalHtml,
  costTotalHtml,
  usedModelsHtml,
  todayBilling,
  allTimeTotal: summarizeTokenWindow(allTimeRows).total,
  allTimeModel: summarizeModelUsageForDaily(allTimeRows)[0]?.model
});`,
  createAppContext(),
  { filename: appPath }
));

assert.deepEqual(uiResult.sol, { model: "GPT-5.6 Sol", input: 5, cacheWrite: 6.25, cached: 0.5, output: 30 });
assert.deepEqual(uiResult.terra, { model: "GPT-5.6 Terra", input: 2, cacheWrite: 2.5, cached: 0.2, output: 12 });
assert.deepEqual(uiResult.luna, { model: "GPT-5.6 Luna", input: 0.2, cacheWrite: 0.25, cached: 0.02, output: 1.2 });
assert.equal(uiResult.solAlias, "GPT-5.6 Sol");
assert.equal(uiResult.solBucketUsd, 41.75);
assert.equal(uiResult.usedModelCostStatus, "complete");
assert.deepEqual(uiResult.modelEfforts, [
  { model: "gpt-5.6-sol", efforts: ["xhigh", "max"] },
  { model: "gpt-5.6-terra", efforts: ["high"] }
]);
assert.match(uiResult.tokenTotalHtml, /Today · Tokens/u);
assert.match(uiResult.tokenTotalHtml, /1\.3\s*K/u);
assert.match(uiResult.costTotalHtml, /Today · Costs/u);
assert.doesNotMatch(uiResult.costTotalHtml, /Partial/u);
assert.match(uiResult.usedModelsHtml, />Reasoning Output</u);
assert.match(uiResult.usedModelsHtml, /XHigh 800/u);
assert.match(uiResult.usedModelsHtml, /Max 300/u);
assert.deepEqual(uiResult.todayBilling, {
  inputTokens: 300,
  cacheCreationInputTokens: 0,
  cachedInputTokens: 900,
  outputTokens: 130
});
assert.equal(uiResult.allTimeTotal, 1_098);
assert.equal(uiResult.allTimeModel, "gpt-5.6-sol");

const now = Date.parse("2026-08-15T12:00:00Z");
const aggregate = aggregateUsageEvents([
  {
    providerId: "codex",
    sourceId: "codex-home",
    timestampMs: now - 10_000,
    model: "gpt-5.6-sol",
    usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 6, total_tokens: 110 },
    evidence: { realpathHash: "one", line: 1 },
    metadata: { sourceGroupId: "codex", reasoningEffort: "max" }
  },
  {
    providerId: "codex",
    sourceId: "codex-home",
    timestampMs: now - 5_000,
    model: "gpt-5.6-sol",
    usage: { input_tokens: 200, cached_input_tokens: 160, output_tokens: 20, reasoning_output_tokens: 8, total_tokens: 220 },
    evidence: { realpathHash: "one", line: 2 },
    metadata: { sourceGroupId: "codex", reasoningEffort: "high" }
  }
], { now });

assert.deepEqual(
  aggregate.daily[0].sources[0].models[0].reasoningEfforts.map((row) => ({ effort: row.effort, totalTokens: row.totalTokens })),
  [
    { effort: "high", totalTokens: 220 },
    { effort: "max", totalTokens: 110 }
  ]
);
assert.deepEqual(
  aggregate.sources[0].models[0].reasoningEfforts.map((row) => ({ effort: row.effort, reasoningOutputTokens: row.reasoningOutputTokens })),
  [
    { effort: "high", reasoningOutputTokens: 8 },
    { effort: "max", reasoningOutputTokens: 6 }
  ]
);

console.log("GPT-5.6 usage cost tests passed");

function createAppContext() {
  const elements = new Map();
  function makeElement(id = "") {
    return {
      id,
      hidden: false,
      disabled: false,
      textContent: "",
      innerHTML: "",
      value: "",
      checked: false,
      dataset: {},
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      addEventListener() {},
      querySelectorAll() { return []; },
      querySelector() { return null; },
      closest() { return null; }
    };
  }
  const document = {
    documentElement: makeElement("html"),
    querySelector(selector) {
      if (selector === "main.app-shell") return makeElement("appShell");
      return null;
    },
    querySelectorAll() { return []; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    addEventListener() {}
  };
  return {
    document,
    window: { requestAnimationFrame(callback) { callback(); } },
    navigator: { language: "en-US", languages: ["en-US"] },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    Intl,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    JSON,
    RegExp,
    console
  };
}
