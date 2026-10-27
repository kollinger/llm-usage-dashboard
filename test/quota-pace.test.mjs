import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { assessQuotaPace, gptAccountQuotaPaceEvents, mergeQuotaPaceSamples, readCodexAccountQuotaPaceTail } = require("../lib/quota-pace.js");
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
  Date: class extends Date { static now() { return now; } },
  state: { language: "de", quotaPaceWindowMinutesByCard: {}, usage: { quotaPace: assessQuotaPace(flatPartialWindow, now) } },
  isWeeklyLimit: () => true,
  escapeHtml: (text) => text,
  formatDateTime: (value) => value,
  formatPacePercent: (value) => Math.round(value),
  t: (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value),
    key.split(".").reduce((value, name) => value[name], messages))
});
vm.runInContext(appSource.slice(appSource.indexOf("function renderQuotaPaceCard("), appSource.indexOf("function renderUsageProjectionModeToggle(")) +
  appSource.slice(appSource.indexOf("function formatDurationCompact("), appSource.indexOf("function limitStatusAccent(")), ui);
const card = vm.runInContext('renderQuotaPaceCard({ id: "codex" }, { key: "weekly", label: "Woche" })', ui);
assert.match(card, /\+0 Prozentpunkte in 12 Min\./);
assert.match(card, /aria-pressed="true">2 h<\/button>/);

for (const hours of [1, 2, 5]) {
  ui.state.usage.quotaPace.codex.weekly[120].observedMinutes = hours * 60;
  const wholeHourCard = vm.runInContext('renderQuotaPaceCard({ id: "codex" }, { key: "weekly", label: "Woche" })', ui);
  assert.match(wholeHourCard, new RegExp(`in ${hours} Std\\.`));
  assert.doesNotMatch(wholeHourCard, /0 Min\./);
}
ui.state.usage.quotaPace.codex.weekly[120].observedMinutes = 90;
const mixedHourCard = vm.runInContext('renderQuotaPaceCard({ id: "codex" }, { key: "weekly", label: "Woche" })', ui);
assert.match(mixedHourCard, /in 1 Std\. 30 Min\./);

// A rounded 3-point rise in 5h still has a useful central estimate, even
// when its rounding interval straddles the planned reset.
const screenshotReset = new Date(now + 131 * 60 * 60_000).toISOString();
const screenshotSamples = mergeQuotaPaceSamples([], [event(20, 300, screenshotReset), event(23, 0, screenshotReset)], now);
const screenshotPace = assessQuotaPace(screenshotSamples, now).codex.weekly[300];
assert.equal(screenshotPace.status, "possible");
assert.equal(Date.parse(screenshotPace.hitAt) - now, 77 / 3 * 300 * 60_000);
ui.state.quotaPaceWindowMinutesByCard["codex:weekly"] = 300;
ui.state.usage.quotaPace.codex.weekly[300] = screenshotPace;
const screenshotCard = vm.runInContext('renderQuotaPaceCard({ id: "codex" }, { key: "weekly", label: "Woche", usedPercent: 23 })', ui);
assert.match(screenshotCard, /\+3 Prozentpunkte in 5 Std\./);
assert.match(screenshotCard, /Geschätzte Zeit bis zum Limit: 5 T 8 Std\./);
assert.doesNotMatch(screenshotCard, /zu ungenau/);

for (const positiveStatus of ["risk", "safe"]) {
  ui.state.usage.quotaPace.codex.weekly[300] = { ...screenshotPace, status: positiveStatus };
  const estimatedCard = vm.runInContext('renderQuotaPaceCard({ id: "codex" }, { key: "weekly", label: "Woche", usedPercent: 23 })', ui);
  assert.match(estimatedCard, /Geschätzte Zeit bis zum Limit:/);
}
for (const unavailableStatus of ["flat", "stale", "changed", "collecting"]) {
  ui.state.usage.quotaPace.codex.weekly[300] = { ...screenshotPace, status: unavailableStatus };
  const unavailableCard = vm.runInContext('renderQuotaPaceCard({ id: "codex" }, { key: "weekly", label: "Woche", usedPercent: 23 })', ui);
  assert.doesNotMatch(unavailableCard, /Geschätzte Zeit bis zum Limit:/);
}

assert.equal(mergeQuotaPaceSamples([], [event(20, 0, reset, 300)], now).length, 0);

