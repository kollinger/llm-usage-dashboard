"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const express = require("express");
const session = require("express-session");

const PORT = Number(process.env.PORT || 4177);
const ROOT = __dirname;
const DATA_DIR = expandHome(process.env.LLM_USAGE_DATA_DIR || process.env.DATA_DIR || path.join(ROOT, "data"));
const MANUAL_LIMITS_FILE = path.join(DATA_DIR, "manual-limits.json");
const OLLAMA_USAGE_FILE = path.join(DATA_DIR, "ollama-usage.jsonl");
const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");
const CODEX_HOME = expandHome(process.env.CODEX_HOME || DEFAULT_CODEX_HOME);
const CODEX_HOMES = uniquePaths([
  DEFAULT_CODEX_HOME,
  CODEX_HOME,
  ...parsePathList(process.env.LLM_USAGE_CODEX_HOMES)
]);
const COPILOT_HOME = expandHome(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"));
const CLAUDE_HOME = expandHome(process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"));
const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_HOME, "settings.json");
const CLAUDE_STATUSLINE_FILE = path.join(CLAUDE_HOME, "usage-dashboard-statusline.json");
const CLAUDE_STATUSLINE_SCRIPT = path.join(CLAUDE_HOME, "llm-usage-statusline-capture.js");
const DEFAULT_CLAUDE_SETUP_PROMPT =
  "Reply briefly: The LLM Usage setup check was triggered. If this answer is visible, return to the dashboard; the Claude limits should update within a few seconds.";
const GEMINI_HOME = expandHome(process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini"));
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_PROXY_PORT = Number(process.env.OLLAMA_PROXY_PORT || 11435);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const DAILY_HISTORY_DAYS = Number(process.env.DAILY_HISTORY_DAYS || 180);
const EXTERNAL_FETCH_TIMEOUT_MS = envMs("EXTERNAL_FETCH_TIMEOUT_SECONDS", 8);
const ANTHROPIC_API_CACHE_MS = envMs("ANTHROPIC_API_CACHE_SECONDS", 60);
const CODEX_LIVE_RATE_LIMITS_ENABLED = parseBoolean(process.env.CODEX_LIVE_RATE_LIMITS ?? "true");
const CODEX_LIVE_RATE_LIMITS_CACHE_MS = envMs("CODEX_LIVE_RATE_LIMITS_CACHE_SECONDS", 15);
const CODEX_APP_SERVER_TIMEOUT_MS = envMs("CODEX_APP_SERVER_TIMEOUT_SECONDS", 5);
const CLAUDE_AUTH_STATUS_TIMEOUT_MS = envMs("CLAUDE_AUTH_STATUS_TIMEOUT_SECONDS", 5);
const ANTHROPIC_WORKSPACE_ID = String(process.env.ANTHROPIC_WORKSPACE_ID || "").trim();

const app = express();
let currentDashboardUrl = null;
const anthropicCache = createTimedCache();
const codexLiveRateLimitsCache = createTimedCache();
let codexAppServer = null;

app.use(express.json({ limit: "200kb" }));
app.use(
  session({
    name: "llm_usage.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);

app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.endsWith(".js") || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});

app.use(express.static(path.join(ROOT, "public")));

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parsePathList(value) {
  return String(value || "")
    .split(path.delimiter)
    .map((item) => expandHome(item.trim()))
    .filter(Boolean);
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths
    .map((item) => path.resolve(expandHome(item)))
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function isProtected() {
  return Boolean(PASSWORD || hasOidcConfig());
}

function isAuthed(req) {
  return !isProtected() || Boolean(req.session.user);
}

function authMiddleware(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: "auth_required" });
}

function hasOidcConfig() {
  return Boolean(
    process.env.OIDC_ISSUER_URL &&
      process.env.OIDC_CLIENT_ID &&
      process.env.OIDC_CLIENT_SECRET &&
      process.env.OIDC_REDIRECT_URI
  );
}

app.get("/api/auth/me", (req, res) => {
  res.json({
    authenticated: isAuthed(req),
    protected: isProtected(),
    methods: {
      password: Boolean(PASSWORD),
      oidc: hasOidcConfig()
    },
    user: req.session.user || (isProtected() ? null : { name: "Local" })
  });
});

app.post("/api/auth/login", (req, res) => {
  if (!PASSWORD) return res.status(400).json({ error: "password_login_disabled" });
  if (req.body?.password !== PASSWORD) return res.status(401).json({ error: "invalid_password" });
  req.session.user = { name: "Local user", method: "password" };
  res.json({ ok: true, user: req.session.user });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/auth/oidc/start", async (req, res) => {
  if (!hasOidcConfig()) return res.status(400).send("OIDC is not configured.");
  try {
    const { Issuer, generators } = require("openid-client");
    const issuer = await Issuer.discover(process.env.OIDC_ISSUER_URL);
    const client = new issuer.Client({
      client_id: process.env.OIDC_CLIENT_ID,
      client_secret: process.env.OIDC_CLIENT_SECRET,
      redirect_uris: [process.env.OIDC_REDIRECT_URI],
      response_types: ["code"]
    });
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const state = generators.state();
    req.session.oidc = { codeVerifier, state };
    const url = client.authorizationUrl({
      scope: process.env.OIDC_SCOPE || "openid profile email",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state
    });
    res.redirect(url);
  } catch (error) {
    res.status(500).send(`OIDC start failed: ${error.message}`);
  }
});

app.get("/auth/oidc/callback", async (req, res) => {
  if (!hasOidcConfig()) return res.status(400).send("OIDC is not configured.");
  try {
    const { Issuer } = require("openid-client");
    const issuer = await Issuer.discover(process.env.OIDC_ISSUER_URL);
    const client = new issuer.Client({
      client_id: process.env.OIDC_CLIENT_ID,
      client_secret: process.env.OIDC_CLIENT_SECRET,
      redirect_uris: [process.env.OIDC_REDIRECT_URI],
      response_types: ["code"]
    });
    const params = client.callbackParams(req);
    const checks = {
      code_verifier: req.session.oidc?.codeVerifier,
      state: req.session.oidc?.state
    };
    const tokenSet = await client.callback(process.env.OIDC_REDIRECT_URI, params, checks);
    let profile = {};
    if (tokenSet.access_token) {
      profile = await client.userinfo(tokenSet.access_token);
    }
    req.session.user = {
      name: profile.name || profile.email || profile.sub || "SSO user",
      email: profile.email || null,
      method: "oidc"
    };
    delete req.session.oidc;
    res.redirect("/");
  } catch (error) {
    res.status(500).send(`OIDC callback failed: ${error.message}`);
  }
});

app.get("/api/usage", authMiddleware, async (_req, res) => {
  const [manual, codex, copilot, claudeCode, geminiLocal, ollama, openai, anthropic] = await Promise.all([
    readManualLimits(),
    readCodexUsage().catch((error) => providerError("codex", error)),
    readCopilotUsage().catch((error) => providerError("copilot", error)),
    readClaudeCodeUsage().catch((error) => providerError("claudeCode", error)),
    readGeminiUsage().catch((error) => providerError("gemini", error)),
    readOllamaUsage().catch((error) => providerError("ollama", error)),
    readOpenAiUsage().catch((error) => providerError("openai", error)),
    readAnthropicUsage().catch((error) => providerError("anthropic", error))
  ]);

  const now = new Date().toISOString();
  res.json({
    generatedAt: now,
    codex,
    copilot,
    claudeCode: mergeManualLimits(claudeCode, manual.claude),
    gemini: mergeManualLimits(geminiLocal, manual.gemini),
    ollama,
    local: buildLocalAggregate([codex, copilot, claudeCode, geminiLocal, ollama]),
    openai: mergeManualLimits(openai, manual.openai),
    anthropic,
    manual
  });
});

app.get("/api/manual-limits", authMiddleware, async (_req, res) => {
  res.json(await readManualLimits());
});

app.post("/api/manual-limits", authMiddleware, async (req, res) => {
  const current = await readManualLimits();
  const next = sanitizeManualLimits({ ...current, ...req.body });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(MANUAL_LIMITS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  res.json(next);
});

app.get("/api/claude/statusline-setup", authMiddleware, async (_req, res) => {
  try {
    res.json(await readClaudeStatuslineSetupStatus());
  } catch (error) {
    sendApiError(res, error, "claude_statusline_setup_status_failed");
  }
});

app.post("/api/claude/statusline-setup", authMiddleware, async (_req, res) => {
  try {
    res.json(await configureClaudeStatusline());
  } catch (error) {
    sendApiError(res, error, "claude_statusline_setup_failed");
  }
});

app.post("/api/claude/open", authMiddleware, async (_req, res) => {
  try {
    res.json(await launchClaudeCode(sanitizeClaudeSetupPrompt(_req.body?.prompt), {
      focusBackDelayMs: Number(_req.body?.focusBackDelayMs || 10000)
    }));
  } catch (error) {
    sendApiError(res, error, "claude_open_failed");
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

function providerError(id, error) {
  return {
    id,
    status: "error",
    error: error.message,
    updatedAt: new Date().toISOString()
  };
}

function sendApiError(res, error, fallbackCode) {
  const status = error.statusCode || error.status || 500;
  res.status(status).json({
    error: error.code || fallbackCode,
    message: error.message || "Request failed"
  });
}

function createTimedCache() {
  return {
    value: null,
    expiresAt: 0,
    pending: null
  };
}

async function readThroughCache(cache, ttlMs, loader) {
  const now = Date.now();
  if (cache.value && now < cache.expiresAt) return cache.value;
  if (cache.pending) return cache.pending;

  cache.pending = Promise.resolve()
    .then(loader)
    .then((value) => {
      cache.value = value;
      cache.expiresAt = Date.now() + ttlMs;
      return value;
    })
    .catch((error) => {
      if (!cache.value) throw error;
      cache.value = {
        ...cache.value,
        cache: {
          ...(cache.value.cache || {}),
          stale: true,
          staleReason: error.message,
          staleAt: new Date().toISOString()
        }
      };
      cache.expiresAt = Date.now() + Math.min(ttlMs, 30_000);
      return cache.value;
    })
    .finally(() => {
      cache.pending = null;
    });

  return cache.pending;
}

async function readManualLimits() {
  try {
    const text = await fsp.readFile(MANUAL_LIMITS_FILE, "utf8");
    return sanitizeManualLimits(JSON.parse(text));
  } catch {
    return sanitizeManualLimits({});
  }
}

function sanitizeManualLimits(raw) {
  const emptyWindow = (label) => ({ usedPercent: 0, limitLabel: label, resetsAt: null });
  const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));
  const sanitizeProvider = (id, fallbackLabel) => {
    const provider = raw[id] || {};
    const five = provider.fiveHour || {};
    const week = provider.weekly || {};
    return {
      label: String(provider.label || fallbackLabel),
      fiveHour: {
        ...emptyWindow("5h limit"),
        ...five,
        usedPercent: clamp(five.usedPercent),
        resetsAt: normalizeOptionalDate(five.resetsAt)
      },
      weekly: {
        ...emptyWindow("Weekly limit"),
        ...week,
        usedPercent: clamp(week.usedPercent),
        resetsAt: normalizeOptionalDate(week.resetsAt)
      },
      planType: String(provider.planType || provider.plan || "").trim(),
      credits: sanitizeUsageCredits(provider.credits || provider.usageCredits || provider.guthaben)
    };
  };
  const claude = sanitizeProvider("claude", "Claude / Anthropic");
  const claudeRaw = raw.claude || {};
  claude.planType = String(claudeRaw.planType || claudeRaw.plan || "").trim();
  claude.currentSession = sanitizeManualWindow(claudeRaw.currentSession || claudeRaw.fiveHour, "Aktuelle Sitzung", 300);
  claude.allModels = sanitizeManualWindow(claudeRaw.allModels || claudeRaw.weekly, "Alle Modelle", 10080);
  claude.claudeDesign = sanitizeManualWindow(claudeRaw.claudeDesign, "Claude Design", 10080);
  return {
    claude,
    gemini: sanitizeProvider("gemini", "Gemini"),
    openai: sanitizeProvider("openai", "OpenAI / GPT")
  };
}

function sanitizeManualWindow(window, label, minutes) {
  const usedPercent = Math.max(0, Math.min(100, Number(window?.usedPercent) || 0));
  return {
    usedPercent,
    limitLabel: String(window?.limitLabel || label),
    resetsAt: normalizeOptionalDate(window?.resetsAt),
    windowMinutes: Number(window?.windowMinutes || minutes)
  };
}

function sanitizeUsageCredits(raw) {
  const credits = raw || {};
  return {
    enabled: parseBoolean(credits.enabled ?? credits.usageCreditsEnabled),
    spentAmount: positiveAmount(credits.spentAmount ?? credits.spent ?? credits.usedAmount ?? credits.amountSpent),
    monthlyLimitAmount: positiveAmount(
      credits.monthlyLimitAmount ?? credits.monthlyLimit ?? credits.limitAmount ?? credits.spendingLimit
    ),
    currentCreditAmount: positiveAmount(
      credits.currentCreditAmount ?? credits.currentCredit ?? credits.balance ?? credits.remainingCredit
    ),
    currency: normalizeCurrency(credits.currency || "EUR"),
    autoTopUp: parseBoolean(credits.autoTopUp ?? credits.autoTopUpEnabled),
    resetsAt: normalizeOptionalDate(credits.resetsAt ?? credits.resetAt),
    resetLabel: String(credits.resetLabel || "").trim()
  };
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on", "an"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function envMs(name, fallbackSeconds) {
  const value = Number(process.env[name]);
  return (Number.isFinite(value) && value > 0 ? value : fallbackSeconds) * 1000;
}

function positiveAmount(value) {
  if (value === undefined || value === null || value === "") return 0;
  const normalized = typeof value === "string" ? value.replace(",", ".").replace(/[^\d.-]/g, "") : value;
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeCurrency(value) {
  const currency = String(value || "EUR").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "EUR";
}

function hasUsageCredits(credits) {
  return Boolean(
    credits &&
      (credits.enabled ||
        credits.spentAmount > 0 ||
        credits.monthlyLimitAmount > 0 ||
        credits.currentCreditAmount > 0 ||
        credits.autoTopUp ||
        credits.resetsAt ||
        credits.resetLabel)
  );
}

function normalizeOptionalDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric =
    typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()))
      ? Number(value)
      : null;
  const date =
    numeric !== null && Number.isFinite(numeric)
      ? new Date(Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric)
      : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildManualProvider(id, config) {
  const fiveHour = makeLimitWindow(config.currentSession || config.fiveHour, 300);
  const weekly = makeLimitWindow(config.allModels || config.weekly, 10080);
  const limits = {
    fiveHour,
    weekly
  };
  if (id === "claudeCode") {
    limits.currentSession = relabelLimitWindow(fiveHour, "Aktuelle Sitzung");
    limits.allModels = relabelLimitWindow(weekly, "Alle Modelle");
    limits.claudeDesign = makeLimitWindow(config.claudeDesign, 10080);
    limits.rows = buildLimitRows(limits, ["currentSession", "allModels", "claudeDesign"]);
  }
  return {
    id,
    status: "manual",
    updatedAt: new Date().toISOString(),
    label: config.label,
    planType: config.planType || null,
    limits,
    credits: hasUsageCredits(config.credits) ? config.credits : null,
    creditRows: buildCreditRows(config.credits)
  };
}

function mergeManualLimits(provider, config) {
  if (!provider || provider.status === "error") return provider;
  const manual = buildManualProvider(provider.id, config);
  const hasManualLimits = hasLimitValues(manual.limits);
  const hasManualCredits = hasUsageCredits(manual.credits);
  const hasManualValue = Boolean(manual.planType) || hasManualLimits || hasManualCredits;
  if (!hasManualValue) return provider;
  const limits = hasManualLimits ? mergeLimitObjects(provider.limits, manual.limits) : provider.limits;
  const credits = mergeCreditObjects(provider.credits, manual.credits);
  return {
    ...provider,
    status:
      (provider.status === "empty" || provider.status === "not_configured") && hasManualValue ? "manual" : provider.status,
    planType: provider.planType || manual.planType || null,
    limits,
    credits,
    creditRows: buildCreditRows(credits),
    limitSource: provider.limitSource || "manual"
  };
}

function hasLimitValues(limits) {
  return Object.values(limits || {})
    .filter((value) => value && !Array.isArray(value))
    .some((limit) => limit.usedPercent > 0 || Boolean(limit.resetsAt || limit.resetLabel));
}

function mergeCreditObjects(primary, fallback) {
  if (!primary && !fallback) return null;
  const merged = {
    ...(fallback || {}),
    ...(primary || {})
  };
  return hasUsageCredits(merged) ? merged : null;
}

function buildCreditRows(credits) {
  if (!hasUsageCredits(credits)) return [];
  const currency = normalizeCurrency(credits.currency);
  const rows = [];
  if (credits.spentAmount > 0 || credits.monthlyLimitAmount > 0 || credits.resetsAt || credits.resetLabel) {
    const percent = credits.monthlyLimitAmount > 0 ? (credits.spentAmount / credits.monthlyLimitAmount) * 100 : null;
    rows.push({
      key: "monthlySpend",
      label: "Nutzungsguthaben",
      amount: credits.spentAmount,
      currency,
      percent: percent === null ? null : Math.max(0, Math.min(100, percent)),
      resetsAt: credits.resetsAt || null,
      resetLabel: credits.resetLabel || null
    });
  }
  if (credits.monthlyLimitAmount > 0) {
    rows.push({
      key: "monthlyLimit",
      label: "Monatliches Limit",
      amount: credits.monthlyLimitAmount,
      currency
    });
  }
  if (credits.currentCreditAmount > 0 || credits.enabled) {
    rows.push({
      key: "currentCredit",
      label: "Aktuelles Guthaben",
      amount: credits.currentCreditAmount,
      currency
    });
  }
  rows.push({
    key: "autoTopUp",
    label: "Automatisch aufladen",
    valueLabel: credits.autoTopUp ? "An" : "Aus"
  });
  return rows;
}

function makeLimitWindow(window, minutes) {
  const usedPercent = Math.max(0, Math.min(100, Number(window?.usedPercent) || 0));
  return {
    label: window?.limitLabel || `${minutes}m limit`,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowMinutes: minutes,
    resetsAt: window?.resetsAt || null
  };
}

function mergeLimitObjects(primary, fallback) {
  if (!primary) return fallback;
  const limits = {
    ...fallback,
    ...primary,
    fiveHour: primary.fiveHour || fallback?.fiveHour || null,
    weekly: primary.weekly || fallback?.weekly || null,
    currentSession: primary.currentSession || fallback?.currentSession || primary.fiveHour || fallback?.fiveHour || null,
    allModels: primary.allModels || fallback?.allModels || primary.weekly || fallback?.weekly || null,
    claudeDesign: primary.claudeDesign || fallback?.claudeDesign || null
  };
  limits.rows = buildLimitRows(limits, ["currentSession", "allModels", "claudeDesign"]);
  return limits;
}

function relabelLimitWindow(window, label) {
  return window ? { ...window, label } : null;
}

function buildLimitRows(limits, keys) {
  return keys
    .map((key) => {
      const limit = limits?.[key];
      return limit ? { key, ...limit } : null;
    })
    .filter(Boolean);
}

async function readCodexUsage() {
  const liveRateLimitsPromise = readCodexLiveRateLimits();
  const { files, roots, duplicatesSkipped } = await listCodexUsageFiles();

  const aggregates = createUsageTotals();
  const last5h = createUsageTotals();
  const last24h = createUsageTotals();
  const last7d = createUsageTotals();
  const dailyMap = new Map();
  const sparkUsage = createUsageAccumulator();
  const sparkRateLimitEvents = [];
  let sparkFirstEvent = null;
  let sparkLatestEvent = null;
  const now = Date.now();
  let firstEvent = null;
  let latestEvent = null;
  let eventCount = 0;
  let sessionsWithEvents = 0;
  const rateLimitEvents = [];

  for (const file of files) {
    let fileEvents = 0;
    let currentModel = null;
    await readJsonl(file, (event) => {
      if (event?.type === "turn_context" && event.payload?.model) {
        currentModel = event.payload.model;
      }
      if (event?.type === "session_meta" && event.payload?.model) {
        currentModel = event.payload.model;
      }
      if (event?.type !== "event_msg" || event?.payload?.type !== "token_count") return;
      const timestampMs = Date.parse(event.timestamp);
      if (Number.isNaN(timestampMs)) return;
      const usage = event.payload.info?.last_token_usage || {};
      if (event.payload.rate_limits) {
        const rateLimitEvent = {
          timestamp: event.timestamp,
          rateLimits: event.payload.rate_limits,
          file
        };
        if (isCodexSparkRateLimit(event.payload.rate_limits)) {
          sparkRateLimitEvents.push(rateLimitEvent);
        } else {
          rateLimitEvents.push(rateLimitEvent);
        }
      }
      addUsage(aggregates, usage);
      if (now - timestampMs <= 5 * 60 * 60 * 1000) addUsage(last5h, usage);
      if (now - timestampMs <= 24 * 60 * 60 * 1000) addUsage(last24h, usage);
      if (now - timestampMs <= 7 * 24 * 60 * 60 * 1000) addUsage(last7d, usage);
      if (isCodexSparkModel(currentModel) || isCodexSparkRateLimit(event.payload.rate_limits)) {
        addUsageEvent(sparkUsage, timestampMs, usage);
        if (!sparkFirstEvent || timestampMs < Date.parse(sparkFirstEvent.timestamp)) {
          sparkFirstEvent = {
            timestamp: event.timestamp,
            model: currentModel || event.payload.rate_limits?.limit_name || "gpt-5.3-codex-spark",
            file
          };
        }
        if (!sparkLatestEvent || timestampMs > Date.parse(sparkLatestEvent.timestamp)) {
          sparkLatestEvent = {
            timestamp: event.timestamp,
            model: currentModel || event.payload.rate_limits?.limit_name || "gpt-5.3-codex-spark",
            info: event.payload.info || {},
            rateLimits: event.payload.rate_limits || null,
            file
          };
        }
      }

      const day = new Date(timestampMs).toISOString().slice(0, 10);
      if (!dailyMap.has(day)) dailyMap.set(day, createUsageTotals());
      addUsage(dailyMap.get(day), usage);

      eventCount += 1;
      fileEvents += 1;
      if (!firstEvent || timestampMs < Date.parse(firstEvent.timestamp)) {
        firstEvent = {
          timestamp: event.timestamp,
          file
        };
      }
      if (!latestEvent || timestampMs > Date.parse(latestEvent.timestamp)) {
        latestEvent = {
          timestamp: event.timestamp,
          info: event.payload.info || {},
          rateLimits: event.payload.rate_limits || null,
          file
        };
      }
    });
    if (fileEvents) sessionsWithEvents += 1;
  }

  const daily = buildDaily(dailyMap);
  const liveRateLimits = await liveRateLimitsPromise;
  const liveCodexLimits = liveRateLimits?.codex ? codexRateLimitsFromLive(liveRateLimits.codex, "Codex") : null;
  const liveSparkLimits = liveRateLimits?.spark ? codexRateLimitsFromLive(liveRateLimits.spark, "Codex 5.3 Spark") : null;

  return {
    id: "codex",
    status: latestEvent || liveCodexLimits ? "live" : "empty",
    updatedAt: new Date().toISOString(),
    source: {
      codexHome: CODEX_HOME,
      codexHomes: CODEX_HOMES,
      rootsScanned: roots,
      filesScanned: files.length,
      duplicatesSkipped,
      sessionsWithEvents,
      eventCount,
      liveRateLimits: liveRateLimits?.source || null
    },
    liveRateLimits: liveRateLimits?.source || null,
    planType: liveRateLimits?.codex?.planType || null,
    latest: latestEvent
      ? {
          timestamp: latestEvent.timestamp,
          modelContextWindow: latestEvent.info.model_context_window || null,
          last: normalizeUsage(latestEvent.info.last_token_usage || {}),
          sessionTotal: normalizeUsage(latestEvent.info.total_token_usage || {}),
          planType: liveRateLimits?.codex?.planType || latestEvent.rateLimits?.plan_type || null,
          file: latestEvent.file
        }
      : null,
    first: firstEvent
      ? {
          timestamp: firstEvent.timestamp,
          file: firstEvent.file
        }
      : null,
    totals: {
      allTime: aggregates,
      last5h,
      last24h,
      last7d
    },
    limits: liveCodexLimits || codexRateLimitsFromEvents(rateLimitEvents, latestEvent?.rateLimits),
    spark: buildCodexSparkUsage(
      sparkLatestEvent,
      sparkFirstEvent,
      sparkUsage,
      sparkRateLimitEvents,
      liveSparkLimits,
      liveRateLimits?.source?.updatedAt || null
    ),
    daily
  };
}

async function readCopilotUsage() {
  const files = await listFiles(path.join(COPILOT_HOME, "session-state"), (file) => path.basename(file) === "events.jsonl");
  const usage = createUsageAccumulator();
  const modelMap = new Map();
  let firstEvent = null;
  let latestEvent = null;
  let eventCount = 0;
  let sessionsWithEvents = 0;
  let totalPremiumRequests = 0;
  let totalApiDurationMs = 0;
  let totalNanoAiu = 0;

  for (const file of files) {
    let fileEvents = 0;
    await readJsonl(file, (event) => {
      if (event?.type !== "session.shutdown" || !event?.data) return;
      const data = event.data;
      const timestampMs = copilotSessionTimestampMs(data, event.timestamp);
      if (!Number.isFinite(timestampMs)) return;

      const sessionUsage = createUsageTotals();
      const modelMetrics = data.modelMetrics && typeof data.modelMetrics === "object" ? data.modelMetrics : {};
      for (const [model, metrics] of Object.entries(modelMetrics)) {
        const normalized = normalizeCopilotUsage(metrics?.usage || {});
        if (!normalized.total_tokens) continue;
        addUsage(sessionUsage, normalized);
        const modelName = model || data.currentModel || "copilot";
        if (!modelMap.has(modelName)) modelMap.set(modelName, createUsageTotals());
        addUsage(modelMap.get(modelName), normalized);
      }

      const premiumRequests = Number(data.totalPremiumRequests || 0);
      if (!sessionUsage.totalTokens && !premiumRequests) return;

      addUsageEvent(usage, timestampMs, sessionUsage);
      totalPremiumRequests += premiumRequests;
      totalApiDurationMs += Number(data.totalApiDurationMs || 0);
      totalNanoAiu += Number(data.totalNanoAiu || 0);
      eventCount += 1;
      fileEvents += 1;

      const row = {
        timestamp: new Date(timestampMs).toISOString(),
        model: data.currentModel || Object.keys(modelMetrics)[0] || "copilot",
        usage: sessionUsage,
        premiumRequests,
        file
      };
      if (!firstEvent || timestampMs < Date.parse(firstEvent.timestamp)) firstEvent = row;
      if (!latestEvent || timestampMs > Date.parse(latestEvent.timestamp)) latestEvent = row;
    });
    if (fileEvents) sessionsWithEvents += 1;
  }

  return {
    id: "copilot",
    status: latestEvent ? "live" : "empty",
    updatedAt: new Date().toISOString(),
    message: latestEvent ? null : "Keine lokalen Copilot CLI Session-Metriken gefunden.",
    source: {
      copilotHome: COPILOT_HOME,
      filesScanned: files.length,
      sessionsWithEvents,
      eventCount,
      totalPremiumRequests,
      totalApiDurationMs,
      totalNanoAiu,
      dataScope: "session.shutdown metrics only; prompt and response content events are ignored"
    },
    latest: latestEvent
      ? {
          timestamp: latestEvent.timestamp,
          model: latestEvent.model,
          last: latestEvent.usage,
          premiumRequests: latestEvent.premiumRequests
        }
      : null,
    first: firstEvent
      ? {
          timestamp: firstEvent.timestamp,
          model: firstEvent.model,
          file: firstEvent.file
        }
      : null,
    totals: finalizeUsageAccumulator(usage),
    usageUnits: {
      premiumRequests: totalPremiumRequests,
      totalApiDurationMs,
      totalNanoAiu
    },
    limits: null,
    byModel: Array.from(modelMap.entries())
      .map(([model, modelUsage]) => ({ model, ...modelUsage }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 8),
    daily: buildDaily(usage.dailyMap)
  };
}

function isCodexSparkRateLimit(rateLimits) {
  if (!rateLimits) return false;
  return /spark|bengalfox|research/i.test(`${rateLimits.limit_id || ""} ${rateLimits.limit_name || ""}`);
}

function isCodexSparkModel(model) {
  return /spark|bengalfox|research/i.test(String(model || ""));
}

function buildCodexSparkUsage(latestEvent, firstEvent, usage, rateLimitEvents, liveLimits, liveLimitsUpdatedAt = null) {
  const limits = codexSparkRateLimitsFromEvents(
    rateLimitEvents,
    latestEvent?.rateLimits,
    Boolean(latestEvent)
  );
  const mergedLimits = liveLimits || limits;
  return {
    id: "codexSpark",
    status: latestEvent || liveLimits ? "live" : "empty",
    updatedAt: new Date().toISOString(),
    message: latestEvent || liveLimits ? null : "Keine Codex 5.3 Spark Events gefunden.",
    latest: latestEvent
      ? {
          timestamp: latestEvent.timestamp,
          model: latestEvent.model,
          last: normalizeUsage(latestEvent.info.last_token_usage || {}),
          sessionTotal: normalizeUsage(latestEvent.info.total_token_usage || {}),
          planType: latestEvent.rateLimits?.plan_type || null,
          file: latestEvent.file
        }
      : null,
    first: firstEvent
      ? {
          timestamp: firstEvent.timestamp,
          model: firstEvent.model,
          file: firstEvent.file
        }
      : null,
    totals: finalizeUsageAccumulator(usage),
    planType: liveLimits?.planType || latestEvent?.rateLimits?.plan_type || null,
    limitsUpdatedAt: liveLimits ? liveLimitsUpdatedAt : null,
    limits: mergedLimits,
    daily: buildDaily(usage.dailyMap)
  };
}

async function readClaudeCodeUsage() {
  const files = await listJsonlFiles(path.join(CLAUDE_HOME, "projects"));
  const seen = new Set();
  const usage = createUsageAccumulator();
  const modelMap = new Map();
  let firstEvent = null;
  let latestEvent = null;
  let responseCount = 0;
  let sessionsWithEvents = 0;

  for (const file of files) {
    let fileEvents = 0;
    await readJsonl(file, (event) => {
      if (event?.type !== "assistant" || !event?.message?.usage) return;
      const timestampMs = Date.parse(event.timestamp);
      if (Number.isNaN(timestampMs)) return;
      const usageKey = event.requestId || event.message?.id || `${file}:${event.uuid || event.timestamp}`;
      if (seen.has(usageKey)) return;
      seen.add(usageKey);

      const normalized = normalizeClaudeUsage(event.message.usage);
      addUsageEvent(usage, timestampMs, normalized);

      const model = event.message.model || "unknown";
      if (!modelMap.has(model)) modelMap.set(model, createUsageTotals());
      addUsage(modelMap.get(model), normalized);

      responseCount += 1;
      fileEvents += 1;
      if (!firstEvent || timestampMs < Date.parse(firstEvent.timestamp)) {
        firstEvent = {
          timestamp: event.timestamp,
          model,
          file
        };
      }
      if (!latestEvent || timestampMs > Date.parse(latestEvent.timestamp)) {
        latestEvent = {
          timestamp: event.timestamp,
          model,
          usage: normalized,
          file
        };
      }
    });
    if (fileEvents) sessionsWithEvents += 1;
  }

  const [statusline, authStatus, settingsInfo, scriptInstalled] = await Promise.all([
    readClaudeStatusline(),
    readClaudeAuthStatus(),
    readClaudeSettings(),
    pathExists(CLAUDE_STATUSLINE_SCRIPT)
  ]);
  const planType = statusline?.planType || authStatus?.planType || null;
  const statuslineConfigured = isClaudeStatuslineConfigured(settingsInfo.settings);
  return {
    id: "claudeCode",
    status: latestEvent ? "live" : "empty",
    updatedAt: new Date().toISOString(),
    source: {
      claudeHome: CLAUDE_HOME,
      filesScanned: files.length,
      sessionsWithEvents,
      eventCount: responseCount,
      statusline: statusline
        ? {
            found: Boolean(statusline.found),
            hasLimits: Boolean(statusline.limits),
            file: statusline.statusFile
          }
        : null,
      authStatus: authStatus
        ? {
            available: Boolean(authStatus.available),
            status: authStatus.status || "unknown"
          }
        : null
    },
    setup: {
      claudeAvailable: Boolean(authStatus?.available),
      configured: statuslineConfigured,
      settingsError: settingsInfo.error || null,
      scriptInstalled,
      statusFileFound: Boolean(statusline?.found),
      hasLimits: Boolean(statusline?.limits),
      staleLimits: Boolean(statusline?.staleLimits)
    },
    latest: latestEvent
      ? {
          timestamp: latestEvent.timestamp,
          model: latestEvent.model,
          last: latestEvent.usage
        }
      : null,
    first: firstEvent
      ? {
          timestamp: firstEvent.timestamp,
          model: firstEvent.model,
          file: firstEvent.file
        }
      : null,
    totals: finalizeUsageAccumulator(usage),
    limits: statusline?.limits || null,
    limitsUpdatedAt: statusline?.updatedAt || null,
    planType,
    credits: statusline?.credits || null,
    creditRows: buildCreditRows(statusline?.credits),
    limitSource: statusline?.limits ? "claude_statusline" : null,
    planSource: statusline?.planType ? "claude_statusline" : authStatus?.planType ? "claude_auth_status" : null,
    message: claudeCodeStatusMessage(statusline),
    byModel: Array.from(modelMap.entries())
      .map(([model, modelUsage]) => ({ model, ...modelUsage }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 8),
    daily: buildDaily(usage.dailyMap)
  };
}

function claudeCodeStatusMessage(statusline) {
  if (statusline?.staleLimits) return "Claude live limits are stale. Open Claude Code once to refresh them.";
  if (statusline?.limits) return null;
  if (statusline?.found) return "Claude live data received, but no official Pro/Max quota values yet.";
  return "Claude live limits are not set up yet. Open Settings to enable them once.";
}

async function readGeminiUsage() {
  const candidates = await listGeminiUsageFiles(GEMINI_HOME);
  const usage = createUsageAccumulator();
  const modelMap = new Map();
  let firstEvent = null;
  let latestEvent = null;
  let eventCount = 0;
  let filesWithEvents = 0;

  for (const file of candidates) {
    let fileEvents = 0;
    await readUsageObjects(file, (event) => {
      const usageMetadata = findGeminiUsageMetadata(event);
      if (!usageMetadata) return;
      const timestampMs = findTimestampMs(event) || (safeStatMtime(file) ?? Date.now());
      const normalized = normalizeGeminiUsage(usageMetadata);
      if (!normalized.total_tokens) return;
      addUsageEvent(usage, timestampMs, normalized);

      const model = findModelName(event) || "gemini";
      if (!modelMap.has(model)) modelMap.set(model, createUsageTotals());
      addUsage(modelMap.get(model), normalized);

      eventCount += 1;
      fileEvents += 1;
      if (!firstEvent || timestampMs < Date.parse(firstEvent.timestamp)) {
        firstEvent = {
          timestamp: new Date(timestampMs).toISOString(),
          model,
          file
        };
      }
      if (!latestEvent || timestampMs > Date.parse(latestEvent.timestamp)) {
        latestEvent = {
          timestamp: new Date(timestampMs).toISOString(),
          model,
          usage: normalizeUsage(normalized),
          file
        };
      }
    });
    if (fileEvents) filesWithEvents += 1;
  }

  return {
    id: "gemini",
    status: latestEvent ? "live" : "empty",
    updatedAt: new Date().toISOString(),
    message: latestEvent ? null : "Keine lokalen Gemini Usage-Logs gefunden.",
    source: {
      geminiHome: GEMINI_HOME,
      filesScanned: candidates.length,
      filesWithEvents,
      eventCount
    },
    latest: latestEvent
      ? {
          timestamp: latestEvent.timestamp,
          model: latestEvent.model,
          last: latestEvent.usage
        }
      : null,
    first: firstEvent
      ? {
          timestamp: firstEvent.timestamp,
          model: firstEvent.model,
          file: firstEvent.file
        }
      : null,
    totals: finalizeUsageAccumulator(usage),
    limits: null,
    byModel: Array.from(modelMap.entries())
      .map(([model, modelUsage]) => ({ model, ...modelUsage }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 8),
    daily: buildDaily(usage.dailyMap)
  };
}

async function readOllamaUsage() {
  const usage = createUsageAccumulator();
  const modelMap = new Map();
  let firstEvent = null;
  let latestEvent = null;
  let eventCount = 0;

  try {
    await readJsonl(OLLAMA_USAGE_FILE, (event) => {
      const timestampMs = Date.parse(event.timestamp);
      if (Number.isNaN(timestampMs)) return;
      const normalized = normalizeUsage(event.usage || {});
      if (!normalized.totalTokens) return;
      addUsageEvent(usage, timestampMs, event.usage);

      const model = event.model || "ollama";
      if (!modelMap.has(model)) modelMap.set(model, createUsageTotals());
      addUsage(modelMap.get(model), event.usage);

      eventCount += 1;
      if (!firstEvent || timestampMs < Date.parse(firstEvent.timestamp)) {
        firstEvent = {
          timestamp: event.timestamp,
          model,
          endpoint: event.endpoint
        };
      }
      if (!latestEvent || timestampMs > Date.parse(latestEvent.timestamp)) {
        latestEvent = {
          timestamp: event.timestamp,
          model,
          endpoint: event.endpoint,
          usage: normalized
        };
      }
    });
  } catch {
    // Missing log file just means the proxy has not recorded requests yet.
  }

  return {
    id: "ollama",
    status: latestEvent ? "live" : "empty",
    updatedAt: new Date().toISOString(),
    message: latestEvent
      ? "Lokale Ollama-Tokens aus Logs"
      : "Keine lokalen Ollama-Logs gefunden.",
    source: {
      usageFile: OLLAMA_USAGE_FILE,
      proxyPort: OLLAMA_PROXY_PORT,
      target: OLLAMA_HOST,
      eventCount
    },
    latest: latestEvent
      ? {
          timestamp: latestEvent.timestamp,
          model: latestEvent.model,
          endpoint: latestEvent.endpoint,
          last: latestEvent.usage
        }
      : null,
    first: firstEvent
      ? {
          timestamp: firstEvent.timestamp,
          model: firstEvent.model,
          endpoint: firstEvent.endpoint
        }
      : null,
    totals: finalizeUsageAccumulator(usage),
    limits: null,
    byModel: Array.from(modelMap.entries())
      .map(([model, modelUsage]) => ({ model, ...modelUsage }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 8),
    daily: buildDaily(usage.dailyMap)
  };
}

function buildLocalAggregate(providers) {
  const usage = createUsageAccumulator();
  const sources = [];
  const dailySourceMap = new Map();
  for (const provider of providers) {
    if (!provider?.totals) continue;
    const sparkDailyMap =
      provider.id === "codex"
        ? new Map((provider.spark?.daily || []).map((row) => [row.date, row]))
        : null;
    addUsage(usage.allTime, provider.totals.allTime || {});
    addUsage(usage.last5h, provider.totals.last5h || {});
    addUsage(usage.last24h, provider.totals.last24h || {});
    addUsage(usage.last7d, provider.totals.last7d || {});
    for (const row of provider.daily || []) {
      if (!usage.dailyMap.has(row.date)) usage.dailyMap.set(row.date, createUsageTotals());
      addUsage(usage.dailyMap.get(row.date), row);
      if (!dailySourceMap.has(row.date)) dailySourceMap.set(row.date, new Map());
      const sourceMap = dailySourceMap.get(row.date);
      for (const sourceRow of buildProviderDailySources(provider, row, sparkDailyMap)) {
        if (!sourceMap.has(sourceRow.id)) sourceMap.set(sourceRow.id, createUsageTotals());
        addUsage(sourceMap.get(sourceRow.id), sourceRow);
      }
    }
    sources.push(...buildProviderSourceSummaries(provider));
  }
  return {
    id: "local",
    status: sources.some((source) => source.totalTokens > 0) ? "live" : "empty",
    updatedAt: new Date().toISOString(),
    totals: finalizeUsageAccumulator(usage),
    daily: buildDaily(usage.dailyMap).map((row) => ({
      ...row,
      sources: buildDailySources(dailySourceMap.get(row.date))
    })),
    sources
  };
}

function buildDailySources(sourceMap) {
  if (!sourceMap) return [];
  return Array.from(sourceMap.entries())
    .map(([id, totals]) => ({ id, ...totals }))
    .filter((source) => source.totalTokens > 0);
}

function buildProviderDailySources(provider, row, sparkDailyMap) {
  if (provider.id !== "codex" || !sparkDailyMap?.size) return [{ id: provider.id, ...row }];
  const sparkRow = sparkDailyMap.get(row.date);
  if (!sparkRow?.totalTokens) return [{ id: provider.id, ...row }];
  const codexRow = subtractUsageTotals(row, sparkRow);
  return [
    codexRow.totalTokens > 0 ? { id: "codex", ...codexRow } : null,
    { id: "codexSpark", ...sparkRow }
  ].filter(Boolean);
}

function buildProviderSourceSummaries(provider) {
  if (provider.id !== "codex" || !provider.spark?.totals) {
    return [sourceSummary(provider.id, provider.status, provider.totals)];
  }
  return [
    sourceSummary("codex", provider.status, subtractUsageWindows(provider.totals, provider.spark.totals)),
    sourceSummary("codexSpark", provider.spark.status, provider.spark.totals)
  ];
}

function sourceSummary(id, status, totals) {
  return {
    id,
    status,
    totalTokens: totals.allTime?.totalTokens || 0,
    last24hTokens: totals.last24h?.totalTokens || 0,
    totals
  };
}

function subtractUsageWindows(totals, subset) {
  return {
    allTime: subtractUsageTotals(totals.allTime, subset.allTime),
    last5h: subtractUsageTotals(totals.last5h, subset.last5h),
    last24h: subtractUsageTotals(totals.last24h, subset.last24h),
    last7d: subtractUsageTotals(totals.last7d, subset.last7d)
  };
}

function subtractUsageTotals(total, subset) {
  const result = createUsageTotals();
  for (const key of Object.keys(result)) {
    result[key] = Math.max(0, Number(total?.[key] || 0) - Number(subset?.[key] || 0));
  }
  return result;
}

async function listCodexUsageFiles() {
  const roots = CODEX_HOMES.flatMap((home) => [
    path.join(home, "sessions"),
    path.join(home, "archived_sessions")
  ]);
  const files = [];
  const seenRealPaths = new Set();
  const seenSessionIds = new Set();
  let duplicatesSkipped = 0;

  for (const root of roots) {
    for (const file of await listJsonlFiles(root)) {
      const realPath = await safeRealpath(file);
      const sessionId = codexSessionId(file);
      if (seenRealPaths.has(realPath) || (sessionId && seenSessionIds.has(sessionId))) {
        duplicatesSkipped += 1;
        continue;
      }
      seenRealPaths.add(realPath);
      if (sessionId) seenSessionIds.add(sessionId);
      files.push(file);
    }
  }

  return { files, roots, duplicatesSkipped };
}

async function safeRealpath(file) {
  try {
    return await fsp.realpath(file);
  } catch {
    return path.resolve(file);
  }
}

function codexSessionId(file) {
  const match = path.basename(file).match(/^rollout-[^.]+(?:\.jsonl)?$/);
  return match ? path.basename(file, ".jsonl") : "";
}

async function listJsonlFiles(root) {
  const result = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          result.push(fullPath);
        }
      })
    );
  }
  await walk(root);
  return result;
}

async function listFiles(root, predicate) {
  const result = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && predicate(fullPath)) {
          result.push(fullPath);
        }
      })
    );
  }
  await walk(root);
  return result;
}

