import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildDesktopWidgetSnapshot, STALE_AFTER_MS } = require("../lib/desktop-widget");
const { createDesktopWidget, restoreWidgetBounds, widgetPreferences, trustedFrame } = require("../electron/desktop-widget");
const { widgetUsageFixture } = require("./fixtures/desktop-widget.cjs");
const now = Date.UTC(2026, 0, 2, 12);

for (const count of [0, 1, 2, 5, 10, 24]) {
  const snapshot = buildDesktopWidgetSnapshot(widgetUsageFixture(count, now), now);
  assert.equal(snapshot.accounts.length, count);
  assert.equal(new Set(snapshot.accounts.map((account) => account.id)).size, count);
}
const usage = widgetUsageFixture(5, now);
usage.connectedAccounts.push({ id: "synthetic-profile", provider: "gpt", accountId: "synthetic-gpt-0", label: "Custom personal label", managed: true,
  status: "connected", updatedAt: usage.generatedAt, limits: { rows: [{ remainingPercent: 99 }] } });
let projected = buildDesktopWidgetSnapshot(usage, now);
assert.equal(projected.accounts.length, 5, "registry and connection share their exact normalized identity");
assert.equal(projected.accounts[0].label, "Custom personal label");
assert.equal(projected.accounts[0].windows[0].remainingPercent, 0, "a real zero remains zero");
assert.equal(projected.accounts[1].windows[1].remainingPercent, null, "unknown is never coerced to zero");
assert.equal(projected.accounts[0].windows[0].status, "current");
assert.deepEqual(projected.accounts[0].sources, ["codex", "openCode"]);
assert(!JSON.stringify(projected).includes("synthetic-gpt"), "only widget handles leave the projection");
assert(!JSON.stringify(projected).includes("accountId"));
const first = usage.gptAccounts.accounts[0];
first.sources[1] = { id: "openCode", active: false, quotaStatus: "ready", limitsUpdatedAt: new Date(now + 1000).toISOString(), limits: { rows: [{ remainingPercent: 99 }] } };
assert.equal(buildDesktopWidgetSnapshot(usage, now).accounts[0].windows[0].remainingPercent, 0, "a historical source cannot override current quota");
first.sources[0].quotaStatus = "unavailable";
first.sources[1].limits = null;
assert.equal(buildDesktopWidgetSnapshot(usage, now).accounts[0].windows[0].status, "stale", "saved quota after an error is visibly stale");
first.sources[0].limits = null;
usage.codex = { limits: { rows: [{ remainingPercent: 75 }] } };
assert.deepEqual(buildDesktopWidgetSnapshot(usage, now).accounts[0].windows, [], "missing account quota is not borrowed from the active default account");

const one = widgetUsageFixture(1, now);
const copilot = { status: "live", quotaStatus: { updatedAt: new Date(now).toISOString() },
  limits: { rows: [{ remainingPercent: 0, windowMinutes: 43200 }] } };
assert.equal(buildDesktopWidgetSnapshot({ copilot }, now).accounts[0].windows[0].status, "current", "Copilot uses its quota measurement timestamp, not the log-scan time");
copilot.quotaStatus.updatedAt = null;
assert.equal(buildDesktopWidgetSnapshot({ copilot }, now).accounts[0].windows[0].status, "stale");
const row = one.gptAccounts.accounts[0].sources[0].limits.rows[0];
for (const value of [null, "0", "", false, undefined, NaN, Infinity, -1, 101]) {
  row.remainingPercent = value;
  assert.equal(buildDesktopWidgetSnapshot(one, now).accounts[0].windows[0].remainingPercent, null);
}
row.remainingPercent = null; row.usedPercent = 100;
assert.equal(buildDesktopWidgetSnapshot(one, now).accounts[0].windows[0].remainingPercent, 0);
row.usedPercent = 0;
assert.equal(buildDesktopWidgetSnapshot(one, now).accounts[0].windows[0].remainingPercent, 100);
for (const delta of [STALE_AFTER_MS + 1, -120_000]) {
  one.gptAccounts.accounts[0].sources[0].limitsUpdatedAt = new Date(now - delta).toISOString();
  assert.equal(buildDesktopWidgetSnapshot(one, now).accounts[0].windows[0].status, "stale");
}
one.gptAccounts.accounts[0].sources[0].limitsUpdatedAt = null;
assert.equal(buildDesktopWidgetSnapshot(one, now).accounts[0].windows[0].status, "stale");
one.gptAccounts.accounts[0].sources[0].limitsUpdatedAt = new Date(now).toISOString();
row.resetsAt = new Date(now - 1).toISOString();
assert.equal(buildDesktopWidgetSnapshot(one, now).accounts[0].windows[0].status, "stale", "elapsed reset never invents a refilled quota");

