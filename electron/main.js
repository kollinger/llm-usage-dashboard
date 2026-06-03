"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { app, BrowserWindow, shell, Notification } = require("electron");

let dashboardServer = null;
let ollamaProxyServer = null;
let mainWindow = null;
let claudeBrowserSyncPending = null;

// Cooldown tracking: key = windowLabel+type, value = timestamp last notified
const notificationCooldowns = new Map();
const NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const NOTIFICATION_POLL_INTERVAL_MS = 60 * 1000; // 1 minute
const SQLITE_BINARY = "/usr/bin/sqlite3";
const CLAUDE_SYNC_INTERVAL_MS = 60 * 1000;
const CLAUDE_BROWSER_SYNC_ENDPOINT = "/api/claude/browser-credits";
const CLAUDE_SYNC_TOKEN_HEADER = "x-llm-usage-sync-token";
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
}

function closeServer(server) {
  if (!server?.listening) return;
  server.close();
}

function alertKey(alert) {
  return `${alert.windowLabel}:${alert.type}`;
}

function buildNotificationBody(alert) {
  if (alert.type === "hard_limit") {
    return `${Math.round(alert.usedPercent)}% used. Limit nearly exhausted.`;
  }
  const parts = [`${Math.round(alert.usedPercent)}% used, pace projects ${alert.projectedPercent}%.`];
  if (alert.exhaustInMinutes !== null && alert.exhaustInMinutes >= 0) {
    const h = Math.floor(alert.exhaustInMinutes / 60);
    const m = alert.exhaustInMinutes % 60;
    parts.push(`Estimated exhaustion in ${h > 0 ? `${h}h ` : ""}${m}m.`);
  }
  return parts.join(" ");
}

async function checkNotifications(port) {
  try {
    const http = require("node:http");
    const token = process.env.LLM_USAGE_ELECTRON_SYNC_TOKEN;
    if (!token) return;
    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: "localhost",
        port,
        path: "/api/notifications/check",
        headers: { [CLAUDE_SYNC_TOKEN_HEADER]: token }
      };
      const req = http.get(options, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
    });
    if (!data?.alerts?.length) {
      app.setBadgeCount?.(0);
      return;
    }
    const now = Date.now();
    for (const alert of data.alerts) {
      const key = alertKey(alert);
      const lastShown = notificationCooldowns.get(key) || 0;
      if (now - lastShown < NOTIFICATION_COOLDOWN_MS) continue;
      notificationCooldowns.set(key, now);
      if (Notification.isSupported()) {
        const title = `Limit warning: ${alert.windowLabel}`;
        const body = buildNotificationBody(alert);
        const n = new Notification({ title, body, silent: false });
        n.on("click", () => mainWindow?.show());
        n.show();
      }
    }
    app.setBadgeCount?.(data.alerts.length);
  } catch {
    // Ignore errors silently; the server may not be ready yet.
  }
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
        const credits = buildClaudeCreditsFromBillingParts(billingPayload);
        if (credits) return { status: "available", reason: null, credits, usage: billingPayload.usage || null };
        if (findUsageCreditsCandidate(payload)) {
          return { status: "available", reason: null, billingPayload: payload, usage: billingPayload.usage || null };
        }
        continue;
      }
      const credits = extractClaudeCreditsFromHtml(text);
      if (credits) return { status: "available", reason: null, credits, usage: billingPayload.usage || null };
    } catch {
      // Try the next endpoint candidate.
    }
  }
  const credits = buildClaudeCreditsFromBillingParts(billingPayload);
  if (credits || billingPayload.usage) return { status: "available", reason: null, credits: credits || null, usage: billingPayload.usage || null };
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
  const port = await startBackend();
  createWindow(port);

  syncClaudeBrowserCredits(port).catch(() => {});

  // Start notification polling after a short initial delay
  setTimeout(() => {
    checkNotifications(port);
    setInterval(() => checkNotifications(port), NOTIFICATION_POLL_INTERVAL_MS);
  }, 10000);
  setInterval(() => {
    syncClaudeBrowserCredits(port).catch(() => {});
  }, CLAUDE_SYNC_INTERVAL_MS);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  closeServer(dashboardServer);
  closeServer(ollamaProxyServer);
});