async function readJsonl(file, onObject) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      onObject(JSON.parse(line));
    } catch {
      // Corrupt or partial JSONL lines can happen during active writes.
    }
  }
}

async function readUsageObjects(file, onObject) {
  if (file.endsWith(".jsonl") || file.endsWith(".log")) {
    await readJsonl(file, onObject);
    return;
  }
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    visitJson(parsed, onObject);
  } catch {
    // Ignore non-JSON files and partially written logs.
  }
}

function visitJson(value, onObject) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, onObject);
    return;
  }
  onObject(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") visitJson(child, onObject);
  }
}

function createUsageAccumulator() {
  return {
    allTime: createUsageTotals(),
    last5h: createUsageTotals(),
    last24h: createUsageTotals(),
    last7d: createUsageTotals(),
    dailyMap: new Map()
  };
}

function addUsageEvent(accumulator, timestampMs, usage) {
  const now = Date.now();
  addUsage(accumulator.allTime, usage);
  if (now - timestampMs <= 5 * 60 * 60 * 1000) addUsage(accumulator.last5h, usage);
  if (now - timestampMs <= 24 * 60 * 60 * 1000) addUsage(accumulator.last24h, usage);
  if (now - timestampMs <= 7 * 24 * 60 * 60 * 1000) addUsage(accumulator.last7d, usage);
  const day = new Date(timestampMs).toISOString().slice(0, 10);
  if (!accumulator.dailyMap.has(day)) accumulator.dailyMap.set(day, createUsageTotals());
  addUsage(accumulator.dailyMap.get(day), usage);
}

