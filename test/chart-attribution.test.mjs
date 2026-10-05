import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appPath = path.join(rootDir, "public", "app.js");
const source = await readFile(appPath, "utf8");
const code = source.replace("\ninit();", "\n// bootstrap disabled for attribution tests");
assert.notEqual(code, source);
const result = JSON.parse(vm.runInNewContext(`${code}
state.translations = ${await readFile(path.join(rootDir, "public/i18n/en.json"), "utf8")};
const device = { id: "fixture-laptop", label: "Laptop", quality: "observed", totalTokens: 120 };
const shared = { id: "shared", label: null, quality: "ambiguous", totalTokens: 80,
  observedOn: [{ id: "fixture-laptop", label: "Laptop" }, { id: "fixture-desktop", label: "Desktop" }] };
const account = { id: "gpt:fixture", label: "Work <account>", quality: "recorded", totalTokens: 120, devices: [device] };
const days = [
  { date: "2026-10-04", totalTokens: 200, attribution: { devices: [device, shared], accounts: [account, { id: "unknown", label: null, quality: "unknown", totalTokens: 80, devices: [shared] }] } },
  { date: "2026-10-05", totalTokens: 100 }
];
const deviceEntries = chartAttributionEntries(days, "device");
const accountEntries = chartAttributionEntries(days, "account");
state.chartBreakdownMode = "account";
const tooltip = chartHistoryDetail(days[0]);
const slotHtml = renderHistorySlotTimeline({ rows: [{ ...days[0], slotStart: "2026-10-04T12:00:00.000Z" }], max: 200, axisY: 240, chartHeight: 200, xForRow: () => 20, valueForRow: row => row.totalTokens, valueFormatter: formatTokens });
const fallback = buildFallbackHistorySlots([{ ...days[0], date: new Date().toISOString().slice(0, 10) }], "today");
const paletteDevices = ["fixture-d", "fixture-b", "fixture-c", "fixture-a"].map((id) => ({ id, label: id, quality: "observed", totalTokens: 25 }));
const paletteAccounts = paletteDevices.map((row) => ({ ...row, id: "gpt:" + row.id, quality: "recorded" }));
const paletteDay = { totalTokens: 100, attribution: { devices: paletteDevices, accounts: paletteAccounts } };
state.usage = { deviceSync: { deviceId: "fixture-d", devices: paletteDevices }, local: { daily: [paletteDay], attribution: paletteDay.attribution } };
const paletteColors = Object.fromEntries(chartAttributionEntries([paletteDay], "device").map((row) => [row.attributionId, row.color]));
const accountColors = Object.fromEntries(chartAttributionEntries([paletteDay], "account").map((row) => [row.attributionId, row.color]));
const subsetColors = Object.fromEntries(chartAttributionEntries([{ totalTokens: 25, attribution: { devices: [paletteDevices[0]] } }], "device").map((row) => [row.attributionId, row.color]));
const accountSubsetColors = Object.fromEntries(chartAttributionEntries([{ totalTokens: 25, attribution: { accounts: [paletteAccounts[0]] } }], "account").map((row) => [row.attributionId, row.color]));
state.usage = JSON.parse(JSON.stringify(state.usage));
state.usage.deviceSync.devices.reverse();
state.usage.local.attribution.devices.reverse();
const refreshedColors = Object.fromEntries(chartAttributionEntries([{ ...paletteDay, attribution: { ...paletteDay.attribution, devices: paletteDevices.map((row) => ({ ...row, label: "Renamed" })) } }], "device").map((row) => [row.attributionId, row.color]));
JSON.stringify({
  deviceEntries, accountEntries, paletteColors, accountColors, subsetColors, accountSubsetColors, refreshedColors,
  specialColors: [chartAttributionColor({ id: "unknown" }, "device"), chartAttributionColor({ id: "shared" }, "device")],
  perDay: days.map(day => chartSegmentsForDay(day, accountEntries).reduce((sum, row) => sum + row.totalTokens, 0)),
  absent: chartAttributionRows({ totalTokens: 45 }, "account"),
  overflow: chartAttributionRows({ totalTokens: 100, attribution: { devices: [device] } }, "device"),
  partial: chartAttributionRows({ totalTokens: 200, attribution: { accounts: [{ id: "unknown", quality: "unknown", totalTokens: 50 }] } }, "account"),
  conflict: chartAttributionLabel({ id: "unknown", quality: "conflict", label: "Must not be used" }, "account"),
  stableColor: chartAttributionColor(device, "device") === chartAttributionColor({ ...device, label: "Renamed" }, "device"),
  summary: renderAttributionWindowSummary(days, "account"),
  selector: renderChartBreakdownToggle(), tooltip, slotHtml,
  costTooltip: chartHistoryDetail(days[0], "costs"),
  fallbackTotal: fallback.reduce((sum, row) => sum + row.totalTokens, 0),
  fallbackKnown: chartAttributionEntries(fallback, "account").filter(row => row.attributionId !== "unknown")
});`, createAppContext(), { filename: appPath }));

