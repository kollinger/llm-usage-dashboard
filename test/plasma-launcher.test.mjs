import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { registerPlasmaLauncher, PLASMA_DESKTOP_ID } = require("../electron/plasma-launcher");
const activate = require("./fixtures/dashboard-activation.cjs");
const run = promisify(execFile);
const helper = fileURLToPath(new URL("../scripts/open-plasma-dashboard.py", import.meta.url));
const qml = await fs.readFile(new URL("../plasma/contents/ui/main.qml", import.meta.url), "utf8");
for (const suffix of ["", ".desktop"]) {
  const rows = [
    { title: "LLM Usage Dashboard", appId: "electron", window: true },
    { title: "LLM Usage Dashboard", appId: PLASMA_DESKTOP_ID + suffix, window: true, skip: true },
    { title: "Other app", appId: PLASMA_DESKTOP_ID + suffix, window: true },
    { title: "LLM Usage Dashboard", appId: PLASMA_DESKTOP_ID + suffix, window: false },
    { title: "LLM Usage Dashboard", appId: PLASMA_DESKTOP_ID + suffix, window: true }
  ];
  const activated = [];
  const context = vm.createContext({ Qt: { DisplayRole: "title" }, TaskManager: { AbstractTasksModel: { AppId: "appId", SkipTaskbar: "skip", IsWindow: "window" } },
    dashboardTasks: { count: rows.length, makeModelIndex: i => i, data: (i, role) => rows[i][role], requestActivate: i => activated.push(i) } });
  vm.runInContext(qml.slice(qml.indexOf("function activateDashboardTask()"), qml.indexOf("function openDashboard()")), context);
  assert.equal(context.activateDashboardTask(), true);
  assert.deepEqual(activated, [4], "native activation targets only the main dashboard, excluding widgets, launchers and unrelated Electron apps");
  const launched = [];
  context.launchPending = false; context.launchError = "old_error"; context.launchCommand = "fixed-packaged-helper";
  context.launcher = { connectSource: command => launched.push(command) };
  vm.runInContext(qml.slice(qml.indexOf("function openDashboard()"), qml.indexOf("TaskManager.TasksModel {")), context);
  context.openDashboard();
  assert.equal(context.launchError, "");
  assert.deepEqual(launched, [], "native activation must not race a redundant secondary launch against an immediate user close");
  context.dashboardTasks.count = 4;
  assert.equal(context.activateDashboardTask(), false);
  context.openDashboard(); context.openDashboard();
  assert.deepEqual(launched, ["fixed-packaged-helper"], "closed app/window uses one guarded local helper invocation");
}