function finalizeUsageAccumulator(accumulator) {
  return {
    allTime: accumulator.allTime,
    last5h: accumulator.last5h,
    last24h: accumulator.last24h,
    last7d: accumulator.last7d
  };
}

function buildDaily(dailyMap) {
  return Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-DAILY_HISTORY_DAYS)
    .map(([date, usage]) => ({ date, ...usage }));
}

function createUsageTotals() {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function normalizeUsage(usage) {
  const totals = createUsageTotals();
  addUsage(totals, usage);
  return totals;
}

function normalizeCopilotUsage(usage) {
  const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
  const cacheWrite = Number(usage.cacheWriteTokens ?? usage.cache_write_tokens ?? 0);
  const cacheRead = Number(usage.cacheReadTokens ?? usage.cache_read_tokens ?? 0);
  const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
  const reasoning = Number(usage.reasoningTokens ?? usage.reasoning_tokens ?? 0);
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheWrite,
    cached_input_tokens: cacheRead,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: Number(usage.totalTokens ?? usage.total_tokens ?? input + cacheWrite + cacheRead + output + reasoning)
  };
}

function copilotSessionTimestampMs(data, fallbackTimestamp) {
  const sessionStart = Number(data?.sessionStartTime);
  if (Number.isFinite(sessionStart) && sessionStart > 0) return sessionStart;
  const fallback = Date.parse(fallbackTimestamp);
  return Number.isNaN(fallback) ? NaN : fallback;
}

