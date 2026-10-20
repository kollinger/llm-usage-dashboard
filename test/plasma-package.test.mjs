import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { activatePackage, repairPanels, PLUGIN_ID } = require("../electron/plasma-package");

function session({ broken = false, running = true } = {}) {
  let nextId = 100;
  const panels = [];
  const shortcuts = new Map();
  function widget(p, type = PLUGIN_ID, legacy = false) {
    const w = { id: nextId++, type, version: legacy ? "old" : "new", shortcut: "", locked: true,
      get globalShortcut() { return this.shortcut; },
      set globalShortcut(value) {
        if (value && shortcuts.has(value) && shortcuts.get(value) !== this.id) return;
        shortcuts.delete(this.shortcut); this.shortcut = value;
        if (value) shortcuts.set(value, this.id);
      },
      get geometry() { return { x: p.items.slice(0, p.items.indexOf(this)).reduce((sum, w) => sum + w.geometry.width, 0), y: 0, width: legacy || broken ? 780 : 40, height: 40 }; }, config: {}, rootConfig: { immutability: "1" },
      get store() { return this.currentConfigGroup?.length === 0 ? this.rootConfig : this.config; },
      get configKeys() { return Object.keys(this.store); },
      get index() { return p.items.indexOf(this); },
      set index(value) { p.items.splice(p.items.indexOf(this), 1); p.items.splice(value, 0, this); },
      readConfig(key, fallback) {
        const value = this.store[key] ?? fallback;
        return typeof fallback === "number" && Number.isInteger(fallback) ? Math.trunc(Number(value)) : value;
      },
      writeConfig(key, value) { this.store[key] = value; }, reloadConfig() {},
      remove() { p.items.splice(p.items.indexOf(this), 1); }
    };
    p.items.push(w); return w;
  }
  for (const id of [1, 2]) {
    const p = { id, height: 48, items: [], widgets() { return this.items.slice(); },
      widgetById(id) { return this.items.find(w => w.id === id); }, addWidget(source, x) {
        const target = this.items.findIndex(w => x < w.geometry.x + w.geometry.width);
        const next = widget(this);
        next.index = target + 1;
        return next;
      } };
    panels.push(p);
    widget(p, "unrelated");
    for (let i = 0; i < 2; i++) {
      const w = widget(p, PLUGIN_ID, true);
      w.config = { favorites: ["opaque-favorite-" + i, "opaque-other-favorite"], provider: "claude", view: "favorites", scale: 1.3 };
      w.rootConfig.immutability = String(i + 1);
      w.globalShortcut = "Alt+" + w.id;
    }
    widget(p, "unrelated");
  }
  let reply;
  const context = vm.createContext({ panels: () => panels, panelById: id => panels.find(p => p.id === id),
    desktops() { throw new Error("Desktop must not be touched"); }, print(value) { reply = value; } });
  return { panels, async run(command, args, options) {
    assert.equal(command, "dbus-send"); assert.equal(options?.shell, undefined);
    if (args.includes("org.freedesktop.DBus.NameHasOwner")) return { stdout: "boolean " + running };
    assert(args.includes("org.kde.PlasmaShell.evaluateScript"));
    vm.runInContext(args.at(-1).slice("string:".length), context);
    return { stdout: reply };
  } };
}
const options = { source: "/synthetic/package'with-quotes", version: "new", force: false, options: {} };
const live = session();
const before = live.panels.map(p => p.items.map(w => ({ id: w.id, type: w.type, config: w.config, rootConfig: w.rootConfig, shortcut: w.globalShortcut })));
// Also catch a cache-stale full view whose metadata already claims the new version.
live.panels[0].items[1].version = "new";
assert.equal(await repairPanels({ ...options, run: live.run }), 4);
for (let i = 0; i < live.panels.length; i++) {
  const now = live.panels[i].items;
  assert.deepEqual(now.map(w => w.type), before[i].map(w => w.type));
  for (let j = 0; j < now.length; j++) {
    if (now[j].type === PLUGIN_ID) {
      assert.notEqual(now[j].id, before[i][j].id);
      assert.deepEqual(now[j].config, before[i][j].config);
      assert.equal(now[j].globalShortcut, before[i][j].shortcut);
      assert.deepEqual(now[j].rootConfig, before[i][j].rootConfig, "explicit immutability is preserved independently of inherited panel locks");
      assert.equal(now[j].geometry.width, now[j].geometry.height);
    } else assert.equal(now[j].id, before[i][j].id);
  }
}
const stable = live.panels.map(p => p.items.map(w => w.id));
assert.equal(await repairPanels({ ...options, run: live.run }), 0);
assert.deepEqual(live.panels.map(p => p.items.map(w => w.id)), stable, "healthy instances survive repeated app starts");
const failure = session({ broken: true });
const originals = failure.panels.map(p => p.items.map(w => w.id));
await assert.rejects(repairPanels({ ...options, run: failure.run }), /repair_failed/);
assert.deepEqual(failure.panels.map(p => p.items.map(w => w.id)), originals, "failed compact validation rolls back only new candidates");
assert.equal(await repairPanels({ ...options, run: session({ running: false }).run }), null);

if (process.platform === "linux") {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "plasma-package-"));
  try {
    const archive = path.join(temporary, "bundled.plasmoid"), dataHome = path.join(temporary, "data");
    const destination = path.join(dataHome, "plasma/plasmoids", PLUGIN_ID);
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "legacy.qml"), "retained legacy source");
    await fs.writeFile(archive, "synthetic immutable package");
    let installs = 0;
    const run = async (command, args) => {
      assert.equal(command, "kpackagetool6"); assert(args.includes("--install"));
      const source = path.join(args[args.indexOf("--packageroot") + 1], PLUGIN_ID);
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "metadata.json"), JSON.stringify({ KPlugin: { Id: PLUGIN_ID, Version: "new" } }));
      installs++; return { stdout: "" };
    };
    const input = { archive, dataHome, version: "new", run, options: {} };
    const first = await activatePackage(input);
    assert(first.changed); assert((await fs.lstat(destination)).isSymbolicLink());
    assert.equal(await fs.realpath(destination), first.source);
    const storage = path.join(dataHome, "llm-usage-dashboard/plasma-packages");
    const backup = (await fs.readdir(storage)).find(name => name.startsWith("legacy-"));
    assert.equal(await fs.readFile(path.join(storage, backup, PLUGIN_ID, "legacy.qml"), "utf8"), "retained legacy source");
    assert.equal((await activatePackage(input)).changed, false); assert.equal(installs, 1);
    await fs.writeFile(archive, "a new source version");
    const second = await activatePackage(input);
    assert(second.changed); assert.notEqual(second.source, first.source);
    await fs.access(first.source); // don't break files still used by old desktop instances
    await fs.unlink(destination);
    await fs.symlink(temporary, destination);
    await assert.rejects(activatePackage(input), /unsafe_plasma_package/);
    assert.equal(await fs.realpath(destination), temporary, "unmanaged symlinks are never overwritten");
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
console.log("Plasma package: canonical cache bypass, legacy preservation, safe activation, exact-panel repair, multiple instances/order/preferences/shortcuts, rollback and idempotence passed.");