// Real Electron single-instance wiring and window lifecycle, with native calls
// replaced only for this fast regression suite (also covered on native Plasma).
for (const locked of [false, true]) {
  const app = new EventEmitter();
  let quit = false, created = 0;
  app.requestSingleInstanceLock = () => locked;
  app.setDesktopName = value => assert.equal(value, `${PLASMA_DESKTOP_ID}.desktop`);
  app.quit = () => { quit = true; };
  const state = activate(app, port => { assert.equal(port, 45678); created++; });
  assert.equal(quit, !locked);
  if (!locked) continue;
  app.emit("second-instance", {}, ["app", "--background"]);
  assert.equal(state.openWindowWhenReady, false);
  app.emit("second-instance", {}, ["app"]);
  assert.equal(state.openWindowWhenReady, true, "activation during startup is queued");
  state.dashboardPort = 45678;
  app.emit("second-instance", {}, ["app"]);
  assert.equal(created, 1, "closed window is recreated");
  for (const minimized of [false, true]) {
    const calls = [];
    state.mainWindow = { isDestroyed: () => false, isMinimized: () => minimized,
      restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus") };
    app.emit("second-instance", {}, ["app"]);
    assert.deepEqual(calls, minimized ? ["restore", "show", "focus"] : ["show", "focus"]);
    assert.equal(created, 1, "running window reused");
  }
  state.mainWindow = { isDestroyed: () => true };
  app.emit("second-instance", {}, ["app"]);
  assert.equal(created, 2, "destroyed window is recreated");
}

if (process.platform === "linux") {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "plasma-launcher-"));
  const dataHome = path.join(temporary, "data ' \" $HOME $(false) ; %");
  const environment = { ...process.env, XDG_DATA_HOME: dataHome };
  const descriptor = path.join(dataHome, "llm-usage-dashboard/launcher.json");
  const output = path.join(temporary, "invocation.json");
  const executable = path.join(temporary, "Dashboard ' \" $HOME $(false) ; %.AppImage");
  const app = { isPackaged: true };
  const read = async () => {
    const { stdout, stderr } = await run("/usr/bin/python3", ["-I", helper], { env: environment });
    assert.equal(stderr, "");
    const value = JSON.parse(stdout);
    assert.deepEqual(Object.keys(value).sort(), ["schema", "status"], "no paths, process output or private payloads returned");
    assert.equal(value.schema, 1);
    return value.status;
  };
  try {
    assert.equal(await read(), "missing");
    await fs.writeFile(executable, "#!/usr/bin/python3\nimport json,sys\nopen(" + JSON.stringify(output) + ", 'w').write(json.dumps(sys.argv))\n", { mode: 0o700 });
    await registerPlasmaLauncher({ app: { isPackaged: false }, dataHome, environment, executable });
    await assert.rejects(fs.access(descriptor), { code: "ENOENT" }, "development app cannot replace installed launcher");
    await registerPlasmaLauncher({ app, dataHome, environment: { ...environment, APPIMAGE: executable }, executable: "/temporary/mount/electron" });
    assert.equal((await fs.stat(path.dirname(descriptor))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(descriptor)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(path.dirname(descriptor), "open_dashboard.py"))).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readFile(path.join(path.dirname(descriptor), "open_dashboard.py")), await fs.readFile(helper));
    await assert.rejects(registerPlasmaLauncher({ app, dataHome, environment: { APPIMAGE: executable + "\nExec=unrelated" } }), /invalid_launcher/);
    const applications = path.join(dataHome, "applications");
    await fs.chmod(applications, 0o777);
    await assert.rejects(registerPlasmaLauncher({ app, dataHome, environment, executable }), /unsafe_applications_directory/);
    await fs.chmod(applications, 0o700);
    assert.equal(await read(), "started");
    assert.deepEqual(JSON.parse(await fs.readFile(output)), [executable], "all path metacharacters stay literal; no shell or background argument");
    const desktopFile = path.join(dataHome, "applications", `${PLASMA_DESKTOP_ID}.desktop`);
    await fs.rm(output);
    let gioAvailable = true;
    try { await run("gio", ["launch", desktopFile], { env: environment }); }
    catch (error) { if (error.code !== "ENOENT") throw error; gioAvailable = false; }
    if (gioAvailable) {
      for (let i = 0; i < 50; i++) {
        try { await fs.access(output); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      assert.deepEqual(JSON.parse(await fs.readFile(output)), [executable], "desktop Exec escaping also preserves literal arguments");
    }
    assert((await fs.readFile(desktopFile, "utf8")).includes("NoDisplay=true"));
    await fs.writeFile(executable, "#!/usr/bin/python3\nraise SystemExit(9)\n");
    assert.equal(await read(), "failed", "immediate child startup failure");
    await fs.chmod(executable, 0o600);
    assert.equal(await read(), "failed", "non-executable installation");
    await fs.rm(executable);
    assert.equal(await read(), "missing", "removed/moved installation");
    const valid = await fs.readFile(descriptor, "utf8");
    for (const value of ["not json", JSON.stringify({ schema: 2, executable: process.execPath }),
      JSON.stringify({ schema: 1, executable: "relative" }), JSON.stringify({ schema: 1, executable: "/bad\0path" }), "[]", "null", "x".repeat(16385)]) {
      await fs.writeFile(descriptor, value);
      assert.equal(await read(), "failed", "malformed/oversize/unsupported descriptor is rejected");
    }
    await fs.writeFile(descriptor, valid);
    await fs.chmod(descriptor, 0o644);
    assert.equal(await read(), "failed");
    await fs.chmod(descriptor, 0o600);
    await fs.chmod(path.dirname(descriptor), 0o755);
    assert.equal(await read(), "failed");
    await assert.rejects(registerPlasmaLauncher({ app, dataHome, environment, executable: process.execPath }), /unsafe_launcher_directory/);
    await fs.chmod(path.dirname(descriptor), 0o700);
    await fs.rm(descriptor);
    const other = path.join(temporary, "other.json");
    await fs.writeFile(other, valid, { mode: 0o600 });
    await fs.symlink(other, descriptor);
    assert.equal(await read(), "failed", "descriptor symlink is rejected");
    await fs.rm(path.dirname(descriptor), { recursive: true });
    await fs.symlink(temporary, path.dirname(descriptor));
    assert.equal(await read(), "failed", "directory symlink is rejected");
    await assert.rejects(registerPlasmaLauncher({ app, dataHome, environment, executable: process.execPath }), /unsafe_launcher_directory/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
console.log("Plasma launcher: private packaged registration, literal paths/no shell, missing/failed/unsafe installation, startup queue, background/closed/minimized/single-instance regressions passed.");
