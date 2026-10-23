"use strict";

// Real Electron windows and process lock; only the production activation code
// runs, so this fixture never starts collectors, credentials or the updater.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
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
const root = path.resolve(__dirname, "../..");
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const title = index.match(/<title\b[^>]*>[\s\S]*?<\/title>/)[0];
const appSource = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const applyTranslations = appSource.slice(appSource.indexOf("function applyStaticTranslations()"), appSource.indexOf("function renderLanguageOptions()"));
const dictionaries = Object.fromEntries(["en", "de"].map(language => [language, JSON.parse(fs.readFileSync(path.join(root, "public/i18n", language + ".json"), "utf8"))]));
const page = "<!doctype html><html><head>" + title + "</head><body><p>Synthetic dashboard activation check</p><script>" +
  "const state={language:'en'}, LANGUAGE_META={en:{dir:'ltr'},de:{dir:'ltr'}};const dictionaries=" + JSON.stringify(dictionaries) + ";" +
  "function t(key){return key.split('.').reduce((v,k)=>v[k],dictionaries[state.language]);}function renderLanguageOptions(){}" + applyTranslations +
  "window.titleStages=[document.title];applyStaticTranslations();window.titleStages.push(document.title);state.language='de';applyStaticTranslations();window.titleStages.push(document.title);</script></body></html>";
const server = http.createServer((_request, response) => { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(page); });
const state = activate(app, null, { BrowserWindow, path, __dirname: path.join(root, "electron"),
  resolvedNativeTheme: () => "light", THEME_BACKGROUND_COLORS: { light: "#f6f7f4" }, themePreference: "light", languagePreference: "de",
  shell: { openExternal() { throw new Error("external_navigation_in_fixture"); } }
});
let pageTitle = null, titleStages = [];
app.on("browser-window-created", (_event, win) => {
  pageTitle = null; titleStages = [];
  win.webContents.once("did-finish-load", async () => {
    const value = await win.webContents.executeJavaScript("({title:document.title,stages:window.titleStages})");
    if (win === state.mainWindow) { pageTitle = value.title; titleStages = value.stages; }
  });
});
let activationCount = 0;
app.on("second-instance", () => { activationCount++; });
app.whenReady().then(async () => {
  // Secondary instances must exit through the production lock path.
  if (!app.hasSingleInstanceLock()) return;
  await registerPlasmaLauncher({ app: { isPackaged: true }, dataHome: process.env.XDG_DATA_HOME,
    environment: { APPIMAGE: process.env.PLASMA_DASHBOARD_EXECUTABLE } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  state.dashboardPort = server.address().port;
  if (!process.argv.includes("--background") || state.openWindowWhenReady) state.showDashboardWindow(state.dashboardPort);
  setInterval(() => {
    const command = path.join(profile, "command");
    if (fs.existsSync(command)) {
      const action = fs.readFileSync(command, "utf8"); fs.unlinkSync(command);
      if (action === "close") state.mainWindow?.close();
      if (action === "hide") state.mainWindow?.hide();
      if (action === "minimize") state.mainWindow?.minimize();
      if (action === "quit") { server.close(); app.quit(); return; }
    }
    const win = state.mainWindow;
    fs.writeFileSync(path.join(profile, "state.tmp"), JSON.stringify({ pid: process.pid, activationCount,
      id: win?.id || null, nativeTitle: win?.getTitle() || null, pageTitle, titleStages,
      visible: Boolean(win?.isVisible()), minimized: Boolean(win?.isMinimized()), focused: Boolean(win?.isFocused()) }));
    fs.renameSync(path.join(profile, "state.tmp"), path.join(profile, "state.json"));
  }, 100);
});
