"use strict";

const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { app, BrowserWindow, shell, Notification, dialog } = require("electron");

let dashboardServer = null;
let ollamaProxyServer = null;
let mainWindow = null;
let dashboardPort = null;
let openWindowWhenReady = false;
let claudeBrowserSyncPending = null;
let instanceMarkerPath = null;
let macNotificationDiagnosticsPending = null;
let notificationCheckPending = null;
let updateCheckPending = null;
let autoUpdaterRef = null;
let autoUpdaterReady = false;

// Cooldown tracking: key = windowLabel+type, value = timestamp last notified
const notificationCooldowns = new Map();
const activeNotifications = new Set();
const NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const NOTIFICATION_POLL_INTERVAL_MS = 60 * 1000; // 1 minute
const NOTIFICATION_TEST_POLL_INTERVAL_MS = 5 * 1000; // 5 seconds for test-pending checks
const NOTIFICATION_REQUEST_TIMEOUT_MS = 90 * 1000; // Local usage scans can take 25-30s on real data.
const NOTIFICATION_LANGUAGE_STORAGE_KEY = "llmUsage.language";
const NOTIFICATION_FALLBACK_LANGUAGE = "de";
const NOTIFICATION_I18N_DIR = path.join(__dirname, "..", "public", "i18n");
const UPDATE_POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const UPDATE_REQUEST_POLL_INTERVAL_MS = 5 * 1000;
const SQLITE_BINARY = "/usr/bin/sqlite3";
const CLAUDE_SYNC_INTERVAL_MS = 60 * 1000;
const CLAUDE_BROWSER_SYNC_ENDPOINT = "/api/claude/browser-credits";
const CLAUDE_SYNC_TOKEN_HEADER = "x-llm-usage-sync-token";
const BACKGROUND_START_ARG = "--background";
const LINUX_AUTOSTART_ID = "local.llm-usage-dashboard";
const INSTANCE_MARKER_DIR = path.join(os.tmpdir(), "llm-usage-dashboard");
const CLAUDE_COOKIE_CANDIDATE_NAMES = ["sessionKey", "__Secure-next-auth.session-token", "sessionKeyLC"];
const CLAUDE_CHROME_COOKIE_DB = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "Default",
  "Cookies"
);
const CLAUDE_SAFARI_COOKIE_FILE = path.join(os.homedir(), "Library", "Cookies", "Cookies.binarycookies");
const CLAUDE_APP_CACHE_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude",
  "Cache",
  "Cache_Data"
);
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const execFileAsync = promisify(execFile);
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (commandLine.includes(BACKGROUND_START_ARG)) return;
    if (dashboardPort) {
      showDashboardWindow(dashboardPort);
    } else {
      openWindowWhenReady = true;
    }
  });
}

