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
const { widgetUsageFixture } = require("./fixtures/desktop-widget.cjs");
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
    let status = "ready", count = 5, calls = 0;
    const options = { runtimeDirectory: temporary, getLanguage: () => "ar", async readSnapshot() {
      calls++; await new Promise((resolve) => setTimeout(resolve, 30));
      if (status === "throw") throw new Error("PRIVATE_FIXTURE_SENTINEL");
      return { status, snapshot: buildDesktopWidgetSnapshot(widgetUsageFixture(count)) };
    } };
    bridge = await startPlasmaBridge(options);
    assert.equal((await fs.stat(bridge.socketPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(bridge.socketPath))).mode & 0o777, 0o700);
    const both = await Promise.all([read(), read()]);
    assert.equal(calls, 1, "multiple plasmoids share one projected endpoint request");
    assert.equal(both[0].snapshot.accounts.length, 5); assert.equal(both[1].language, "ar");
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
          await fs.mkdir(path.dirname(metadataFile), { recursive: true });
          await fs.writeFile(metadataFile, JSON.stringify({ KPlugin: { Version: app.getVersion() } }));
        }
        return { stdout: command === "kpackagetool6" ? "kpackagetool6 2.0\n" : "Python 3\n" };
      }
    });
    assert.equal((await handlers.get("plasma:status")(event)).installed, false);
    assert.throws(() => handlers.get("plasma:status")({ ...event, senderFrame: { url: event.senderFrame.url } }), /untrusted/);
    assert.equal((await handlers.get("plasma:install")(event)).success, true);
    assert(commands.some(([, args]) => args.includes("--install")));
    assert.equal((await handlers.get("plasma:install")(event)).success, true);
    assert(commands.some(([, args]) => args.includes("--upgrade")));
    assert.equal((await installer.status()).installedVersion, app.getVersion());
    await installer.dispose(); assert.equal(handlers.size, 0);
  } finally { await bridge?.close(); await fs.rm(temporary, { recursive: true, force: true }); }
}
console.log("Plasma widget: 27 locales, grouping/favorites, missing/zero/stale quotas, owner-private bridge/restart, session auth and trusted user-only installer passed.");
