import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

console.log("sync UI and localization contract passed");

function placeholders(value) {
  return Array.from(String(value).matchAll(/\{(\w+)\}/gu), (match) => match[1]).sort();
}
