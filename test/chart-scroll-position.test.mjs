import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appPath = path.join(rootDir, "public", "app.js");
const appSource = await readFile(appPath, "utf8");
const code = appSource.replace("\ninit();", "\n// init disabled for chart scroll position tests");
assert.notEqual(code, appSource, "chart scroll tests must disable app bootstrap");

const result = JSON.parse(vm.runInNewContext(
  `${code}
els.chart.clientWidth = 900;
state.language = "en";

const daily = makeDaily(40);
renderChart(daily);
const initial = chartSnapshot();

els.chart.scrollLeft = 0;
handleChartScroll();
const manualAway = chartSnapshot();

requestChartLatestForViewChange();
state.chartBreakdownMode = "provider";
renderChart(daily);
const preservedManual = chartSnapshot();

els.chart.scrollLeft = chartMaxScrollLeft();
handleChartScroll();
requestChartLatestForViewChange();
state.chartBreakdownMode = "model";
renderChart(makeDaily(41));
const endPinnedRefresh = chartSnapshot();

requestChartLatestForRangeChange();
els.chart.scrollLeft = 0;
renderChart(daily);
const rangeReset = chartSnapshot();

const totalProviderEntries = chartTokenSegmentEntries([daily[0]], "total");
const totalProviderSegments = chartSegmentsForDay(daily[0], totalProviderEntries).map((segment) => ({
  id: segment.id,
  sourceId: segment.sourceId,
  color: chartSegmentColor(segment),
  totalTokens: segment.totalTokens
}));
const localOnlyEntries = chartTokenSegmentEntries([{ date: "2026-07-01", totalTokens: 1234 }], "total");
const localOnlySegments = chartSegmentsForDay({ date: "2026-07-01", totalTokens: 1234 }, localOnlyEntries).map((segment) => ({
  id: segment.id,
  type: segment.type,
  color: chartSegmentColor(segment),
  totalTokens: segment.totalTokens
}));

const pageScrollCalls = [];
window.scrollX = 12;
window.pageXOffset = 12;
window.scrollY = 760;
window.pageYOffset = 760;
window.scrollTo = (left, top) => {
  pageScrollCalls.push({ left, top });
  window.scrollX = left;
  window.pageXOffset = left;
  window.scrollY = top;
  window.pageYOffset = top;
};
preservePageScrollDuring(() => {
  window.scrollY = 0;
  window.pageYOffset = 0;
});
const preservedPageScroll = {
  scrollX: window.scrollX,
  scrollY: window.scrollY,
  calls: pageScrollCalls
};

JSON.stringify({
  initial,
  manualAway,
  preservedManual,
  endPinnedRefresh,
  rangeReset,
  totalProviderSegments,
  localOnlySegments,
  codexColor: chartSourceColor("codex"),
  claudeCodeColor: chartSourceColor("claudeCode"),
  totalFallbackColor: "#5f6f68",
  preservedPageScroll
});

function chartSnapshot() {
  return {
    scrollLeft: els.chart.scrollLeft,
    maxScrollLeft: chartMaxScrollLeft(),
    userScrolledAway: state.chartUserScrolledAwayFromLatest,
    scrollToLatest: state.chartScrollToLatest,
    rendered: state.chartRendered
  };
}

function makeDaily(count) {
  const start = Date.UTC(2026, 5, 1);
  return Array.from({ length: count }, (_value, index) => {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    const codexTokens = 10_000 + index * 300;
    const claudeTokens = 8_000 + index * 200;
    return {
      date,
      totalTokens: codexTokens + claudeTokens,
      sources: [
        {
          id: "codex",
          totalTokens: codexTokens,
          models: [{ model: "GPT-5.3-Codex", totalTokens: codexTokens }]
        },
        {
          id: "claudeCode",
          totalTokens: claudeTokens,
          models: [{ model: "Claude Sonnet 4.6", totalTokens: claudeTokens }]
        }
      ]
    };
  });
}`,
  createAppContext(),
  { filename: appPath }
));

