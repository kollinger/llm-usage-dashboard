"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SIZE = Object.freeze({ width: 780, height: 700 });
const MIN_SIZE = Object.freeze({ width: 420, height: 320 });
const PROVIDERS = new Set(["all", "gpt", "claude", "kimi", "glm", "openai", "anthropic", "moonshot", "copilot", "gemini"]);

function widgetPreferences(value = {}) {
  return {
    favorites: Array.isArray(value?.favorites) ? [...new Set(value.favorites.filter((id) => /^widget-[a-f0-9]{24}$/.test(id)))].slice(0, 512) : [],
    view: value?.view === "favorites" ? "favorites" : "all",
    provider: PROVIDERS.has(value?.provider) ? value.provider : "all",
    scale: [1, 1.15, 1.3].includes(value?.scale) ? value.scale : 1
  };
}

function restoreWidgetBounds(saved, displays, primary = displays[0]) {
  const areas = displays.map((display) => display.workArea);
  const fallback = primary.workArea;
  const numeric = (value) => typeof value === "number" && Number.isFinite(value);
  const candidate = saved && ["x", "y", "width", "height"].every((key) => numeric(saved[key])) ? saved : null;
  // Prefer the display containing the saved titlebar; otherwise recover to the
  // primary work area. Clamp the entire window, including its titlebar.
  const area = candidate && areas.find((rect) => candidate.x >= rect.x && candidate.x < rect.x + rect.width &&
    candidate.y >= rect.y && candidate.y < rect.y + rect.height) || fallback;
  const width = Math.min(area.width, Math.max(MIN_SIZE.width, Math.round(candidate?.width || DEFAULT_SIZE.width)));
  const height = Math.min(area.height, Math.max(MIN_SIZE.height, Math.round(candidate?.height || DEFAULT_SIZE.height)));
  return { width, height,
    x: Math.round(Math.max(area.x, Math.min(candidate?.x ?? area.x + (area.width - width) / 2, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(candidate?.y ?? area.y + (area.height - height) / 2, area.y + area.height - height))) };
}

function trustedFrame(event, window, expectedUrl) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) return false;
  try {
    const actual = new URL(event.senderFrame.url), expected = new URL(expectedUrl);
    return actual.origin === expected.origin && actual.pathname === expected.pathname && !actual.search;
  } catch { return false; }
}

