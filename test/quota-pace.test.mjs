import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { assessQuotaPace, mergeQuotaPaceSamples } = require("../lib/quota-pace.js");
const now = Date.parse("2026-10-01T12:00:00.000Z");
const reset = new Date(now + 10 * 60 * 60_000).toISOString();

function event(usedPercent, minutesAgo, resetsAt = reset, windowMinutes = 10080) {
  return {
    type: "quota_window",
    provider: "codex",
    windowKey: "weekly",
    windowMinutes,
    usedPercent,
    capturedAt: new Date(now - minutesAgo * 60_000).toISOString(),
    resetsAt
  };
}

function status(before, after, minutes = 120) {
  const samples = mergeQuotaPaceSamples([], [event(before, minutes), event(after, 0)], now);
  return assessQuotaPace(samples, now).codex.weekly[minutes];
}

assert.equal(status(30, 50).status, "risk");
assert.equal(status(9, 10).status, "safe");
assert.equal(status(88, 90).status, "possible");
assert.equal(status(10, 10).status, "flat");
assert.equal(status(30, 20).status, "changed");
assert.equal(status(30, 50, 30).status, "risk");

const wrongReset = mergeQuotaPaceSamples([], [event(30, 120, new Date(now + 8 * 60 * 60_000).toISOString()), event(50, 0)], now);
assert.equal(assessQuotaPace(wrongReset, now).codex.weekly[120].status, "collecting");

const sameResetWithClockJitter = mergeQuotaPaceSamples([], [event(30, 120, new Date(Date.parse(reset) - 30_000).toISOString()), event(50, 0)], now);
assert.equal(assessQuotaPace(sameResetWithClockJitter, now).codex.weekly[120].status, "risk");

const shortRefreshDelay = mergeQuotaPaceSamples([], [event(30, 126), event(50, 6)], now);
assert.equal(assessQuotaPace(shortRefreshDelay, now).codex.weekly[120].status, "risk");

const delayedShortWindow = mergeQuotaPaceSamples([], [event(30, 38), event(50, 8)], now);
assert.equal(assessQuotaPace(delayedShortWindow, now).codex.weekly[30].status, "risk");

const staleLongWindow = mergeQuotaPaceSamples([], [event(30, 136), event(50, 16)], now);
assert.equal(assessQuotaPace(staleLongWindow, now).codex.weekly[120].status, "stale");
assert.equal(assessQuotaPace(staleLongWindow, now).codex.weekly[30].status, "stale");

// Reproduce an old baseline leaving the tolerance while new readings accumulate.
const beforeBoundary = mergeQuotaPaceSamples([], [event(30, 35), event(40, 6), event(42, 0)], now);
assert.equal(assessQuotaPace(beforeBoundary, now).codex.weekly[30].status, "risk");
const afterBoundary = mergeQuotaPaceSamples([], [event(30, 38), event(40, 9), event(42, 3), event(43, 0)], now);
const afterBoundaryPace = assessQuotaPace(afterBoundary, now).codex.weekly;
assert.equal(afterBoundaryPace[30].status, "risk");
assert.equal(afterBoundaryPace[30].observedMinutes, 9);
assert.equal(afterBoundaryPace[30].deltaPercent, 3);

// Longer views can use the same available, shorter span without inventing history.
for (const minutes of [60, 120, 300]) {
  assert.notEqual(afterBoundaryPace[minutes].status, "collecting");
  assert.equal(afterBoundaryPace[minutes].observedMinutes, 38);
}
const onlyHourlyBaseline = mergeQuotaPaceSamples([], [event(30, 60), event(40, 0)], now);
assert.equal(assessQuotaPace(onlyHourlyBaseline, now).codex.weekly[60].status, "risk");
assert.equal(assessQuotaPace(onlyHourlyBaseline, now).codex.weekly[30].status, "collecting");
const tooBrief = mergeQuotaPaceSamples([], [event(30, 4), event(40, 0)], now);
assert.equal(assessQuotaPace(tooBrief, now).codex.weekly[30].status, "collecting");
const flatPartialWindow = mergeQuotaPaceSamples([], [event(40, 12), event(40, 0)], now);
assert.equal(assessQuotaPace(flatPartialWindow, now).codex.weekly[30].status, "flat");
assert.equal(assessQuotaPace(flatPartialWindow, now).codex.weekly[30].observedMinutes, 12);
const changedPartialWindow = mergeQuotaPaceSamples([], [event(40, 12), event(30, 0)], now);
assert.equal(assessQuotaPace(changedPartialWindow, now).codex.weekly[30].status, "changed");

// The selected 2h view must disclose that only 12 minutes were measured.
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const messages = JSON.parse(readFileSync(new URL("../public/i18n/de.json", import.meta.url), "utf8"));
const ui = vm.createContext({
  state: { language: "de", quotaPaceWindowMinutesByCard: {}, usage: { quotaPace: assessQuotaPace(flatPartialWindow, now) } },
  isWeeklyLimit: () => true,
  escapeHtml: (text) => text,
  t: (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value),
    key.split(".").reduce((value, name) => value[name], messages))
});
vm.runInContext(appSource.slice(appSource.indexOf("function renderQuotaPaceCard("), appSource.indexOf("function renderUsageProjectionModeToggle(")) +
  appSource.slice(appSource.indexOf("function formatDurationCompact("), appSource.indexOf("function limitStatusAccent(")), ui);
const card = vm.runInContext('renderQuotaPaceCard({ id: "codex" }, { key: "weekly", label: "Woche" })', ui);
assert.match(card, /\+0 Prozentpunkte in 12 Min\./);
assert.match(card, /aria-pressed="true">2 h<\/button>/);

assert.equal(mergeQuotaPaceSamples([], [event(20, 0, reset, 300)], now).length, 0);
console.log("quota pace scenarios passed");