// Canonical account cards must retain the pace controls without borrowing
// the old provider-wide history, even when that history has a projection.
const accountCard = { id: "gpt-0123456789abcdef", accountId: "gpt-0123456789abcdef", providerId: "codex" };
ui.accountCard = accountCard;
const accountCollecting = vm.runInContext('renderQuotaPaceCard(accountCard, { key: "weekly", label: "Woche", usedPercent: 23 })', ui);
assert.match(accountCollecting, /Letztes Tempo/);
assert.match(accountCollecting, /Für diesen Zeitraum fehlen noch Messpunkte/);
assert.doesNotMatch(accountCollecting, /Geschätzte Zeit bis zum Limit:/);
assert.match(accountCollecting, /data-quota-pace-card="gpt-0123456789abcdef:weekly"/);

const otherAccount = "gpt-fedcba9876543210";
function accountSnapshot(id, usedPercent, at = now) {
  return { id, identityQuality: "account_id", active: true, sources: [{ id: "codex", active: true, quotaStatus: "ready",
    limitsUpdatedAt: new Date(at).toISOString(), limits: { rows: [{ key: "weekly", usedPercent, resetsAt: reset }] } }] };
}
const beforeAt = now - 120 * 60_000;
const accountEvents = [
  ...gptAccountQuotaPaceEvents({ accounts: [accountSnapshot(accountCard.id, 30, beforeAt), accountSnapshot(otherAccount, 9, beforeAt)] }, beforeAt),
  ...gptAccountQuotaPaceEvents({ accounts: [accountSnapshot(accountCard.id, 50), accountSnapshot(otherAccount, 10)] }, now)
];
const accountSamples = mergeQuotaPaceSamples([], [...accountEvents, event(80, 120), event(81, 0)], now);
const accountPace = assessQuotaPace(accountSamples, now);
assert.equal(accountPace[accountCard.id].weekly[120].status, "risk");
assert.equal(accountPace[accountCard.id].weekly[120].deltaPercent, 20);
assert.equal(accountPace[otherAccount].weekly[120].status, "safe");
assert.equal(accountPace[otherAccount].weekly[120].deltaPercent, 1);
assert.equal(accountPace.codex.weekly[120].deltaPercent, 1, "legacy source history remains separate");
assert.equal(mergeQuotaPaceSamples(accountSamples, accountEvents, now).length, accountSamples.length, "repeated scans cannot duplicate measurements");
assert.deepEqual(assessQuotaPace(JSON.parse(JSON.stringify(accountSamples)), now), accountPace, "persisted samples retain account separation");

ui.state.usage.quotaPace = accountPace;
const accountMeasured = vm.runInContext('renderQuotaPaceCard(accountCard, { key: "weekly", label: "Woche", usedPercent: 50 })', ui);
assert.match(accountMeasured, /\+20 Prozentpunkte in 2 Std\./);
assert.match(accountMeasured, /Geschätzte Zeit bis zum Limit:/);
const accountStale = vm.runInContext('renderQuotaPaceCard(accountCard, { key: "weekly", label: "Woche", usedPercent: 50, status: "stale" })', ui);
assert.match(accountStale, /Der letzte Quotenwert ist zu alt/);
assert.doesNotMatch(accountStale, /Geschätzte Zeit bis zum Limit:/);
const accountUnavailable = vm.runInContext('renderQuotaPaceCard(accountCard, { key: "weekly", label: "Woche", status: "unavailable" })', ui);
assert.match(accountUnavailable, /Für diesen Zeitraum fehlen noch Messpunkte/);
assert.doesNotMatch(accountUnavailable, /Geschätzte Zeit bis zum Limit:/);
ui.state.quotaPaceWindowMinutesByCard[`${accountCard.id}:weekly`] = 30;
const shortAccountWindow = vm.runInContext('renderQuotaPaceCard(accountCard, { key: "weekly", label: "Woche", usedPercent: 50 })', ui);
assert.match(shortAccountWindow, /aria-pressed="true">30 min<\/button>/);
assert.match(shortAccountWindow, /Für diesen Zeitraum fehlen noch Messpunkte/);

