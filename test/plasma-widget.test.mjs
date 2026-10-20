import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const run = promisify(execFile);
const { startPlasmaBridge, readPlasmaSnapshot, MAX_BYTES } = require("../lib/plasma-bridge");
const { createPlasmaWidget, PLUGIN_ID } = require("../electron/plasma-widget");
const { buildDesktopWidgetSnapshot } = require("../lib/desktop-widget");
const { widgetUsageFixture, claudeUsageFixture } = require("./fixtures/desktop-widget.cjs");
const root = fileURLToPath(new URL("../", import.meta.url));
const locales = path.join(root, "public/i18n");
const english = JSON.parse(await fs.readFile(path.join(locales, "en.json"), "utf8")).plasma;
const placeholders = (text) => [...text.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
for (const file of await fs.readdir(locales)) {
  if (!file.endsWith(".json")) continue;
  const translated = JSON.parse(await fs.readFile(path.join(locales, file), "utf8")).plasma;
  assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort(), file);
  for (const key of Object.keys(english)) {
    assert(translated[key].trim(), `${file}:${key}`);
    assert.deepEqual(placeholders(translated[key]), placeholders(english[key]), `${file}:${key}`);
  }
}
// Exercise the actual dialog renderer. A matching disk version must never be
// presented as proof that a running Plasma applet has loaded the new QML.
const appSource = await fs.readFile(path.join(root, "public/app.js"), "utf8");
const ui = vm.createContext({
  t: (key, values = {}) => Object.entries(values).reduce((text, [name, value]) =>
    text.replaceAll(`{${name}}`, value), english[key.replace(/^plasma\./, "")])
});
vm.runInContext(appSource.slice(appSource.indexOf("function renderPlasmaWidgetStatus("), appSource.indexOf("function bindEvents(")), ui);
const button = {}, notice = {};
const installedState = { supported: true, installed: true, installedVersion: "1.10.0-preview.1", version: "1.10.0-preview.1", connected: true };
for (const result of [installedState, { ...installedState, success: true }]) {
  ui.renderPlasmaWidgetStatus(result, button, notice);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, english.current);
  assert(notice.textContent.includes("1.10.0-preview.1"));
  assert(notice.textContent.includes(english.reloadHelp), "cache/reload guidance survives both install success and reopening the dialog/app");
  assert(!notice.textContent.includes(english.offline));
}
ui.renderPlasmaWidgetStatus({ ...installedState, panelsReady: true }, button, notice);
assert(!notice.textContent.includes(english.reloadHelp), "a verified live panel repair does not ask for a session restart");
ui.renderPlasmaWidgetStatus({ ...installedState, installedVersion: "1.9.0-preview.2", connected: false }, button, notice);
assert.equal(button.disabled, false);
assert.equal(button.textContent, english.update);
assert(notice.textContent.includes("1.9.0-preview.2"));
assert(notice.textContent.includes(english.offline));
ui.renderPlasmaWidgetStatus({ ...installedState, success: false }, button, notice);
assert.equal(button.disabled, false, "failed install allows retry even if metadata already matches");
assert.equal(notice.textContent, english.installError);
ui.renderPlasmaWidgetStatus({ supported: true, installed: false, version: "1.10.0-preview.1", connected: true }, button, notice);
assert.equal(button.disabled, false);
assert.equal(button.textContent, english.install);
assert.equal(notice.textContent, "");
ui.renderPlasmaWidgetStatus({ supported: false, reason: "unsupported" }, button, notice);
assert.equal(button.disabled, true);
assert.equal(notice.textContent, english.unsupported);
ui.renderPlasmaWidgetStatus({ supported: false, reason: "requirements" }, button, notice);
assert.equal(notice.textContent, english.requirements);
const model = vm.createContext({});
vm.runInContext((await fs.readFile(path.join(root, "plasma/contents/code/ViewModel.js"), "utf8")).replace(/^\.pragma library\s*/, ""), model);
for (const count of [0, 1, 5, 12, 80]) {
  const snapshot = buildDesktopWidgetSnapshot(widgetUsageFixture(count));
  const all = model.accounts(snapshot, "all", "all", []);
  assert.equal(all.length, count);
  assert.equal(new Set(all.map((a) => a.id)).size, count);
  assert(all.every((a) => /^widget-[a-f0-9]{24}$/.test(a.id)));
  if (count) {
    assert.equal(model.accounts(snapshot, "all", "favorites", [all[0].id]).length, 1);
    assert(model.accounts(snapshot, "gpt", "all", []).every((a) => a.provider === "gpt"));
    assert.equal(model.remaining(all[0].windows[0]), 0, "real zero remains zero");
  }
}
assert.equal(model.remaining({ remainingPercent: null }), null);
assert.equal(model.remaining({ remainingPercent: "0" }), null);
assert.equal(model.remaining({ remainingPercent: -1 }), null);
const current = { status: "current", measuredAt: new Date().toISOString(), resetsAt: new Date(Date.now() + 60000).toISOString() };
assert.equal(model.stale(current, {}, false, Date.now()), false);
assert.equal(model.stale(current, {}, true, Date.now()), true);
assert.equal(model.stale({ ...current, measuredAt: null }, {}, false, Date.now()), true);
assert.equal(model.stale({ ...current, resetsAt: new Date(Date.now() - 1).toISOString() }, {}, false, Date.now()), true);
let fetchStatus = 200;
const session = { async fetch(url, options) {
  assert.equal(url, "http://localhost:45678/api/desktop-widget");
  assert.equal(options.credentials, "include"); assert.equal(options.redirect, "error");
  assert.equal(options.headers, undefined, "no credential or admin token exported");
  return { status: fetchStatus, ok: fetchStatus === 200, json: async () => buildDesktopWidgetSnapshot(widgetUsageFixture(5)) };
} };
assert.equal((await readPlasmaSnapshot(session, "http://localhost:45678")).status, "ready");
fetchStatus = 401;
assert.deepEqual(await readPlasmaSnapshot(session, "http://localhost:45678"), { status: "locked" });
fetchStatus = 503;
assert.deepEqual(await readPlasmaSnapshot(session, "http://localhost:45678"), { status: "unavailable" });
for (const origin of ["https://localhost", "http://attacker.invalid", "http://localhost/path"]) {
  await assert.rejects(readPlasmaSnapshot(session, origin), /loopback/);
}