function setDefaultEnv(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

function configureDashboardEnv() {
  setDefaultEnv("PORT", "0");
  setDefaultEnv("LLM_USAGE_DATA_DIR", path.join(app.getPath("userData"), "data"));
  setDefaultEnv("OLLAMA_HOST", "http://localhost:11434");
  setDefaultEnv("LLM_USAGE_ELECTRON_SYNC_TOKEN", crypto.randomUUID());
}

async function startBackend() {
  configureDashboardEnv();
  const { startDashboard } = require("../server");
  const servers = startDashboard({ port: Number(process.env.PORT || 0) });
  dashboardServer = servers.dashboardServer;
  ollamaProxyServer = servers.ollamaProxyServer;
  await new Promise((resolve) => dashboardServer.once("listening", resolve));
  const address = dashboardServer.address();
  return typeof address === "object" && address ? address.port : Number(process.env.PORT || 4177);
}

async function writeInstanceMarker(port) {
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  const gid = typeof process.getgid === "function" ? process.getgid() : os.userInfo().gid;
  const user = os.userInfo().username || process.env.USER || "unknown";
  const dataDir = process.env.LLM_USAGE_DATA_DIR || "";
  const version = require("../package.json").version || null;
  await fs.mkdir(INSTANCE_MARKER_DIR, { recursive: true, mode: 0o755 });
  instanceMarkerPath = path.join(INSTANCE_MARKER_DIR, `${uid ?? user}.json`);
  await fs.writeFile(
    instanceMarkerPath,
    `${JSON.stringify({
      app: "llm-usage-dashboard",
      pid: process.pid,
      uid,
      gid,
      user,
      port,
      startedAt: new Date().toISOString(),
      version,
      dataDirHash: crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 24)
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

async function removeInstanceMarker() {
  if (!instanceMarkerPath) return;
  const marker = instanceMarkerPath;
  instanceMarkerPath = null;
  await fs.rm(marker, { force: true });
}

function removeInstanceMarkerSync() {
  if (!instanceMarkerPath) return;
  try {
    fsSync.rmSync(instanceMarkerPath, { force: true });
  } catch {
    // Best-effort cleanup during process exit.
  }
  instanceMarkerPath = null;
}

function createWindow(port) {
  const appUrl = `http://localhost:${port}`;
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 980,
    minHeight: 680,
    title: "LLM Usage Dashboard",
    backgroundColor: "#f6f7f4",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.loadURL(appUrl);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showDashboardWindow(port) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow(port);
}

async function configureBackgroundLoginItem() {
  if (!app.isPackaged) return;
  if (String(process.env.LLM_USAGE_AUTO_LAUNCH || "true").toLowerCase() === "false") return;
  try {
    if (process.platform === "darwin") {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    } else if (process.platform === "win32") {
      app.setLoginItemSettings({ openAtLogin: true, args: [BACKGROUND_START_ARG] });
    } else if (process.platform === "linux") {
      await configureLinuxAutostart();
    }
  } catch {
    // Login-item setup is best-effort and should not block the dashboard.
  }
}

async function configureLinuxAutostart() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const autostartDir = path.join(configHome, "autostart");
  const autostartFile = path.join(autostartDir, `${LINUX_AUTOSTART_ID}.desktop`);
  const desktopEntry = [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=LLM Usage Dashboard",
    "Comment=Start LLM Usage Dashboard in the background",
    `Exec=${desktopExecQuote(linuxAutostartExecPath())} ${BACKGROUND_START_ARG}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    ""
  ].join("\n");
  await fs.mkdir(autostartDir, { recursive: true });
  await fs.writeFile(autostartFile, desktopEntry, "utf8");
}

function linuxAutostartExecPath() {
  return process.env.APPIMAGE || process.execPath;
}

function desktopExecQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shouldOpenInitialWindow() {
  if (process.argv.includes(BACKGROUND_START_ARG)) return false;
  try {
    const settings = app.getLoginItemSettings();
    if (settings.wasOpenedAsHidden) return false;
  } catch {
    // Fall through to opening a normal window.
  }
  return true;
}

function closeServer(server) {
  if (!server?.listening) return;
  server.close();
}

function alertKey(alert) {
  return `${alert.windowLabel}:${alert.type}`;
}

function normalizeNotificationLanguage(language) {
  const base = String(language || "")
    .trim()
    .toLowerCase()
    .split(/[_.-]/)[0];
  if (!base) return null;
  return fsSync.existsSync(path.join(NOTIFICATION_I18N_DIR, `${base}.json`)) ? base : null;
}

const notificationTranslationCache = new Map();

function readNotificationTranslations(language) {
  const normalized = normalizeNotificationLanguage(language) || NOTIFICATION_FALLBACK_LANGUAGE;
  if (notificationTranslationCache.has(normalized)) return notificationTranslationCache.get(normalized);
  try {
    const translations = JSON.parse(fsSync.readFileSync(path.join(NOTIFICATION_I18N_DIR, `${normalized}.json`), "utf8"));
    notificationTranslationCache.set(normalized, translations);
    return translations;
  } catch {
    if (normalized !== NOTIFICATION_FALLBACK_LANGUAGE) return readNotificationTranslations(NOTIFICATION_FALLBACK_LANGUAGE);
    notificationTranslationCache.set(normalized, {});
    return {};
  }
}

function notificationTranslationValue(translations, key) {
  return String(key || "")
    .split(".")
    .reduce((current, part) => (current && typeof current === "object" ? current[part] : undefined), translations);
}

function notificationT(language, key, values = {}) {
  const translations = readNotificationTranslations(language);
  const fallbackTranslations = language === NOTIFICATION_FALLBACK_LANGUAGE ? translations : readNotificationTranslations(NOTIFICATION_FALLBACK_LANGUAGE);
  const template = notificationTranslationValue(translations, key) ?? notificationTranslationValue(fallbackTranslations, key) ?? key;
  return String(template).replace(/\{(\w+)\}/g, (_match, name) => values[name] ?? "");
}

async function getNotificationLanguage() {
  const candidates = [];
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      candidates.push(await mainWindow.webContents.executeJavaScript(
        `(() => {
          try {
            return localStorage.getItem(${JSON.stringify(NOTIFICATION_LANGUAGE_STORAGE_KEY)}) ||
              document.documentElement.lang ||
              navigator.language ||
              "";
          } catch {
            return "";
          }
        })()`,
        true
      ));
    } catch {
      // The window may still be loading; fall through to app/system locale.
    }
  }
  candidates.push(app.getLocale?.(), process.env.LANG, NOTIFICATION_FALLBACK_LANGUAGE);
  for (const candidate of candidates) {
    const normalized = normalizeNotificationLanguage(candidate);
    if (normalized) return normalized;
  }
  return NOTIFICATION_FALLBACK_LANGUAGE;
}

function notificationWindowKey(alert) {
  const raw = String(alert?.windowKey || alert?.window_key || alert?.key || alert?.windowLabel || alert?.label || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!raw) return "generic";
  if (/fable/.test(raw)) return "fable";
  if (/sonnet/.test(raw)) return "sonnetOnly";
  if (/design/.test(raw)) return "claudeDesign";
  if (/5h|five_hour|fivehour|current_session|session|primary/.test(raw)) return "fiveHour";
  if (/week|weekly|seven_day|7d|woche|all_models|secondary/.test(raw)) return "weekly";
  return "generic";
}

function localizedNotificationWindowLabel(alert, language) {
  const key = notificationWindowKey(alert);
  const translationKey = {
    fiveHour: "settings.notifications.nativeWindowFiveHour",
    weekly: "settings.notifications.nativeWindowWeekly",
    fable: "settings.notifications.nativeWindowFable",
    sonnetOnly: "settings.notifications.nativeWindowSonnetOnly",
    claudeDesign: "settings.notifications.nativeWindowClaudeDesign",
    generic: "settings.notifications.nativeWindowGeneric"
  }[key] || "settings.notifications.nativeWindowGeneric";
  return notificationT(language, translationKey);
}

function formatNotificationDuration(minutes, language) {
  const totalMinutes = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  if (hours > 0 && remainingMinutes > 0) {
    return notificationT(language, "settings.notifications.nativeDurationHoursMinutes", {
      hours,
      minutes: remainingMinutes
    });
  }
  if (hours > 0) {
    return notificationT(language, "settings.notifications.nativeDurationHours", { hours });
  }
  return notificationT(language, "settings.notifications.nativeDurationMinutes", { minutes: remainingMinutes });
}

function buildNotificationTitle(alert, language) {
  return notificationT(language, "settings.notifications.nativeAlertTitle", {
    window: localizedNotificationWindowLabel(alert, language)
  });
}

function buildNotificationBody(alert, language) {
  const usedPercent = Math.round(Number(alert.usedPercent) || 0);
  if (alert.type === "hard_limit") {
    return [
      notificationT(language, "settings.notifications.nativeUsedPercent", { percent: usedPercent }),
      notificationT(language, "settings.notifications.nativeHardLimit")
    ].join(" ");
  }
  const projectedPercent = Math.round(Number(alert.projectedPercent) || 0);
  const parts = [
    notificationT(language, "settings.notifications.nativePacingProjected", {
      usedPercent,
      projectedPercent
    })
  ];
  if (alert.exhaustInMinutes !== null && alert.exhaustInMinutes >= 0) {
    parts.push(notificationT(language, "settings.notifications.nativeEstimatedExhaustion", {
      time: formatNotificationDuration(alert.exhaustInMinutes, language)
    }));
  }
  return parts.join(" ");
}

function getNotificationStatusFile() {
  const dataDir = process.env.LLM_USAGE_DATA_DIR || path.join(app.getPath("userData"), "data");
  return path.join(dataDir, "notification-status.json");
}

async function writeNotificationStatus(updates) {
  const filePath = getNotificationStatusFile();
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let current = {};
    try { current = JSON.parse(await fs.readFile(filePath, "utf8")); } catch { /* file may not exist yet */ }
    const macNotificationDiagnostics = await getMacNotificationDiagnostics();
    await fs.writeFile(filePath, `${JSON.stringify({ ...current, ...updates, macNotificationDiagnostics }, null, 2)}\n`, { mode: 0o600 });
  } catch { /* best-effort; never block polling */ }
}

async function getMacNotificationDiagnostics() {
  if (process.platform !== "darwin") {
    return {
      platform: process.platform,
      nativeDelivery: "not_applicable",
      bundleId: null,
      codeSignature: null,
      gatekeeper: null
    };
  }
  if (!macNotificationDiagnosticsPending) {
    macNotificationDiagnosticsPending = (async () => {
      let bundleId = null;
      let codeSignature = "unknown";
      let gatekeeper = "unknown";
      try {
        const { stdout, stderr } = await execFileAsync("/usr/bin/codesign", ["-dv", "--verbose=4", process.execPath], { timeout: 5000 });
        const output = `${stdout || ""}\n${stderr || ""}`;
        const identifierMatch = output.match(/^Identifier=(.+)$/m);
        if (identifierMatch) bundleId = identifierMatch[1].trim();
        if (/Signature=adhoc/.test(output) || /TeamIdentifier=not set/.test(output)) {
          codeSignature = "adhoc";
        } else if (/TeamIdentifier=/.test(output)) {
          codeSignature = "signed";
        }
      } catch (error) {
        const output = `${error?.stdout || ""}\n${error?.stderr || ""}`;
        const identifierMatch = output.match(/^Identifier=(.+)$/m);
        if (identifierMatch) bundleId = identifierMatch[1].trim();
        if (/Signature=adhoc/.test(output) || /TeamIdentifier=not set/.test(output)) {
          codeSignature = "adhoc";
        } else {
          codeSignature = "invalid";
        }
      }

      try {
        const bundlePath = path.resolve(path.dirname(process.execPath), "..", "..");
        await execFileAsync("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", bundlePath], { timeout: 5000 });
        gatekeeper = "accepted";
      } catch (error) {
        const output = `${error?.stdout || ""}\n${error?.stderr || ""}`;
        gatekeeper = /rejected/i.test(output) ? "rejected" : "unknown";
      }

      let nativeDelivery = "unverified";
      if (gatekeeper === "rejected") {
        nativeDelivery = "gatekeeper_rejected";
      } else if (codeSignature === "adhoc" || codeSignature === "invalid") {
        nativeDelivery = "ad_hoc";
      } else if (codeSignature === "signed" && gatekeeper === "accepted") {
        nativeDelivery = "ready";
      }

      return {
        platform: "darwin",
        nativeDelivery,
        bundleId,
        appName: app.getName(),
        codeSignature,
        gatekeeper
      };
    })();
  }
  try {
    return await macNotificationDiagnosticsPending;
  } catch {
    return {
      platform: "darwin",
      nativeDelivery: "unverified",
      bundleId: null,
      appName: app.getName(),
      codeSignature: "unknown",
      gatekeeper: "unknown"
    };
  }
}

function requestNotificationAttention() {
  try {
    if (process.platform === "darwin" && app.dock?.bounce) {
      app.dock.bounce("informational");
    } else {
      mainWindow?.flashFrame?.(true);
      setTimeout(() => mainWindow?.flashFrame?.(false), 5000).unref?.();
    }
  } catch {
    // Best-effort fallback only.
  }
}

function showNativeNotification(options, onClick) {
  if (!Notification.isSupported()) return Promise.resolve({ result: "not_supported", error: null });
  return new Promise((resolve) => {
    let notification = null;
    let settled = false;
    let timeout = null;
    let releaseTimer = null;
    const settle = (result, error = null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ result, error });
    };
    try {
      notification = new Notification(options);
      activeNotifications.add(notification);
      releaseTimer = setTimeout(() => activeNotifications.delete(notification), 60 * 1000);
      releaseTimer.unref?.();
      notification.once("show", () => settle("sent"));
      notification.once("failed", (_event, error) => settle("error", error || "notification_failed"));
      notification.once("close", () => {
        if (releaseTimer) clearTimeout(releaseTimer);
        activeNotifications.delete(notification);
      });
      if (onClick) notification.on("click", onClick);
      timeout = setTimeout(() => settle("sent"), 2500);
      timeout.unref?.();
      notification.show();
    } catch (err) {
      if (releaseTimer) clearTimeout(releaseTimer);
      if (notification) activeNotifications.delete(notification);
      settle("error", err.message || String(err));
    }
  });
}

async function fetchLocalJson(port, urlPath) {
  const http = require("node:http");
  const token = process.env.LLM_USAGE_ELECTRON_SYNC_TOKEN;
  if (!token) return null;
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "localhost", port, path: urlPath, headers: { [CLAUDE_SYNC_TOKEN_HEADER]: token } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      }
    );
    req.on("error", reject);
    req.setTimeout(NOTIFICATION_REQUEST_TIMEOUT_MS, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function getUpdateSettingsFile() {
  const dataDir = process.env.LLM_USAGE_DATA_DIR || path.join(app.getPath("userData"), "data");
  return path.join(dataDir, "update-settings.json");
}

function getUpdateStatusFile() {
  const dataDir = process.env.LLM_USAGE_DATA_DIR || path.join(app.getPath("userData"), "data");
  return path.join(dataDir, "update-status.json");
}

function sanitizeUpdateSettings(settings) {
  return {
    enabled: true,
    allowPrerelease: typeof settings?.allowPrerelease === "boolean" ? settings.allowPrerelease : true
  };
}

async function readUpdateSettings() {
  try {
    const data = JSON.parse(await fs.readFile(getUpdateSettingsFile(), "utf8"));
    return sanitizeUpdateSettings(data);
  } catch {
    return sanitizeUpdateSettings({});
  }
}

async function writeUpdateStatus(updates) {
  const filePath = getUpdateStatusFile();
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let current = {};
    try { current = JSON.parse(await fs.readFile(filePath, "utf8")); } catch { /* file may not exist yet */ }
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        ...current,
        ...updates,
        isElectron: true,
        platform: process.platform,
        appVersion: app.getVersion(),
        updatedAt: new Date().toISOString()
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
  } catch {
    // Best-effort diagnostics; updater behavior should not depend on status writes.
  }
}

async function getAutoUpdateSupport() {
  if (!app.isPackaged) {
    return { supported: false, supportStatus: "development_build", macDiagnostics: null };
  }
  if (process.platform === "darwin") {
    const macDiagnostics = await getMacNotificationDiagnostics();
    if (macDiagnostics.codeSignature !== "signed") {
      return { supported: false, supportStatus: "macos_signing_required", macDiagnostics };
    }
    return {
      supported: true,
      supportStatus: macDiagnostics.gatekeeper === "accepted" ? "ready" : "macos_gatekeeper_warning",
      macDiagnostics
    };
  }
  if (process.platform === "win32" || process.platform === "linux") {
    return { supported: true, supportStatus: "ready", macDiagnostics: null };
  }
  return { supported: false, supportStatus: "unsupported_platform", macDiagnostics: null };
}

function registerAutoUpdaterEvents(autoUpdater) {
  autoUpdater.on("checking-for-update", () => {
    writeUpdateStatus({
      state: "checking",
      lastCheckAt: new Date().toISOString(),
      downloadPercent: null,
      lastError: null
    }).catch(() => {});
  });
  autoUpdater.on("update-available", (info) => {
    writeUpdateStatus({
      state: "available",
      availableVersion: info?.version || null,
      releaseName: info?.releaseName || null,
      releaseDate: info?.releaseDate || null,
      lastError: null
    }).catch(() => {});
  });
  autoUpdater.on("download-progress", (progress) => {
    writeUpdateStatus({
      state: "downloading",
      downloadPercent: Number.isFinite(Number(progress?.percent)) ? Math.round(Number(progress.percent)) : null
    }).catch(() => {});
  });
  autoUpdater.on("update-not-available", () => {
    writeUpdateStatus({
      state: "up_to_date",
      availableVersion: null,
      downloadedVersion: null,
      downloadPercent: null,
      lastError: null
    }).catch(() => {});
  });
  autoUpdater.on("update-downloaded", (info) => {
    writeUpdateStatus({
      state: "downloaded",
      downloadedVersion: info?.version || null,
      releaseName: info?.releaseName || null,
      releaseDate: info?.releaseDate || null,
      lastError: null
    }).catch(() => {});
    showUpdateReadyDialog(info).catch(() => {});
  });
  autoUpdater.on("error", (error) => {
    writeUpdateStatus({
      state: "error",
      lastError: error?.message || String(error || "update_error")
    }).catch(() => {});
  });
}

async function ensureAutoUpdater() {
  const settings = await readUpdateSettings();
  const support = await getAutoUpdateSupport();
  const setupStatus = {
    enabled: settings.enabled,
    allowPrerelease: settings.allowPrerelease,
    supported: support.supported,
    supportStatus: support.supportStatus,
    macDiagnostics: support.macDiagnostics
  };
  if (!support.supported) setupStatus.state = support.supportStatus;
  await writeUpdateStatus(setupStatus);
  if (!support.supported) return { ok: false, reason: support.supportStatus };
  if (!autoUpdaterRef) {
    let autoUpdater;
    try {
      ({ autoUpdater } = require("electron-updater"));
    } catch (error) {
      await writeUpdateStatus({ state: "error", lastError: error?.message || "electron_updater_missing" });
      return { ok: false, reason: "electron_updater_missing" };
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    registerAutoUpdaterEvents(autoUpdater);
    autoUpdaterRef = autoUpdater;
  }
  autoUpdaterRef.allowPrerelease = settings.allowPrerelease;
  autoUpdaterReady = true;
  return { ok: true, autoUpdater: autoUpdaterRef };
}

async function checkForUpdates(reason = "scheduled") {
  if (updateCheckPending) return updateCheckPending;
  updateCheckPending = (async () => {
    const ready = await ensureAutoUpdater();
    if (!ready.ok) {
      await writeUpdateStatus({ state: ready.reason, lastCheckReason: reason });
      return;
    }
    await writeUpdateStatus({
      state: "checking",
      lastCheckAt: new Date().toISOString(),
      lastCheckReason: reason,
      downloadPercent: null,
      lastError: null
    });
    await ready.autoUpdater.checkForUpdates();
  })().catch((error) => {
    return writeUpdateStatus({
      state: "error",
      lastError: error?.message || String(error || "update_check_failed")
    });
  }).finally(() => {
    updateCheckPending = null;
  });
  return updateCheckPending;
}

async function showUpdateReadyDialog(info) {
  const version = info?.version || "new";
  const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const options = {
    type: "info",
    title: "Update ready",
    message: `Version ${version} is ready to install.`,
    detail: "Restart LLM Usage Dashboard to apply the update.",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1
  };
  const result = targetWindow
    ? await dialog.showMessageBox(targetWindow, options)
    : await dialog.showMessageBox(options);
  if (result.response === 0 && autoUpdaterRef) {
    autoUpdaterRef.quitAndInstall();
  }
}

async function startAutoUpdatePolling(port) {
  await ensureAutoUpdater();
  setTimeout(() => checkForUpdates("startup").catch(() => {}), 10000);
  setInterval(() => checkForUpdates("scheduled").catch(() => {}), UPDATE_POLL_INTERVAL_MS);
  setInterval(() => checkUpdateCheckPending(port), UPDATE_REQUEST_POLL_INTERVAL_MS);
}

async function checkUpdateCheckPending(port) {
  try {
    const data = await fetchLocalJson(port, "/api/updates/check-pending");
    if (data?.pending) {
      await checkForUpdates("manual");
    } else if (!autoUpdaterReady) {
      await ensureAutoUpdater();
    }
  } catch { /* ignore; server may not be ready yet */ }
}

async function checkNotifications(port) {
  const startAt = Date.now();
  const notificationSupported = Notification.isSupported();
  let lastError = null;
  let lastAlertCount = 0;
  let lastAlerts = [];
  let lastShownAt = null;
  let lastShownAlert = null;
  let lastSkippedReason = null;
  try {
    const data = await fetchLocalJson(port, "/api/notifications/check");
    const durationMs = Date.now() - startAt;
    if (!data?.alerts?.length) {
      app.setBadgeCount?.(0);
      await writeNotificationStatus({
        lastCheckAt: new Date(startAt).toISOString(),
        lastCheckDurationMs: durationMs,
        lastAlertCount: 0,
        lastAlerts: [],
        lastShownAt: null,
        lastShownAlert: null,
        lastSkippedReason: null,
        lastError: null,
        notificationSupported
      });
      return;
    }
    lastAlertCount = data.alerts.length;
    lastAlerts = data.alerts;
    const now = Date.now();
    const notificationLanguage = await getNotificationLanguage();
    for (const alert of data.alerts) {
      const key = alertKey(alert);
      const lastShown = notificationCooldowns.get(key) || 0;
      if (now - lastShown < NOTIFICATION_COOLDOWN_MS) {
        lastSkippedReason = `cooldown:${key}`;
        continue;
      }
      notificationCooldowns.set(key, now);
      if (notificationSupported) {
        const title = buildNotificationTitle(alert, notificationLanguage);
        const body = buildNotificationBody(alert, notificationLanguage);
        const delivery = await showNativeNotification({ title, body, silent: false }, () => {
          if (dashboardPort) showDashboardWindow(dashboardPort);
        });
        if (delivery.result === "error") {
          lastSkippedReason = `notification_failed:${delivery.error}`;
        } else {
          requestNotificationAttention();
          lastShownAt = new Date().toISOString();
          lastShownAlert = alert;
        }
      } else {
        lastSkippedReason = "notification_not_supported";
      }
    }
    app.setBadgeCount?.(data.alerts.length);
    await writeNotificationStatus({
      lastCheckAt: new Date(startAt).toISOString(),
      lastCheckDurationMs: durationMs,
      lastAlertCount,
      lastAlerts,
      lastShownAt,
      lastShownAlert,
      lastSkippedReason,
      lastError: null,
      notificationSupported
    });
  } catch (err) {
    lastError = err.message || String(err);
    await writeNotificationStatus({
      lastCheckAt: new Date(startAt).toISOString(),
      lastCheckDurationMs: Date.now() - startAt,
      lastError,
      notificationSupported
    });
  }
}

function pollNotifications(port) {
  if (notificationCheckPending) return notificationCheckPending;
  notificationCheckPending = checkNotifications(port).finally(() => {
    notificationCheckPending = null;
  });
  return notificationCheckPending;
}

async function fireTestNotification() {
  const notificationSupported = Notification.isSupported();
  const lastTestAt = new Date().toISOString();
  if (!notificationSupported) {
    await writeNotificationStatus({ lastTestAt, lastTestResult: "not_supported", lastTestError: null });
    return;
  }
  try {
    const notificationLanguage = await getNotificationLanguage();
    const delivery = await showNativeNotification({
      title: notificationT(notificationLanguage, "settings.notifications.testTitle"),
      body: notificationT(notificationLanguage, "settings.notifications.testBody"),
      silent: false
    }, () => {
      if (dashboardPort) showDashboardWindow(dashboardPort);
      else mainWindow?.show();
    });
    if (delivery.result !== "error") requestNotificationAttention();
    await writeNotificationStatus({
      lastTestAt,
      lastTestResult: delivery.result === "error" ? "error" : delivery.result,
      lastTestError: delivery.error
    });
  } catch (err) {
    await writeNotificationStatus({ lastTestAt, lastTestResult: "error", lastTestError: err.message });
  }
}

async function checkTestNotificationPending(port) {
  try {
    const data = await fetchLocalJson(port, "/api/notifications/test-pending");
    if (data?.pending) {
      await fireTestNotification();
    }
  } catch { /* ignore; server may not be ready yet */ }
}

async function openSystemNotificationSettings() {
  if (process.platform === "darwin") {
    await shell.openExternal("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
    return;
  }
  if (process.platform === "win32") {
    await shell.openExternal("ms-settings:notifications");
    return;
  }
  if (process.platform === "linux" && openLinuxNotificationSettings()) return;
  await shell.openExternal("https://www.freedesktop.org/wiki/Specifications/desktop-notification-spec/");
}

function openLinuxNotificationSettings() {
  const candidates = [
    ["gnome-control-center", ["notifications"]],
    ["systemsettings", ["kcm_notifications"]],
    ["systemsettings6", ["kcm_notifications"]],
    ["kcmshell6", ["kcm_notifications"]],
    ["kcmshell5", ["kcm_notifications"]],
    ["xfce4-notifyd-config", []],
    ["cinnamon-settings", ["notifications"]]
  ];
  for (const [command, args] of candidates) {
    const executable = findExecutable(command);
    if (!executable) continue;
    try {
      const child = spawn(executable, args, { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    } catch {
      // Try the next known desktop settings app.
    }
  }
  return false;
}

function findExecutable(command) {
  const pathDirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, command);
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

async function checkOpenNotificationSettingsPending(port) {
  try {
    const data = await fetchLocalJson(port, "/api/notifications/open-settings-pending");
    if (data?.pending) {
      await openSystemNotificationSettings();
    }
  } catch { /* ignore; server may not be ready yet */ }
}

async function syncClaudeBrowserCredits(port) {
  if (claudeBrowserSyncPending) return claudeBrowserSyncPending;
  claudeBrowserSyncPending = (async () => {
    try {
      const session = await readClaudeBrowserSession();
      let payload = {
        status: session.status || "missing",
        reason: session.reason || null,
        source: session.source || null,
        cookieName: session.cookieName || null,
        updatedAt: new Date().toISOString()
      };
      if (session.cookieHeader) {
        const billing = await fetchClaudeBillingSnapshot(session.cookieHeader, session.orgId || null);
        payload = {
          ...payload,
          ...billing,
          source: session.source || billing.source || payload.source,
          cookieName: session.cookieName || payload.cookieName,
          updatedAt: new Date().toISOString()
        };
      }
      const cachedBilling = await readClaudeAppCacheBillingSnapshot();
      if (cachedBilling) {
        if (!payload.credits && !payload.billingPayload) {
          payload = {
            ...payload,
            ...cachedBilling,
            cookieName: session.cookieName || payload.cookieName || null
          };
        }
        if (!payload.usage && cachedBilling.usage) {
          payload = {
            ...payload,
            usage: cachedBilling.usage,
            updatedAt: new Date().toISOString()
          };
        }
      }
      await postClaudeBrowserCredits(port, payload);
    } catch {
      await postClaudeBrowserCredits(port, {
        status: "error",
        reason: "sync_failed",
        source: null,
        updatedAt: new Date().toISOString()
      }).catch(() => {});
    }
  })().finally(() => {
    claudeBrowserSyncPending = null;
  });
  return claudeBrowserSyncPending;
}

async function postClaudeBrowserCredits(port, payload) {
  const token = process.env.LLM_USAGE_ELECTRON_SYNC_TOKEN;
  if (!token) return;
  await fetch(`http://localhost:${port}${CLAUDE_BROWSER_SYNC_ENDPOINT}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CLAUDE_SYNC_TOKEN_HEADER]: token
    },
    body: JSON.stringify(payload)
  });
}