function addUsage(target, usage) {
  const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0);
  const cached = Number(
    usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cachedInputTokens ?? 0
  );
  const output = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
  const reasoning = Number(
    usage.reasoning_output_tokens ?? usage.thoughts_token_count ?? usage.reasoningOutputTokens ?? 0
  );
  const explicitTotal = usage.total_tokens ?? usage.totalTokens;
  const total = Number(explicitTotal ?? input + cacheCreation + cached + output + reasoning);
  target.inputTokens += input;
  target.cacheCreationInputTokens += cacheCreation;
  target.cachedInputTokens += cached;
  target.outputTokens += output;
  target.reasoningOutputTokens += reasoning;
  target.totalTokens += total;
}

function normalizeClaudeUsage(usage) {
  const input = Number(usage.input_tokens || 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens || 0);
  const cached = Number(usage.cache_read_input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheCreation,
    cached_input_tokens: cached,
    output_tokens: output,
    total_tokens: input + cacheCreation + cached + output
  };
}

async function readClaudeStatusline() {
  const statusFile = CLAUDE_STATUSLINE_FILE;
  try {
    const stat = await fsp.stat(statusFile);
    const raw = JSON.parse(await fsp.readFile(statusFile, "utf8"));
    const extracted = extractClaudeStatusline(raw) || {};
    return {
      statusFile,
      found: true,
      updatedAt: stat.mtime.toISOString(),
      ...extracted
    };
  } catch (error) {
    return {
      statusFile,
      found: false,
      error: error?.code === "ENOENT" ? "missing" : "unreadable"
    };
  }
}

