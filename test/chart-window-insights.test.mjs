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
  invalidSpan: calendarDaySpan("bad", "2026-07-05")
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
