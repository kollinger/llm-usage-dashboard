import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const source = await readFile(new URL("../public/connections.js", import.meta.url), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(ids.length, new Set(ids).size, "HTML IDs must remain unique");
class Element {
  constructor() { this.dataset = {}; this.hidden = false; this.disabled = false; this.value = ""; this.innerHTML = ""; this.handlers = {}; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  querySelectorAll() { return []; }
  focus() {}
  insertAdjacentHTML(_where, content) { this.innerHTML += content; }
}
const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
const tabs = ["accounts", "installations", "general", "advanced"].map((name) => Object.assign(new Element(), { dataset: { settingsTab: name } }));
const panels = tabs.map((tab) => Object.assign(new Element(), { dataset: { settingsPanel: tab.dataset.settingsTab } }));
const nav = new Element();
const content = new Element();
const requests = [];
const sync = { enabled: false, deviceId: "local", name: "My laptop", devices: [], peers: [] };
const dictionary = JSON.parse(await readFile(new URL("../public/i18n/en.json", import.meta.url), "utf8"));
const getPath = (object, key) => key.split(".").reduce((value, part) => value?.[part], object);
const context = vm.createContext({
  URL, Map, Set, document: {
    getElementById: (id) => elements[id], activeElement: null, documentElement: { dir: "ltr" },
    querySelector: (selector) => selector === ".settings-tabs" ? nav : content,
    querySelectorAll: (selector) => selector === "[data-settings-tab]" ? tabs : selector === "[data-settings-panel]" ? panels : []
  },
  state: { translations: dictionary, fallbackTranslations: dictionary }, getPath,
  t: (key, values, fallback) => getPath(dictionary, key) ?? fallback ?? key,
  escapeHtml: (value) => String(value).replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
  formatRelativeUpdatedAt: () => "just now", formatTokens: String, formatMoney: String,
  formatLimitRemainingPercent: (limit) => `${limit.remainingPercent}%`,
  fetchJson: async (url, options) => {
    requests.push({ url, ...options });
    if (url.endsWith("/settings")) return { ...sync, enabled: true };
    if (url.endsWith("/invite")) return { code: "one-time-pairing-code" };
    if (url === "/api/connections" && options?.method === "POST") throw new Error("invalid_key");
    return {};
  },
  loadUsage: async () => {}, openSettings: async () => {},
  navigator: { clipboard: { writeText: async () => {} } },
  setTimeout: () => 1, clearTimeout: () => {}
});
vm.runInContext(source, context);
context.setupConnections();
context.selectSettingsTab("installations");
assert.deepEqual(panels.map((panel) => panel.hidden), [true, false, true, true]);
assert.equal(tabs[1]["aria-selected"], "true");
assert.equal(tabs[0].tabIndex, -1);
context.renderDeviceSync(sync);
assert.match(elements.deviceSyncPeers.innerHTML, /My laptop/);
assert.match(elements.deviceSyncPeers.innerHTML, /This installation/);
assert.match(elements.deviceSyncPeers.innerHTML, /Sync disabled/);
assert.equal(elements.deviceSyncRefreshBtn.disabled, true);
assert.equal(elements.deviceSyncInviteBtn.disabled, false, "users must be able to begin pairing while sync is off");
await elements.deviceSyncInviteBtn.handlers.click();
assert.deepEqual(requests.map((request) => request.url), ["/api/device-sync/settings", "/api/device-sync/invite"]);
assert.equal(elements.deviceSyncCode.value, "one-time-pairing-code");
assert.equal(elements.deviceSyncCode.readOnly, true);
assert.equal(elements.deviceSyncJoinBtn.hidden, true);
vm.runInContext(`connectionState.accounts = { providers: [
  { id: "claude", methods: [{ id: "browser", type: "browser", available: false, helpUrl: "https://code.claude.com/docs/setup", unavailableReason: "cli_missing" }] },
  { id: "glm", methods: [{ id: "key", type: "key", available: true }] },
  { id: "kimi", methods: [{ id: "browser", type: "browser", available: true }, { id: "key", type: "key", available: true }] }
], accounts: [] };`, context);
context.chooseConnectionProvider("claude");
assert.equal(elements.accountConnectBtn.disabled, true);
assert.match(elements.accountMethodHelp.textContent, /official CLI/);
assert.equal(elements.accountMethodHelpLink.hidden, false);
assert.match(elements.accountProviderDescription.textContent, /Claude Code handles/);
context.chooseConnectionProvider("glm");
assert.equal(elements.accountKeyFields.hidden, false);
assert.equal(elements.accountRegionField.hidden, false);
elements.accountApiKey.value = "synthetic-secret";
elements.accountRegion.value = "global";
await context.submitConnectionAccount({ preventDefault() {} });
assert.equal(elements.accountApiKey.value, "", "keys must be cleared after failure as well as success");
assert.equal(elements.accountsMessage.textContent, dictionary.connections.errors.invalid_key);
const request = requests.at(-1);
assert.equal(JSON.parse(request.body).apiKey, "synthetic-secret");
assert.equal(context.safeConnectionUrl("javascript:alert(1)"), null);
assert.equal(context.safeConnectionUrl("https://user:secret@example.test"), null);
context.chooseConnectionProvider("kimi");
assert.equal(elements.accountConnectBtn.disabled, false, "Kimi browser login needs no user CLI install");
assert.equal(elements.accountRegionField.hidden, true);
assert.match(elements.accountMethodHelp.textContent, /downloads the official Kimi helper directly from Kimi/);
assert.doesNotMatch(elements.accountMethodHelp.textContent, /Install.*CLI/);
const knownErrors = ["invalid_account", "invalid_key", "permission_denied", "unsupported_key", "account_limit", "connection_unavailable", "account_storage_unavailable", "profile_remove_failed", "unsupported_platform"];
for (const code of knownErrors) {
  assert.equal(context.connectionErrorKey(code), `connections.errors.${code}`);
  context.renderConnectionLogin({ id: "kimi", status: "failed", error: code });
  assert.equal(elements.accountLoginMessage.textContent, dictionary.connections.errors[code]);
}
context.renderConnectionLogin({ id: "kimi", status: "failed", error: "untrusted-secret-error-text" });
assert.equal(elements.accountLoginMessage.textContent, dictionary.connections.failed);
assert.equal(context.connectionErrorKey("cli_missing"), "connections.needsSetup");
const saved = context.renderConnectedAccount({ provider: "claude", label: "Saved account", status: "saved", managed: true });
assert.match(saved, /Previous/);
assert.doesNotMatch(saved, /Active/);
const denied = context.renderConnectedAccount({ provider: "anthropic", label: "API account", status: "unavailable", managed: true, detailCode: "permission_denied" });
assert.match(denied, /required permissions/);
const unknown = context.renderConnectedAccount({ provider: "kimi", label: "Kimi", managed: true, tokenTotal: null, balance: null });
assert.match(unknown, /Not available/);
assert.doesNotMatch(unknown, /0%|Balance: 0/);
const nonzero = context.renderConnectedAccount({ provider: "kimi", label: "Kimi", managed: true, status: "connected", limits: { rows: [{ usedPercent: 25 }] } });
assert.match(nonzero, /75%/);
context.renderConnections({ connectedAccounts: [{ id: "kimi-a", provider: "kimi", label: "Kimi account", status: "connected", managed: true }] });
assert.equal(elements.accountOverviewPanel.hidden, false);
assert.match(elements.accountOverviewList.innerHTML, /Kimi account/);

const flatten = (value, prefix = "") => Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
  const name = prefix ? `${prefix}.${key}` : key;
  return typeof child === "string" ? [[name, child]] : Object.entries(flatten(child, name));
}));
const english = flatten(dictionary);
const newKeys = Object.keys(english).filter((key) => key.startsWith("connections.") || key.startsWith("providers.kimi."));
const placeholders = (value) => [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
assert(newKeys.length >= 60);
for (const file of await readdir(new URL("../public/i18n/", import.meta.url))) {
  if (!file.endsWith(".json")) continue;
  const locale = flatten(JSON.parse(await readFile(new URL(`../public/i18n/${file}`, import.meta.url), "utf8")));
  for (const key of newKeys) {
    assert.equal(typeof locale[key], "string", `${file}: ${key}`);
    assert(locale[key].trim(), `${file}: empty ${key}`);
    assert.deepEqual(placeholders(locale[key]), placeholders(english[key]), `${file}: ${key} placeholders`);
  }
}
for (const match of html.matchAll(/data-i18n(?:-aria-label|-title|-placeholder)?="(connections\.[^"]+)"/g)) {
  assert.equal(typeof english[match[1]], "string", `missing HTML translation ${match[1]}`);
}
console.log("Account manager UI: tabs, local installation, pairing consent, CLI guidance, key clearing, unavailable metrics and 27 locales passed.");
