import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once, EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Launch the real entry point, never a replacement main or a manually created
// Tray. The loopback inspector only observes the controllers created by main.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const sourceMode = process.argv.includes("--source");
if (process.argv.includes("--ci") && process.env.GITHUB_ACTIONS !== "true") process.exit(0);
if (process.platform === "linux" && !process.env.DISPLAY) {
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 1600x1000x24", process.execPath,
    fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  const [code] = await once(child, "exit");
  process.exit(code ?? 1);
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "llm-desktop-startup-"));
try {
  const profile = path.join(temporary, "profile"), home = path.join(temporary, "home");
  const tempDir = path.join(temporary, "tmp"), data = path.join(profile, "data");
  await Promise.all([home, tempDir, data].map(directory => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(profile, "language-settings.json"), JSON.stringify({ language: "en" }));
  await fs.mkdir(path.join(home, ".claude"));
  await fs.writeFile(path.join(home, ".claude", "usage-dashboard-statusline.json"), JSON.stringify({
    captured_at: new Date().toISOString(), rate_limits: {
      five_hour: { used_percentage: 27, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day: { used_percentage: 100, resets_at: new Date(Date.now() + 86_400_000).toISOString() }
    }
  }));
  const mainSource = await fs.readFile(path.join(root, "electron/main.js"), "utf8");
  const startupLine = mainSource.split("\n").findIndex(line => line.includes("mobileAccess = createDesktopMobileAccess("));
  assert(startupLine > 0);

  let executable, prefix = [];
  if (sourceMode) { executable = require("electron"); prefix = [root]; }
  else if (process.platform === "darwin") {
    const version = require("../package.json").version;
    // Exercise the ZIP that will be uploaded, not a previously installed app.
    execFileSync("/usr/bin/ditto", ["-x", "-k", path.join(root, "dist", `LLM-Usage-Dashboard-${version}-mac-universal.zip`), path.join(temporary, "package")]);
    const contents = path.join(temporary, "package", "LLM Usage Dashboard.app", "Contents");
    const { extractFile } = require("@electron/asar");
    const archive = path.join(contents, "Resources", "app.asar");
    const packaged = JSON.parse(extractFile(archive, "package.json"));
    assert.equal(packaged.main, "electron/main.js"); assert.equal(packaged.version, version);
    for (const file of ["electron/main.js", "electron/mac-menu-bar.js", "electron/desktop-widget.js",
      "electron/assets/menu-barTemplate.png", "electron/assets/menu-barTemplate@2x.png"]) {
      assert.deepEqual(extractFile(archive, file), await fs.readFile(path.join(root, file)), `fresh ZIP contains exact ${file}`);
    }
    executable = path.join(contents, "MacOS", "LLM Usage Dashboard");
  } else executable = process.platform === "win32" ? path.join(root, "dist/win-unpacked/LLM Usage Dashboard.exe")
    : path.join(root, "dist/linux-unpacked/llm-usage-dashboard");

  // Do not inherit provider credentials, sessions, source overrides or updater
  // credentials. Home/appData/tmp and all persisted state belong to this test.
  const env = Object.fromEntries(["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "DISPLAY", "XAUTHORITY", "LANG"]
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"), TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir,
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
    LLM_USAGE_DATA_DIR: data, LLM_USAGE_AUTO_LAUNCH: "false", PORT: "0", OLLAMA_PROXY_PORT: "0",
    CODEX_LIVE_RATE_LIMITS: "false", COPILOT_LIVE_QUOTA_ENABLED: "false", GLM_CODING_PLAN_QUOTA_ENABLED: "false" });

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return; await pause(50); }
    throw new Error(`Timed out: ${label}`);
  }

  async function launch(cycle) {
    const args = [...prefix, "--inspect-brk=127.0.0.1:0", `--user-data-dir=${profile}`, "--disable-background-networking"];
    if (process.platform === "linux" && (process.env.GITHUB_ACTIONS === "true" || process.env.DESKTOP_STARTUP_NO_SANDBOX === "1")) args.push("--no-sandbox");
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", inspectorUrl, socket;
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-30_000); });
    child.stderr.on("data", chunk => { output = (output + chunk).slice(-30_000); inspectorUrl ||= output.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f\d-]+/)?.[0]; });
    let spawnError;
    child.on("error", error => { spawnError = error; });
    const exited = new Promise(resolve => { child.once("exit", (...result) => resolve(result)); child.once("error", () => resolve([null])); });
    const watchdog = setTimeout(() => child.kill(), 180_000);
    try {
      await until(() => { if (spawnError) throw spawnError; assert.equal(child.exitCode, null, output); return inspectorUrl; }, "app inspector");
      socket = new WebSocket(inspectorUrl);
      await once(socket, "open");
      const events = new EventEmitter(), pending = new Map(); let id = 0;
      socket.addEventListener("message", ({ data: message }) => {
        const result = JSON.parse(message);
        if (result.id) { const callback = pending.get(result.id); pending.delete(result.id); callback?.(result); }
        else events.emit(result.method, result.params);
      });
      const command = (method, params = {}) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Inspector timeout: ${method}`)); }, 30_000);
        pending.set(requestId, result => { clearTimeout(timer); result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result); });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
      const evaluate = async expression => {
        // Retain native executeJavaScript promises until the inspector has read
        // them; inspector-only references may otherwise be garbage-collected.
        const result = await command("Runtime.evaluate", {
          expression: `globalThis.__desktopStartupEval = eval(${JSON.stringify(expression)})`,
          returnByValue: true, awaitPromise: true
        }).catch(error => { throw new Error(`Startup evaluation failed: ${expression}`, { cause: error }); });
        assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        return result.result?.value;
      };
      await command("Runtime.enable"); await command("Debugger.enable");
      const nextPause = () => Promise.race([once(events, "Debugger.paused", { signal: AbortSignal.timeout(45_000) }),
        exited.then(() => { throw new Error(`App exited before startup completed: ${output}`); })]);
      const firstPause = nextPause();
      await command("Runtime.runIfWaitingForDebugger");
      let [initial] = await firstPause;
      const initialSource = await command("Debugger.getScriptSource", { scriptId: initial.callFrames[0].location.scriptId });
      if (initialSource.scriptSource.trim() !== mainSource.trim()) {
        const entry = await command("Debugger.setBreakpointByUrl", { lineNumber: 2, urlRegex: "[/\\\\]electron[/\\\\]main\\.js$" });
        const entryPause = nextPause();
        await command("Debugger.resume");
        [initial] = await entryPause;
        assert(initial.hitBreakpoints.includes(entry.breakpointId));
        await command("Debugger.removeBreakpoint", { breakpointId: entry.breakpointId });
      }
      // Electron's OS appData path can ignore HOME. Set it before the unmodified
      // main acquires its instance lock or reads any profile state.
      const isolated = await command("Debugger.evaluateOnCallFrame", { callFrameId: initial.callFrames[0].callFrameId,
        expression: `require('electron').app.setPath('appData', ${JSON.stringify(path.dirname(profile))}); require('electron').app.setPath('userData', ${JSON.stringify(profile)}); true`, returnByValue: true });
      assert(!isolated.exceptionDetails, JSON.stringify(isolated.exceptionDetails));
      const breakpoint = await command("Debugger.setBreakpointByUrl", { lineNumber: startupLine, urlRegex: "[/\\\\]electron[/\\\\]main\\.js$" });
      const startupPause = nextPause();
      await command("Debugger.resume");
      const [started] = await startupPause;
      assert(started.hitBreakpoints.includes(breakpoint.breakpointId), "real main reaches menu-bar initialization");
      const captured = await command("Debugger.evaluateOnCallFrame", { callFrameId: started.callFrames[0].callFrameId,
        expression: "globalThis.__desktopStartup = { app, require, getMain: () => mainWindow, getTray: () => macMenuBar.getTray(), getWidget: () => desktopWidget, getPort: () => dashboardPort }; true",
        returnByValue: true });
      assert(!captured.exceptionDetails, JSON.stringify(captured.exceptionDetails));
      await command("Debugger.removeBreakpoint", { breakpointId: breakpoint.breakpointId });
      await command("Debugger.resume");
      const state = "globalThis.__desktopStartup";
      const quotaReady = async window => {
        await until(() => evaluate(`${state}.getWidget().${window}()?.webContents.executeJavaScript("document.querySelectorAll('.widget-account').length === 1 && document.getElementById('widgetList').getAttribute('aria-busy') === 'false'")`), "real API renders synthetic local quota");
        assert.deepEqual(await evaluate(`${state}.getWidget().${window}().webContents.executeJavaScript("[...document.querySelectorAll('.widget-track')].map(node => node.getAttribute('aria-valuenow'))")`), ["73", "0"]);
      };
      assert.equal(await evaluate(`${state}.app.isPackaged`), !sourceMode);
      assert.equal(await evaluate(`${state}.app.getPath('userData')`), profile);
      assert.equal(await evaluate(`${state}.require('node:os').homedir()`), home);
      console.log(`Desktop startup ${cycle}: ${JSON.stringify(await evaluate(`({ version: ${state}.app.getVersion(), electron: process.versions.electron, platform: process.platform, arch: process.arch, os: ${state}.require('node:os').release() })`))}`);
      await until(() => evaluate(`Boolean(${state}.getMain()?.isVisible() && !${state}.getMain().webContents.isLoadingMainFrame())`), "actual main window loads");
      assert.equal(await evaluate(`${state}.getMain().webContents.getURL()`), `http://localhost:${await evaluate(`${state}.getPort()`)}/`);
      assert.equal(await evaluate(`${state}.getMain().webContents.executeJavaScript("Boolean(document.getElementById('desktopWidgetBtn'))")`), true, "real dashboard rendered");
      if (process.platform === "darwin") {
        await until(() => evaluate(`Boolean(${state}.getTray()?.getBounds().height > 0)`), "actual main places native menu-bar icon");
        const bounds = await evaluate(`${state}.getTray().getBounds()`);
        console.log(`Packaged startup ${cycle}: native Tray bounds ${JSON.stringify(bounds)}`);
        // OS input is required; emitting Electron's click event cannot pass this.
        const click = () => execFileSync("/usr/bin/swift", [path.join(root, "test/mac-menu-bar-click.swift"),
          String(bounds.x + bounds.width / 2), String(bounds.y + bounds.height / 2)], { timeout: 60_000, stdio: "inherit" });
        for (let toggle = 0; toggle < 2; toggle++) {
          click();
          await until(() => evaluate(`Boolean(${state}.getWidget().getPopupWindow()?.isVisible())`), "OS click opens quota popup through real main");
          await quotaReady("getPopupWindow");
          assert.equal(await evaluate(`${state}.getWidget().getPopupWindow().webContents.getURL()`), `http://localhost:${await evaluate(`${state}.getPort()`)}/widget.html`);
          if (process.env.GITHUB_ACTIONS === "true" && cycle === 1 && toggle === 0) {
            await evaluate(`${state}.getWidget().getPopupWindow().webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")`);
            await pause(300);
            const panel = await evaluate(`${state}.getWidget().getPopupWindow().getBounds()`);
            const x = Math.min(bounds.x, panel.x), y = Math.min(bounds.y, panel.y);
            const width = Math.max(bounds.x + bounds.width, panel.x + panel.width) - x;
            const height = Math.max(bounds.y + bounds.height, panel.y + panel.height) - y;
            const screenshot = path.join(temporary, "startup-menu-bar.png");
            execFileSync("/usr/sbin/screencapture", ["-x", "-R", `${x},${y},${width},${height}`, screenshot]);
            // Preserve one bounded synthetic screenshot in the native job log.
            // It can be decoded for review without changing workflow permissions
            // or adding diagnostic files to the release's downloadable assets.
            console.log(`DESKTOP_STARTUP_SCREENSHOT:${(await fs.readFile(screenshot)).toString("base64")}`);
            const colors = await evaluate(`(() => {
              const image = ${state}.require('electron').nativeImage.createFromPath(${JSON.stringify(screenshot)});
              const scale = image.getSize().width / ${width};
              const pixels = image.crop({ x: Math.round(${panel.x - x + 12} * scale), y: Math.round(${panel.y - y + 12} * scale),
                width: Math.round(300 * scale), height: Math.round(180 * scale) }).toBitmap();
              const colors = new Set();
              for (let i = 0; i < pixels.length; i += 4) colors.add(pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2]);
              return colors.size;
            })()`);
            assert(colors > 16, "OS screenshot contains painted popup content, not only a blank background");
          }
          click(); await until(() => evaluate(`!${state}.getWidget().getPopupWindow()`), "second OS click closes popup");
        }
        await evaluate(`${state}.getMain().close(); true`);
        await until(() => evaluate(`!${state}.getMain()`), "main window closes");
        assert(await evaluate(`!${state}.getTray().isDestroyed()`), "Tray survives closing the main window");
        click(); await until(() => evaluate(`Boolean(${state}.getWidget().getPopupWindow()?.isVisible())`), "menu bar opens popup without main window");
        await quotaReady("getPopupWindow");
        assert.equal(await evaluate(`Boolean(${state}.getMain())`), false);
        click(); await until(() => evaluate(`!${state}.getWidget().getPopupWindow()`), "popup closes without main window");
      } else {
        assert.equal(await evaluate(`${state}.getTray()`), null, "no macOS Tray on Linux/Windows");
        await evaluate(`${state}.getMain().webContents.executeJavaScript("window.llmUsageDashboard.desktopWidget.open()")`);
        await quotaReady("getWindow");
        await evaluate(`${state}.getWidget().getWindow().close(); true`);
        await evaluate(`${state}.getMain().close(); true`);
        await until(() => evaluate(`!${state}.getMain()`), "main window closes");
      }
      await evaluate(`setTimeout(() => ${state}.app.quit(), 0); true`);
      socket.close();
      await until(() => child.exitCode !== null || child.signalCode !== null, "clean app shutdown");
      const [code] = await exited;
      assert.equal(code, 0, output);
      console.log(`Desktop startup ${cycle}: ${process.platform}, ${sourceMode ? "source" : "fresh package"}, real main/window, platform Tray and clean quit passed.`);
    } catch (error) {
      console.error(output);
      throw error;
    } finally {
      clearTimeout(watchdog);
      socket?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await Promise.race([exited, pause(5000)]);
        if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      }
    }
  }

  for (let cycle = 1; cycle <= 2; cycle++) await launch(cycle);
}
finally { await fs.rm(temporary, { recursive: true, force: true }); }