const duplicate = widgetUsageFixture(12, now);
projected = buildDesktopWidgetSnapshot(duplicate, now);
const sameLabels = projected.accounts.filter((account) => account.label === "Example duplicate display name");
assert(sameLabels.some((account) => account.labelIndex === 2), "same-provider label collisions have visible ordinals");
const sentinel = "PRIVATE_FIELD_SENTINEL";
duplicate.raw = duplicate.apiKey = duplicate.transcript = sentinel;
duplicate.gptAccounts.accounts[0].accountId = sentinel;
duplicate.gptAccounts.accounts[0].sources[0].payload = sentinel;
duplicate.gptAccounts.accounts[0].sources[0].limits.rows[0].raw = sentinel;
assert(!JSON.stringify(buildDesktopWidgetSnapshot(duplicate, now)).includes(sentinel));
assert.deepEqual(Object.keys(projected.accounts[0]).sort(), ["id", "label", "labelIndex", "provider", "sources", "windows"].sort());
assert.deepEqual(Object.keys(projected.accounts[0].windows[0]).sort(), ["key", "label", "windowMinutes", "remainingPercent", "resetsAt", "measuredAt", "status", "quality"].sort());
duplicate.connectedAccounts.push({ ...duplicate.connectedAccounts[0], id: "another-normalized-id", accountId: "shared-synthetic-identity" });
duplicate.connectedAccounts[0].accountId = "shared-synthetic-identity";
assert.equal(buildDesktopWidgetSnapshot(duplicate, now).accounts.length, 12, "exact provider identity deduplicates mirrored sources");

const primary = { workArea: { x: 0, y: 30, width: 1920, height: 1050 } };
const left = { workArea: { x: -1280, y: 0, width: 1280, height: 720 } };
assert.deepEqual(restoreWidgetBounds({ x: -1200, y: 20, width: 600, height: 500 }, [left, primary], primary), { x: -1200, y: 20, width: 600, height: 500 });
for (const saved of [{ x: 6000, y: 3000, width: 9000, height: 9000 }, { x: -1200, y: 20, width: 600, height: 500 }, { x: NaN }, null]) {
  const result = restoreWidgetBounds(saved, [primary], primary);
  assert(result.x >= 0 && result.y >= 30 && result.x + result.width <= 1920 && result.y + result.height <= 1080);
}
const tiny = { workArea: { x: 0, y: 0, width: 320, height: 240 } };
assert.deepEqual(restoreWidgetBounds(null, [tiny]), { x: 0, y: 0, width: 320, height: 240 });
assert.deepEqual(widgetPreferences({ scale: 100, provider: "__proto__", favorites: ["private-id"], view: "rotate" }), { favorites: [], view: "all", provider: "all", scale: 1 });

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "llm-widget-"));
const windows = [];
class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.bounds = { ...options }; this.pinned = false; this.destroyed = false;
    this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: "" };
    this.webContents.setWindowOpenHandler = (handler) => { this.newWindow = handler; };
    this.sent = []; this.webContents.send = (...args) => this.sent.push(args); windows.push(this);
  }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  isMaximized() { return false; }
  getBounds() { return { x: this.bounds.x ?? 0, y: this.bounds.y ?? 0, width: this.bounds.width, height: this.bounds.height }; }
  setBounds(value) { this.bounds = value; }
  setSize(width, height) { this.bounds = { ...this.bounds, width, height }; }
  setMinimumSize() {}
  setBackgroundColor() {}
  setAlwaysOnTop(value) { this.pinned = value; }
  isAlwaysOnTop() { return this.pinned; }
  loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
  show() {}
  focus() {}
  close() { this.emit("close"); this.destroyed = true; this.emit("closed"); }
  destroy() { this.close(); }
}
const screen = new EventEmitter();
screen.getAllDisplays = () => [primary]; screen.getPrimaryDisplay = () => primary;
const handlers = new Map(), ipcMain = { handle: (name, handler) => { assert(!handlers.has(name)); handlers.set(name, handler); }, removeHandler: (name) => handlers.delete(name) };
const mainWindow = new FakeWindow({}); mainWindow.webContents.mainFrame.url = "http://localhost:1234/";
const event = (window) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
const targets = [];
const options = { BrowserWindow: FakeWindow, ipcMain, screen, origin: "http://localhost:1234", stateFile: path.join(temporary, "widget.json"),
  getMainWindow: () => mainWindow, getTheme: () => ({ preference: "dark", color: "#000000" }), getLanguage: () => "de", showDashboard: (target) => targets.push(target) };