assert.equal(result.initial.rendered, true);
assert.ok(result.initial.maxScrollLeft > 0);
assert.equal(result.initial.scrollLeft, result.initial.maxScrollLeft);
assert.equal(result.initial.userScrolledAway, false);
assert.equal(result.initial.scrollToLatest, false);

assert.equal(result.manualAway.scrollLeft, 0);
assert.equal(result.manualAway.userScrolledAway, true);

assert.equal(result.preservedManual.scrollLeft, 0);
assert.equal(result.preservedManual.userScrolledAway, true);
assert.equal(result.preservedManual.scrollToLatest, false);

assert.ok(result.endPinnedRefresh.maxScrollLeft > result.initial.maxScrollLeft);
assert.equal(result.endPinnedRefresh.scrollLeft, result.endPinnedRefresh.maxScrollLeft);
assert.equal(result.endPinnedRefresh.userScrolledAway, false);

assert.equal(result.rangeReset.scrollLeft, result.rangeReset.maxScrollLeft);
assert.equal(result.rangeReset.userScrolledAway, false);

assert.deepEqual(result.totalProviderSegments.map((segment) => segment.sourceId), ["codex", "claudeCode"]);
assert.deepEqual(
  result.totalProviderSegments.map((segment) => segment.color),
  [result.codexColor, result.claudeCodeColor]
);
assert.deepEqual(
  result.totalProviderSegments.map((segment) => segment.totalTokens),
  [10_000, 8_000]
);
assert.deepEqual(result.localOnlySegments, [
  {
    id: "total",
    type: "total",
    color: result.totalFallbackColor,
    totalTokens: 1234
  }
]);

assert.equal(result.preservedPageScroll.scrollX, 12);
assert.equal(result.preservedPageScroll.scrollY, 760);
assert.deepEqual(result.preservedPageScroll.calls, [
  { left: 12, top: 760 },
  { left: 12, top: 760 }
]);

function createAppContext() {
  const elements = new Map();
  function makeElement(id = "") {
    let html = "";
    const element = {
      id,
      hidden: false,
      disabled: false,
      textContent: "",
      value: "",
      checked: false,
      scrollLeft: 0,
      scrollWidth: 900,
      clientWidth: 900,
      dataset: {},
      style: {},
      classList: {
        add() {},
        remove() {},
        toggle() {},
        contains() {
          return false;
        }
      },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      closest() {
        return null;
      },
      cloneNode() {
        return makeElement(`${id}-clone`);
      },
      getBoundingClientRect() {
        return { width: this.clientWidth, height: 300, top: 0, left: 0 };
      },
      appendChild() {},
      remove() {},
      focus() {},
      showModal() {},
      close() {}
    };
    Object.defineProperty(element, "innerHTML", {
      get() {
        return html;
      },
      set(value) {
        html = String(value || "");
        const widthMatch = html.match(/chart-canvas" style="width: ([\d.]+)px/u);
        if (widthMatch) {
          element.scrollWidth = Number(widthMatch[1]);
        } else if (id === "chart") {
          element.scrollWidth = element.clientWidth;
          element.scrollLeft = 0;
        }
      }
    });
    return element;
  }
  function getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  }
  const document = {
    hidden: false,
    documentElement: makeElement("html"),
    body: makeElement("body"),
    getElementById,
    querySelector(selector) {
      if (selector === "main.app-shell") return getElementById("appShell");
      return makeElement(selector);
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    createElement(tag) {
      return makeElement(tag);
    }
  };
  return {
    console,
    document,
    navigator: { language: "en-US", languages: ["en-US"], platform: "Linux x86_64" },
    window: { lucide: null, requestAnimationFrame: (fn) => fn(), Notification: undefined, focus() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout,
    clearTimeout,
    setInterval() {
      return 0;
    },
    clearInterval() {},
    URLSearchParams,
    Intl,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    Map,
    Set,
    RegExp,
    Error
  };
}