async function readClaudeStatuslineSetupStatus() {
  const [settingsInfo, statusline, authStatus] = await Promise.all([
    readClaudeSettings(),
    readClaudeStatusline(),
    readClaudeAuthStatus()
  ]);
  const statusLine = settingsInfo.settings?.statusLine || null;
  const command = typeof statusLine?.command === "string" ? statusLine.command : "";
  const configured = isClaudeStatuslineConfigured(settingsInfo.settings);
  const statusFileUpdatedAt = await fileMtime(CLAUDE_STATUSLINE_FILE);

  return {
    claudeAvailable: Boolean(resolveClaudeBinary()),
    claudeAuthStatus: authStatus?.status || "unknown",
    claudeLoggedIn: Boolean(authStatus?.loggedIn),
    configured,
    settingsPath: CLAUDE_SETTINGS_FILE,
    settingsError: settingsInfo.error || null,
    scriptInstalled: await pathExists(CLAUDE_STATUSLINE_SCRIPT),
    statusFile: CLAUDE_STATUSLINE_FILE,
    statusFileFound: Boolean(statusline?.found),
    statusFileUpdatedAt: statusline?.updatedAt || statusFileUpdatedAt,
    hasLimits: Boolean(statusline?.limits),
    staleLimits: Boolean(statusline?.staleLimits),
    hasCredits: Boolean(statusline?.credits),
    planType: statusline?.planType || authStatus?.planType || null,
    currentCommandManaged: command.includes(CLAUDE_STATUSLINE_SCRIPT)
  };
}

async function configureClaudeStatusline() {
  const settingsInfo = await readClaudeSettings();
  if (settingsInfo.error) {
    const error = new Error("Claude settings could not be read because settings.json is not valid JSON.");
    error.statusCode = 400;
    error.code = "claude_settings_invalid_json";
    throw error;
  }

  await installClaudeStatuslineScript();
  const command = claudeStatuslineCommand();
  const nextSettings = {
    ...settingsInfo.settings,
    statusLine: {
      type: "command",
      command
    }
  };
  const changed = JSON.stringify(settingsInfo.settings?.statusLine || null) !== JSON.stringify(nextSettings.statusLine);
  let backupPath = null;

  if (changed) {
    await fsp.mkdir(CLAUDE_HOME, { recursive: true });
    if (settingsInfo.exists) {
      backupPath = path.join(CLAUDE_HOME, `settings.json.llm-usage-backup-${timestampForFile()}`);
      await fsp.copyFile(CLAUDE_SETTINGS_FILE, backupPath);
    }
    await fsp.writeFile(CLAUDE_SETTINGS_FILE, `${JSON.stringify(nextSettings, null, 2)}\n`, { mode: 0o600 });
  }

  return {
    ...(await readClaudeStatuslineSetupStatus()),
    changed,
    backupPath
  };
}

async function readClaudeSettings() {
  try {
    const text = await fsp.readFile(CLAUDE_SETTINGS_FILE, "utf8");
    const settings = JSON.parse(text || "{}");
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return { exists: true, settings: {}, error: "invalid_json" };
    }
    return { exists: true, settings, error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, settings: {}, error: null };
    if (error instanceof SyntaxError) return { exists: true, settings: {}, error: "invalid_json" };
    throw error;
  }
}

async function installClaudeStatuslineScript() {
  const source = path.join(ROOT, "scripts", "claude-statusline-capture.js");
  const content = await fsp.readFile(source, "utf8");
  await fsp.mkdir(CLAUDE_HOME, { recursive: true });
  await fsp.writeFile(CLAUDE_STATUSLINE_SCRIPT, content, { mode: 0o700 });
}

function isClaudeStatuslineConfigured(settings) {
  const statusLine = settings?.statusLine;
  return (
    statusLine?.type === "command" &&
    typeof statusLine.command === "string" &&
    statusLine.command.includes(CLAUDE_STATUSLINE_SCRIPT)
  );
}

function claudeStatuslineCommand() {
  const runner = process.versions?.electron
    ? `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)}`
    : shellQuote(process.execPath);
  return `CLAUDE_HOME=${shellQuote(CLAUDE_HOME)} ${runner} ${shellQuote(CLAUDE_STATUSLINE_SCRIPT)}`;
}

