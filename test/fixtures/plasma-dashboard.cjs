"use strict";

// Real Electron windows and process lock; only the production activation code
// runs, so this fixture never starts collectors, credentials or the updater.
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const activate = require("./dashboard-activation.cjs");
const { registerPlasmaLauncher } = require("../../electron/plasma-launcher");
const profile = process.env.PLASMA_DASHBOARD_PROFILE;
if (!profile) throw new Error("isolated_profile_required");
app.setName("llm-usage-dashboard");
fs.mkdirSync(path.join(profile, "electron-profile"), { recursive: true });
app.setPath("userData", path.join(profile, "electron-profile"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});
const state = activate(app, () => {
  const win = new BrowserWindow({ width: 500, height: 300, title: "LLM Usage Dashboard", webPreferences: { sandbox: true } });
  state.mainWindow = win;
  win.loadURL("data:text/html,<title>LLM Usage Dashboard</title><p>Synthetic dashboard activation check</p>");
  win.on("closed", () => { state.mainWindow = null; });
});
let activationCount = 0;
app.on("second-instance", () => { activationCount++; });
app.whenReady().then(async () => {
  // Secondary instances must exit through the production lock path.
  if (!app.hasSingleInstanceLock()) return;
  await registerPlasmaLauncher({ app: { isPackaged: true }, dataHome: process.env.XDG_DATA_HOME,
    environment: { APPIMAGE: process.env.PLASMA_DASHBOARD_EXECUTABLE } });
  state.dashboardPort = 45678;
  if (!process.argv.includes("--background") || state.openWindowWhenReady) state.showDashboardWindow(45678);
  setInterval(() => {
    const command = path.join(profile, "command");
    if (fs.existsSync(command)) {
      const action = fs.readFileSync(command, "utf8"); fs.unlinkSync(command);
      if (action === "close") state.mainWindow?.close();
      if (action === "hide") state.mainWindow?.hide();
      if (action === "minimize") state.mainWindow?.minimize();
      if (action === "quit") { app.quit(); return; }
    }
    const win = state.mainWindow;
    fs.writeFileSync(path.join(profile, "state.tmp"), JSON.stringify({ pid: process.pid, activationCount,
      id: win?.id || null, visible: Boolean(win?.isVisible()), minimized: Boolean(win?.isMinimized()), focused: Boolean(win?.isFocused()) }));
    fs.renameSync(path.join(profile, "state.tmp"), path.join(profile, "state.json"));
  }, 100);
});
