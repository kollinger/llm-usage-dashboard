import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appPath = path.join(rootDir, "public", "app.js");
const appSource = await readFile(appPath, "utf8");
const code = appSource.replace("\ninit();", "\n// init disabled for chart window insight tests");
assert.notEqual(code, appSource, "chart window insight tests must disable app bootstrap");

const result = JSON.parse(vm.runInNewContext(
  `${code}
const summary = summarizeTokenWindow([
  { date: "2026-07-01", totalTokens: 1000 },
  { date: "2026-07-03", totalTokens: 0 },
  { date: "2026-07-05", totalTokens: 500 }
]);
const empty = summarizeTokenWindow([
  { date: "2026-07-04", totalTokens: 0 }
]);
const breakdownDaily = [
  {
    date: "2026-07-06",
    totalTokens: 875,
    sources: [
      {
        id: "codex",
        totalTokens: 300,
        models: [{ model: "GPT-5.3-Codex", inputTokens: 120, outputTokens: 180, totalTokens: 300 }]
      },
      {
        id: "claudeCode",
        totalTokens: 450,
        models: [{ model: "Claude Sonnet 4.6", inputTokens: 210, cachedInputTokens: 40, outputTokens: 200, totalTokens: 450 }]
      },
      {
        id: "glm",
        totalTokens: 75,
        models: [{ model: "glm-5.2", inputTokens: 50, outputTokens: 25, totalTokens: 75 }]
      },
      {
        id: "copilot",
        totalTokens: 50,
        models: [{ model: "GPT-4.1-Copilot", inputTokens: 20, outputTokens: 30, totalTokens: 50 }]
      }
    ]
  },
  {
    date: "2026-07-07",
    totalTokens: 125,
    sources: [
      {
        id: "codex",
        totalTokens: 125,
        models: [{ model: "GPT-5.3-Codex", inputTokens: 40, outputTokens: 85, totalTokens: 125 }]
      }
    ]
  }
];
const providerRows = summarizeProviderUsageForDaily(breakdownDaily).map((row) => ({
  sourceId: row.sourceId,
  totalTokens: row.totalTokens,
  share: Math.round(row.share * 10) / 10,
  topModel: row.topModel
}));
const modelRows = summarizeModelUsageForDaily(breakdownDaily).map((row) => ({
  sourceId: row.sourceId,
  model: row.model,
  totalTokens: row.totalTokens
}));
const localOnlyModelRows = summarizeModelUsageForDaily([
  { date: "2026-07-08", totalTokens: 90 }
]).map((row) => ({
  sourceId: row.sourceId,
  model: row.model,
  totalTokens: row.totalTokens
}));
const providerSummaryHtml = renderChartWindowInsights(breakdownDaily, "tokens", "provider");
const modelSummaryHtml = renderChartWindowInsights(breakdownDaily, "tokens", "model");
const totalToolbarHtml = renderTokenBreakdownSummary(breakdownDaily, "total");
const costSummaryHtml = renderChartWindowInsights(breakdownDaily, "costs", "model");
JSON.stringify({
  total: summary.total,
  activeDays: summary.activeDays,
  calendarDays: summary.calendarDays,
  averageActiveDay: summary.averageActiveDay,
  averageCalendarDay: summary.averageCalendarDay,
  peakDate: summary.peakDate,
  peakValue: summary.peakValue,
  hasActivity: summary.hasActivity,
  emptyHasActivity: empty.hasActivity,
  sameDaySpan: calendarDaySpan("2026-07-05", "2026-07-05"),
  invalidSpan: calendarDaySpan("bad", "2026-07-05"),
  providerRows,
  modelRows,
  localOnlyModelRows,
  providerSummaryHasProviderTable: providerSummaryHtml.includes("provider-window-table"),
  modelSummaryHasModelTable: modelSummaryHtml.includes("model-window-table"),
  modelSummaryHasProviderTable: modelSummaryHtml.includes("provider-window-table"),
  totalToolbarHasTopProvider: totalToolbarHtml.includes("chart.breakdownSummary.topProvider"),
  costSummaryHasBreakdownTable: costSummaryHtml.includes("model-window-summary")
});`,
  createAppContext(),
  { filename: appPath }
));

assert.equal(result.total, 1500);
assert.equal(result.activeDays, 2);
assert.equal(result.calendarDays, 5);
assert.equal(result.averageActiveDay, 750);
assert.equal(result.averageCalendarDay, 300);
assert.equal(result.peakDate, "2026-07-01");
assert.equal(result.peakValue, 1000);
assert.equal(result.hasActivity, true);
assert.equal(result.emptyHasActivity, false);
assert.equal(result.sameDaySpan, 1);
assert.equal(result.invalidSpan, 0);
assert.deepEqual(result.providerRows, [
  {
    sourceId: "claudeCode",
    totalTokens: 450,
    share: 45,
    topModel: { model: "Claude Sonnet 4.6", totalTokens: 450 }
  },
  {
    sourceId: "codex",
    totalTokens: 425,
    share: 42.5,
    topModel: { model: "GPT-5.3-Codex", totalTokens: 425 }
  },
  {
    sourceId: "glm",
    totalTokens: 75,
    share: 7.5,
    topModel: { model: "glm-5.2", totalTokens: 75 }
  },
  {
    sourceId: "copilot",
    totalTokens: 50,
    share: 5,
    topModel: { model: "GPT-4.1-Copilot", totalTokens: 50 }
  }
]);
assert.deepEqual(result.modelRows, [
  { sourceId: "claudeCode", model: "Claude Sonnet 4.6", totalTokens: 450 },
  { sourceId: "codex", model: "GPT-5.3-Codex", totalTokens: 425 },
  { sourceId: "glm", model: "glm-5.2", totalTokens: 75 },
  { sourceId: "copilot", model: "GPT-4.1-Copilot", totalTokens: 50 }
]);
assert.deepEqual(result.localOnlyModelRows, [
  { sourceId: "local", model: "chart.models.unknown", totalTokens: 90 }
]);
assert.equal(result.providerSummaryHasProviderTable, true);
assert.equal(result.modelSummaryHasModelTable, true);
assert.equal(result.modelSummaryHasProviderTable, false);
assert.equal(result.totalToolbarHasTopProvider, true);
assert.equal(result.costSummaryHasBreakdownTable, false);

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
    querySelectorAll() {
      return [];
    },
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