async function launchClaudeCode(prompt = DEFAULT_CLAUDE_SETUP_PROMPT, options = {}) {
  const claudeBinary = resolveClaudeBinary();
  if (!claudeBinary) {
    const error = new Error("Claude Code was not found on this machine.");
    error.statusCode = 404;
    error.code = "claude_not_found";
    throw error;
  }

  if (process.platform === "darwin") {
    return launchClaudeCodeInTerminal(claudeBinary, prompt, options);
  }

  const child = spawn(claudeBinary, [prompt], {
    cwd: os.homedir(),
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return { opened: true, method: "detached", claudeBinary };
}

function launchClaudeCodeInTerminal(claudeBinary, prompt, options = {}) {
  const command = `cd ${shellQuote(os.homedir())} && ${shellQuote(claudeBinary)} ${shellQuote(prompt)}`;
  const result = spawnSync(
    "osascript",
    ["-e", "tell application \"Terminal\"", "-e", "activate", "-e", `do script ${JSON.stringify(command)}`, "-e", "end tell"],
    {
      encoding: "utf8",
      timeout: 15000
    }
  );
  if (result.error?.code === "ETIMEDOUT") {
    return { opened: true, method: "terminal", claudeBinary, warning: "terminal_open_timeout" };
  }
  if (result.error || result.status !== 0) {
    const error = new Error(result.error?.message || result.stderr || "Could not open Claude Code in Terminal.");
    error.statusCode = 500;
    error.code = "claude_open_terminal_failed";
    throw error;
  }
  scheduleDashboardFocusBack(options.focusBackDelayMs);
  return { opened: true, method: "terminal", claudeBinary };
}

function scheduleDashboardFocusBack(delayMs = 10000) {
  const delaySeconds = Math.max(3, Math.min(30, Number(delayMs || 10000) / 1000));
  const focusCommand = process.versions?.electron
    ? `osascript -e ${shellQuote('tell application "LLM Usage Dashboard" to activate')}`
    : `open ${shellQuote(currentDashboardUrl || `http://localhost:${PORT}`)}`;
  const child = spawn("/bin/sh", ["-lc", `sleep ${delaySeconds}; ${focusCommand} >/dev/null 2>&1`], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function sanitizeClaudeSetupPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text || text.length > 600) return DEFAULT_CLAUDE_SETUP_PROMPT;
  return text.replaceAll(/[\u0000-\u001f\u007f]/g, " ").replaceAll(/\s+/g, " ");
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileMtime(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

function timestampForFile() {
  return new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function readClaudeAuthStatus() {
  const claudeBinary = resolveClaudeBinary();
  if (!claudeBinary) return { available: false, status: "missing", planType: null };

  const result = spawnSync(claudeBinary, ["auth", "status", "--json"], {
    encoding: "utf8",
    timeout: CLAUDE_AUTH_STATUS_TIMEOUT_MS,
    maxBuffer: 256 * 1024
  });
  if (result.error) {
    return {
      available: true,
      status: result.error.code === "ETIMEDOUT" ? "timeout" : "error",
      planType: null
    };
  }
  if (result.status !== 0) {
    return { available: true, status: "unavailable", planType: null };
  }

  try {
    const raw = JSON.parse(result.stdout || "{}");
    return {
      available: true,
      status: "ok",
      planType: extractClaudePlanType(raw),
      loggedIn: parseBoolean(raw.loggedIn ?? raw.logged_in)
    };
  } catch {
    return { available: true, status: "invalid_json", planType: null };
  }
}

function resolveClaudeBinary() {
  const candidates = [
    process.env.CLAUDE_BIN,
    process.env.CLAUDE_CLI_PATH,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude"
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  const which = spawnSync("which", ["claude"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

function extractClaudeStatusline(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rateLimits = raw.rate_limits || raw.rateLimits || raw;
  const extractedLimits = extractClaudeRateLimits(rateLimits);
  const limits = hasActiveClaudeLimits(extractedLimits) ? extractedLimits : null;
  const staleLimits = Boolean(extractedLimits?.staleWindows?.length);
  const planType = extractClaudePlanType(raw) || extractClaudePlanType(rateLimits);
  const credits = extractUsageCredits(raw) || extractUsageCredits(rateLimits);
  return limits || planType || credits || staleLimits ? { limits, staleLimits, planType, credits } : null;
}

function extractUsageCredits(source) {
  if (!source || typeof source !== "object") return null;
  const candidates = [
    source.usage_credits,
    source.usageCredits,
    source.guthaben,
    source.credits,
    source.credit,
    source.billing?.usage_credits,
    source.billing?.usageCredits,
    source.billing?.credits,
    source.account?.usage_credits,
    source.account?.usageCredits,
    source.account?.credits
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const credits = sanitizeUsageCredits(candidate);
    if (hasUsageCredits(credits)) return credits;
  }
  return null;
}

function extractClaudePlanType(raw) {
  if (!raw || typeof raw !== "object") return null;
  const value =
    raw.subscriptionType ??
    raw.subscription_type ??
    raw.plan_type ??
    raw.planType ??
    raw.plan ??
    raw.subscription_plan ??
    raw.subscriptionPlan ??
    raw.account?.plan ??
    raw.user?.plan ??
    raw.organization?.plan;
  return value ? String(value).trim() : null;
}

function extractClaudeRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const official = extractOfficialClaudeRateLimits(rateLimits);
  const fallback = extractFallbackClaudeRateLimits(rateLimits);
  if (official) {
    const limits = {
      ...official,
      claudeDesign: fallback?.claudeDesign || null
    };
    limits.rows = buildLimitRows(limits, ["fiveHour", "weekly", "claudeDesign"]);
    return limits;
  }
  return fallback;
}

function extractOfficialClaudeRateLimits(rateLimits) {
  const fiveHourCandidate = claudeLimitWindow(
    findClaudeLimit(rateLimits, ["five_hour", "fiveHour"]),
    "5h",
    300
  );
  const weeklyCandidate = claudeLimitWindow(
    findClaudeLimit(rateLimits, ["seven_day", "sevenDay"]),
    "Woche",
    10080
  );
  const staleWindows = staleClaudeWindows(fiveHourCandidate, weeklyCandidate);
  const fiveHour = freshClaudeWindow(fiveHourCandidate);
  const weekly = freshClaudeWindow(weeklyCandidate);
  if (!fiveHour && !weekly && !staleWindows.length) return null;
  const limits = {
    fiveHour,
    weekly,
    currentSession: fiveHour,
    allModels: weekly
  };
  if (staleWindows.length) limits.staleWindows = staleWindows;
  limits.rows = buildLimitRows(limits, ["fiveHour", "weekly"]);
  return limits;
}

function extractFallbackClaudeRateLimits(rateLimits) {
  const weeklyRoot = rateLimits.weekly || rateLimits.weekly_limits || rateLimits.weeklyLimits || {};
  const currentSessionCandidate = claudeLimitWindow(
    findClaudeLimit(rateLimits, ["current_session", "currentSession", "session", "five_hour", "fiveHour", "primary", "5h"]),
    "Aktuelle Sitzung",
    300
  );
  const allModelsCandidate = claudeLimitWindow(
    findClaudeLimit(weeklyRoot, ["all_models", "allModels", "all", "models"]) ||
      findClaudeLimit(rateLimits, ["all_models", "allModels", "secondary", "seven_day", "sevenDay", "7d"]),
    "Alle Modelle",
    10080
  );
  const claudeDesignCandidate = claudeLimitWindow(
    findClaudeLimit(weeklyRoot, ["claude_design", "claudeDesign", "design"]) ||
      findClaudeLimit(rateLimits, ["claude_design", "claudeDesign", "design"]),
    "Claude Design",
    10080
  );
  const staleWindows = staleClaudeWindows(currentSessionCandidate, allModelsCandidate, claudeDesignCandidate);
  const currentSession = freshClaudeWindow(currentSessionCandidate);
  const allModels = freshClaudeWindow(allModelsCandidate);
  const claudeDesign = freshClaudeWindow(claudeDesignCandidate);
  const weeklyCandidate = allModelsCandidate || claudeLimitWindow(findClaudeLimit(rateLimits, ["weekly"]), "Woche", 10080);
  const weekly = freshClaudeWindow(weeklyCandidate);
  if (!allModelsCandidate && weeklyCandidate?.expired) staleWindows.push(weeklyCandidate.label);
  const fiveHour = currentSession;
  const limits = {
    fiveHour,
    weekly,
    currentSession,
    allModels,
    claudeDesign
  };
  if (staleWindows.length) limits.staleWindows = staleWindows;
  limits.rows = buildLimitRows(limits, ["currentSession", "allModels", "claudeDesign"]);
  if (!fiveHour && !weekly && !claudeDesign && !staleWindows.length) return null;
  return limits;
}

function findClaudeLimit(source, keys) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    if (source[key]) return source[key];
  }
  const entries = Array.isArray(source)
    ? source.map((value, index) => [String(index), value])
    : Object.entries(source);
  for (const [, value] of entries) {
    if (!value || typeof value !== "object") continue;
    const name = String(
      value.key || value.name || value.label || value.limit_name || value.limitName || value.type || ""
    ).toLowerCase();
    if (keys.some((key) => name.includes(String(key).replaceAll("_", " ").toLowerCase()))) return value;
  }
  return null;
}

function claudeLimitWindow(window, label, minutes) {
  if (!window || typeof window !== "object") return null;
  const remainingPercentRaw =
    window.remaining_percentage ??
    window.remainingPercent ??
    window.remaining_percent ??
    window.percent_remaining ??
    null;
  const usedPercent =
    window.used_percentage ??
    window.usedPercent ??
    window.used_percent ??
    window.percent_used ??
    window.usage_percentage ??
    window.usagePercent ??
    (remainingPercentRaw === null ? null : 100 - Number(remainingPercentRaw));
  if (usedPercent === null || Number.isNaN(Number(usedPercent))) return null;
  const resetsAt = window.resets_at || window.resetsAt || window.reset_at || window.resetAt || null;
  const resetLabel =
    window.reset_label ||
    window.resetLabel ||
    window.resets_in ||
    window.resetsIn ||
    window.reset_in ||
    window.resetIn ||
    null;
  const safeUsedPercent = Math.max(0, Math.min(100, Number(usedPercent)));
  const normalizedResetsAt = normalizeOptionalDate(resetsAt);
  const resetMs = normalizedResetsAt ? Date.parse(normalizedResetsAt) : null;
  return {
    label: String(window.label || window.name || window.limit_name || window.limitName || label),
    usedPercent: safeUsedPercent,
    remainingPercent: Math.max(0, 100 - safeUsedPercent),
    windowMinutes: Number(window.window_minutes || window.windowMinutes || minutes),
    resetsAt: normalizedResetsAt,
    resetLabel: resetLabel ? String(resetLabel) : null,
    expired: Number.isFinite(resetMs) && resetMs <= Date.now()
  };
}

function freshClaudeWindow(window) {
  return window?.expired ? null : window;
}

function staleClaudeWindows(...windows) {
  return windows.filter((window) => window?.expired).map((window) => window.label);
}

function hasActiveClaudeLimits(limits) {
  return Boolean(
    limits &&
      (limits.fiveHour ||
        limits.weekly ||
        limits.currentSession ||
        limits.allModels ||
        limits.claudeDesign ||
        limits.rows?.length)
  );
}

async function listGeminiUsageFiles(root) {
  const skipParts = [`${path.sep}config${path.sep}plugins${path.sep}`];
  const allowedNames = new Set(["telemetry.log", "usage.json", "usage.jsonl"]);
  return listFiles(root, (file) => {
    if (skipParts.some((part) => file.includes(part))) return false;
    const base = path.basename(file);
    if (allowedNames.has(base)) return true;
    if (file.includes(`${path.sep}tmp${path.sep}`) && /\.(json|jsonl|log)$/.test(file)) return true;
    if (file.includes(`${path.sep}chats${path.sep}`) && /\.(json|jsonl)$/.test(file)) return true;
    if (file.includes(`${path.sep}telemetry${path.sep}`) && /\.(json|jsonl|log)$/.test(file)) return true;
    return false;
  });
}

function findGeminiUsageMetadata(event) {
  const wrapper = findFirstObject(event, (object) => {
    const hasCamel =
      object.promptTokenCount !== undefined ||
      object.candidatesTokenCount !== undefined ||
      object.totalTokenCount !== undefined ||
      object.thoughtsTokenCount !== undefined;
    const hasSnake =
      object.prompt_token_count !== undefined ||
      object.candidates_token_count !== undefined ||
      object.total_token_count !== undefined ||
      object.thoughts_token_count !== undefined;
    return hasCamel || hasSnake || object.usageMetadata !== undefined || object.usage_metadata !== undefined;
  });
  return wrapper?.usageMetadata || wrapper?.usage_metadata || findFirstObject(event, (object) => {
    return (
      object.promptTokenCount !== undefined ||
      object.candidatesTokenCount !== undefined ||
      object.totalTokenCount !== undefined ||
      object.prompt_token_count !== undefined ||
      object.candidates_token_count !== undefined ||
      object.total_token_count !== undefined
    );
  });
}

function normalizeGeminiUsage(usage) {
  const input = Number(usage.promptTokenCount ?? usage.prompt_token_count ?? 0);
  const cached = Number(usage.cachedContentTokenCount ?? usage.cached_content_token_count ?? 0);
  const output = Number(usage.candidatesTokenCount ?? usage.candidates_token_count ?? 0);
  const thoughts = Number(usage.thoughtsTokenCount ?? usage.thoughts_token_count ?? 0);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: thoughts,
    total_tokens: Number(usage.totalTokenCount ?? usage.total_token_count ?? input + cached + output + thoughts)
  };
}

function findTimestampMs(event) {
  const candidate =
    event.timestamp || event.createdAt || event.created_at || event.startTime || event.start_time || event.time;
  const parsed = candidate ? Date.parse(candidate) : NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

function findModelName(event) {
  return findFirstValue(event, ["model", "modelName", "model_name"]);
}

function findFirstObject(value, predicate) {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value) && predicate(value)) return value;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = findFirstObject(child, predicate);
    if (found) return found;
  }
  return null;
}

function findFirstValue(value, keys) {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value)) {
    for (const key of keys) {
      if (typeof value[key] === "string") return value[key];
    }
  }
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = findFirstValue(child, keys);
    if (found) return found;
  }
  return null;
}

function safeStatMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

async function readCodexLiveRateLimits() {
  if (!CODEX_LIVE_RATE_LIMITS_ENABLED) return null;
  return readThroughCache(codexLiveRateLimitsCache, CODEX_LIVE_RATE_LIMITS_CACHE_MS, async () => {
    try {
      const client = await getCodexAppServer();
      const response = await client.request("account/rateLimits/read", undefined);
      return normalizeCodexLiveRateLimits(response);
    } catch (error) {
      if (codexLiveRateLimitsCache.value) throw error;
      return {
        source: {
          status: "error",
          message: error.message,
          updatedAt: new Date().toISOString()
        }
      };
    }
  });
}

function normalizeCodexLiveRateLimits(response) {
  const entries = [];
  if (response?.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object") {
    for (const [limitId, snapshot] of Object.entries(response.rateLimitsByLimitId)) {
      if (snapshot) entries.push([limitId, snapshot]);
    }
  }
  if (!entries.length && response?.rateLimits) {
    entries.push([response.rateLimits.limitId || "codex", response.rateLimits]);
  }

  const codex = entries.find(([, snapshot]) => !isCodexSparkSnapshot(snapshot))?.[1] || null;
  const spark = entries.find(([, snapshot]) => isCodexSparkSnapshot(snapshot))?.[1] || null;

  return {
    codex,
    spark,
    source: {
      status: codex || spark ? "live" : "empty",
      source: "codex app-server",
      updatedAt: new Date().toISOString(),
      limitCount: entries.length
    }
  };
}

function isCodexSparkSnapshot(snapshot) {
  return /spark|bengalfox|research/i.test(`${snapshot?.limitId || ""} ${snapshot?.limitName || ""}`);
}

function codexRateLimitsFromLive(snapshot, labelPrefix) {
  if (!snapshot) return null;
  return {
    planType: snapshot.planType || null,
    fiveHour: codexWindowFromLive(snapshot.primary, `5h ${labelPrefix} limit`),
    weekly: codexWindowFromLive(snapshot.secondary, `Weekly ${labelPrefix} limit`)
  };
}

function codexWindowFromLive(window, label) {
  if (!window) return null;
  const usedPercent = Number(window.usedPercent);
  if (!Number.isFinite(usedPercent)) return null;
  return {
    label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes: Number(window.windowDurationMins || 0),
    resetsAt: window.resetsAt ? new Date(Number(window.resetsAt) * 1000).toISOString() : null
  };
}

async function getCodexAppServer() {
  if (codexAppServer) return codexAppServer;

  const codexBinary = resolveCodexBinary();
  if (!codexBinary) {
    throw new Error("Codex CLI not found");
  }

  const proc = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map();
  let buffer = "";
  let closing = false;

  const send = (message) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const client = {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }, CODEX_APP_SERVER_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timeout, method });
        send({ id, method, params });
      });
    },
    close() {
      closing = true;
      proc.kill("SIGTERM");
    }
  };

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!rawLine) continue;

      let message;
      try {
        message = JSON.parse(rawLine);
      } catch {
        continue;
      }

      if (!message || !Object.prototype.hasOwnProperty.call(message, "id")) continue;
      const entry = pending.get(String(message.id));
      if (!entry) continue;
      clearTimeout(entry.timeout);
      pending.delete(String(message.id));
      if (message.error) {
        entry.reject(new Error(message.error.message || `Request failed: ${entry.method}`));
      } else {
        entry.resolve(message.result);
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    if (process.env.CODEX_LIVE_RATE_LIMITS_DEBUG) process.stderr.write(chunk);
  });

  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
    pending.clear();
  };

  proc.on("error", (error) => {
    if (!closing) rejectPending(error);
    codexAppServer = null;
  });

  proc.on("exit", (code, signal) => {
    if (!closing) {
      rejectPending(new Error(`Codex app-server exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`));
    }
    codexAppServer = null;
  });

  codexAppServer = client;
  try {
    await client.request("initialize", {
      clientInfo: { name: "llm-usage-dashboard", version: "1.0.0" },
      capabilities: null
    });
    send({ method: "initialized" });
    return client;
  } catch (error) {
    client.close();
    codexAppServer = null;
    throw error;
  }
}