async function readClaudeBrowserSession() {
  const chrome = await readChromeClaudeSession();
  if (chrome.cookieHeader) return chrome;
  const safari = await readSafariClaudeSession();
  if (safari.cookieHeader) return safari;
  return preferredClaudeSessionResult(chrome, safari);
}

function preferredClaudeSessionResult(...results) {
  return (
    results.find((result) => result.status === "unsupported") ||
    results.find((result) => result.status === "expired") ||
    results.find((result) => result.status === "missing") ||
    results[0] || { status: "missing", reason: "browser_unavailable", source: null }
  );
}

async function readChromeClaudeSession() {
  if (!(await fileExists(CLAUDE_CHROME_COOKIE_DB))) {
    return { status: "missing", reason: "chrome_cookie_store_missing", source: "chrome" };
  }
  const rows = await readChromeClaudeCookieRows();
  if (!rows.length) return { status: "missing", reason: "claude_cookie_missing", source: "chrome" };
  const chromeKey = await getChromeSafeStorageKey();
  return buildClaudeCookieSession(rows, "chrome", chromeKey || null);
}

async function readChromeClaudeCookieRows() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-usage-chrome-cookies-"));
  const tmpDb = path.join(tmpDir, "Cookies.sqlite");
  try {
    await fs.copyFile(CLAUDE_CHROME_COOKIE_DB, tmpDb);
    const sql = [
      "select host_key, name, value, hex(encrypted_value), path, is_secure",
      "from cookies",
      "where host_key like '%claude.ai%';"
    ].join(" ");
    const { stdout } = await execFileAsync(SQLITE_BINARY, ["-tabs", tmpDb, sql], { maxBuffer: 1024 * 1024 });
    return String(stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [host, name, value, encryptedHex, cookiePath, isSecure] = line.split("\t");
        return {
          domain: host || "",
          name: name || "",
          value: value || "",
          encryptedValue: encryptedHex ? Buffer.from(encryptedHex, "hex") : Buffer.alloc(0),
          path: cookiePath || "/",
          secure: isSecure === "1"
        };
      });
  } catch {
    return [];
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readSafariClaudeSession() {
  if (!(await fileExists(CLAUDE_SAFARI_COOKIE_FILE))) {
    return { status: "missing", reason: "safari_cookie_store_missing", source: "safari" };
  }
  try {
    const rows = parseSafariBinaryCookies(await fs.readFile(CLAUDE_SAFARI_COOKIE_FILE)).filter((cookie) =>
      cookie.domain.includes("claude.ai")
    );
    if (!rows.length) return { status: "missing", reason: "claude_cookie_missing", source: "safari" };
    return buildClaudeCookieSession(rows, "safari");
  } catch {
    return { status: "error", reason: "safari_cookie_parse_failed", source: "safari" };
  }
}

function buildClaudeCookieSession(rows, source, chromeKey = null) {
  const decryptedCookies = [];
  let authCookieName = null;
  let encryptedAuthCookie = false;
  let orgId = null;
  for (const row of rows) {
    const isCandidate = CLAUDE_COOKIE_CANDIDATE_NAMES.includes(row.name);
    if (isCandidate && !authCookieName) authCookieName = row.name;
    const value = decodeBrowserCookieValue(row, chromeKey);
    if (!value) {
      if (isCandidate) encryptedAuthCookie = true;
      continue;
    }
    if (row.name === "lastActiveOrg") orgId = value;
    decryptedCookies.push(`${row.name}=${value}`);
  }
  if (!authCookieName) {
    return { status: "missing", reason: "claude_auth_cookie_missing", source };
  }
  if (!decryptedCookies.some((cookie) => CLAUDE_COOKIE_CANDIDATE_NAMES.some((name) => cookie.startsWith(`${name}=`)))) {
    return {
      status: encryptedAuthCookie ? "unsupported" : "missing",
      reason: encryptedAuthCookie ? "claude_auth_cookie_encrypted" : "claude_auth_cookie_empty",
      source,
      cookieName: authCookieName
    };
  }
  return {
    status: "available",
    reason: null,
    source,
    cookieName: authCookieName,
    cookieHeader: decryptedCookies.join("; "),
    orgId: orgId || null
  };
}

let _chromeAesKey = null;

async function getChromeSafeStorageKey() {
  if (_chromeAesKey !== null) return _chromeAesKey;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password", "-w", "-s", "Chrome Safe Storage"
    ]);
    const password = stdout.trim();
    if (!password) { _chromeAesKey = false; return false; }
    _chromeAesKey = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    return _chromeAesKey;
  } catch {
    _chromeAesKey = false;
    return false;
  }
}