for (const invalid of [
  { ...accountSnapshot(accountCard.id, 50), active: false },
  { ...accountSnapshot(accountCard.id, 50), identityQuality: "email" },
  accountSnapshot("invalid-id", 50),
  accountSnapshot(accountCard.id, 50, now - 16 * 60_000),
  accountSnapshot(accountCard.id, 50, now + 2 * 60_000)
]) assert.deepEqual(gptAccountQuotaPaceEvents({ accounts: [invalid] }, now), []);
for (const sourcePatch of [{ active: false }, { quotaStatus: "unavailable" }, { limitsUpdatedAt: null }]) {
  const invalid = accountSnapshot(accountCard.id, 50);
  Object.assign(invalid.sources[0], sourcePatch);
  assert.deepEqual(gptAccountQuotaPaceEvents({ accounts: [invalid] }, now), []);
}
for (const rowPatch of [{ usedPercent: null }, { updatedAt: null }, { resetsAt: null }, { resetsAt: new Date(now - 1).toISOString() }]) {
  const invalid = accountSnapshot(accountCard.id, 50);
  Object.assign(invalid.sources[0].limits.rows[0], rowPatch);
  assert.deepEqual(gptAccountQuotaPaceEvents({ accounts: [invalid] }, now), []);
}
const remainingOnly = accountSnapshot(accountCard.id, null);
remainingOnly.sources[0].limits.rows[0].remainingPercent = 100;
assert.equal(gptAccountQuotaPaceEvents({ accounts: [remainingOnly] }, now)[0].usedPercent, 0, "measured zero stays available");
const mixedSources = accountSnapshot(accountCard.id, 50);
mixedSources.sources.unshift({ ...accountSnapshot(accountCard.id, 70, now - 60_000).sources[0], id: "openCode" });
assert.equal(gptAccountQuotaPaceEvents({ accounts: [mixedSources] }, now)[0].usedPercent, 50, "use the same freshest account row as the overview");
// A new account-scoped cache must recover older exactly attributed live
// measurements from the existing reset ledger, without relabelling legacy data.
const historyDirectory = await mkdtemp(join(tmpdir(), "quota-pace-history-"));
try {
  const historyFile = join(historyDirectory, "reset-samples.jsonl");
  const registry = { accounts: [
    { id: accountCard.id, active: true, identityQuality: "account_id" },
    { id: otherAccount, active: true, identityQuality: "account_id" },
    { id: "gpt-1111111111111111", active: true, identityQuality: "email" },
    { id: "gpt-2222222222222222", active: false, identityQuality: "account_id" }
  ] };
  const snapshot = (id, usedPercent, minutesAgo) => ({ kind: "sample", source: "live", accountRef: id,
    accountKey: "synthetic-private-key", accountLabel: "Synthetic account", credits: { availableCount: 1 },
    at: new Date(now - minutesAgo * 60_000).toISOString(),
    window: { usedPercent, resetsAt: reset, windowMinutes: 10080 } });
  const history = [
    ...[[300, 10], [120, 20], [60, 25], [30, 28], [0, 30]].map(([minutes, used]) => snapshot(accountCard.id, used, minutes)),
    snapshot(otherAccount, 50, 120), snapshot(otherAccount, 55, 0),
    snapshot("gpt-1111111111111111", 99, 0), snapshot("gpt-2222222222222222", 99, 0),
    { ...snapshot(accountCard.id, 99, 0), source: "quota_history" },
    { ...snapshot(accountCard.id, 99, 0), accountRef: null },
    { ...snapshot(accountCard.id, 99, 0), kind: "gap" },
    snapshot(accountCard.id, null, 0), snapshot(accountCard.id, 1, 420), snapshot(accountCard.id, 99, -2),
    { ...snapshot(accountCard.id, 99, 0), window: { usedPercent: 99, resetsAt: reset, windowMinutes: 300 } }
  ];
  const originalHistory = history.map(record => JSON.stringify(record)).join("\n") + "\n{partial";
  await writeFile(historyFile, originalHistory);
  const imported = await readCodexAccountQuotaPaceTail(historyFile, registry, now);
  assert.equal(imported.length, 7, "only recent live samples with verified active account references are reusable");
  const recovered = assessQuotaPace(mergeQuotaPaceSamples(imported, [event(80, 300), event(90, 0)], now), now);
  for (const [minutes, delta] of [[30, 2], [60, 5], [120, 10], [300, 20]]) {
    assert.equal(recovered[accountCard.id].weekly[minutes].observedMinutes, minutes);
    assert.equal(recovered[accountCard.id].weekly[minutes].deltaPercent, delta);
  }
  assert.equal(recovered[otherAccount].weekly[120].deltaPercent, 5, "accounts retain separate historical measurements");
  assert.equal(recovered.codex.weekly[300].deltaPercent, 10, "unscoped provider samples are never assigned to an account");
  assert.equal(await readFile(historyFile, "utf8"), originalHistory, "recovery does not alter the source ledger");
  assert.doesNotMatch(JSON.stringify(imported), /accountKey|accountLabel|credits/, "only quota measurement fields leave the reader");
  assert.deepEqual(await readCodexAccountQuotaPaceTail(join(historyDirectory, "missing.jsonl"), registry, now), []);
  assert.deepEqual(await readCodexAccountQuotaPaceTail(historyFile, { accounts: [] }, now), []);
} finally { await rm(historyDirectory, { recursive: true, force: true }); }

console.log("quota pace scenarios passed");
