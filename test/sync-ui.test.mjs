import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index = await readFile(path.join(root, "public", "index.html"), "utf8");
const app = await readFile(path.join(root, "public", "app.js"), "utf8");
const styles = await readFile(path.join(root, "public", "styles.css"), "utf8");

for (const id of [
  "syncDeviceFilter",
  "syncSettingsSection",
  "syncEnabled",
  "syncServerUrl",
  "syncDeviceName",
  "syncPairingCode",
  "syncCreateSpaceBtn",
  "syncJoinBtn",
  "syncNewPairingCodeBtn",
  "syncNowBtn",
  "syncDisconnectBtn"
]) {
  assert.match(index, new RegExp(`id=["']${id}["']`, "u"), `missing sync UI control ${id}`);
}
assert.match(index, /data-i18n="sync\.privacy"/u);
assert.match(app, /function activeDashboardUsage\(\)/u);
assert.match(app, /state\.syncStatus\?\.connected && state\.syncUsage/u);
assert.match(app, /loadSyncUsageView\(\{ renderAfter: false \}\)/u);
assert.match(app, /device_id: state\.syncDeviceFilter/u);
assert.match(app, /fallbackLocal/u);
assert.match(app, /renderPricing\(local, chartRowsForCurrentRange\(local\), buildProviders\(state\.usage\)\)/u);
assert.match(app, /const selectedRangeRows = usageRowsForSelectedRange\(local, chartRows\);/u);
assert.match(app, /renderPricing\(local, chartRows, sourceProviders\);/u);
assert.match(styles, /\.settings-modal-body \.diag-list\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/u);
assert.match(styles, /\.source-path-list span\s*\{\s*overflow-wrap: anywhere;/u);

const localeDir = path.join(root, "public", "i18n");
const files = (await readdir(localeDir)).filter((name) => name.endsWith(".json")).sort();
const english = JSON.parse(await readFile(path.join(localeDir, "en.json"), "utf8"));
const expectedKeys = Object.keys(english.sync).sort();
for (const name of files) {
  const translations = JSON.parse(await readFile(path.join(localeDir, name), "utf8"));
  assert.deepEqual(Object.keys(translations.sync || {}).sort(), expectedKeys, `${name} sync keys must match en.json`);
  for (const key of expectedKeys) {
    assert.equal(typeof translations.sync[key], "string", `${name} sync.${key} must be a string`);
    assert(translations.sync[key].trim(), `${name} sync.${key} must not be empty`);
    assert.deepEqual(
      placeholders(translations.sync[key]),
      placeholders(english.sync[key]),
      `${name} sync.${key} interpolation placeholders must match en.json`
    );
  }
}

const syncFunctions = app.slice(app.indexOf("function activeDashboardUsage()"), app.indexOf("function loadDashboardSectionOrderPreference()"));
const directUsage = { totals: { allTime: { totalTokens: 99 } } };
const state = { usage: { local: directUsage }, syncStatus: { enabled: true, connected: true }, syncDeviceFilter: "all" };
const connectionState = { selectedDevice: "all" };
const requests = [];
const context = vm.createContext({
  state, connectionState, URLSearchParams, Date,
  localStorage: { setItem() {} },
  t: (key) => key,
  fetchJson: async (url) => {
    requests.push(url);
    if (url.includes("/devices")) return { devices: [] };
    return { usage: { totals: { allTime: { totalTokens: 150 } } } };
  }
});
vm.runInContext(syncFunctions, context);
await context.loadSyncUsageView();
assert.equal(requests.length, 0, "direct installation views must not wait on or mix in collector requests");
assert.equal(context.activeDashboardUsage(), directUsage);
connectionState.selectedDevice = "collector";
await context.loadSyncUsageView();
assert.equal(context.activeDashboardUsage().totals.allTime.totalTokens, 150);
connectionState.selectedDevice = "local";
assert.equal(context.activeDashboardUsage(), directUsage, "selecting this installation must immediately restore its own aggregate");

const pending = [];
context.fetchJson = async (url) => url.includes("/devices") ? { devices: [] } : new Promise((resolve) => pending.push(resolve));
connectionState.selectedDevice = "collector";
const older = context.loadSyncUsageView();
await new Promise(setImmediate);
state.syncDeviceFilter = "unknown";
const newer = context.loadSyncUsageView();
await new Promise(setImmediate);
assert.equal(pending.length, 2);
pending[1]({ usage: { total: 5 } });
await newer;
pending[0]({ usage: { total: 150 } });
await older;
assert.equal(state.syncUsage.total, 5, "a late response must not overwrite the selected collector filter");

const obsolete = context.loadSyncUsageView();
await new Promise(setImmediate);
connectionState.selectedDevice = "local";
await context.loadSyncUsageView();
pending[2]({ usage: { total: 900 } });
await obsolete;
assert.equal(state.syncUsage, null, "a late collector response must not revive another source after switching to local");
assert.equal(context.activeDashboardUsage(), directUsage);

console.log("sync UI, source isolation, stale-response and localization contracts passed");

function placeholders(value) {
  return Array.from(String(value).matchAll(/\{(\w+)\}/gu), (match) => match[1]).sort();
}