function decodeBrowserCookieValue(row, chromeKey = null) {
  if (row.value) return row.value;
  if (!row.encryptedValue?.length) return "";
  const versionPrefix = row.encryptedValue.subarray(0, 3).toString("utf8");
  if (versionPrefix === "v10" || versionPrefix === "v11") {
    if (!chromeKey) return "";
    try {
      const iv = Buffer.alloc(16, 0x20);
      const ciphertext = row.encryptedValue.subarray(3);
      const decipher = crypto.createDecipheriv("aes-128-cbc", chromeKey, iv);
      decipher.setAutoPadding(true);
      return normalizeDecryptedChromeCookie(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    } catch {
      return "";
    }
  }
  const text = row.encryptedValue.toString("utf8").replace(/\0+$/g, "");
  return /[^\x20-\x7e]/.test(text) ? "" : text;
}

function normalizeDecryptedChromeCookie(decrypted) {
  const raw = decrypted.toString("utf8").replace(/\0+$/, "");
  const withoutHostPrefix = decrypted.subarray(32).toString("utf8").replace(/\0+$/, "");
  if (decrypted.length > 32 && isPrintableCookieValue(withoutHostPrefix)) return withoutHostPrefix;
  return isPrintableCookieValue(raw) ? raw : "";
}

function isPrintableCookieValue(value) {
  return Boolean(value && !/[^\x20-\x7e]/.test(value));
}

async function fetchClaudeBillingSnapshot(cookieHeader, orgId = null) {
  const orgEndpoints = orgId ? [
    `https://claude.ai/api/organizations/${orgId}/usage`,
    `https://claude.ai/api/organizations/${orgId}/overage_spend_limit`,
    `https://claude.ai/api/organizations/${orgId}/prepaid/credits`
  ] : [];
  const endpoints = [
    ...orgEndpoints,
    "https://claude.ai/api/account/billing",
    "https://claude.ai/api/settings/billing",
    "https://claude.ai/api/account",
    "https://claude.ai/settings/billing"
  ];
  const billingPayload = {};
  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json, text/html;q=0.9",
          cookie: cookieHeader,
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36"
        },
        redirect: "manual"
      });
      const location = response.headers.get("location") || "";
      if (response.status === 401 || /\/login/i.test(location)) {
        return { status: "expired", reason: "claude_login_required" };
      }
      if (!response.ok) continue;
      const text = await response.text();
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = JSON.parse(text || "{}");
        if (url.includes("/usage")) {
          billingPayload.usage = {
            ...payload,
            updatedAt: new Date().toISOString()
          };
          continue;
        }
        if (url.includes("/overage_spend_limit")) billingPayload.overageLimit = payload;
        if (url.includes("/prepaid/credits")) billingPayload.prepaidCredits = payload;
        const subscription = findClaudeSubscriptionCandidate(payload);
        if (subscription) billingPayload.subscription = subscription;
        const credits = buildClaudeCreditsFromBillingParts(billingPayload);
        if (credits || subscription) {
          return {
            status: "available",
            reason: null,
            credits: credits || null,
            subscription: subscription || null,
            usage: billingPayload.usage || null
          };
        }
        if (findUsageCreditsCandidate(payload)) {
          return { status: "available", reason: null, billingPayload: payload, usage: billingPayload.usage || null };
        }
        continue;
      }
      const credits = extractClaudeCreditsFromHtml(text);
      const subscription = extractClaudeSubscriptionFromHtml(text);
      if (credits || subscription) {
        return {
          status: "available",
          reason: null,
          credits: credits || null,
          subscription: subscription || null,
          usage: billingPayload.usage || null
        };
      }
    } catch {
      // Try the next endpoint candidate.
    }
  }
  const credits = buildClaudeCreditsFromBillingParts(billingPayload);
  if (credits || billingPayload.subscription || billingPayload.usage) {
    return {
      status: "available",
      reason: null,
      credits: credits || null,
      subscription: billingPayload.subscription || null,
      usage: billingPayload.usage || null
    };
  }
  return { status: "missing", reason: "claude_billing_data_unavailable" };
}