if (process.platform === "linux") {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "plasma-contract-"));
  let bridge;
  const helper = path.join(root, "plasma/contents/code/read_snapshot.py");
  const env = { ...process.env, XDG_RUNTIME_DIR: temporary };
  const read = async () => {
    const result = await run("/usr/bin/python3", ["-I", helper], { env });
    assert.equal(result.stderr, "");
    assert(!result.stdout.includes("PRIVATE_FIXTURE_SENTINEL"));
    return JSON.parse(result.stdout);
  };
  try {
    assert.equal((await read()).status, "unavailable");
    let status = "ready", count = 5, calls = 0, claudeCase = false;
    const options = { runtimeDirectory: temporary, getLanguage: () => "ar", async readSnapshot() {
      calls++; await new Promise((resolve) => setTimeout(resolve, 30));
      if (status === "throw") throw new Error("PRIVATE_FIXTURE_SENTINEL");
      return { status, snapshot: buildDesktopWidgetSnapshot(claudeCase ? claudeUsageFixture() : widgetUsageFixture(count)) };
    } };
    bridge = await startPlasmaBridge(options);
    assert.equal((await fs.stat(bridge.socketPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(bridge.socketPath))).mode & 0o777, 0o700);
    const both = await Promise.all([read(), read()]);
    assert.equal(calls, 1, "multiple plasmoids share one projected endpoint request");
    assert.equal(both[0].snapshot.accounts.length, 5); assert.equal(both[1].language, "ar");
    claudeCase = true;
    const localClaude = (await read()).snapshot.accounts;
    assert.equal(localClaude.length, 3);
    assert.deepEqual(localClaude[2].sources, ["local"]);
    assert.equal(localClaude[2].windows[0].remainingPercent, 0);
    assert.equal(localClaude[2].windows[1].remainingPercent, null);
    claudeCase = false;
    await assert.rejects(startPlasmaBridge(options), /busy/);
    status = "locked";
    const locked = await read(); assert.equal(locked.status, "locked"); assert.equal(locked.snapshot, undefined);
    status = "throw"; assert.equal((await read()).status, "unavailable");
    await bridge.close(); bridge = null;
    assert.equal((await read()).status, "unavailable");
    count = 12; status = "ready";
    bridge = await startPlasmaBridge(options);
    assert.equal((await read()).snapshot.accounts.length, 12, "restart reconnects without a port or pairing token");
    await bridge.close(); bridge = null;
    bridge = await startPlasmaBridge({ runtimeDirectory: temporary, readSnapshot: async () => ({ status: "ready", snapshot: { accounts: [], extra: "x".repeat(MAX_BYTES) } }) });
    assert.equal((await read()).status, "unavailable", "oversize is rejected");
    await bridge.close(); bridge = null;
    await fs.chmod(temporary, 0o755);
    await assert.rejects(startPlasmaBridge(options), /private_directory/);
    assert.equal((await read()).status, "unavailable");
    await fs.chmod(temporary, 0o700);
    const socketPath = path.join(temporary, "llm-usage-dashboard/plasma.sock");
    await fs.symlink(path.join(temporary, "unrelated"), socketPath);
    await assert.rejects(startPlasmaBridge(options), /unsafe/);
    assert.equal((await read()).status, "unavailable");
    await fs.unlink(socketPath);
    // A crashed process leaves a stale socket; reconnect safely replaces it.
    await run("/usr/bin/python3", ["-I", "-c", "import socket,sys,os;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);os.chmod(sys.argv[1],0o600)", socketPath]);
    bridge = await startPlasmaBridge(options);
    assert.equal((await read()).status, "ready");
    await bridge.close(); bridge = null;

    // Exercise trusted IPC and exact user-local installer arguments.
    await run(process.execPath, [path.join(root, "scripts/build-plasmoid.mjs")]);
    assert.equal(await fs.readFile(path.join(root, "dist/plasma/package/contents/code/ProviderColors.js"), "utf8"),
      ".pragma library\n" + await fs.readFile(path.join(root, "public/provider-colors.js"), "utf8"),
      "Plasma ships the identical shared palette and contrast logic");
    assert.deepEqual(await fs.readFile(path.join(root, "dist/plasma/llm-usage-dashboard.plasmoid")),
      await fs.readFile(path.join(root, "dist", `LLM-Usage-Dashboard-${require("../package.json").version}-plasma.zip`)),
      "existing CI ZIP asset and bundled native package are identical");
    const handlers = new Map(), commands = [];
    const window = { isDestroyed: () => false, webContents: { mainFrame: { url: "http://localhost:45678/" } } };
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const app = { isPackaged: false, getVersion: () => require("../package.json").version };
    const metadataFile = path.join(temporary, "data/plasma/plasmoids", PLUGIN_ID, "metadata.json");
    const installer = createPlasmaWidget({ app, origin: "http://localhost:45678", session, getMainWindow: () => window,
      getLanguage: () => "en", environment: { ...env, XDG_DATA_HOME: path.join(temporary, "data") },
      ipcMain: { handle: (key, value) => handlers.set(key, value), removeHandler: (key) => handlers.delete(key) },
      async run(command, args, options) {
        assert.equal(options.shell, undefined); commands.push([command, args]);
        if (args.includes("--install") || args.includes("--upgrade")) {
          assert(args.includes("--packageroot")); assert(!args.includes("--global"));
          const target = path.join(args[args.indexOf("--packageroot") + 1], PLUGIN_ID, "metadata.json");
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, JSON.stringify({ KPlugin: { Id: PLUGIN_ID, Version: app.getVersion() } }));
        }
        if (command === "dbus-send") return { stdout: "boolean false" }; // no running desktop in this contract
        return { stdout: command === "kpackagetool6" ? "kpackagetool6 2.0\n" : "Python 3\n" };
      }
    });
    assert.equal((await handlers.get("plasma:status")(event)).installed, false);
    await installer.start();
    assert(!commands.some(([, args]) => args.includes("--install")), "startup must not opt a user into a first native-widget install");
    assert.throws(() => handlers.get("plasma:status")({ ...event, senderFrame: { url: event.senderFrame.url } }), /untrusted/);
    assert.throws(() => handlers.get("plasma:install")({ ...event, senderFrame: { url: event.senderFrame.url } }), /untrusted/);
    assert.equal((await handlers.get("plasma:install")(event)).success, true);
    assert(commands.some(([, args]) => args.includes("--install")));
    assert.equal((await handlers.get("plasma:install")(event)).success, true);
    assert.equal(commands.filter(([cmd, args]) => cmd === "kpackagetool6" && args.includes("--install")).length, 1, "the same immutable package is reused");
    assert((await fs.lstat(path.dirname(metadataFile))).isSymbolicLink());
    assert.equal((await installer.status()).installedVersion, app.getVersion());
    const callsBeforeNewerPackage = commands.length;
    await fs.writeFile(metadataFile, JSON.stringify({ KPlugin: { Id: PLUGIN_ID, Version: "99.0.0" } }));
    await installer.start();
    assert.equal((await installer.status()).installedVersion, "99.0.0", "starting an older app must not downgrade an installed newer widget");
    assert(!commands.slice(callsBeforeNewerPackage).some(([cmd]) => cmd === "dbus-send"));
    await installer.dispose(); assert.equal(handlers.size, 0);
  } finally { await bridge?.close(); await fs.rm(temporary, { recursive: true, force: true }); }
}
console.log("Plasma widget: 27 locales, grouping/favorites, missing/zero/stale quotas, owner-private bridge/restart, session auth and trusted user-only installer passed.");