function createDesktopWidget({ BrowserWindow, ipcMain, screen, origin, stateFile, getMainWindow,
  getTheme, getLanguage, showDashboard, isWayland = false }) {
  let window = null, saveTimer = null, disposed = false, settings = {};
  try { settings = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* First run or damaged local settings. */ }
  settings = { bounds: settings?.bounds, pinned: settings?.pinned === true, preferences: widgetPreferences(settings?.preferences) };
  const widgetUrl = `${origin}/widget.html`;
  const mainUrl = `${origin}/`;
  const pinSupported = !isWayland;
  const state = () => ({ pinned: pinSupported && Boolean(window && !window.isDestroyed() && window.isAlwaysOnTop()),
    pinSupported, wayland: isWayland, preferences: settings.preferences });
  const persist = () => {
    clearTimeout(saveTimer); saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const temporary = `${stateFile}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, stateFile);
    } catch { /* Keep usable in-memory settings on read-only storage. */ }
  };
  const rememberBounds = () => {
    if (!window || window.isDestroyed() || window.isMinimized() || window.isMaximized()) return;
    const bounds = window.getBounds();
    // Wayland reports fictitious global coordinates (0, 0). Persist size only.
    settings.bounds = isWayland ? { ...settings.bounds, width: bounds.width, height: bounds.height } : bounds;
    clearTimeout(saveTimer); saveTimer = setTimeout(persist, 150);
  };
  const fitDisplays = () => {
    if (!window || window.isDestroyed()) return;
    const displays = screen.getAllDisplays(), primary = screen.getPrimaryDisplay();
    const bounds = restoreWidgetBounds(window.getBounds(), displays, primary);
    window.setMinimumSize(Math.min(MIN_SIZE.width, bounds.width), Math.min(MIN_SIZE.height, bounds.height));
    if (isWayland) window.setSize(bounds.width, bounds.height);
    else window.setBounds(bounds);
    rememberBounds();
  };
  function open() {
    if (disposed) return;
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show(); window.focus(); return state();
    }
    const displays = screen.getAllDisplays(), primary = screen.getPrimaryDisplay();
    const saved = isWayland ? { x: primary.workArea.x, y: primary.workArea.y,
      width: settings.bounds?.width || DEFAULT_SIZE.width, height: settings.bounds?.height || DEFAULT_SIZE.height } : settings.bounds;
    const bounds = restoreWidgetBounds(saved, displays, primary);
    const { x, y, ...size } = bounds;
    const theme = getTheme();
    window = new BrowserWindow({ ...(isWayland ? size : bounds),
      minWidth: Math.min(MIN_SIZE.width, bounds.width), minHeight: Math.min(MIN_SIZE.height, bounds.height),
      title: "LLM Usage Dashboard", backgroundColor: theme.color, show: false,
      autoHideMenuBar: true, maximizable: false, fullscreenable: false,
      webPreferences: { preload: path.join(__dirname, "widget-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true,
        additionalArguments: [`--llm-usage-theme=${theme.preference}`, `--llm-usage-language=${getLanguage() || ""}`] }
    });
    const created = window;
    if (pinSupported) window.setAlwaysOnTop(settings.pinned, "floating");
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const guardNavigation = (event, target) => {
      const url = typeof target === "string" ? target : event.url;
      if (url !== widgetUrl) event.preventDefault();
    };
    window.webContents.on("will-navigate", guardNavigation);
    window.webContents.on("will-frame-navigate", guardNavigation);
    window.webContents.on("will-redirect", guardNavigation);
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.once("ready-to-show", () => { if (!created.isDestroyed()) created.show(); });
    window.on("move", rememberBounds); window.on("resize", rememberBounds);
    window.on("close", () => { rememberBounds(); persist(); });
    window.on("closed", () => { if (window === created) window = null; });
    window.loadURL(widgetUrl).catch(() => { if (!created.isDestroyed()) created.close(); });
    return state();
  }
  const channels = {
    "widget:open": (event) => {
      const main = getMainWindow();
      if (!trustedFrame(event, main, mainUrl) && !trustedFrame(event, main, `${origin}/index.html`)) throw new Error("untrusted_widget_request");
      return open();
    },
    "widget:state": () => state(),
    "widget:pin": (_event, pinned) => {
      if (typeof pinned !== "boolean") throw new Error("invalid_widget_setting");
      if (pinSupported) { window.setAlwaysOnTop(pinned, "floating"); settings.pinned = window.isAlwaysOnTop(); persist(); }
      return state();
    },
    "widget:preferences": (_event, preferences) => {
      settings.preferences = widgetPreferences(preferences); persist(); return state();
    },
    "widget:dashboard": (_event, target) => {
      if (!["dashboard", "accounts"].includes(target)) throw new Error("invalid_widget_target");
      showDashboard(target); return true;
    },
    "widget:close": () => { window.close(); return true; }
  };
  for (const [channel, handler] of Object.entries(channels)) ipcMain.handle(channel, (event, ...args) => {
    if (channel !== "widget:open" && !trustedFrame(event, window, widgetUrl)) throw new Error("untrusted_widget_request");
    return handler(event, ...args);
  });
  for (const event of ["display-removed", "display-metrics-changed"]) screen.on(event, fitDisplays);
  return {
    open, state, getWindow: () => window,
    updateTheme(theme) {
      if (!window || window.isDestroyed()) return;
      window.setBackgroundColor(theme.color);
      window.webContents.send("widget:appearance", { theme: theme.preference, language: getLanguage() });
    },
    dispose() {
      disposed = true;
      if (window && !window.isDestroyed()) { window.close(); if (window && !window.isDestroyed()) window.destroy(); }
      persist();
      for (const channel of Object.keys(channels)) ipcMain.removeHandler(channel);
      for (const event of ["display-removed", "display-metrics-changed"]) screen.removeListener(event, fitDisplays);
    }
  };
}

module.exports = { createDesktopWidget, widgetPreferences, restoreWidgetBounds, trustedFrame, DEFAULT_SIZE, MIN_SIZE };