async function readClaudeAppCacheBillingSnapshot() {
  if (typeof zlib.zstdDecompressSync !== "function") return null;
  let entries = [];
  try {
    entries = await fs.readdir(CLAUDE_APP_CACHE_DIR, { withFileTypes: true });
  } catch {
    return null;
  }

  const cacheParts = {
    overageLimit: null,
    prepaidCredits: null,
    usage: null
  };
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(CLAUDE_APP_CACHE_DIR, entry.name);
    try {
      const [stats, buffer] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
      const endpoint = detectClaudeCacheEndpoint(buffer);
      if (!endpoint) continue;
      const payload = decodeClaudeCacheJsonPayload(buffer);
      if (!payload) continue;
      const cacheEntry = { payload, mtimeMs: stats.mtimeMs };
      if (endpoint === "overageLimit" && (!cacheParts.overageLimit || stats.mtimeMs >= cacheParts.overageLimit.mtimeMs)) {
        cacheParts.overageLimit = cacheEntry;
      }
      if (
        endpoint === "prepaidCredits" &&
        (!cacheParts.prepaidCredits || stats.mtimeMs >= cacheParts.prepaidCredits.mtimeMs)
      ) {
        cacheParts.prepaidCredits = cacheEntry;
      }
      if (endpoint === "usage" && (!cacheParts.usage || stats.mtimeMs >= cacheParts.usage.mtimeMs)) {
        cacheParts.usage = cacheEntry;
      }
    } catch {
      // Cache entries are best-effort; skip corrupt or locked files.
    }
  }

  const credits = buildClaudeCreditsFromCacheParts(cacheParts);
  const usage = cacheParts.usage
    ? {
        ...cacheParts.usage.payload,
        source: "claude_app_cache",
        updatedAt: new Date(cacheParts.usage.mtimeMs).toISOString()
      }
    : null;
  if (!credits && !usage) return null;
  const updatedAtMs = Math.max(
    cacheParts.overageLimit?.mtimeMs || 0,
    cacheParts.prepaidCredits?.mtimeMs || 0,
    cacheParts.usage?.mtimeMs || 0
  );
  return {
    status: "available",
    reason: null,
    source: "claude_app_cache",
    updatedAt: new Date(updatedAtMs || Date.now()).toISOString(),
    credits: credits || null,
    usage
  };
}