assert.equal(result.deviceEntries.reduce((sum, row) => sum + row.totalTokens, 0), 300);
assert.equal(result.accountEntries.reduce((sum, row) => sum + row.totalTokens, 0), 300);
assert.deepEqual(result.perDay, [200, 100]);
assert.equal(result.deviceEntries.find(row => row.attributionId === "shared").totalTokens, 80, "copied observations must count once");
assert.match(result.deviceEntries.find(row => row.attributionId === "shared").detail, /Laptop.*Desktop/);
assert.equal(result.accountEntries.find(row => row.attributionId === "unknown").totalTokens, 180);
assert.match(result.accountEntries.find(row => row.attributionId === "unknown").detail, /Unknown installation: 100/);
assert.match(result.accountEntries.find(row => row.attributionId === "gpt:fixture").detail, /Laptop: 120/);
assert.deepEqual(result.absent, [{ id: "unknown", quality: "unknown", label: null, totalTokens: 45 }]);
assert.deepEqual(result.overflow, [{ id: "unknown", quality: "unknown", label: null, totalTokens: 100 }]);
assert.equal(result.partial.length, 1);
assert.equal(result.partial[0].totalTokens, 200);
assert.equal(result.conflict, "Unknown account");
assert.equal(result.stableColor, true);
assert.equal(new Set(Object.values(result.paletteColors)).size, 4, "four known installations must have distinct colors");
assert.equal(new Set(Object.values(result.accountColors)).size, 4, "four known accounts must have distinct colors");
assert.equal(result.subsetColors["fixture-d"], result.paletteColors["fixture-d"], "filtering other installations must not change a color");
assert.equal(result.accountSubsetColors["gpt:fixture-d"], result.accountColors["gpt:fixture-d"], "date filters must retain the all-time account colors");
assert.deepEqual(result.refreshedColors, result.paletteColors, "refresh, input order and labels must not change colors");
assert.deepEqual(result.specialColors, ["#89918c", "#b07a34"]);
for (const color of Object.values(result.paletteColors)) {
  const channels = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  assert.ok(1.05 / (luminance + .05) >= 3, `${color} must contrast with the light plot background`);
}
assert.match(result.summary, /Work &lt;account&gt;/);
assert.doesNotMatch(result.summary, /Work <account>/);
assert.match(result.summary, /Laptop: 120/);
assert.match(result.tooltip, /Work <account>: 120.*Laptop: 120/);
assert.match(result.slotHtml, /data-history-detail=/);
assert.match(result.slotHtml, /Work &lt;account&gt;/);
assert.equal(result.costTooltip, "");
assert.ok(Math.abs(result.fallbackTotal - 200) < 0.001);
assert.deepEqual(result.fallbackKnown, [], "daily fallback must not invent measured slot attribution");
assert.equal((result.selector.match(/<option /g) || []).length, 5);
assert.match(result.selector, /value="account" selected/);

const locales = await readdir(path.join(rootDir, "public/i18n"));
for (const name of locales.filter(name => name.endsWith(".json"))) {
  const locale = JSON.parse(await readFile(path.join(rootDir, "public/i18n", name), "utf8"));
  for (const key of ["device", "account"]) assert.ok(locale.chart.breakdown[key], `${name}: ${key}`);
  for (const key of ["groupBy", "unknownAccount", "unknownDevice", "sharedDevice", "sharedDeviceHelp", "observed", "observedOn", "evidence", "observedHelp", "accountHelp"]) {
    assert.ok(locale.chart.attribution[key], `${name}: ${key}`);
    assert.doesNotMatch(locale.chart.attribution[key], /\{[^}]+\}/, `${name}: unexpected placeholder`);
  }
}

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