function resolveCodexBinary() {
  const candidates = [
    process.env.CODEX_BIN,
    process.env.CODEX_CLI_PATH,
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/MacOS/Codex"
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  const which = spawnSync("which", ["codex"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

function codexRateLimits(rateLimits) {
  if (!rateLimits) {
    return {
      fiveHour: null,
      weekly: null
    };
  }
  return {
    fiveHour: codexWindow(rateLimits.primary, "5h Codex limit"),
    weekly: codexWindow(rateLimits.secondary, "Weekly Codex limit")
  };
}

function codexRateLimitsFromEvents(events, fallbackRateLimits) {
  if (!events.length) return codexRateLimits(fallbackRateLimits);
  return {
    fiveHour: codexWindowFromEvents(events, "primary", "5h Codex limit"),
    weekly: codexWindowFromEvents(events, "secondary", "Weekly Codex limit")
  };
}

function codexSparkRateLimitsFromEvents(events, fallbackRateLimits, hasSparkUsage) {
  const limits = codexRateLimitsFromEvents(events, fallbackRateLimits);
  const hasAnyLimit = Boolean(limits.fiveHour || limits.weekly);
  return {
    fiveHour: relabelCodexWindow(
      limits.fiveHour || (hasAnyLimit || hasSparkUsage ? emptyCodexWindow("5h Codex 5.3 Spark limit", 300) : null),
      "5h Codex 5.3 Spark limit"
    ),
    weekly: relabelCodexWindow(limits.weekly, "Weekly Codex 5.3 Spark limit")
  };
}

function relabelCodexWindow(window, label) {
  return window ? { ...window, label } : null;
}

function emptyCodexWindow(label, minutes) {
  return {
    label,
    usedPercent: 0,
    remainingPercent: 100,
    windowMinutes: minutes,
    resetsAt: null
  };
}

function codexWindowFromEvents(events, key, label) {
  const nowSeconds = Date.now() / 1000;
  const candidates = events
    .map((event) => ({
      timestamp: event.timestamp,
      window: event.rateLimits?.[key],
      file: event.file
    }))
    .filter(({ window }) => {
      if (!window) return false;
      if (window.resets_at && Number(window.resets_at) < nowSeconds) return false;
      return Number.isFinite(Number(window.used_percent));
    });

  if (!candidates.length) return null;

  // Prefer the newest reset window first. Older active sessions can keep
  // emitting stale quota windows after a plan change or quota recalculation.
  const best = candidates.reduce((selected, candidate) => {
    const candidateReset = Number(candidate.window.resets_at || 0);
    const selectedReset = Number(selected.window.resets_at || 0);
    if (candidateReset !== selectedReset) return candidateReset > selectedReset ? candidate : selected;

    const candidateTime = Date.parse(candidate.timestamp);
    const selectedTime = Date.parse(selected.timestamp);
    if (candidateTime !== selectedTime) return candidateTime > selectedTime ? candidate : selected;

    const candidateUsed = Number(candidate.window.used_percent || 0);
    const selectedUsed = Number(selected.window.used_percent || 0);
    return candidateUsed > selectedUsed ? candidate : selected;
  });

  return codexWindow(best.window, label);
}

function codexWindow(window, label) {
  if (!window) return null;
  const usedPercent = Number(window.used_percent || 0);
  return {
    label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes: Number(window.window_minutes || 0),
    resetsAt: window.resets_at ? new Date(Number(window.resets_at) * 1000).toISOString() : null
  };
}

async function readOpenAiUsage() {
  const key = process.env.OPENAI_ADMIN_KEY;
  if (!key) {
    return {
      id: "openai",
      status: "not_configured",
      updatedAt: new Date().toISOString(),
      message: "Set OPENAI_ADMIN_KEY for organization usage and costs."
    };
  }

  const end = Math.floor(Date.now() / 1000);
  const start = end - 7 * 24 * 60 * 60;
  const headers = { Authorization: `Bearer ${key}` };
  const usageUrl = new URL("https://api.openai.com/v1/organization/usage/completions");
  usageUrl.searchParams.set("start_time", String(start));
  usageUrl.searchParams.set("end_time", String(end));
  usageUrl.searchParams.set("bucket_width", "1d");
  usageUrl.searchParams.append("group_by[]", "model");

  const costsUrl = new URL("https://api.openai.com/v1/organization/costs");
  costsUrl.searchParams.set("start_time", String(start));
  costsUrl.searchParams.set("end_time", String(end));
  costsUrl.searchParams.set("bucket_width", "1d");

  const [usage, costs] = await Promise.all([
    fetchJson(usageUrl, { headers }),
    fetchJson(costsUrl, { headers })
  ]);

  return {
    id: "openai",
    status: "live",
    updatedAt: new Date().toISOString(),
    usage: summarizeOpenAiUsage(usage),
    costs: summarizeOpenAiCosts(costs)
  };
}

function summarizeOpenAiUsage(payload) {
  const totals = createUsageTotals();
  const models = new Map();
  for (const result of flattenResults(payload)) {
    const usage = {
      input_tokens: result.input_tokens,
      cached_input_tokens: result.input_cached_tokens,
      output_tokens: result.output_tokens,
      total_tokens: Number(result.input_tokens || 0) + Number(result.output_tokens || 0)
    };
    addUsage(totals, usage);
    const model = result.model || "unknown";
    if (!models.has(model)) models.set(model, createUsageTotals());
    addUsage(models.get(model), usage);
  }
  return {
    totals,
    byModel: Array.from(models.entries())
      .map(([model, usage]) => ({ model, ...usage }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 8)
  };
}

function summarizeOpenAiCosts(payload) {
  let total = 0;
  let currency = "usd";
  for (const result of flattenResults(payload)) {
    total += Number(result.amount?.value || 0);
    currency = result.amount?.currency || currency;
  }
  return { total, currency };
}

async function readAnthropicUsage() {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) {
    return {
      id: "anthropic",
      status: "not_configured",
      updatedAt: new Date().toISOString(),
      message: "Set ANTHROPIC_ADMIN_KEY for organization usage and costs."
    };
  }

  return readThroughCache(anthropicCache, ANTHROPIC_API_CACHE_MS, async () => {
    const ending = new Date();
    const starting = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const headers = {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "user-agent": "llm-usage-dashboard/1.0.0"
    };

    const usageUrl = new URL("https://api.anthropic.com/v1/organizations/usage_report/messages");
    usageUrl.searchParams.set("starting_at", starting.toISOString());
    usageUrl.searchParams.set("ending_at", ending.toISOString());
    usageUrl.searchParams.set("bucket_width", "1d");
    usageUrl.searchParams.append("group_by[]", "model");

    const costUrl = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    costUrl.searchParams.set("starting_at", starting.toISOString());
    costUrl.searchParams.set("ending_at", ending.toISOString());
    costUrl.searchParams.append("group_by[]", "description");

    const [usage, costs, limits] = await Promise.all([
      fetchJson(usageUrl, { headers }),
      fetchJson(costUrl, { headers }),
      fetchAnthropicRateLimits(headers).catch((error) => ({
        status: "error",
        message: error.message,
        rows: []
      }))
    ]);

    return {
      id: "anthropic",
      status: "live",
      updatedAt: new Date().toISOString(),
      usage: summarizeAnthropicUsage(usage),
      costs: summarizeAnthropicCosts(costs),
      limits
    };
  });
}

async function fetchAnthropicRateLimits(headers) {
  const orgUrl = new URL("https://api.anthropic.com/v1/organizations/rate_limits");
  orgUrl.searchParams.set("group_type", "model_group");

  const requests = [fetchJson(orgUrl, { headers })];
  if (ANTHROPIC_WORKSPACE_ID) {
    const workspaceUrl = new URL(
      `https://api.anthropic.com/v1/organizations/workspaces/${encodeURIComponent(ANTHROPIC_WORKSPACE_ID)}/rate_limits`
    );
    workspaceUrl.searchParams.set("group_type", "model_group");
    requests.push(fetchJson(workspaceUrl, { headers }));
  }

  const [organization, workspace] = await Promise.all(requests);
  return summarizeAnthropicRateLimits(organization, workspace);
}

function summarizeAnthropicRateLimits(organization, workspace) {
  const workspaceRows = summarizeAnthropicRateLimitRows(workspace?.data || [], "Workspace");
  const organizationRows = summarizeAnthropicRateLimitRows(organization?.data || [], "Org");
  const rows = [...workspaceRows, ...organizationRows].slice(0, 5);
  return {
    status: "live",
    source: ANTHROPIC_WORKSPACE_ID ? "Anthropic Admin API org/workspace rate limits" : "Anthropic Admin API org rate limits",
    updatedAt: new Date().toISOString(),
    summaryLabel: rows.length ? `${rows.length} Limitgruppen` : "Keine Modelllimits",
    rows
  };
}

function summarizeAnthropicRateLimitRows(entries, scope) {
  return entries
    .filter((entry) => entry?.group_type === "model_group")
    .sort((a, b) => anthropicModelGroupRank(a) - anthropicModelGroupRank(b))
    .map((entry, index) => {
      const limits = new Map((entry.limits || []).map((limit) => [limit.type, Number(limit.value)]));
      const requests = limits.get("requests_per_minute");
      const input = limits.get("input_tokens_per_minute");
      const output = limits.get("output_tokens_per_minute");
      const valueLabel = [
        Number.isFinite(requests) ? `${formatCompactLimit(requests)} RPM` : null,
        Number.isFinite(input) ? `${formatCompactLimit(input)} ITPM` : null,
        Number.isFinite(output) ? `${formatCompactLimit(output)} OTPM` : null
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        key: `${scope}-${index}-${entry.models?.[0] || entry.group_type}`,
        label: `${scope} ${anthropicModelGroupLabel(entry)}`,
        valueLabel: valueLabel || `${entry.limits?.length || 0} Limits`
      };
    });
}

function anthropicModelGroupRank(entry) {
  const label = anthropicModelGroupLabel(entry).toLowerCase();
  if (label.includes("opus")) return 0;
  if (label.includes("sonnet")) return 1;
  if (label.includes("haiku")) return 2;
  return 3;
}

function anthropicModelGroupLabel(entry) {
  const models = (entry.models || []).join(" ");
  if (/opus/i.test(models)) return "Opus";
  if (/sonnet/i.test(models)) return "Sonnet";
  if (/haiku/i.test(models)) return "Haiku";
  return String(entry.models?.[0] || entry.group_type || "Modelle").replace(/^claude-/, "");
}

function formatCompactLimit(value) {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function summarizeAnthropicUsage(payload) {
  const totals = createUsageTotals();
  const models = new Map();
  for (const result of flattenResults(payload)) {
    const usage = {
      input_tokens:
        Number(result.uncached_input_tokens || result.input_tokens || 0) +
        Number(result.cache_creation_input_tokens || 0),
      cached_input_tokens: result.cache_read_input_tokens || result.cached_input_tokens || 0,
      output_tokens: result.output_tokens || 0,
      total_tokens:
        Number(result.uncached_input_tokens || result.input_tokens || 0) +
        Number(result.cache_creation_input_tokens || 0) +
        Number(result.cache_read_input_tokens || result.cached_input_tokens || 0) +
        Number(result.output_tokens || 0)
    };
    addUsage(totals, usage);
    const model = result.model || result.group?.model || result.description?.model || "unknown";
    if (!models.has(model)) models.set(model, createUsageTotals());
    addUsage(models.get(model), usage);
  }
  return {
    totals,
    byModel: Array.from(models.entries())
      .map(([model, usage]) => ({ model, ...usage }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 8)
  };
}

function summarizeAnthropicCosts(payload) {
  let total = 0;
  for (const result of flattenResults(payload)) {
    total += Number(result.amount || result.cost || result.cost_usd || result.total_cost || 0);
  }
  return { total, currency: "usd" };
}

function flattenResults(payload) {
  const results = [];
  const buckets = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.buckets) ? payload.buckets : [];
  for (const bucket of buckets) {
    if (Array.isArray(bucket.results)) results.push(...bucket.results);
    else results.push(bucket);
  }
  if (Array.isArray(payload?.results)) results.push(...payload.results);
  return results;
}

async function fetchJson(url, options = {}) {
  const { timeoutMs = EXTERNAL_FETCH_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...fetchOptions, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Timed out fetching ${new URL(url).hostname}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const message = json.error?.message || json.message || response.statusText;
    throw new Error(`${response.status} ${message}`);
  }
  return json;
}

function startOllamaProxy() {
  const proxy = express();
  proxy.use(express.json({ limit: "50mb", type: "*/*" }));
  proxy.all("*", proxyOllamaRequest);
  const server = proxy.listen(OLLAMA_PROXY_PORT, () => {
    console.log(`Ollama usage proxy listening on http://localhost:${OLLAMA_PROXY_PORT} -> ${OLLAMA_HOST}`);
  });
  server.on("error", (error) => {
    console.error(`Ollama usage proxy failed on port ${OLLAMA_PROXY_PORT}: ${error.message}`);
  });
  return server;
}

async function proxyOllamaRequest(req, res) {
  const targetUrl = new URL(req.originalUrl, OLLAMA_HOST);
  const headers = copyProxyHeaders(req.headers);
  const body = hasRequestBody(req.method) ? JSON.stringify(req.body || {}) : undefined;

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body
    });
    res.status(upstream.status);
    copyResponseHeaders(upstream.headers, res);

    const chunks = [];
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        const buffer = Buffer.from(chunk);
        chunks.push(buffer);
        res.write(buffer);
      }
    }
    res.end();

    const text = Buffer.concat(chunks).toString("utf8");
    const usageEvent = extractOllamaUsage(text, req.body || {}, req.originalUrl);
    if (usageEvent) await appendOllamaUsageLog(usageEvent);
  } catch (error) {
    res.status(502).json({
      error: "ollama_proxy_error",
      message: error.message,
      target: OLLAMA_HOST
    });
  }
}

function hasRequestBody(method) {
  return !["GET", "HEAD"].includes(String(method || "").toUpperCase());
}

function copyProxyHeaders(source) {
  const headers = {};
  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (["host", "content-length", "connection", "accept-encoding"].includes(lower)) continue;
    headers[key] = value;
  }
  headers["content-type"] = "application/json";
  return headers;
}

function copyResponseHeaders(source, res) {
  for (const [key, value] of source.entries()) {
    const lower = key.toLowerCase();
    if (["content-length", "transfer-encoding", "content-encoding", "connection"].includes(lower)) continue;
    res.setHeader(key, value);
  }
}

function extractOllamaUsage(text, requestBody, endpoint) {
  const objects = parseJsonObjects(text);
  const usageObject = [...objects].reverse().find((object) => {
    return (
      object?.prompt_eval_count !== undefined ||
      object?.eval_count !== undefined ||
      object?.usage?.prompt_tokens !== undefined ||
      object?.usage?.completion_tokens !== undefined
    );
  });
  if (!usageObject) return null;

  const openAiUsage = usageObject.usage || {};
  const input = Number(usageObject.prompt_eval_count ?? openAiUsage.prompt_tokens ?? 0);
  const output = Number(usageObject.eval_count ?? openAiUsage.completion_tokens ?? 0);
  const total = Number(usageObject.total_tokens ?? openAiUsage.total_tokens ?? input + output);
  if (!total) return null;

  return {
    timestamp: new Date().toISOString(),
    provider: "ollama",
    endpoint,
    model: usageObject.model || requestBody.model || "ollama",
    usage: {
      input_tokens: input,
      output_tokens: output,
      total_tokens: total
    },
    durations: {
      total_duration: usageObject.total_duration ?? null,
      load_duration: usageObject.load_duration ?? null,
      prompt_eval_duration: usageObject.prompt_eval_duration ?? null,
      eval_duration: usageObject.eval_duration ?? null
    }
  };
}

function parseJsonObjects(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const sseLine = line.startsWith("data:") ? line.slice(5).trim() : line;
        if (!sseLine || sseLine === "[DONE]") return [];
        try {
          return [JSON.parse(sseLine)];
        } catch {
          return [];
        }
      });
  }
}

async function appendOllamaUsageLog(event) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.appendFile(OLLAMA_USAGE_FILE, `${JSON.stringify(event)}\n`);
}

function startDashboard(options = {}) {
  const port = Number(options.port ?? PORT);
  const dashboardServer = app.listen(port, () => {
    const address = dashboardServer.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    currentDashboardUrl = `http://localhost:${actualPort}`;
    console.log(`LLM usage dashboard listening on http://localhost:${actualPort}`);
  });
  const ollamaProxyServer = options.ollamaProxy === false ? null : startOllamaProxy();
  return { dashboardServer, ollamaProxyServer };
}

if (require.main === module) {
  startDashboard();
}

module.exports = { app, startDashboard };