function detectClaudeCacheEndpoint(buffer) {
  if (buffer.includes(Buffer.from("/api/organizations/")) && buffer.includes(Buffer.from("/usage"))) return "usage";
  if (buffer.includes(Buffer.from("/prepaid/credits"))) return "prepaidCredits";
  if (buffer.includes(Buffer.from("/overage_spend_limit"))) return "overageLimit";
  return null;
}

function decodeClaudeCacheJsonPayload(buffer) {
  const frameStart = buffer.indexOf(ZSTD_FRAME_MAGIC);
  if (frameStart === -1) return null;
  try {
    const text = zlib.zstdDecompressSync(buffer.subarray(frameStart)).toString("utf8").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function buildClaudeCreditsFromCacheParts(cacheParts) {
  return buildClaudeCreditsFromBillingParts({
    overageLimit: cacheParts.overageLimit?.payload || null,
    prepaidCredits: cacheParts.prepaidCredits?.payload || null
  });
}

function buildClaudeCreditsFromBillingParts(parts) {
  const limit = parts?.overageLimit || null;
  const prepaid = parts?.prepaidCredits || null;
  const credits = {
    enabled: Boolean(limit?.is_enabled ?? prepaid),
    spentAmount: centsToCreditAmount(limit?.used_credits),
    monthlyLimitAmount: centsToCreditAmount(limit?.monthly_credit_limit),
    currentCreditAmount: centsToCreditAmount(prepaid?.amount),
    currency: normalizeClaudeCurrency(limit?.currency || prepaid?.currency),
    autoTopUp: Boolean(prepaid?.auto_reload_settings?.enabled ?? prepaid?.auto_reload_settings?.is_enabled)
  };
  const hasCreditData =
    credits.enabled ||
    credits.spentAmount > 0 ||
    credits.monthlyLimitAmount > 0 ||
    credits.currentCreditAmount > 0 ||
    credits.autoTopUp;
  return hasCreditData ? credits : null;
}

function centsToCreditAmount(value) {
  if (value === undefined || value === null || value === "") return 0;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number / 100 : 0;
}

function normalizeClaudeCurrency(value) {
  const currency = String(value || "EUR").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "EUR";
}

const CLAUDE_BROWSER_SUBSCRIPTION_PLAN_KEYS = new Set([
  "free",
  "pro",
  "claude pro",
  "max",
  "claude max",
  "max 5x",
  "claude max 5x",
  "max 20x",
  "claude max 20x",
  "20x",
  "team",
  "claude team",
  "enterprise",
  "claude enterprise",
  "business"
]);

function findClaudeSubscriptionCandidate(value, options = {}, seen = new Set()) {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  const direct = sanitizeClaudeSubscriptionCandidate(value, options);
  if (direct) return direct;
  const explicitNested = [
    value.subscription,
    value.billing?.subscription,
    value.account?.subscription
  ];
  for (const candidate of explicitNested) {
    const match = findClaudeSubscriptionCandidate(candidate, { explicitPath: true }, seen);
    if (match) return match;
  }
  const scopedNested = [
    value.account,
    value.billing
  ];
  for (const candidate of scopedNested) {
    const match = findClaudeSubscriptionCandidate(candidate, {}, seen);
    if (match) return match;
  }
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) {
    const match = findClaudeSubscriptionCandidate(entry, {}, seen);
    if (match) return match;
  }
  return null;
}

function sanitizeClaudeSubscriptionCandidate(candidate, options = {}) {
  if (!candidate || typeof candidate !== "object") return null;
  const explicitPlanType = explicitClaudeSubscriptionPlan(candidate);
  const planType = explicitPlanType || (options.explicitPath ? fallbackClaudeSubscriptionPlan(candidate) : "");
  const hasSubscriptionScope = Boolean(options.explicitPath || explicitPlanType);
  if (!hasSubscriptionScope) return null;
  if (planType && !isKnownClaudeBrowserSubscriptionPlan(planType)) return null;
  const monthlyCost = positiveCurrencyAmount(
    candidate.monthlyCost ??
      candidate.monthly_cost ??
      candidate.subscriptionCost ??
      candidate.subscription_cost ??
      candidate.monthlyPrice ??
      candidate.monthly_price ??
      candidate.priceMonthly ??
      candidate.price_monthly ??
      candidate.price?.monthly ??
      (options.explicitPath ? candidate.price?.amount : undefined)
  );
  const monthlyCostCents = positiveCurrencyAmount(
    candidate.monthlyCostCents ??
      candidate.monthly_cost_cents ??
      candidate.monthlyPriceCents ??
      candidate.monthly_price_cents ??
      candidate.subscriptionCostCents ??
      candidate.subscription_cost_cents ??
      (options.explicitPath ? candidate.unitAmount ?? candidate.unit_amount : undefined)
  );
  const normalizedCost = monthlyCost || (monthlyCostCents ? monthlyCostCents / 100 : 0);
  if (!planType && !(normalizedCost > 0)) return null;
  return {
    planType: planType || null,
    monthlyCost: normalizedCost,
    currency: normalizeClaudeCurrency(candidate.currency || candidate.price?.currency),
    source: "claude_browser_sync",
    actualBillingKnown: normalizedCost > 0,
    updatedAt: new Date().toISOString()
  };
}

function explicitClaudeSubscriptionPlan(candidate) {
  const planObject = candidate?.plan && typeof candidate.plan === "object" ? candidate.plan : null;
  return firstNonEmptyString(
    candidate.planType,
    candidate.plan_type,
    planObject?.planType,
    planObject?.plan_type,
    planObject?.type,
    planObject?.name,
    planObject?.displayName,
    planObject?.display_name,
    planObject?.tier,
    typeof candidate.plan === "object" ? "" : candidate.plan,
    candidate.subscriptionType,
    candidate.subscription_type,
    candidate.subscriptionPlan,
    candidate.subscription_plan
  );
}

function fallbackClaudeSubscriptionPlan(candidate) {
  return firstNonEmptyString(
    candidate.tier,
    candidate.name,
    candidate.displayName
  );
}

function isKnownClaudeBrowserSubscriptionPlan(planType) {
  const planKey = normalizeSubscriptionPlanKey(planType);
  return Boolean(planKey && CLAUDE_BROWSER_SUBSCRIPTION_PLAN_KEYS.has(planKey));
}

function normalizeSubscriptionPlanKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function positiveCurrencyAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function findUsageCreditsCandidate(value) {
  if (!value || typeof value !== "object") return null;
  if (
    value.usage_credits ||
    value.usageCredits ||
    value.credits ||
    value.balance ||
    value.spendingLimit ||
    value.availableCredits ||
    value.creditsEnabled ||
    value.usageCreditsEnabled ||
    value.autoTopUp ||
    value.billing?.usage_credits ||
    value.billing?.usageCredits ||
    value.billing?.credits ||
    value.billing?.balance ||
    value.billing?.spendingLimit ||
    value.account?.usage_credits ||
    value.account?.usageCredits ||
    value.account?.credits ||
    value.account?.balance ||
    value.subscription?.usage_credits ||
    value.subscription?.credits ||
    value.subscription?.spendingLimit
  ) {
    return value;
  }
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) {
    const match = findUsageCreditsCandidate(entry);
    if (match) return match;
  }
  return null;
}

