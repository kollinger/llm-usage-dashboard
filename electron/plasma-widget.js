"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { trustedFrame } = require("./desktop-widget");
const { startPlasmaBridge, readPlasmaSnapshot } = require("../lib/plasma-bridge");
const runFile = promisify(execFile);
const PLUGIN_ID = "local.llm-usage-dashboard.quotas";
const ARCHIVE_NAME = "llm-usage-dashboard.plasmoid";

function createPlasmaWidget({ app, ipcMain, session, origin, getMainWindow, getLanguage,
  platform = process.platform, environment = process.env, run = runFile }) {
  let bridge = null, installing = null;
  const archive = app.isPackaged ? path.join(process.resourcesPath, "plasma", ARCHIVE_NAME)
    : path.join(__dirname, "..", "dist", "plasma", ARCHIVE_NAME);
  const dataHome = environment.XDG_DATA_HOME && path.isAbsolute(environment.XDG_DATA_HOME)
    ? environment.XDG_DATA_HOME : path.join(os.homedir(), ".local", "share");
  const installedMetadata = path.join(dataHome, "plasma", "plasmoids", PLUGIN_ID, "metadata.json");
  const options = { timeout: 30_000, maxBuffer: 64 * 1024, env: environment };
  const status = async () => {
    if (platform !== "linux") return { supported: false, reason: "unsupported" };
    let available = false, installedVersion = null;
    try {
      const { stdout } = await run("kpackagetool6", ["--version"], options);
      available = /kpackagetool6/.test(stdout);
      await run("/usr/bin/python3", ["-I", "--version"], options);
    } catch { available = false; }
    try { installedVersion = JSON.parse(await fs.readFile(installedMetadata, "utf8"))?.KPlugin?.Version || null; } catch { /* Not installed. */ }
    let bundled = false;
    try { await fs.access(archive); bundled = true; } catch { /* Development package not built yet. */ }
    return { supported: available && bundled, installed: Boolean(installedVersion), installedVersion,
      version: app.getVersion(), connected: Boolean(bridge), reason: !available ? "requirements" : !bundled ? "package" : null };
  };
  const trusted = (event) => trustedFrame(event, getMainWindow(), `${origin}/`) ||
    trustedFrame(event, getMainWindow(), `${origin}/index.html`);
  ipcMain.handle("plasma:status", (event) => {
    if (!trusted(event)) throw new Error("untrusted_plasma_request");
    return status();
  });
  ipcMain.handle("plasma:install", async (event) => {
    if (!trusted(event)) throw new Error("untrusted_plasma_request");
    if (installing) return installing;
    installing = (async () => {
      const before = await status();
      if (!before.supported) return before;
      try {
        // Explicit package root confines both install and update to this user.
        // No shell, sudo, downloaded code or caller-selected package/path.
        const root = path.join(dataHome, "plasma", "plasmoids");
        await run("kpackagetool6", ["--type", "Plasma/Applet", "--packageroot", root,
          before.installed ? "--upgrade" : "--install", archive], options);
        const after = await status();
        return { ...after, success: after.installedVersion === app.getVersion() };
      } catch { return { ...await status(), success: false }; }
    })().finally(() => { installing = null; });
    return installing;
  });
  return {
    status,
    async start() {
      if (platform !== "linux") return;
      try {
        bridge = await startPlasmaBridge({ runtimeDirectory: environment.XDG_RUNTIME_DIR,
          readSnapshot: () => readPlasmaSnapshot(session, origin), getLanguage });
      } catch { /* No private session runtime: native widget stays unavailable. */ }
    },
    async dispose() {
      ipcMain.removeHandler("plasma:status"); ipcMain.removeHandler("plasma:install");
      await bridge?.close(); bridge = null;
    }
  };
}

module.exports = { createPlasmaWidget, PLUGIN_ID, ARCHIVE_NAME };
