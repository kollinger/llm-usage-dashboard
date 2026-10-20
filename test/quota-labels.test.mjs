import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildDesktopWidgetSnapshot } = require("../lib/desktop-widget");
const { claudeQuotaLabelsFixture } = require("./fixtures/desktop-widget.cjs");
const source = await fs.readFile(new URL("../public/widget.js", import.meta.url), "utf8");
const qml = await fs.readFile(new URL("../plasma/contents/ui/AccountView.qml", import.meta.url), "utf8");
const body = (text, name, indent) => {
  const start = text.indexOf(`function ${name}(`);
  const end = text.indexOf(`\n${" ".repeat(indent)}}`, start);
  assert(start >= 0 && end > start, name);
  return text.slice(start, end + indent + 2);
};
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const now = Date.now();
const usage = claudeQuotaLabelsFixture(now);
const original = structuredClone(usage);
const snapshot = buildDesktopWidgetSnapshot(usage, now);
const account = snapshot.accounts[0], rows = account.windows;
assert.deepEqual(usage, original, "projection cannot mutate the original measurements");
assert.equal(rows.length, original.connectedAccounts[0].limits.rows.length);
assert.deepEqual(rows.map((row) => row.key), original.connectedAccounts[0].limits.rows.map((row) => row.key));
assert.deepEqual(rows.map((row) => row.remainingPercent), [0, 45, 100, 80, 61, 15, null, null, 0]);
assert.deepEqual(rows.map((row) => row.status), ["current", "current", "current", "current", "stale", "current", "unavailable", "unavailable", "stale"]);
assert.equal(new Set(rows.map((row) => row.resetsAt)).size, rows.length, "each row retains its own reset");
for (let i = 0; i < rows.length; i++) {
  const input = original.connectedAccounts[0].limits.rows[i];
  assert.equal(rows[i].resetsAt, input.resetsAt);
  assert.equal(rows[i].measuredAt, input.updatedAt || usage.generatedAt);
}
const placeholders = (text) => [...text.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
const locales = new URL("../public/i18n/", import.meta.url);
for (const file of (await fs.readdir(locales)).filter((file) => file.endsWith(".json"))) {
  const dictionary = JSON.parse(await fs.readFile(new URL(file, locales), "utf8"));
  assert.deepEqual(placeholders(dictionary.widget.scopedPeriod), ["period", "scope"], file);
  const t = (key, values = {}) => key.split(".").reduce((value, part) => value?.[part], dictionary)
    .replace(/\{([^}]+)\}/g, (_match, name) => String(values[name] ?? ""));
  const number = (value, maximumFractionDigits = 0) => new Intl.NumberFormat(file.slice(0, -5), { maximumFractionDigits }).format(value);
  const context = vm.createContext({ t, number, escape, date: (value) => value || t("widget.unavailable"), snapshot, failed: false });
  vm.runInContext(body(source, "windowLabel", 2) + "\n" + body(source, "renderWindow", 2), context);
  const plasmaLabel = vm.runInNewContext(`(${body(qml, "quotaLabel", 4)})`, { t, number });
  const labels = rows.map((row) => context.windowLabel(row, "claude"));
  assert.deepEqual(labels, rows.map((row) => plasmaLabel(row, "claude")), `${file}: renderer consistency`);
  assert.equal(labels[0], t("limits.fiveHour"));
  assert.equal(labels[1], t("widget.scopedPeriod", { scope: t("limits.allModels"), period: t("limits.weekly") }));
  assert.equal(labels[2], t("widget.scopedPeriod", { scope: t("limits.sonnetOnly"), period: t("limits.weekly") }));
  assert.equal(new Set(labels).size, rows.length, `${file}: equal durations retain distinct scopes`);
  assert.equal(context.windowLabel({ ...rows[1], key: "allModels" }, "claude"), labels[1]);
  assert.equal(plasmaLabel({ ...rows[1], key: "allModels" }, "claude"), labels[1]);
  assert.equal(context.windowLabel({ ...rows[7], key: "constructor" }, "claude"), labels[7]);
  assert.equal(plasmaLabel({ ...rows[7], key: "constructor" }, "claude"), labels[7]);
  assert.equal(context.windowLabel(rows[1], "gpt"), t("limits.weekly"), "other providers keep their period labels");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], html = context.renderWindow(row, "claude");
    assert(html.includes(`title="${escape(labels[i])}"`), `${file}: visible label`);
    assert(html.includes(escape(t("limits.resetPrefix", { time: row.resetsAt }))), `${file}: matching reset`);
    assert(html.includes(`data-status="${row.status}"`), `${file}: matching freshness`);
    if (row.remainingPercent === null) {
      assert(html.includes("—")); assert(!html.includes('role="meter"'), `${file}: missing never becomes 100%`);
    } else {
      assert(html.includes(`aria-valuenow="${row.remainingPercent}"`));
      assert(html.includes(escape(t("limits.freeLabel", { label: labels[i] }))));
    }
  }
  if (file === "en.json") {
    const plain = (text) => text.replace(/[\u2068\u2069]/g, "");
    assert.equal(plain(labels[1]), "All models · Week"); assert.equal(plain(labels[2]), "Sonnet only · Week");
    assert.equal(plain(labels[3]), "Fable · Week"); assert.equal(plain(labels[4]), "Fable Extended · Week");
    assert.equal(plain(labels[7]), "Limit · Week");
  }
}
console.log("Quota labels: real Electron/QML functions agree across 27 locales; 45/100%, multiple scopes, unknown/zero/missing/stale values, identities and resets remain separate.");