function extractClaudeCreditsFromHtml(text) {
  const snippet = extractJsonObjectAroundNeedles(text, [
    "usage_credits", "usageCredits", "currentCreditAmount", "monthlyLimitAmount",
    "spendingLimit", "availableCredits", "creditsEnabled", "usageCreditsEnabled",
    "autoTopUp", "autoReload", "resetsAt", "resetLabel"
  ]);
  if (!snippet) return null;
  try {
    const parsed = JSON.parse(snippet);
    return findUsageCreditsCandidate(parsed);
  } catch {
    return null;
  }
}

function extractClaudeSubscriptionFromHtml(text) {
  const snippet = extractJsonObjectAroundNeedles(text, [
    "subscriptionCost", "subscription_cost", "monthlyCost", "monthly_cost",
    "monthlyPrice", "monthly_price", "priceMonthly", "subscriptionPlan",
    "subscription_plan", "subscriptionType", "subscription_type"
  ]);
  if (!snippet) return null;
  try {
    const parsed = JSON.parse(snippet);
    return findClaudeSubscriptionCandidate(parsed);
  } catch {
    return null;
  }
}

function extractJsonObjectAroundNeedles(text, needles) {
  for (const needle of needles) {
    const index = text.indexOf(needle);
    if (index === -1) continue;
    const start = text.lastIndexOf("{", index);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseSafariBinaryCookies(buffer) {
  if (buffer.subarray(0, 4).toString("ascii") !== "cook") return [];
  const pageCount = buffer.readUInt32BE(4);
  const pageSizes = [];
  let offset = 8;
  for (let i = 0; i < pageCount; i += 1) {
    pageSizes.push(buffer.readUInt32BE(offset));
    offset += 4;
  }
  const cookies = [];
  for (const pageSize of pageSizes) {
    const page = buffer.subarray(offset, offset + pageSize);
    cookies.push(...parseSafariCookiePage(page));
    offset += pageSize;
  }
  return cookies;
}

function parseSafariCookiePage(page) {
  const cookieCount = page.readUInt32LE(4);
  const offsets = [];
  for (let i = 0; i < cookieCount; i += 1) {
    offsets.push(page.readUInt32LE(8 + i * 4));
  }
  return offsets
    .map((offset) => parseSafariCookieRecord(page.subarray(offset)))
    .filter(Boolean);
}

function parseSafariCookieRecord(record) {
  if (record.length < 48) return null;
  const size = record.readUInt32LE(0);
  if (!size || size > record.length) return null;
  const domainOffset = record.readUInt32LE(16);
  const nameOffset = record.readUInt32LE(20);
  const pathOffset = record.readUInt32LE(24);
  const valueOffset = record.readUInt32LE(28);
  return {
    domain: readSafariCookieString(record, domainOffset),
    name: readSafariCookieString(record, nameOffset),
    path: readSafariCookieString(record, pathOffset),
    value: readSafariCookieString(record, valueOffset),
    secure: Boolean(record.readUInt32LE(8) & 0x1),
    encryptedValue: Buffer.alloc(0)
  };
}

function readSafariCookieString(record, offset) {
  if (!offset || offset >= record.length) return "";
  let end = offset;
  while (end < record.length && record[end] !== 0x00) end += 1;
  return record.subarray(offset, end).toString("utf8");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  const port = await startBackend();
  dashboardPort = port;
  await writeInstanceMarker(port).catch(() => {});
  await configureBackgroundLoginItem();
  if (shouldOpenInitialWindow() || openWindowWhenReady) showDashboardWindow(port);

  startAutoUpdatePolling(port).catch(() => {});
  syncClaudeBrowserCredits(port).catch(() => {});

  // Start notification polling after a short initial delay
  setTimeout(() => {
    pollNotifications(port);
    setInterval(() => pollNotifications(port), NOTIFICATION_POLL_INTERVAL_MS);
    setInterval(() => checkTestNotificationPending(port), NOTIFICATION_TEST_POLL_INTERVAL_MS);
    setInterval(() => checkOpenNotificationSettingsPending(port), NOTIFICATION_TEST_POLL_INTERVAL_MS);
  }, 10000);
  setInterval(() => {
    syncClaudeBrowserCredits(port).catch(() => {});
  }, CLAUDE_SYNC_INTERVAL_MS);

  app.on("activate", () => {
    showDashboardWindow(port);
  });
});

app.on("window-all-closed", () => {
  // Keep the backend alive for background quota sync; a later app launch reopens the window.
});

app.on("before-quit", () => {
  removeInstanceMarker().catch(() => {});
  closeServer(dashboardServer);
  closeServer(ollamaProxyServer);
});

process.on("exit", removeInstanceMarkerSync);