let controller;
try {
  controller = createDesktopWidget(options);
  for (let cycle = 0; cycle < 3; cycle++) {
    handlers.get("widget:open")(event(mainWindow));
    const window = controller.getWindow();
    const before = windows.length;
    handlers.get("widget:open")(event(mainWindow));
    assert.equal(windows.length, before, "repeated opens reuse one window");
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.equal(window.newWindow({ url: "https://example.invalid" }).action, "deny");
    for (const url of ["https://example.invalid", "http://localhost:12345/widget.html", "http://localhost:1234/"]) {
      let prevented = false;
      window.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, url);
      assert(prevented);
    }
    assert(!trustedFrame({ ...event(window), senderFrame: { url: "http://localhost:1234/widget.html" } }, window, "http://localhost:1234/widget.html"));
    assert.throws(() => handlers.get("widget:pin")(event(mainWindow), true), /untrusted_widget_request/);
    assert.throws(() => handlers.get("widget:open")(event(window)), /untrusted_widget_request/);
    handlers.get("widget:pin")(event(window), true);
    assert.equal(controller.state().pinned, true);
    assert.throws(() => handlers.get("widget:pin")(event(window), "true"), /invalid_widget_setting/);
    handlers.get("widget:dashboard")(event(window), "accounts");
    assert.throws(() => handlers.get("widget:dashboard")(event(window), "https://example.invalid"), /invalid_widget_target/);
    const favorite = projected.accounts[0].id;
    handlers.get("widget:preferences")(event(window), { favorites: [favorite], scale: 1.15 });
    window.bounds = { x: 9000, y: 9000, width: 700, height: 500 };
    screen.emit("display-removed");
    assert(window.bounds.x + 700 <= primary.workArea.width);
    handlers.get("widget:close")(event(window));
    assert.equal(controller.getWindow(), null);
  }
  assert.deepEqual(targets, ["accounts", "accounts", "accounts"]);
  controller.open();
  const compact = controller.getWindow();
  const savedBounds = { ...compact.getBounds() };
  for (let cycle = 0; cycle < 3; cycle++) {
    controller.openPopup({ x: 40, y: 30, width: 780, height: 700 });
    const popup = controller.getPopupWindow();
    controller.openPopup({ x: 40, y: 30, width: 780, height: 700 });
    assert.equal(controller.getPopupWindow(), popup);
    assert.equal(popup.options.frame, false);
    assert.equal(popup.options.webPreferences.sandbox, true);
    assert.equal(popup.options.webPreferences.contextIsolation, true);
    assert.equal(handlers.get("widget:state")(event(popup)).presentation, "popup");
    assert.equal(handlers.get("widget:state")(event(popup)).pinSupported, false);
    assert.throws(() => handlers.get("widget:pin")(event(popup), true), /unsupported_widget_setting/);
    assert.throws(() => handlers.get("widget:open")(event(popup)), /untrusted_widget_request/);
    assert.throws(() => handlers.get("widget:state")({ ...event(popup), senderFrame: { url: popup.webContents.mainFrame.url } }), /untrusted_widget_request/);
    handlers.get("widget:preferences")(event(popup), { provider: "claude", scale: 1.3 });
    assert.equal(controller.state().preferences.provider, "claude", "preferences are shared with the compact window");
    assert.equal(compact.sent.at(-1)[0], "widget:state-changed");
    assert.equal(compact.sent.at(-1)[1].preferences.provider, "claude");
    assert.equal(popup.sent.length, 0, "do not echo an older optimistic edit back over the sender's newer inputs");
    let prevented = false;
    popup.webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, "http://localhost:1234/");
    assert(prevented);
    if (cycle === 0) {
      popup.webContents.emit("before-input-event", { preventDefault() {} }, { type: "keyDown", key: "Escape" });
    } else if (cycle === 1) popup.emit("blur");
    else handlers.get("widget:close")(event(popup));
    assert.equal(controller.getPopupWindow(), null);
    assert.equal(controller.getWindow(), compact, "closing the popup preserves the separate compact window");
    assert.deepEqual(compact.getBounds(), savedBounds);
  }
  handlers.get("widget:preferences")(event(compact), { scale: 1.15 });
  controller.dispose(); assert.equal(handlers.size, 0); assert.equal(screen.listenerCount("display-removed"), 0);
  controller = createDesktopWidget({ ...options, isWayland: true });
  controller.open();
  assert.equal(controller.state().pinSupported, false);
  assert.equal(controller.state().preferences.scale, 1.15, "preferences survive close/reopen and process recreation");
  assert.equal(controller.getWindow().options.x, undefined, "native Wayland never claims global positioning");
  handlers.get("widget:pin")(event(controller.getWindow()), true);
  assert.equal(controller.state().pinned, false);
  if (process.platform !== "win32") assert.equal((await fs.stat(options.stateFile)).mode & 0o777, 0o600);
} finally { controller?.dispose(); await fs.rm(temporary, { recursive: true, force: true }); }

const localeDir = new URL("../public/i18n/", import.meta.url);
const english = JSON.parse(await fs.readFile(new URL("en.json", localeDir), "utf8")).widget;
for (const file of await fs.readdir(localeDir)) {
  if (!file.endsWith(".json")) continue;
  const translated = JSON.parse(await fs.readFile(new URL(file, localeDir), "utf8")).widget;
  assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort(), `${file} widget keys`);
  for (const [key, value] of Object.entries(english)) {
    assert(translated[key].trim());
    const placeholders = (text) => [...text.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(translated[key]), placeholders(value), `${file} ${key}`);
  }
}
console.log("Desktop widget: account projection, missing/zero/stale quotas, privacy, geometry, lifecycle, IPC and 27 locale contracts passed.");
