"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const crypto = require("node:crypto");
const https = require("node:https");
const { spawn, spawnSync } = require("node:child_process");
const express = require("express");
const session = require("express-session");
const { discoverSources, sourceId } = require("./lib/source-discovery");
const {
  connectSource,
  disableSource,
  normalizeConnectedSource,
  readSourceSettings
} = require("./lib/source-settings");
const { aggregateUsageEvents, hashEvidencePath } = require("./lib/usage-events");

const PORT = Number(process.env.PORT || 4177);
const ROOT = __dirname;
const DATA_DIR = expandHome(process.env.LLM_USAGE_DATA_DIR || process.env.DATA_DIR || path.join(ROOT, "data"));
const OLLAMA_USAGE_FILE = path.join(DATA_DIR, "ollama-usage.jsonl");
const NOTIFICATION_SETTINGS_FILE = path.join(DATA_DIR, "notification-settings.json");
const NOTIFICATION_STATUS_FILE = path.join(DATA_DIR, "notification-status.json");
const UPDATE_SETTINGS_FILE = path.join(DATA_DIR, "update-settings.json");
const UPDATE_STATUS_FILE = path.join(DATA_DIR, "update-status.json");
const CLAUDE_BROWSER_CREDITS_FILE = path.join(DATA_DIR, "claude-browser-credits.json");
const QUOTA_EVENTS_FILE = path.join(DATA_DIR, "quota-events.jsonl");
const SUBSCRIPTION_SETTINGS_FILE = path.join(DATA_DIR, "subscription-settings.json");
const SUBSCRIPTION_HISTORY_FILE = path.join(DATA_DIR, "subscription-history.json");
const OFFICIAL_SUBSCRIPTION_PRICING_FILE = path.join(DATA_DIR, "official-subscription-pricing.json");
const ACCOUNT_BILLING_SNAPSHOTS_FILE = path.join(DATA_DIR, "account-billing-snapshots.json");
const LEGACY_MANUAL_LIMITS_FILE = path.join(DATA_DIR, "manual-limits.json");
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
const CLAUDE_APP_COOKIES = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude",
  "Cookies"
);
const CLAUDE_API_USAGE_TIMEOUT_MS = 5000;
const DEFAULT_CLAUDE_SETUP_PROMPT =
  "Reply briefly: The LLM Usage setup check was triggered. If this answer is visible, return to the dashboard; the Claude limits should update within a few seconds.";
const GEMINI_HOME = expandHome(process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini"));
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_PROXY_PORT = Number(process.env.OLLAMA_PROXY_PORT || 11435);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const DAILY_HISTORY_DAYS = Number(process.env.DAILY_HISTORY_DAYS || 180);
const USAGE_CACHE_MS = envMs("USAGE_CACHE_SECONDS", 120);
const EXTERNAL_FETCH_TIMEOUT_MS = envMs("EXTERNAL_FETCH_TIMEOUT_SECONDS", 8);
const ANTHROPIC_API_CACHE_MS = envMs("ANTHROPIC_API_CACHE_SECONDS", 60);
const CODEX_LIVE_RATE_LIMITS_ENABLED = parseBoolean(process.env.CODEX_LIVE_RATE_LIMITS ?? "true");
const CODEX_LIVE_RATE_LIMITS_CACHE_MS = envMs("CODEX_LIVE_RATE_LIMITS_CACHE_SECONDS", 15);
const CODEX_APP_SERVER_TIMEOUT_MS = envMs("CODEX_APP_SERVER_TIMEOUT_SECONDS", 5);
const COPILOT_LIVE_QUOTA_ENABLED = parseBoolean(process.env.COPILOT_LIVE_QUOTA_ENABLED ?? "true");
const COPILOT_LIVE_QUOTA_CACHE_MS = envMs("COPILOT_LIVE_QUOTA_CACHE_SECONDS", 30);
const COPILOT_LIVE_QUOTA_TIMEOUT_MS = envMs("COPILOT_LIVE_QUOTA_TIMEOUT_SECONDS", 12);
const SOURCE_DIAGNOSTICS_CACHE_MS = envMs("SOURCE_DIAGNOSTICS_CACHE_SECONDS", 30);
const COPILOT_QUOTA_PROBE_SCRIPT = resolvePackagedResourcePath(path.join("scripts", "copilot-quota-probe.mjs"));
const CLAUDE_AUTH_STATUS_TIMEOUT_MS = envMs("CLAUDE_AUTH_STATUS_TIMEOUT_SECONDS", 5);
const CLAUDE_API_USAGE_CACHE_MS = envMs("CLAUDE_API_USAGE_CACHE_SECONDS", 60);
const CLAUDE_API_USAGE_STALE_MS = envMs("CLAUDE_API_USAGE_STALE_SECONDS", 600);
const ANTHROPIC_WORKSPACE_ID = String(process.env.ANTHROPIC_WORKSPACE_ID || "").trim();
const ELECTRON_SYNC_TOKEN = String(process.env.LLM_USAGE_ELECTRON_SYNC_TOKEN || "").trim();
const SUBSCRIPTION_PROVIDER_IDS = ["codex", "claudeCode", "openai", "anthropic", "copilot", "gemini"];
const SUBSCRIPTION_HISTORY_VERSION = 1;
const SUBSCRIPTION_CATALOG_REVIEW_DATE = "2026-07-07";
const ACCOUNT_BILLING_STALE_MS = envMs("ACCOUNT_BILLING_STALE_SECONDS", 7 * 24 * 60 * 60);
const OFFICIAL_PRICING_CACHE_MS = envMs("OFFICIAL_SUBSCRIPTION_PRICING_CACHE_SECONDS", 6 * 60 * 60);
const OFFICIAL_PRICING_FETCH_TIMEOUT_MS = envMs("OFFICIAL_SUBSCRIPTION_PRICING_FETCH_TIMEOUT_SECONDS", 8);
const OFFICIAL_SUBSCRIPTION_PRICING_SOURCES = {
  openai: {
    sourceUrl: "https://developers.openai.com/codex/pricing",
    parser: parseOpenAiCodexPricingPage
  },
  anthropic: {
    sourceUrl: "https://claude.com/pricing",
    parser: parseClaudePricingPage
  }
};
const PUBLIC_SUBSCRIPTION_PLAN_CATALOG = {
  openai: [
    {
      aliases: ["plus", "chatgpt plus", "codex plus"],
      monthlyCost: 20,
      currency: "USD",
      source: "bundled_catalog",
      sourceUrl: "https://developers.openai.com/codex/pricing"
    },
    {
      aliases: ["pro", "chatgpt pro", "codex pro"],
      monthlyCost: 100,
      currency: "USD",
      source: "bundled_catalog",
      sourceUrl: "https://developers.openai.com/codex/pricing",
      priceType: "official_starting_list_price",
      priceVariant: "from",
      tierVariant: null,
      actualBillingKnown: false
    },
    {
      aliases: ["pro 5x", "pro-5x"],
      monthlyCost: 100,
      currency: "USD",
      source: "bundled_catalog",
      sourceUrl: "https://developers.openai.com/codex/pricing",
      priceType: "official_list_price",
      priceVariant: "pro_5x",
      tierVariant: "pro_5x",
      actualBillingKnown: false
    },
    {
      aliases: ["pro 20x", "pro-20x", "20x", "pro max", "pro-max", "max"],
      monthlyCost: 200,
      currency: "USD",
      source: "bundled_catalog",
      sourceUrl: "https://developers.openai.com/codex/pricing",
      priceType: "official_list_price",
      priceVariant: "pro_20x",
      tierVariant: "pro_20x",
      actualBillingKnown: false
    }
  ],
  anthropic: [
    {
      aliases: ["pro", "claude pro"],
      monthlyCost: 20,
      currency: "USD",
      source: "bundled_catalog",
      sourceUrl: "https://claude.com/pricing"
    },
    {
      aliases: ["max", "claude max", "max 5x", "max-5x", "claude max 5x"],
      monthlyCost: 100,
      currency: "USD",
      source: "bundled_catalog",
      sourceUrl: "https://claude.com/pricing",
      priceType: "official_starting_list_price",
      priceVariant: "from",
      tierVariant: null,
      actualBillingKnown: false
    },
    {
      aliases: ["max 20x", "max-20x", "20x", "claude max 20x"],
      monthlyCost: 200,
      currency: "USD",
      source: "bundled_catalog",
      sourceUrl: "https://claude.com/pricing",
      priceType: "official_list_price",
      priceVariant: "max_20x",
      tierVariant: "max_20x",
      actualBillingKnown: false
    }
  ]
};
const REGIONAL_SUBSCRIPTION_PLAN_CATALOG = {
  de: {
    openai: [
      {
        aliases: ["plus", "chatgpt plus", "codex plus"],
        monthlyCost: 22.99,
        currency: "EUR",
        source: "official_pricing_page",
        sourceUrl: "https://chatgpt.com/pricing/",
        priceType: "official_list_price",
        priceRegion: "de_eur",
        actualBillingKnown: false
      },
      {
        aliases: ["pro", "chatgpt pro", "codex pro"],
        monthlyCost: 115,
        currency: "EUR",
        source: "official_pricing_page",
        sourceUrl: "https://chatgpt.com/pricing/",
        priceType: "official_starting_list_price",
        priceVariant: "from",
        priceRegion: "de_eur",
        tierVariant: null,
        actualBillingKnown: false
      },
      {
        aliases: ["pro 5x", "pro-5x"],
        monthlyCost: 115,
        currency: "EUR",
        source: "official_pricing_page",
        sourceUrl: "https://chatgpt.com/pricing/",
        priceType: "official_list_price",
        priceVariant: "pro_5x",
        priceRegion: "de_eur",
        tierVariant: "pro_5x",
        actualBillingKnown: false
      },
      {
        aliases: ["pro 20x", "pro-20x", "20x", "pro max", "pro-max", "max"],
        monthlyCost: 229,
        currency: "EUR",
        source: "official_pricing_page",
        sourceUrl: "https://chatgpt.com/pricing/",
        priceType: "official_list_price",
        priceVariant: "pro_20x",
        priceRegion: "de_eur",
        tierVariant: "pro_20x",
        actualBillingKnown: false
      }
    ],
    anthropic: [
      {
        aliases: ["pro", "claude pro"],
        monthlyCost: 18,
        currency: "EUR",
        source: "official_pricing_page",
        sourceUrl: "https://claude.com/pricing",
        priceType: "official_list_price",
        priceRegion: "de_eur",
        actualBillingKnown: false
      },
      {
        aliases: ["max", "claude max", "max 5x", "max-5x", "claude max 5x"],
        monthlyCost: 90,
        currency: "EUR",
        source: "official_pricing_page",
        sourceUrl: "https://claude.com/pricing",
        priceType: "official_starting_list_price",
        priceVariant: "from",
        priceRegion: "de_eur",
        tierVariant: null,
        actualBillingKnown: false
      },
      {
        aliases: ["max 20x", "max-20x", "20x", "claude max 20x"],
        monthlyCost: 180,
        currency: "EUR",
        source: "official_pricing_page",
        sourceUrl: "https://claude.com/pricing",
        priceType: "official_list_price",
        priceVariant: "max_20x",
        priceRegion: "de_eur",
        tierVariant: "max_20x",
        actualBillingKnown: false
      }
    ]
  }
};
const ACCOUNT_BILLING_PROVIDER_ALIASES = {
  codex: "codex",
  chatgpt: "openai",
  "chat gpt": "openai",
  openai: "openai",
  claude: "anthropic",
  anthropic: "anthropic",
  claude_code: "claudeCode",
  "claude code": "claudeCode",
  claudecode: "claudeCode",
  claudeCode: "claudeCode"
};
const ACCOUNT_BILLING_PROVIDER_IDS = new Set(["codex", "openai", "claudeCode", "anthropic"]);
const ACCOUNT_BILLING_SAFE_SOURCE_TYPES = new Set([
  "account_billing",
  "browser",
  "browser_account_snapshot",
  "local_account_endpoint",
  "sanitized_snapshot",
  "billing_page"
]);
const ACCOUNT_BILLING_CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);
const ACCOUNT_BILLING_PARSER_STATUSES = new Set([
  "parsed",
  "missing",
  "expired",
  "unavailable",
  "parse_failed",
  "redacted",
  "unsupported_period"
]);
const ACCOUNT_BILLING_FORBIDDEN_KEY_PATTERN =
  /(?:authorization|bearer|cookie|cookies|token|tokens|secret|session|password|credential|invoice|pdf|address|email|customer|account[_-]?id|payment|card|last4)/i;
const ACCOUNT_BILLING_MAX_SOURCE_URL_LENGTH = 512;
const ACCOUNT_BILLING_REASON_CODES = new Set([
  "account_billing_source_unavailable",
  "account_billing_source_missing",
  "account_billing_source_parse_failed",
  "account_billing_source_unreadable",
  "account_billing_source_expired",
  "account_billing_amount_missing",
  "account_billing_unsupported_period",
  "account_billing_provider_missing"
]);
const LIVE_METRICS_SAMPLE_MS = 5000;
const LIVE_METRICS_HISTORY_POINTS = 90;
const LIVE_METRICS_TOKEN_MIN_WINDOW_MS = 30_000;
const LIVE_METRICS_TOKEN_WINDOWS = {
  oneMinute: 60_000,
  fiveMinutes: 5 * 60_000,
  fifteenMinutes: 15 * 60_000
};
const LIVE_METRICS_TOKEN_SCALE_PER_MIN = 1_000_000;
const LIVE_METRICS_PROCESS_GROUPS = [
  { id: "codex", label: "Codex", patterns: [/codex/i] },
  { id: "claude", label: "Claude", patterns: [/claude/i] },
  { id: "multica", label: "Multica", patterns: [/multica/i] },
  { id: "dashboard", label: "LLM Usage Dashboard", patterns: [/llm\s*usage\s*dashboard/i] },
  { id: "ollama", label: "Ollama", patterns: [/ollama/i] }
];

const app = express();
let currentDashboardUrl = null;
const anthropicCache = createTimedCache();
const codexLiveRateLimitsCache = createTimedCache();
const copilotLiveQuotaCache = createTimedCache();
const claudeApiUsageCache = createTimedCache();
const usageCache = createTimedCache();
const sourceDiagnosticsCache = createTimedCache();
const officialSubscriptionPricingCache = createTimedCache();
let codexAppServer = null;
let pendingTestNotification = false;
let pendingOpenNotificationSettings = false;
let pendingUpdateCheck = false;
let livePreviousCpuSample = sampleCpuTimes();
let liveLastCpuPercent = null;
const liveMetricsTokenHistory = [];
const liveTimeSeries = [];

const liveMetricsTimer = setInterval(refreshCpuSample, LIVE_METRICS_SAMPLE_MS);
if (typeof liveMetricsTimer.unref === "function") liveMetricsTimer.unref();

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

function resolvePackagedResourcePath(relativePath) {
  if (ROOT.endsWith(".asar")) {
    const unpackedPath = path.join(`${ROOT}.unpacked`, relativePath);
    if (fs.existsSync(unpackedPath)) return unpackedPath;
  }
  return path.join(ROOT, relativePath);
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

function electronSyncMiddleware(req, res, next) {
  if (!ELECTRON_SYNC_TOKEN) return res.status(403).json({ error: "electron_sync_disabled" });
  if (req.get("x-llm-usage-sync-token") !== ELECTRON_SYNC_TOKEN) {
    return res.status(401).json({ error: "electron_sync_forbidden" });
  }
  return next();
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

app.get("/api/usage", authMiddleware, async (req, res) => {
  try {
    const usage = await readUsageDashboard({ force: parseBoolean(req.query.force) });
    res.json(localizeUsageSubscriptionPrices(usage, pricingLocaleFromRequest(req)));
  } catch (error) {
    sendApiError(res, error, "usage_read_failed");
  }
});

app.get("/api/system/live", authMiddleware, async (_req, res) => {
  try {
    let localUsage = null;
    try {
      localUsage = (await readUsageDashboard()).local || null;
    } catch {
      localUsage = null;
    }
    res.json(buildSystemLiveMetrics(localUsage));
  } catch (error) {
    sendApiError(res, error, "system_live_failed");
  }
});

app.get("/api/sources/diagnostics", authMiddleware, async (_req, res) => {
  try {
    res.json(sanitizeSourceDiagnosticsPayload(await buildSourceDiagnostics()));
  } catch (error) {
    sendApiError(res, error, "source_diagnostics_failed");
  }
});

app.post("/api/sources/recheck", authMiddleware, async (_req, res) => {
  try {
    invalidateTimedCache(sourceDiagnosticsCache);
    res.json({
      ...sanitizeSourceDiagnosticsPayload(await buildSourceDiagnostics()),
      rechecked: true
    });
  } catch (error) {
    sendApiError(res, error, "source_recheck_failed");
  }
});

app.post("/api/sources/connect", authMiddleware, async (req, res) => {
  try {
    const sourceId = String(req.body?.sourceId || req.body?.id || "").trim();
    if (!sourceId) {
      const error = new Error("Source id is required.");
      error.statusCode = 400;
      error.code = "source_id_required";
      throw error;
    }
    const diagnostics = await buildSourceDiagnostics();
    const candidate = diagnostics.candidates.find((source) => source.id === sourceId);
    if (!candidate) {
      const error = new Error("Source candidate was not found.");
      error.statusCode = 404;
      error.code = "source_candidate_not_found";
      throw error;
    }
    if (!["readable", "mixed"].includes(candidate.accessStatus)) {
      const error = new Error("Source is not readable yet. Grant access, then recheck before connecting.");
      error.statusCode = 409;
      error.code = "source_not_readable";
      throw error;
    }
    const settings = await connectSource(DATA_DIR, normalizeConnectedSource(candidate, {
      enabled: true,
      label: String(req.body?.label || candidate.label || "").trim() || candidate.label,
      lastVerifiedAt: new Date().toISOString()
    }));
    invalidateTimedCache(usageCache);
    invalidateTimedCache(sourceDiagnosticsCache);
    res.json({
      ok: true,
      connected: settings.sources.find((source) => source.id === sourceId) || null,
      settings
    });
  } catch (error) {
    sendApiError(res, error, "source_connect_failed");
  }
});

app.post("/api/sources/:id/disable", authMiddleware, async (req, res) => {
  try {
    const settings = await disableSource(DATA_DIR, req.params.id);
    invalidateTimedCache(usageCache);
    invalidateTimedCache(sourceDiagnosticsCache);
    res.json({ ok: true, settings });
  } catch (error) {
    sendApiError(res, error, "source_disable_failed");
  }
});

async function readUsageDashboard({ force = false } = {}) {
  return readThroughCache(usageCache, USAGE_CACHE_MS, async () => {
    const connectedSettings = await readSourceSettings(DATA_DIR).catch(() => ({ sources: [] }));
    const localSources = buildReaderSources(connectedSettings.sources || []);
    const [
      subscriptions,
      accountBilling,
      officialPricing,
      codexRaw,
      copilotRaw,
      claudeCodeRaw,
      geminiRaw,
      ollamaRaw,
      openaiRaw,
      anthropicRaw
    ] = await Promise.all([
      readSubscriptionSettings().catch(() => sanitizeSubscriptionSettings({})),
      readAccountBillingSnapshots().catch(() =>
        accountBillingSnapshotUnavailable("unavailable", "account_billing_source_unavailable")
      ),
      readOfficialSubscriptionPricing().catch((error) => ({
        version: 1,
        fetchedAt: null,
        families: {},
        errors: { official_pricing_page: error.message || "official pricing unavailable" }
      })),
      readCodexUsage({ sources: localSources.codex }).catch((error) => providerError("codex", error)),
      readCopilotUsage({ sources: localSources.copilot }).catch((error) => providerError("copilot", error)),
      readClaudeCodeUsage({ sources: localSources.claudeCode }).catch((error) => providerError("claudeCode", error)),
      readGeminiUsage({ sources: localSources.gemini }).catch((error) => providerError("gemini", error)),
      readOllamaUsage({ sources: localSources.ollama }).catch((error) => providerError("ollama", error)),
      readOpenAiUsage().catch((error) => providerError("openai", error)),
      readAnthropicUsage().catch((error) => providerError("anthropic", error))
    ]);

    const codex = mergeProviderSubscription(codexRaw, subscriptions.codex, "codex", officialPricing, accountBilling);
    const copilot = mergeProviderSubscription(copilotRaw, subscriptions.copilot, "copilot", officialPricing, accountBilling);
    const claudeCode = mergeProviderSubscription(
      claudeCodeRaw,
      subscriptions.claudeCode,
      "claudeCode",
      officialPricing,
      accountBilling
    );
    const gemini = mergeProviderSubscription(geminiRaw, subscriptions.gemini, "gemini", officialPricing, accountBilling);
    const ollama = ollamaRaw;
    const openai = mergeProviderSubscription(openaiRaw, subscriptions.openai, "openai", officialPricing, accountBilling);
    const anthropic = mergeProviderSubscription(
      anthropicRaw,
      subscriptions.anthropic,
      "anthropic",
      officialPricing,
      accountBilling
    );
    await recordProviderQuotaSnapshots([codex, copilot, claudeCode, gemini, openai, anthropic]).catch(() => {});
    const local = buildLocalAggregate([codex, copilot, claudeCode, gemini, ollama]);

    const now = new Date().toISOString();
    return {
      generatedAt: now,
      codex: stripProviderUsageEvents(codex),
      copilot: stripProviderUsageEvents(copilot),
      claudeCode: stripProviderUsageEvents(claudeCode),
      gemini: stripProviderUsageEvents(gemini),
      ollama: stripProviderUsageEvents(ollama),
      local,
      openai,
      anthropic
    };
  }, { force });
}

function buildSystemLiveMetrics(localUsage) {
  const timestampMs = Date.now();
  const timestamp = new Date(timestampMs).toISOString();
  const cpu = buildLiveCpuMetric();
  const ram = buildLiveRamMetric();
  const swap = buildLiveSwapMetric();
  const processes = buildLiveProcessMetrics();
  const tokenRates = computeTokensPerMinute(recordLiveMetricsTokenSnapshot(localUsage?.totals?.allTime, timestampMs));
  const tokensPerMinute = buildTokensPerMinuteMetric(tokenRates);
  const aiLoadScore = buildAiLoadScore(cpu, ram, tokensPerMinute.value, { processes, swap });

  const point = {
    timestamp,
    cpuPercent: cpu.usedPercent,
    ramPercent: ram.usedPercent,
    aiCpuPercent: processes.ai.cpuPercent,
    aiRamPercent: processes.ai.memorySharePercent,
    swapUsedPercent: swap.usedPercent,
    aiLoadScore: aiLoadScore.score,
    tokensPerMinute: {
      total: tokensPerMinute.value,
      input: tokensPerMinute.input.value,
      output: tokensPerMinute.output.value,
      cached: tokensPerMinute.cached.value
    }
  };
  liveTimeSeries.push(point);
  while (liveTimeSeries.length > LIVE_METRICS_HISTORY_POINTS) liveTimeSeries.shift();

  return {
    timestamp,
    platform: process.platform,
    sampleIntervalMs: LIVE_METRICS_SAMPLE_MS,
    cpu,
    ram,
    swap,
    processes,
    tokensPerMinute,
    aiLoadScore,
    timeSeries: liveTimeSeries.slice()
  };
}

function buildLiveCpuMetric() {
  if (liveLastCpuPercent !== null) {
    return {
      usedPercent: roundMetric(liveLastCpuPercent),
      quality: "measured"
    };
  }
  const estimated = estimateCpuPercentFromLoadAverage();
  return {
    usedPercent: estimated,
    quality: estimated === null ? "unavailable" : "estimated"
  };
}

function refreshCpuSample() {
  const next = sampleCpuTimes();
  if (!next) {
    livePreviousCpuSample = null;
    liveLastCpuPercent = null;
    return;
  }
  if (!livePreviousCpuSample) {
    livePreviousCpuSample = next;
    liveLastCpuPercent = null;
    return;
  }
  const deltaTotal = next.total - livePreviousCpuSample.total;
  const deltaIdle = next.idle - livePreviousCpuSample.idle;
  livePreviousCpuSample = next;
  if (deltaTotal <= 0 || deltaIdle < 0) {
    liveLastCpuPercent = null;
    return;
  }
  liveLastCpuPercent = clampPercent(((deltaTotal - deltaIdle) / deltaTotal) * 100);
}

function sampleCpuTimes() {
  const cpus = os.cpus();
  if (!Array.isArray(cpus) || !cpus.length) return null;
  return cpus.reduce(
    (total, cpu) => {
      const times = cpu?.times || {};
      const idle = Number(times.idle || 0);
      const sum = Object.values(times).reduce((acc, value) => acc + Number(value || 0), 0);
      total.idle += idle;
      total.total += sum;
      return total;
    },
    { idle: 0, total: 0 }
  );
}

function estimateCpuPercentFromLoadAverage() {
  if (process.platform === "win32") return null;
  const [oneMinuteLoad] = os.loadavg();
  const cpuCount = os.cpus()?.length || 0;
  if (!Number.isFinite(oneMinuteLoad) || cpuCount <= 0) return null;
  return roundMetric(clampPercent((oneMinuteLoad / cpuCount) * 100));
}

function buildLiveRamMetric() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  if (!(totalBytes > 0) || !Number.isFinite(freeBytes)) {
    return {
      usedPercent: null,
      usedGb: null,
      totalGb: null,
      quality: "unavailable"
    };
  }
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    usedPercent: roundMetric((usedBytes / totalBytes) * 100),
    usedGb: roundMetric(usedBytes / 1024 / 1024 / 1024),
    totalGb: roundMetric(totalBytes / 1024 / 1024 / 1024),
    quality: "measured"
  };
}

function buildLiveSwapMetric() {
  if (process.platform === "darwin") {
    const result = spawnSync("sysctl", ["-n", "vm.swapusage"], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 32 * 1024
    });
    if (result.status !== 0 && result.error) return unavailableSwapMetric();
    return parseDarwinSwapUsage(result.stdout);
  }
  if (process.platform === "linux") {
    try {
      return parseLinuxMeminfoSwap(fs.readFileSync("/proc/meminfo", "utf8"));
    } catch {
      return unavailableSwapMetric();
    }
  }
  return unavailableSwapMetric();
}

function unavailableSwapMetric() {
  return {
    usedPercent: null,
    usedGb: null,
    totalGb: null,
    freeGb: null,
    quality: "unavailable"
  };
}

function parseDarwinSwapUsage(output) {
  const match = String(output || "").match(/total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M/i);
  if (!match) return unavailableSwapMetric();
  return buildSwapMetricFromMb(Number(match[2]), Number(match[1]), Number(match[3]));
}

function parseLinuxMeminfoSwap(output) {
  const fields = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^(SwapTotal|SwapFree):\s+(\d+)\s+kB/i);
    if (match) fields[match[1]] = Number(match[2]) / 1024;
  }
  if (!Number.isFinite(fields.SwapTotal) || !Number.isFinite(fields.SwapFree)) return unavailableSwapMetric();
  return buildSwapMetricFromMb(Math.max(0, fields.SwapTotal - fields.SwapFree), fields.SwapTotal, fields.SwapFree);
}

function buildSwapMetricFromMb(usedMb, totalMb, freeMb) {
  if (!Number.isFinite(totalMb) || totalMb < 0 || !Number.isFinite(usedMb) || !Number.isFinite(freeMb)) {
    return unavailableSwapMetric();
  }
  const usedPercent = totalMb > 0 ? (Math.max(0, usedMb) / totalMb) * 100 : 0;
  return {
    usedPercent: roundMetric(clampPercent(usedPercent)),
    usedGb: roundMetric(Math.max(0, usedMb) / 1024),
    totalGb: roundMetric(totalMb / 1024),
    freeGb: roundMetric(Math.max(0, freeMb) / 1024),
    quality: "measured"
  };
}

function buildLiveProcessMetrics(options = {}) {
  const fallback = unavailableProcessMetrics();
  if (process.platform === "win32") return fallback;
  const output = options.psOutput ?? readProcessSnapshot();
  if (output === null) return fallback;
  const rows = parseProcessRows(output);
  const groups = aggregateAiProcessMetrics(rows);
  const totalRssMb = groups.reduce((sum, group) => sum + metricNumber(group.rssMb), 0);
  const totalCpu = groups.reduce((sum, group) => sum + metricNumber(group.cpuPercent), 0);
  const processCount = groups.reduce((sum, group) => sum + metricNumber(group.processCount), 0);
  const totalMemMb = os.totalmem() / 1024 / 1024;
  const groupsWithShares = groups.map((group) => ({
    ...group,
    memorySharePercent: totalMemMb > 0 ? roundMetric(clampPercent((metricNumber(group.rssMb) / totalMemMb) * 100)) : null
  }));
  return {
    quality: "measured",
    ai: {
      cpuPercent: roundMetric(clampPercent(totalCpu)),
      rssGb: roundMetric(totalRssMb / 1024),
      memorySharePercent: totalMemMb > 0 ? roundMetric(clampPercent((totalRssMb / totalMemMb) * 100)) : null,
      processCount,
      groupCount: groups.length
    },
    groups: groupsWithShares
  };
}

function unavailableProcessMetrics() {
  return {
    quality: "unavailable",
    ai: {
      cpuPercent: null,
      rssGb: null,
      memorySharePercent: null,
      processCount: 0,
      groupCount: 0
    },
    groups: []
  };
}

function readProcessSnapshot() {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,comm="], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 512 * 1024
  });
  if (result.status !== 0 || result.error) return null;
  return result.stdout;
}

function parseProcessRows(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        cpuPercentRaw: Number(match[3]),
        rssMb: Number(match[4]) / 1024,
        command: match[5]
      };
    })
    .filter((row) =>
      row &&
      Number.isFinite(row.pid) &&
      Number.isFinite(row.ppid) &&
      Number.isFinite(row.cpuPercentRaw) &&
      Number.isFinite(row.rssMb)
    );
}

function aggregateAiProcessMetrics(rows) {
  const cpuCount = Math.max(1, os.cpus()?.length || 1);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const directGroups = new Map();
  for (const row of rows) {
    const direct = classifyAiProcess(row.command);
    if (direct) directGroups.set(row.pid, direct);
  }
  const resolvedGroups = new Map(directGroups);
  for (const row of rows) {
    if (resolvedGroups.has(row.pid)) continue;
    const inherited = inheritProcessGroup(row, byPid, directGroups);
    if (inherited) resolvedGroups.set(row.pid, inherited);
  }

  const groups = new Map();
  for (const row of rows) {
    const group = resolvedGroups.get(row.pid);
    if (!group) continue;
    const current = groups.get(group.id) || {
      id: group.id,
      label: group.label,
      cpuPercent: 0,
      rssMb: 0,
      processCount: 0,
      quality: "measured"
    };
    current.cpuPercent += Math.max(0, row.cpuPercentRaw) / cpuCount;
    current.rssMb += Math.max(0, row.rssMb);
    current.processCount += 1;
    groups.set(group.id, current);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      cpuPercent: roundMetric(clampPercent(group.cpuPercent)),
      rssMb: roundMetric(group.rssMb),
      rssGb: roundMetric(group.rssMb / 1024)
    }))
    .sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssMb - a.rssMb || a.label.localeCompare(b.label));
}

function classifyAiProcess(command) {
  const normalized = String(command || "");
  for (const group of LIVE_METRICS_PROCESS_GROUPS) {
    if (group.patterns.some((pattern) => pattern.test(normalized))) {
      return { id: group.id, label: group.label };
    }
  }
  return null;
}

function inheritProcessGroup(row, byPid, directGroups) {
  let current = row;
  const visited = new Set([row.pid]);
  for (let depth = 0; depth < 4; depth += 1) {
    current = byPid.get(current.ppid);
    if (!current || visited.has(current.pid)) return null;
    visited.add(current.pid);
    const group = directGroups.get(current.pid);
    if (group) return group;
  }
  return null;
}

function recordLiveMetricsTokenSnapshot(totals, timestampMs = Date.now()) {
  if (!totals) return liveMetricsTokenHistory;
  const input = metricNumber(totals.inputTokens);
  const output = metricNumber(totals.outputTokens) + metricNumber(totals.reasoningOutputTokens);
  const cached = metricNumber(totals.cachedInputTokens) + metricNumber(totals.cacheCreationInputTokens);
  const explicitTotal = metricNumber(totals.totalTokens);
  const total = explicitTotal || input + output + cached;
  const subAvailable = input > 0 || output > 0 || cached > 0;
  liveMetricsTokenHistory.push({ ts: timestampMs, total, input, output, cached, subAvailable });

  const oldestAllowed = timestampMs - LIVE_METRICS_TOKEN_WINDOWS.fifteenMinutes;
  while (
    liveMetricsTokenHistory.length > LIVE_METRICS_HISTORY_POINTS ||
    (liveMetricsTokenHistory[0] && liveMetricsTokenHistory[0].ts < oldestAllowed)
  ) {
    liveMetricsTokenHistory.shift();
  }
  return liveMetricsTokenHistory;
}

function computeTokensPerMinute(history) {
  return {
    total: computeTokenRate(history, "total", LIVE_METRICS_TOKEN_WINDOWS.oneMinute),
    input: computeTokenSubRate(history, "input", LIVE_METRICS_TOKEN_WINDOWS.oneMinute),
    output: computeTokenSubRate(history, "output", LIVE_METRICS_TOKEN_WINDOWS.oneMinute),
    cached: computeTokenSubRate(history, "cached", LIVE_METRICS_TOKEN_WINDOWS.oneMinute),
    windows: {
      oneMinute: computeTokenRate(history, "total", LIVE_METRICS_TOKEN_WINDOWS.oneMinute),
      fiveMinutes: computeTokenRate(history, "total", LIVE_METRICS_TOKEN_WINDOWS.fiveMinutes),
      fifteenMinutes: computeTokenRate(history, "total", LIVE_METRICS_TOKEN_WINDOWS.fifteenMinutes)
    }
  };
}

function computeTokenRate(history, key, windowMs) {
  const pair = tokenRateWindow(history, windowMs, (snapshot) => snapshot);
  return pair ? tokenRateFromPair(pair.oldest, pair.newest, key) : null;
}

function computeTokenSubRate(history, key, windowMs) {
  const pair = tokenRateWindow(history, windowMs, (snapshot) => (snapshot.subAvailable ? snapshot : null));
  return pair ? tokenRateFromPair(pair.oldest, pair.newest, key) : null;
}

function tokenRateWindow(history, windowMs, selector) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const newest = selector(history[history.length - 1]);
  if (!newest) return null;
  const earliestTs = newest.ts - windowMs;
  let oldest = null;
  for (const snapshot of history) {
    const selected = selector(snapshot);
    if (!selected || selected.ts < earliestTs) continue;
    oldest = selected;
    break;
  }
  if (!oldest || newest.ts - oldest.ts < LIVE_METRICS_TOKEN_MIN_WINDOW_MS) return null;
  return { oldest, newest };
}

function tokenRateFromPair(oldest, newest, key) {
  const deltaMs = newest.ts - oldest.ts;
  const deltaTokens = newest[key] - oldest[key];
  if (deltaMs < LIVE_METRICS_TOKEN_MIN_WINDOW_MS || deltaTokens < 0) return null;
  return Math.round((deltaTokens / deltaMs) * 60_000);
}

function buildTokensPerMinuteMetric(tokenRates) {
  const total = liveRateValue(tokenRates.total);
  return {
    value: total.value,
    quality: total.quality,
    input: liveRateValue(tokenRates.input),
    output: liveRateValue(tokenRates.output),
    cached: liveRateValue(tokenRates.cached),
    windows: {
      oneMinute: liveRateValue(tokenRates.windows.oneMinute),
      fiveMinutes: liveRateValue(tokenRates.windows.fiveMinutes),
      fifteenMinutes: liveRateValue(tokenRates.windows.fifteenMinutes)
    },
    windowSeconds: LIVE_METRICS_TOKEN_WINDOWS.oneMinute / 1000
  };
}

function liveRateValue(value) {
  return value === null || value === undefined
    ? { value: null, quality: "unavailable" }
    : { value: Math.max(0, Math.round(value)), quality: "calculated" };
}

function buildAiLoadScore(cpu, ram, tokensPerMinute, context = {}) {
  const tokenPercent =
    tokensPerMinute === null || tokensPerMinute === undefined
      ? null
      : clampPercent((Number(tokensPerMinute) / LIVE_METRICS_TOKEN_SCALE_PER_MIN) * 100);
  const factors = {
    systemCpu: cpu.usedPercent,
    systemRam: ram.usedPercent,
    aiCpu: context.processes?.ai?.cpuPercent ?? null,
    aiRam: context.processes?.ai?.memorySharePercent ?? null,
    swap: context.swap?.usedPercent ?? null,
    tokens: tokenPercent
  };
  const weighted = [
    { value: factors.aiCpu, weight: 0.35 },
    { value: factors.aiRam, weight: 0.2 },
    { value: factors.tokens, weight: 0.2 },
    { value: factors.systemCpu, weight: 0.15 },
    { value: factors.swap, weight: 0.1 },
    { value: factors.systemRam, weight: context.processes?.quality === "measured" ? 0 : 0.25 }
  ].filter((item) => item.weight > 0 && item.value !== null && item.value !== undefined && Number.isFinite(Number(item.value)));
  if (!weighted.length) {
    return {
      score: null,
      quality: "unavailable",
      factors
    };
  }
  const weightTotal = weighted.reduce((sum, item) => sum + item.weight, 0);
  const score = weighted.reduce((sum, item) => sum + item.value * item.weight, 0) / weightTotal;
  return {
    score: roundMetric(clampPercent(score)),
    quality: "estimated",
    factors
  };
}

function metricNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function roundMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : null;
}

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

app.post("/api/claude/browser-credits", electronSyncMiddleware, async (req, res) => {
  try {
    const snapshot = await saveClaudeBrowserCreditsSnapshot(req.body || {});
    res.json({ ok: true, snapshot });
  } catch (error) {
    sendApiError(res, error, "claude_browser_credits_save_failed");
  }
});

app.post("/api/account-billing/snapshots", electronSyncMiddleware, async (req, res) => {
  try {
    const snapshot = await saveAccountBillingSnapshots(req.body || {});
    invalidateTimedCache(usageCache);
    res.json({ ok: true, snapshot });
  } catch (error) {
    sendApiError(res, error, "account_billing_snapshot_save_failed");
  }
});

app.get("/api/quota-history", authMiddleware, async (req, res) => {
  try {
    const events = await readQuotaEvents();
    const provider = String(req.query.provider || "").trim();
    const windowKey = String(req.query.window || req.query.windowKey || "").trim();
    const filteredEvents = events.filter((event) => {
      if (provider && event.provider !== provider) return false;
      if (windowKey && event.windowKey !== windowKey) return false;
      return true;
    });
    const windows = buildQuotaWindowSummaries(filteredEvents);
    const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 1000)));
    res.json({
      generatedAt: new Date().toISOString(),
      events: filteredEvents.slice(-limit),
      windows: windows.slice(-limit)
    });
  } catch (error) {
    sendApiError(res, error, "quota_history_read_failed");
  }
});

app.get("/api/subscriptions/settings", authMiddleware, async (_req, res) => {
  try {
    res.json(await readSubscriptionSettings());
  } catch (error) {
    sendApiError(res, error, "subscription_settings_read_failed");
  }
});

app.post("/api/subscriptions/settings", authMiddleware, async (req, res) => {
  try {
    const settings = mergeSubscriptionSettingsPatch(await readSubscriptionSettings(), req.body || {});
    await saveSubscriptionSettings(settings);
    invalidateTimedCache(usageCache);
    res.json(settings);
  } catch (error) {
    sendApiError(res, error, "subscription_settings_save_failed");
  }
});

app.get("/api/subscription-history", authMiddleware, async (_req, res) => {
  try {
    res.json(await readSubscriptionHistory());
  } catch (error) {
    sendApiError(res, error, "subscription_history_read_failed");
  }
});

app.put("/api/subscription-history", authMiddleware, async (req, res) => {
  try {
    const history = sanitizeSubscriptionHistory(req.body || {});
    validateSubscriptionHistory(history);
    await saveSubscriptionHistory(history);
    res.json(history);
  } catch (error) {
    sendApiError(res, error, "subscription_history_save_failed");
  }
});

app.get("/api/updates/settings", authMiddleware, async (_req, res) => {
  try {
    res.json(await readUpdateSettings());
  } catch (error) {
    sendApiError(res, error, "update_settings_read_failed");
  }
});

app.post("/api/updates/settings", authMiddleware, async (req, res) => {
  try {
    const settings = mergeUpdateSettingsPatch(await readUpdateSettings(), req.body || {});
    await saveUpdateSettings(settings);
    res.json(settings);
  } catch (error) {
    sendApiError(res, error, "update_settings_save_failed");
  }
});

app.get("/api/updates/status", authMiddleware, async (_req, res) => {
  try {
    const text = await fsp.readFile(UPDATE_STATUS_FILE, "utf8");
    res.json({
      isElectron: Boolean(ELECTRON_SYNC_TOKEN),
      ...JSON.parse(text)
    });
  } catch {
    res.json({ isElectron: Boolean(ELECTRON_SYNC_TOKEN), state: ELECTRON_SYNC_TOKEN ? "unknown" : "not_electron" });
  }
});

app.post("/api/updates/check", authMiddleware, (_req, res) => {
  if (!ELECTRON_SYNC_TOKEN) return res.status(503).json({ error: "not_electron" });
  pendingUpdateCheck = true;
  return res.json({ queued: true });
});

app.get("/api/updates/check-pending", electronSyncMiddleware, (_req, res) => {
  const pending = pendingUpdateCheck;
  pendingUpdateCheck = false;
  res.json({ pending });
});

app.get("/api/notifications/settings", authMiddleware, async (_req, res) => {
  try {
    res.json(await readNotificationSettings());
  } catch (error) {
    sendApiError(res, error, "notification_settings_read_failed");
  }
});

app.post("/api/notifications/settings", authMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const current = await readNotificationSettings();
    const updated = {
      enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      pacingPercent: Number.isFinite(Number(body.pacingPercent))
        ? Math.max(50, Math.min(200, Number(body.pacingPercent)))
        : current.pacingPercent,
      hardLimitPercent: Number.isFinite(Number(body.hardLimitPercent))
        ? Math.max(50, Math.min(100, Number(body.hardLimitPercent)))
        : current.hardLimitPercent
    };
    await saveNotificationSettings(updated);
    res.json(updated);
  } catch (error) {
    sendApiError(res, error, "notification_settings_save_failed");
  }
});

app.get("/api/notifications/check", electronSyncMiddleware, async (_req, res) => {
  try {
    const [settings, codex, claudeCode, copilot] = await Promise.all([
      readNotificationSettings(),
      readCodexUsage().catch(() => null),
      readClaudeCodeUsage().catch(() => null),
      readCopilotUsage().catch(() => null)
    ]);
    await recordProviderQuotaSnapshots([codex, claudeCode, copilot]).catch(() => {});
    const alerts = settings.enabled ? buildNotificationAlerts(settings, { codex, claudeCode, copilot }) : [];
    res.json({ alerts });
  } catch (error) {
    sendApiError(res, error, "notification_check_failed");
  }
});

app.get("/api/notifications/status", authMiddleware, async (_req, res) => {
  try {
    const text = await fsp.readFile(NOTIFICATION_STATUS_FILE, "utf8");
    res.json(JSON.parse(text));
  } catch {
    res.json(null);
  }
});

app.post("/api/notifications/test", authMiddleware, (_req, res) => {
  if (!ELECTRON_SYNC_TOKEN) return res.status(503).json({ error: "not_electron" });
  pendingTestNotification = true;
  return res.json({ queued: true });
});

app.get("/api/notifications/test-pending", electronSyncMiddleware, (_req, res) => {
  const pending = pendingTestNotification;
  pendingTestNotification = false;
  res.json({ pending });
});

app.post("/api/notifications/open-settings", authMiddleware, (_req, res) => {
  if (!ELECTRON_SYNC_TOKEN) return res.status(503).json({ error: "not_electron" });
  pendingOpenNotificationSettings = true;
  return res.json({ queued: true });
});

app.get("/api/notifications/open-settings-pending", electronSyncMiddleware, (_req, res) => {
  const pending = pendingOpenNotificationSettings;
  pendingOpenNotificationSettings = false;
  res.json({ pending });
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

async function buildSourceDiagnostics() {
  return readThroughCache(sourceDiagnosticsCache, SOURCE_DIAGNOSTICS_CACHE_MS, async () => {
    const [settings, discovery] = await Promise.all([
      readSourceSettings(DATA_DIR).catch(() => ({ version: 1, sources: [] })),
      discoverSources({
        dataDir: DATA_DIR,
        ollamaUsageFile: OLLAMA_USAGE_FILE,
        codexHomes: CODEX_HOMES
      })
    ]);
    return buildSourceDiagnosticsPayload(settings, discovery);
  });
}

function buildSourceDiagnosticsPayload(settings, discovery) {
  const enabledConnected = (settings.sources || []).filter((source) => source.enabled !== false);
  const connectedIds = new Set(enabledConnected.map((source) => source.id));
  const candidates = (discovery.candidates || []).map((source) => ({
    ...source,
    connected: connectedIds.has(source.id) || isAutomaticCurrentUserSource(source),
    automatic: !connectedIds.has(source.id) && isAutomaticCurrentUserSource(source)
  }));
  const persistedConnected = enabledConnected.map((source) => ({
    ...source,
    automatic: false,
    currentCandidate: candidates.find((candidate) => candidate.id === source.id) || null
  }));
  const automaticConnected = candidates
    .filter((source) => source.automatic)
    .map((source) => ({
      ...source,
      currentCandidate: source
    }));
  const connected = [...automaticConnected, ...persistedConnected];
  return {
    ...discovery,
    status: deriveSourceDiagnosticsStatus(discovery, candidates, connected),
    candidates,
    connected,
    counts: {
      ...(discovery.counts || {}),
      connected: connected.length,
      connectedEnabled: enabledConnected.length,
      connectedSaved: enabledConnected.length,
      connectedAutomatic: automaticConnected.length,
      candidates: candidates.length
    },
    persistence: {
      version: settings.version || 1,
      file: path.join(DATA_DIR, "connected-sources.json")
    }
  };
}

function isAutomaticCurrentUserSource(source) {
  return Boolean(source?.owner?.current && ["readable", "mixed"].includes(source.accessStatus));
}

function deriveSourceDiagnosticsStatus(discovery, candidates, connected) {
  if (connected.length && candidates.some((source) => source.connected && ["readable", "mixed"].includes(source.accessStatus))) {
    return "connected_live";
  }
  if (discovery.otherDashboardInstances?.some((instance) => instance.pid !== process.pid)) return "other_dashboard_found";
  if (candidates.some((source) => source.accessStatus === "denied")) return "candidates_denied";
  if (candidates.some((source) => ["readable", "mixed"].includes(source.accessStatus))) return "candidates_readable_empty";
  if (candidates.some((source) => ["process_only", "service_only"].includes(source.accessStatus))) return "runtime_hints_only";
  if (discovery.os?.supportLevel === "partial_container" || discovery.os?.supported === false) return "partial_unsupported";
  if (candidates.some((source) => source.owner?.current)) return "current_user_empty";
  return "no_tools_found";
}

function sanitizeSourceDiagnosticsPayload(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return diagnostics;
  const { processEvidence: _processEvidence, serviceEvidence: _serviceEvidence, ...rest } = diagnostics;
  const otherDashboardInstances = (diagnostics.otherDashboardInstances || []).filter((instance) => Number(instance?.pid) !== process.pid);
  return {
    ...rest,
    counts: diagnostics.counts
      ? {
          ...diagnostics.counts,
          otherDashboardInstances: otherDashboardInstances.length
        }
      : diagnostics.counts,
    currentUser: sanitizeDiagnosticOwner(diagnostics.currentUser),
    candidates: (diagnostics.candidates || []).map(sanitizeDiagnosticSource),
    connected: (diagnostics.connected || []).map(sanitizeDiagnosticSource),
    otherDashboardInstances: otherDashboardInstances.map(sanitizeDiagnosticInstance),
    persistence: diagnostics.persistence ? { version: diagnostics.persistence.version || 1 } : undefined
  };
}

function sanitizeDiagnosticSource(source) {
  if (!source || typeof source !== "object") return source;
  const { processes: _processes, service: _service, currentCandidate, ...rest } = source;
  return {
    ...rest,
    owner: sanitizeDiagnosticOwner(source.owner),
    currentCandidate: currentCandidate ? sanitizeDiagnosticSource(currentCandidate) : currentCandidate
  };
}

function sanitizeDiagnosticOwner(owner) {
  if (!owner || typeof owner !== "object") return owner;
  const { home: _home, ...rest } = owner;
  return rest;
}

function sanitizeDiagnosticInstance(instance) {
  if (!instance || typeof instance !== "object") return instance;
  return {
    user: instance.user || null,
    startedAt: instance.startedAt || null,
    version: instance.version || null
  };
}

function buildReaderSources(connectedSources = []) {
  const grouped = {
    codex: defaultCodexSources(),
    copilot: [defaultHomeSource("copilot", "GitHub Copilot", COPILOT_HOME, [
      { role: "session_state", path: path.join(COPILOT_HOME, "session-state"), kind: "directory" }
    ])],
    claudeCode: [defaultHomeSource("claudeCode", "Claude Code", CLAUDE_HOME, [
      { role: "projects", path: path.join(CLAUDE_HOME, "projects"), kind: "directory" }
    ])],
    gemini: [defaultHomeSource("gemini", "Gemini", GEMINI_HOME, [
      { role: "telemetry", path: path.join(GEMINI_HOME, "telemetry"), kind: "directory" },
      { role: "chats", path: path.join(GEMINI_HOME, "chats"), kind: "directory" },
      { role: "tmp", path: path.join(GEMINI_HOME, "tmp"), kind: "directory" },
      { role: "home", path: GEMINI_HOME, kind: "directory" }
    ])],
    ollama: [defaultFileSource("ollama", "Ollama", OLLAMA_USAGE_FILE, "usage_file")]
  };

  for (const rawSource of connectedSources) {
    if (rawSource.enabled === false) continue;
    let source;
    try {
      source = normalizeConnectedSource(rawSource);
    } catch {
      continue;
    }
    if (!grouped[source.providerId]) grouped[source.providerId] = [];
    grouped[source.providerId].push(source);
  }

  for (const providerId of Object.keys(grouped)) {
    grouped[providerId] = dedupeReaderSources(grouped[providerId]);
  }
  return grouped;
}

function defaultCodexSources() {
  return CODEX_HOMES.map((home) => defaultHomeSource("codex", "Codex", home, [
    { role: "sessions", path: path.join(home, "sessions"), kind: "directory" },
    { role: "archived_sessions", path: path.join(home, "archived_sessions"), kind: "directory" }
  ]));
}

function defaultHomeSource(providerId, label, home, paths) {
  const owner = currentOwner(home);
  return {
    id: sourceId(providerId, owner.uid ?? "current", paths.map((entry) => entry.path)),
    providerId,
    kind: "usage_dir",
    label: `${label} - current user`,
    owner,
    paths: paths.map((entry) => ({
      ...entry,
      exists: false,
      readable: true,
      permission: "configured"
    })),
    accessStatus: "readable",
    discovery: {
      method: "configured-current-user",
      confidence: "high",
      checkedAt: new Date().toISOString(),
      evidence: []
    },
    privacy: {
      scope: "metadata_only",
      forbidden: ["credentials", "raw_transcripts", "provider_payloads"]
    }
  };
}

function defaultFileSource(providerId, label, file, role) {
  const owner = currentOwner(path.dirname(file));
  return {
    id: sourceId(providerId, owner.uid ?? "current", [file]),
    providerId,
    kind: "usage_file",
    label: `${label} - current data dir`,
    owner,
    paths: [{
      role,
      path: file,
      kind: "file",
      exists: false,
      readable: true,
      permission: "configured"
    }],
    accessStatus: "readable",
    discovery: {
      method: "configured-data-dir",
      confidence: "high",
      checkedAt: new Date().toISOString(),
      evidence: []
    },
    privacy: {
      scope: "metadata_only",
      forbidden: ["credentials", "raw_transcripts", "provider_payloads"]
    }
  };
}

function currentOwner(home) {
  const info = os.userInfo();
  return {
    uid: typeof process.getuid === "function" ? process.getuid() : info.uid ?? null,
    gid: typeof process.getgid === "function" ? process.getgid() : info.gid ?? null,
    name: info.username || process.env.USER || "current",
    home,
    current: true
  };
}

function dedupeReaderSources(sources) {
  const seenIds = new Set();
  const seenPaths = new Set();
  const result = [];
  for (const source of sources) {
    const pathKey = source.paths.map((entry) => path.resolve(entry.path)).sort().join("\n");
    const key = `${source.providerId}\n${pathKey}`;
    if (seenIds.has(source.id) || seenPaths.has(key)) continue;
    seenIds.add(source.id);
    seenPaths.add(key);
    result.push(source);
  }
  return result;
}

function stripProviderUsageEvents(provider) {
  if (!provider || typeof provider !== "object") return provider;
  const { _usageEvents, ...rest } = provider;
  return rest;
}

function createTimedCache() {
  return {
    value: null,
    expiresAt: 0,
    pending: null,
    generation: 0
  };
}

async function readThroughCache(cache, ttlMs, loader, { force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now < cache.expiresAt) return cache.value;
  if (cache.pending) return cache.pending;

  const generation = cache.generation || 0;
  const pending = Promise.resolve()
    .then(loader)
    .then((value) => {
      if (cache.pending === pending && cache.generation === generation) {
        cache.value = value;
        cache.expiresAt = Date.now() + ttlMs;
      }
      return value;
    })
    .catch((error) => {
      if (!cache.value) throw error;
      const staleValue = {
        ...cache.value,
        cache: {
          ...(cache.value.cache || {}),
          stale: true,
          staleReason: error.message,
          staleAt: new Date().toISOString()
        }
      };
      if (cache.pending === pending && cache.generation === generation) {
        cache.value = staleValue;
        cache.expiresAt = Date.now() + Math.min(ttlMs, 30_000);
      }
      return staleValue;
    })
    .finally(() => {
      if (cache.pending === pending) cache.pending = null;
    });

  cache.pending = pending;
  return cache.pending;
}

function invalidateTimedCache(cache) {
  if (!cache || typeof cache !== "object") return;
  cache.value = null;
  cache.expiresAt = 0;
  cache.pending = null;
  cache.generation = (cache.generation || 0) + 1;
}

async function readSubscriptionSettings() {
  try {
    const text = await fsp.readFile(SUBSCRIPTION_SETTINGS_FILE, "utf8");
    return sanitizeSubscriptionSettings(JSON.parse(text));
  } catch {
    return readLegacySubscriptionSettings();
  }
}

async function readLegacySubscriptionSettings() {
  try {
    const text = await fsp.readFile(LEGACY_MANUAL_LIMITS_FILE, "utf8");
    const legacy = JSON.parse(text);
    return sanitizeSubscriptionSettings({
      codex: legacy.codex,
      claudeCode: legacy.claude,
      openai: legacy.openai,
      anthropic: legacy.anthropic,
      copilot: legacy.copilot,
      gemini: legacy.gemini
    });
  } catch {
    return sanitizeSubscriptionSettings({});
  }
}

async function saveSubscriptionSettings(settings) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(SUBSCRIPTION_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

async function readAccountBillingSnapshots() {
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(ACCOUNT_BILLING_SNAPSHOTS_FILE, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return accountBillingSnapshotUnavailable("missing", "account_billing_source_missing");
    }
    if (error instanceof SyntaxError) {
      return accountBillingSnapshotUnavailable("parse_failed", "account_billing_source_parse_failed");
    }
    return accountBillingSnapshotUnavailable("unavailable", "account_billing_source_unreadable");
  }
  return sanitizeAccountBillingSnapshots(parsed);
}

async function saveAccountBillingSnapshots(payload) {
  const snapshot = sanitizeAccountBillingSnapshots(payload);
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(ACCOUNT_BILLING_SNAPSHOTS_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  return snapshot;
}

function accountBillingSnapshotUnavailable(status, reason) {
  const normalizedStatus = normalizeAccountBillingParserStatus(status) || "unavailable";
  return {
    version: 1,
    source: "account_billing",
    status: normalizedStatus,
    reason: accountBillingShortString(reason, "account_billing_source_unavailable"),
    fetchedAt: null,
    providers: {},
    errors: {
      account_billing: accountBillingShortString(reason, "account_billing_source_unavailable")
    }
  };
}

function sanitizeAccountBillingSnapshots(raw, options = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const fetchedAt = normalizeOptionalDate(source.fetchedAt || source.updatedAt || source.capturedAt) || null;
  const entries = accountBillingSnapshotEntries(source);
  const providers = {};
  for (const { providerId, value } of entries) {
    const normalized = sanitizeAccountBillingProviderSnapshot(value, providerId, { fetchedAt }, nowMs);
    if (normalized) providers[providerId] = normalized;
  }
  const status = Object.values(providers).some((entry) => entry.status === "available")
    ? "available"
    : normalizeAccountBillingParserStatus(source.status) || (entries.length ? "unavailable" : "missing");
  return {
    version: 1,
    source: "account_billing",
    status,
    reason: accountBillingReasonCode(source.reason || source.error || "", null),
    fetchedAt,
    providers
  };
}

function accountBillingSnapshotEntries(source) {
  const entries = [];
  if (source.provider || source.providerId || source.id) {
    const providerId = normalizeAccountBillingProviderId(source.provider || source.providerId || source.id);
    if (providerId) entries.push({ providerId, value: source });
  }

  const providers = source.providers || source.accounts || source.billing || null;
  if (Array.isArray(providers)) {
    for (const entry of providers) {
      const providerId = normalizeAccountBillingProviderId(entry?.provider || entry?.providerId || entry?.id);
      if (providerId) entries.push({ providerId, value: entry });
    }
  } else if (providers && typeof providers === "object") {
    for (const [key, value] of Object.entries(providers)) {
      const providerId = normalizeAccountBillingProviderId(value?.provider || value?.providerId || value?.id || key);
      if (providerId) entries.push({ providerId, value });
    }
  }

  for (const [key, value] of Object.entries(source)) {
    const providerId = normalizeAccountBillingProviderId(key);
    if (providerId && value && typeof value === "object") entries.push({ providerId, value });
  }

  return entries;
}

function normalizeAccountBillingProviderId(value) {
  const original = String(value || "").trim();
  if (!original) return null;
  if (ACCOUNT_BILLING_PROVIDER_ALIASES[original]) return ACCOUNT_BILLING_PROVIDER_ALIASES[original];
  const normalized = normalizeSubscriptionPlanKey(original).replace(/\s+/g, "_");
  const providerId = ACCOUNT_BILLING_PROVIDER_ALIASES[normalized] || ACCOUNT_BILLING_PROVIDER_ALIASES[normalized.replace(/_/g, "")];
  return ACCOUNT_BILLING_PROVIDER_IDS.has(providerId) ? providerId : null;
}

function sanitizeAccountBillingProviderSnapshot(raw, providerId, rootMeta = {}, nowMs = Date.now()) {
  if (!raw || typeof raw !== "object" || !ACCOUNT_BILLING_PROVIDER_IDS.has(providerId)) return null;
  const redacted = accountBillingHasForbiddenKey(raw);
  const fetchedAt =
    normalizeOptionalDate(raw.fetchedAt || raw.updatedAt || raw.capturedAt || raw.syncedAt || raw.dataUpdatedAt) ||
    rootMeta.fetchedAt ||
    null;
  const explicitStatus = normalizeAccountBillingParserStatus(raw.status);
  const sourceType = normalizeAccountBillingSourceType(raw.sourceType || raw.source_type || raw.source || "account_billing");
  const parserStatus = normalizeAccountBillingParserStatus(raw.parserStatus || raw.parser_status || explicitStatus) || "parsed";
  const planType = accountBillingShortString(raw.plan || raw.planType || raw.plan_type || raw.planName || raw.plan_name, null);
  const period = normalizeAccountBillingPeriod(raw.period || raw.billingPeriod || raw.billing_period || "month");
  const amount = accountBillingAmount(raw);
  const base = {
    providerId,
    source: "account_billing",
    sourceType,
    priceSourceType: "account_billing",
    planType,
    planKey: normalizeSubscriptionPlanKey(planType),
    monthlyCost: 0,
    amount: 0,
    currency: normalizeCurrency(raw.currency || raw.amount?.currency || "EUR"),
    period,
    sourceUrl: sanitizeAccountBillingSourceUrl(raw.sourceUrl || raw.source_url || raw.url),
    fetchedAt,
    confidence: normalizeAccountBillingConfidence(raw.confidence),
    parserStatus,
    actualBillingKnown: false,
    costStatus: "account_billing",
    redacted
  };

  if (["missing", "expired", "unavailable", "parse_failed"].includes(explicitStatus)) {
    return {
      ...base,
      status: explicitStatus,
      parserStatus: explicitStatus,
      unavailableReason: accountBillingReasonCode(
        raw.reason || raw.error,
        `account_billing_source_${explicitStatus}`
      )
    };
  }

  if (period !== "month") {
    return {
      ...base,
      status: "unavailable",
      parserStatus: "unsupported_period",
      unavailableReason: "account_billing_unsupported_period"
    };
  }

  if (fetchedAt && nowMs - Date.parse(fetchedAt) > ACCOUNT_BILLING_STALE_MS) {
    return {
      ...base,
      status: "expired",
      parserStatus: "expired",
      unavailableReason: "account_billing_source_expired"
    };
  }

  if (!(amount > 0)) {
    return {
      ...base,
      status: "missing",
      parserStatus: parserStatus === "parsed" ? "missing" : parserStatus,
      unavailableReason: accountBillingReasonCode(raw.reason || raw.error, "account_billing_amount_missing")
    };
  }

  return {
    ...base,
    status: "available",
    monthlyCost: amount,
    amount,
    parserStatus: parserStatus === "missing" ? "parsed" : parserStatus,
    actualBillingKnown: true,
    unavailableReason: null
  };
}

function accountBillingAmount(raw) {
  const direct = positiveAmount(
    raw.amount?.value ??
      raw.amount ??
      raw.monthlyCost ??
      raw.monthly_cost ??
      raw.subscriptionCost ??
      raw.subscription_cost ??
      raw.monthlyPrice ??
      raw.monthly_price
  );
  if (direct > 0) return direct;
  const cents = positiveAmount(
    raw.amountCents ??
      raw.amount_cents ??
      raw.monthlyCostCents ??
      raw.monthly_cost_cents ??
      raw.monthlyPriceCents ??
      raw.monthly_price_cents ??
      raw.unitAmount ??
      raw.unit_amount
  );
  return cents > 0 ? cents / 100 : 0;
}

function normalizeAccountBillingPeriod(value) {
  const normalized = normalizeSubscriptionPlanKey(value);
  if (!normalized || ["month", "monthly", "mo", "per month", "p1m"].includes(normalized)) return "month";
  if (["year", "yearly", "annual", "annually", "per year", "p1y"].includes(normalized)) return "year";
  return normalized.slice(0, 40) || "unknown";
}

function normalizeAccountBillingSourceType(value) {
  const normalized = normalizeSubscriptionPlanKey(value).replace(/\s+/g, "_");
  return ACCOUNT_BILLING_SAFE_SOURCE_TYPES.has(normalized) ? normalized : "account_billing";
}

function normalizeAccountBillingConfidence(value) {
  const normalized = normalizeSubscriptionPlanKey(value);
  return ACCOUNT_BILLING_CONFIDENCE_LEVELS.has(normalized) ? normalized : "medium";
}

function normalizeAccountBillingParserStatus(value) {
  const normalized = normalizeSubscriptionPlanKey(value).replace(/\s+/g, "_");
  return ACCOUNT_BILLING_PARSER_STATUSES.has(normalized) ? normalized : null;
}

function sanitizeAccountBillingSourceUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname
      .split("/")
      .map((segment) => (/^[A-Za-z0-9_-]{24,}$/.test(segment) ? ":id" : segment))
      .join("/");
    return url.toString().slice(0, ACCOUNT_BILLING_MAX_SOURCE_URL_LENGTH);
  } catch {
    return null;
  }
}

function accountBillingHasForbiddenKey(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return false;
  for (const [key, child] of Object.entries(value)) {
    if (ACCOUNT_BILLING_FORBIDDEN_KEY_PATTERN.test(key)) return true;
    if (child && typeof child === "object" && accountBillingHasForbiddenKey(child, depth + 1)) return true;
  }
  return false;
}

function accountBillingReasonCode(value, fallback = "account_billing_source_unavailable") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) return fallback;
  return ACCOUNT_BILLING_REASON_CODES.has(normalized) ? normalized : fallback;
}

function accountBillingShortString(value, fallback) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 180) : fallback;
}

async function readOfficialSubscriptionPricing() {
  return readThroughCache(officialSubscriptionPricingCache, OFFICIAL_PRICING_CACHE_MS, async () => {
    const previous = await readStoredOfficialSubscriptionPricing().catch(() => null);
    const fetchedAt = new Date().toISOString();
    const families = {};
    const errors = {};
    await Promise.all(Object.entries(OFFICIAL_SUBSCRIPTION_PRICING_SOURCES).map(async ([family, source]) => {
      try {
        const html = await fetchText(source.sourceUrl, { timeoutMs: OFFICIAL_PRICING_FETCH_TIMEOUT_MS });
        const parsed = source.parser(html, { fetchedAt, sourceUrl: source.sourceUrl });
        if (!parsed.entries.length) throw new Error("official pricing parser returned no plan prices");
        families[family] = parsed;
      } catch (error) {
        errors[family] = error.message || "official pricing fetch failed";
        const cachedFamily = previous?.families?.[family];
        if (cachedFamily?.entries?.length) {
          families[family] = {
            ...cachedFamily,
            source: "cached_official_snapshot",
            parserStatus: "cached_after_fetch_error",
            fetchError: errors[family]
          };
        }
      }
    }));
    const snapshot = {
      version: 1,
      fetchedAt,
      families,
      errors
    };
    if (Object.values(families).some((family) => family.entries?.length)) {
      await saveOfficialSubscriptionPricing(snapshot).catch(() => {});
      return snapshot;
    }
    return previous || snapshot;
  });
}

async function readStoredOfficialSubscriptionPricing() {
  const text = await fsp.readFile(OFFICIAL_SUBSCRIPTION_PRICING_FILE, "utf8");
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" ? parsed : null;
}

async function saveOfficialSubscriptionPricing(snapshot) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(OFFICIAL_SUBSCRIPTION_PRICING_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
}

function parseOpenAiCodexPricingPage(html, meta = {}) {
  const entries = [
    officialPricingEntryFromHtml(html, {
      family: "openai",
      planKey: "plus",
      planName: "Plus",
      aliases: ["plus", "chatgpt plus", "codex plus"],
      sourceUrl: meta.sourceUrl,
      fetchedAt: meta.fetchedAt
    }),
    officialPricingEntryFromHtml(html, {
      family: "openai",
      planKey: "pro",
      planName: "Pro",
      aliases: ["pro", "chatgpt pro", "codex pro"],
      sourceUrl: meta.sourceUrl,
      fetchedAt: meta.fetchedAt,
      priceType: "official_starting_list_price",
      priceVariant: "from",
      tierVariant: null,
      actualBillingKnown: false
    })
  ].filter(Boolean);
  return {
    source: "official_pricing_page",
    sourceUrl: meta.sourceUrl || OFFICIAL_SUBSCRIPTION_PRICING_SOURCES.openai.sourceUrl,
    fetchedAt: meta.fetchedAt || new Date().toISOString(),
    parserStatus: entries.length ? "parsed" : "parse_failed",
    entries
  };
}

function parseClaudePricingPage(html, meta = {}) {
  const entries = [
    officialPricingEntryFromDataPlan(html, {
      planKey: "pro",
      planName: "Claude Pro",
      dataPlan: "pro_monthly",
      aliases: ["pro", "claude pro"],
      sourceUrl: meta.sourceUrl,
      fetchedAt: meta.fetchedAt
    }),
    officialPricingEntryFromDataPlan(html, {
      planKey: "max",
      planName: "Claude Max",
      dataPlan: "max_5x_monthly",
      aliases: ["max", "claude max", "max 5x", "max-5x"],
      sourceUrl: meta.sourceUrl,
      fetchedAt: meta.fetchedAt,
      priceType: "official_starting_list_price",
      priceVariant: "from",
      tierVariant: null,
      actualBillingKnown: false
    }),
    officialPricingEntryFromDataPlan(html, {
      planKey: "max 20x",
      planName: "Claude Max 20x",
      dataPlan: "max_20x_monthly",
      aliases: ["max 20x", "max-20x", "20x", "claude max 20x"],
      sourceUrl: meta.sourceUrl,
      fetchedAt: meta.fetchedAt,
      priceType: "official_list_price",
      priceVariant: "max_20x",
      tierVariant: "max_20x",
      actualBillingKnown: false
    })
  ].filter(Boolean);
  return {
    source: "official_pricing_page",
    sourceUrl: meta.sourceUrl || OFFICIAL_SUBSCRIPTION_PRICING_SOURCES.anthropic.sourceUrl,
    fetchedAt: meta.fetchedAt || new Date().toISOString(),
    parserStatus: entries.length ? "parsed" : "parse_failed",
    entries
  };
}

function officialPricingEntryFromHtml(html, options) {
  const planPattern = escapeRegExp(options.planName);
  const cardPattern = new RegExp(`<h3[^>]*>\\s*${planPattern}\\s*<\\/h3>[\\s\\S]{0,2600}?((?:From\\s*)?\\$\\s*[0-9][0-9,]*(?:\\.[0-9]{2})?)\\s*<`, "i");
  const match = String(html || "").match(cardPattern);
  if (!match) return null;
  return officialPricingEntryFromPriceText(match[1], options);
}

function officialPricingEntryFromDataPlan(html, options) {
  const planPattern = escapeRegExp(options.dataPlan);
  const dataPlanPattern = new RegExp(`data-plan=["']${planPattern}["'][^>]*>\\s*((?:From\\s*)?\\$\\s*[0-9][0-9,]*(?:\\.[0-9]{2})?)\\s*<`, "i");
  const match = String(html || "").match(dataPlanPattern);
  if (!match) return null;
  return officialPricingEntryFromPriceText(match[1], options);
}

function officialPricingEntryFromPriceText(priceText, options) {
  const monthlyCost = positiveAmount(priceText);
  if (!(monthlyCost > 0)) return null;
  const startingPrice = /\bfrom\b/i.test(String(priceText || "")) || options.priceType === "official_starting_list_price";
  return {
    planKey: options.planKey,
    planName: options.planName,
    aliases: options.aliases || [options.planKey, options.planName],
    monthlyCost,
    currency: "USD",
    source: "official_pricing_page",
    sourceUrl: options.sourceUrl,
    fetchedAt: options.fetchedAt || new Date().toISOString(),
    parserStatus: "parsed",
    priceType: startingPrice ? "official_starting_list_price" : options.priceType || "official_list_price",
    priceVariant: options.priceVariant || (startingPrice ? "from" : null),
    tierVariant: options.tierVariant || null,
    actualBillingKnown: options.actualBillingKnown === true
  };
}

async function readSubscriptionHistory() {
  try {
    const text = await fsp.readFile(SUBSCRIPTION_HISTORY_FILE, "utf8");
    const history = sanitizeSubscriptionHistory(JSON.parse(text));
    validateSubscriptionHistory(history);
    return history;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const settings = await readSubscriptionSettings();
  const history = sanitizeSubscriptionHistory({
    version: SUBSCRIPTION_HISTORY_VERSION,
    entries: buildSubscriptionHistoryEntriesFromSettings(settings)
  });
  validateSubscriptionHistory(history);
  await saveSubscriptionHistory(history);
  return history;
}

async function saveSubscriptionHistory(history) {
  const sanitizedHistory = sanitizeSubscriptionHistory(history);
  validateSubscriptionHistory(sanitizedHistory);
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(SUBSCRIPTION_HISTORY_FILE, `${JSON.stringify(sanitizedHistory, null, 2)}\n`, { mode: 0o600 });
  await saveSubscriptionSettings(buildCurrentSubscriptionSettingsFromHistory(sanitizedHistory));
}

function sanitizeSubscriptionSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const result = {};
  for (const id of SUBSCRIPTION_PROVIDER_IDS) {
    result[id] = sanitizeSubscriptionProvider(source[id]);
  }
  return result;
}

function mergeSubscriptionSettingsPatch(current, rawPatch) {
  const merged = sanitizeSubscriptionSettings(current);
  const patch = rawPatch && typeof rawPatch === "object" ? rawPatch : {};
  for (const id of SUBSCRIPTION_PROVIDER_IDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, id)) continue;
    merged[id] = sanitizeSubscriptionProvider({
      ...(merged[id] || {}),
      ...(patch[id] || {})
    });
  }
  return merged;
}

function sanitizeSubscriptionProvider(raw) {
  const provider = raw && typeof raw === "object" ? raw : {};
  const credits = provider.credits || provider.usageCredits || provider.guthaben || {};
  return {
    planType: String(provider.planType || provider.plan || "").trim(),
    monthlyCost: positiveAmount(
      provider.monthlyCost ??
        provider.monthly_cost ??
        provider.subscriptionCost ??
        provider.subscription_cost ??
        provider.monthlyPrice ??
        provider.monthly_price ??
        credits.monthlyCost ??
        credits.monthly_cost ??
        credits.monthlyLimitAmount ??
        credits.monthlyLimit
    ),
    currency: normalizeCurrency(provider.currency || credits.currency || "EUR")
  };
}

function sanitizeSubscriptionHistory(raw) {
  const source = Array.isArray(raw) ? { entries: raw } : raw && typeof raw === "object" ? raw : {};
  return {
    version: SUBSCRIPTION_HISTORY_VERSION,
    entries: Array.isArray(source.entries) ? source.entries.map(sanitizeSubscriptionHistoryEntry).filter(Boolean) : []
  };
}

function sanitizeSubscriptionHistoryEntry(raw) {
  if (!raw || typeof raw !== "object") return null;

  const provider = normalizeSubscriptionHistoryProvider(raw.provider ?? raw.id ?? raw.subscriptionProvider);
  if (!provider) return null;

  const planName = String(raw.planName ?? raw.planType ?? raw.plan ?? "").trim();
  const monthlyCost = positiveAmount(
    raw.monthlyCost ??
      raw.monthly_cost ??
      raw.subscriptionCost ??
      raw.subscription_cost ??
      raw.monthlyPrice ??
      raw.monthly_price
  );
  const currency = normalizeCurrency(raw.currency || "EUR");
  const effectiveFrom = normalizeDateOnly(raw.effectiveFrom ?? raw.startDate ?? raw.startsAt ?? raw.effective_from);
  const effectiveTo = normalizeDateOnly(raw.effectiveTo ?? raw.endDate ?? raw.endsAt ?? raw.effective_to);
  const notes = String(raw.notes ?? raw.note ?? raw.source ?? "").trim();

  return {
    provider,
    planName,
    monthlyCost,
    currency,
    effectiveFrom,
    effectiveTo,
    notes: notes || null,
    isActive: effectiveTo === null
  };
}

function normalizeSubscriptionHistoryProvider(value) {
  const provider = String(value || "").trim();
  return SUBSCRIPTION_PROVIDER_IDS.includes(provider) ? provider : null;
}

function buildSubscriptionHistoryEntriesFromSettings(settings) {
  const today = currentIsoDate();
  const entries = [];
  for (const provider of SUBSCRIPTION_PROVIDER_IDS) {
    const subscription = settings?.[provider];
    if (!hasSubscriptionValue(subscription) || !subscription.planType) continue;
    entries.push({
      provider,
      planName: String(subscription.planType).trim(),
      monthlyCost: positiveAmount(subscription.monthlyCost),
      currency: normalizeCurrency(subscription.currency || "EUR"),
      effectiveFrom: today,
      effectiveTo: null,
      notes: "Migrated from subscription settings",
      isActive: true
    });
  }
  return entries;
}

function buildCurrentSubscriptionSettingsFromHistory(history) {
  const settings = sanitizeSubscriptionSettings({});
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  for (const provider of SUBSCRIPTION_PROVIDER_IDS) {
    const activeEntry = entries.find((entry) => entry.provider === provider && entry.effectiveTo === null);
    if (!activeEntry) continue;
    settings[provider] = sanitizeSubscriptionProvider({
      planType: activeEntry.planName,
      monthlyCost: activeEntry.monthlyCost,
      currency: activeEntry.currency
    });
  }
  return settings;
}

function validateSubscriptionHistory(history) {
  if (!history || typeof history !== "object") {
    throw createHttpError(400, "subscription_history_invalid", "Subscription history payload must be an object.");
  }

  const entries = Array.isArray(history.entries) ? history.entries : [];
  const byProvider = new Map();

  for (const entry of entries) {
    if (!entry?.provider) {
      throw createHttpError(400, "subscription_history_provider_required", "Each subscription history entry needs a provider.");
    }
    if (!entry.planName) {
      throw createHttpError(400, "subscription_history_plan_required", `Subscription history entry for ${entry.provider} needs a planName.`);
    }
    if (!entry.effectiveFrom) {
      throw createHttpError(
        400,
        "subscription_history_effective_from_required",
        `Subscription history entry for ${entry.provider} needs an effectiveFrom date.`
      );
    }
    if (entry.effectiveTo && entry.effectiveTo < entry.effectiveFrom) {
      throw createHttpError(
        400,
        "subscription_history_invalid_range",
        `Subscription history entry for ${entry.provider} has effectiveTo before effectiveFrom.`
      );
    }

    if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
    byProvider.get(entry.provider).push(entry);
  }

  for (const [provider, providerEntries] of byProvider.entries()) {
    const sorted = providerEntries
      .slice()
      .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom) || left.planName.localeCompare(right.planName));

    let openIntervals = 0;
    let previousEnd = null;
    for (const entry of sorted) {
      if (entry.effectiveTo === null) openIntervals += 1;
      if (openIntervals > 1) {
        throw createHttpError(
          400,
          "subscription_history_multiple_active_entries",
          `Subscription history for ${provider} cannot have more than one active interval.`
        );
      }
      if (previousEnd === null) {
        if (entry !== sorted[0]) {
          throw createHttpError(
            400,
            "subscription_history_overlap",
            `Subscription history for ${provider} cannot have intervals after an open-ended entry.`
          );
        }
      } else if (entry.effectiveFrom <= previousEnd) {
        throw createHttpError(
          400,
          "subscription_history_overlap",
          `Subscription history for ${provider} contains overlapping intervals.`
        );
      }
      previousEnd = entry.effectiveTo;
    }
  }
}

function mergeProviderSubscription(provider, subscription, providerId = provider?.id, officialPricing = null, accountBilling = null) {
  if (!provider || provider.status === "error") return provider;
  const accountSubscription = accountBillingSubscriptionPlan(providerId, provider, accountBilling);
  if (accountSubscription?.monthlyCost > 0 && accountSubscription.actualBillingKnown) {
    return mergeAccountBillingSubscription(provider, providerId, accountSubscription);
  }
  const accountPlanHint = accountBillingPlanHint(providerId, accountBilling);
  if (!hasSubscriptionValue(subscription)) {
    return attachAccountBillingStatus(enrichProviderSubscriptionFromCatalog(applyAccountBillingPlanHint(provider, accountPlanHint), providerId, officialPricing), providerId, accountBilling);
  }
  const sourcePlan = String(accountPlanHint?.planType || provider.planType || "").trim();
  const planType = subscription.planType || sourcePlan || null;
  const monthlyCost = positiveAmount(subscription.monthlyCost);
  if (!(monthlyCost > 0)) {
    return attachAccountBillingStatus(enrichProviderSubscriptionFromCatalog({
      ...provider,
      planType,
      planSource: subscription.planType ? "local_settings" : accountPlanHint?.source || provider.planSource || null,
      subscription: {
        ...(provider.subscription && typeof provider.subscription === "object" ? provider.subscription : {}),
        planType,
        planSource: subscription.planType ? "local_settings" : accountPlanHint?.source || provider.planSource || null
      }
    }, providerId, officialPricing), providerId, accountBilling);
  }
  const mergedSubscription = {
    planType,
    monthlyCost,
    currency: normalizeCurrency(subscription.currency || "EUR"),
    source: "local_settings",
    costStatus: "local_settings",
    priceSourceType: "local_settings",
    actualBillingKnown: false
  };
  const merged = {
    ...provider,
    planType,
    planSource: subscription.planType ? "local_settings" : provider.planSource || null,
    subscription: mergedSubscription
  };
  if (provider._usageEvents) merged._usageEvents = provider._usageEvents;
  return attachAccountBillingStatus(merged, providerId, accountBilling);
}

function applyAccountBillingPlanHint(provider, accountPlanHint) {
  if (!accountPlanHint?.planType) return provider;
  const currentPlan = String(provider?.planType || provider?.latest?.planType || "").trim();
  if (currentPlan && isConcreteSubscriptionPlanVariant(provider?.id, currentPlan)) return provider;
  return {
    ...provider,
    planType: accountPlanHint.planType,
    planSource: accountPlanHint.source || provider.planSource || null,
    subscription: provider.subscription
      ? {
          ...provider.subscription,
          planType: provider.subscription.planType || accountPlanHint.planType,
          planSource: provider.subscription.planSource || accountPlanHint.source || provider.planSource || null
        }
      : provider.subscription
  };
}

function mergeAccountBillingSubscription(provider, providerId, accountSubscription) {
  const planType = accountSubscription.planType || provider.planType || provider.latest?.planType || null;
  const mergedSubscription = {
    ...accountSubscription,
    planType,
    source: "account_billing",
    planSource: accountSubscription.planType ? "account_billing" : provider.planSource || null,
    priceSourceType: "account_billing",
    actualBillingKnown: true,
    costStatus: "account_billing",
    accountBillingStatus: "available",
    accountBillingReason: null,
    accountBillingFetchedAt: accountSubscription.fetchedAt || null,
    accountBillingParserStatus: accountSubscription.parserStatus || "parsed",
    accountBillingSourceType: accountSubscription.sourceType || "account_billing"
  };
  const merged = {
    ...provider,
    planType,
    planSource: accountSubscription.planType ? "account_billing" : provider.planSource || null,
    subscription: mergedSubscription
  };
  if (provider._usageEvents) merged._usageEvents = provider._usageEvents;
  return merged;
}

function attachAccountBillingStatus(provider, providerId, accountBilling) {
  if (!provider?.subscription || provider.status === "error") return provider;
  const status = accountBillingProviderStatus(providerId, accountBilling);
  if (!status) return provider;
  return {
    ...provider,
    subscription: {
      ...provider.subscription,
      accountBillingStatus: status.status,
      accountBillingReason: status.reason,
      accountBillingFetchedAt: status.fetchedAt,
      accountBillingParserStatus: status.parserStatus,
      accountBillingSourceType: status.sourceType
    }
  };
}

function accountBillingSubscriptionPlan(providerId, provider, accountBilling) {
  const entry = accountBillingProviderEntry(providerId, accountBilling);
  if (!entry || entry.status !== "available" || !(entry.monthlyCost > 0)) return null;
  return {
    planType: entry.planType || provider?.planType || provider?.latest?.planType || null,
    monthlyCost: entry.monthlyCost,
    amount: entry.amount,
    currency: entry.currency,
    period: entry.period,
    source: "account_billing",
    sourceType: entry.sourceType,
    priceSourceType: "account_billing",
    sourceUrl: entry.sourceUrl,
    fetchedAt: entry.fetchedAt,
    updatedAt: entry.fetchedAt,
    confidence: entry.confidence,
    parserStatus: entry.parserStatus || "parsed",
    planKey: entry.planKey,
    actualBillingKnown: true,
    costStatus: "account_billing",
    redacted: Boolean(entry.redacted)
  };
}

function accountBillingPlanHint(providerId, accountBilling) {
  const entry = accountBillingProviderEntry(providerId, accountBilling);
  if (!entry?.planType) return null;
  if (entry.redacted || entry.status === "expired" || entry.parserStatus === "expired") return null;
  return {
    planType: entry.planType,
    source: entry.sourceType || "account_billing",
    fetchedAt: entry.fetchedAt || null
  };
}

function accountBillingProviderStatus(providerId, accountBilling) {
  if (!ACCOUNT_BILLING_PROVIDER_IDS.has(providerId) && !subscriptionCatalogFamily(providerId)) return null;
  const entry = accountBillingProviderEntry(providerId, accountBilling);
  if (entry) {
    return {
      status: entry.status || "unavailable",
      reason: entry.unavailableReason || null,
      fetchedAt: entry.fetchedAt || null,
      parserStatus: entry.parserStatus || entry.status || "unknown",
      sourceType: entry.sourceType || "account_billing"
    };
  }
  if (!accountBilling || typeof accountBilling !== "object") return null;
  return {
    status: accountBilling.status || "missing",
    reason: accountBilling.reason || "account_billing_provider_missing",
    fetchedAt: accountBilling.fetchedAt || null,
    parserStatus: accountBilling.status || "missing",
    sourceType: "account_billing"
  };
}

function accountBillingProviderEntry(providerId, accountBilling) {
  if (!accountBilling?.providers || typeof accountBilling.providers !== "object") return null;
  if (accountBilling.providers[providerId]) return accountBilling.providers[providerId];
  const family = subscriptionCatalogFamily(providerId);
  if (family === "openai") return accountBilling.providers.openai || null;
  if (family === "anthropic") return accountBilling.providers.anthropic || null;
  return null;
}

function enrichProviderSubscriptionFromCatalog(provider, providerId = provider?.id, officialPricing = null) {
  if (!provider || provider.status === "error") return provider;
  const existing = provider.subscription && typeof provider.subscription === "object" ? provider.subscription : null;
  const explicitCost = positiveAmount(existing?.monthlyCost);
  if (explicitCost > 0) return provider;

  const planType = String(existing?.planType || provider.planType || provider.plan || provider.latest?.planType || "").trim();
  if (!planType) return provider;

  const planSource = existing?.planSource || existing?.source || provider.planSource || null;
  const official = officialSubscriptionPlan(providerId, planType, officialPricing);
  const catalog = official || publicSubscriptionPlan(providerId, planType);
  const subscription = {
    ...(existing || {}),
    planType,
    monthlyCost: catalog ? catalog.monthlyCost : 0,
    currency: catalog ? catalog.currency : normalizeCurrency(existing?.currency || "EUR"),
    source: catalog ? catalog.source : existing?.source || planSource,
    planSource,
    updatedAt: catalog?.fetchedAt || existing?.updatedAt || null,
    fetchedAt: catalog?.fetchedAt || null,
    catalogReviewedAt: catalog && catalog.source === "bundled_catalog" ? SUBSCRIPTION_CATALOG_REVIEW_DATE : null,
    sourceUrl: catalog ? catalog.sourceUrl : null,
    planKey: catalog?.planKey || normalizeSubscriptionPlanKey(planType),
    parserStatus: catalog?.parserStatus || (catalog ? "bundled" : "missing"),
    priceType: catalog?.priceType || (catalog ? "bundled_catalog" : null),
    priceSourceType: catalog?.source || (catalog ? "bundled_catalog" : "unknown"),
    priceVariant: catalog?.priceVariant || null,
    tierVariant: catalog?.tierVariant || null,
    actualBillingKnown: catalog?.actualBillingKnown === true,
    officialListPrice: String(catalog?.priceType || "").startsWith("official_"),
    costStatus: catalog ? catalog.source : "catalog_missing",
    costReason: catalog ? null : subscriptionCostMissingReasonKey(providerId, existing?.source || planSource)
  };

  return {
    ...provider,
    planType,
    subscription
  };
}

function localizeUsageSubscriptionPrices(usage, locale) {
  const region = normalizePricingLocale(locale);
  if (!region || !usage || typeof usage !== "object") return usage;
  const localized = { ...usage };
  for (const providerId of ["codex", "codexSpark", "claudeCode", "openai", "anthropic"]) {
    if (!localized[providerId]) continue;
    localized[providerId] = localizeProviderSubscriptionPrice(localized[providerId], providerId, region);
  }
  return localized;
}

function localizeProviderSubscriptionPrice(provider, providerId, region) {
  const subscription = provider?.subscription;
  if (!subscription || subscription.actualBillingKnown === true || subscription.source === "account_billing") return provider;
  const planType = subscription.planType || provider.planType || provider.latest?.planType || "";
  const regional = regionalSubscriptionPlan(providerId, planType, region);
  if (!regional) return provider;
  return {
    ...provider,
    subscription: {
      ...subscription,
      monthlyCost: regional.monthlyCost,
      currency: regional.currency,
      source: regional.source || subscription.source,
      sourceUrl: regional.sourceUrl || subscription.sourceUrl,
      fetchedAt: subscription.fetchedAt || regional.fetchedAt || null,
      priceType: regional.priceType || subscription.priceType,
      priceSourceType: regional.source || subscription.priceSourceType || subscription.source,
      priceVariant: regional.priceVariant || subscription.priceVariant || null,
      tierVariant: regional.tierVariant || subscription.tierVariant || null,
      priceRegion: regional.priceRegion || region,
      actualBillingKnown: false,
      officialListPrice: true,
      quality: regional.priceType === "official_starting_list_price" ? "officialStarting" : "official"
    }
  };
}

function officialSubscriptionPlan(providerId, planType, officialPricing) {
  const family = subscriptionCatalogFamily(providerId);
  const entries = family ? officialPricing?.families?.[family]?.entries || [] : [];
  const planKey = normalizeSubscriptionPlanKey(planType);
  if (!planKey) return null;
  let entry = entries.find((candidate) => (candidate.aliases || []).some((alias) => normalizeSubscriptionPlanKey(alias) === planKey));
  if (!entry && family === "openai" && planKey === "pro 5x") {
    entry = entries.find((candidate) => candidate.planKey === "pro");
  }
  if (!entry) {
    return officialSubscriptionPlanVariantFromCatalog(providerId, planType, officialPricing);
  }
  const familyMeta = officialPricing.families[family] || {};
  const official = {
    ...entry,
    source: familyMeta.source || entry.source || "official_pricing_page",
    sourceUrl: familyMeta.sourceUrl || entry.sourceUrl,
    fetchedAt: familyMeta.fetchedAt || entry.fetchedAt,
    parserStatus: familyMeta.parserStatus || entry.parserStatus || "parsed"
  };
  if (family === "openai" && entry.planKey === "pro") {
    const explicitFiveX = planKey === "pro 5x";
    return {
      ...official,
      priceType: explicitFiveX ? "official_list_price" : "official_starting_list_price",
      priceVariant: explicitFiveX ? "pro_5x" : "from",
      tierVariant: explicitFiveX ? "pro_5x" : null,
      actualBillingKnown: false
    };
  }
  return official;
}

function officialSubscriptionPlanVariantFromCatalog(providerId, planType, officialPricing) {
  const family = subscriptionCatalogFamily(providerId);
  const familyMeta = family ? officialPricing?.families?.[family] || null : null;
  if (!familyMeta || familyMeta.parserStatus === "parse_failed") return null;

  const catalog = publicSubscriptionPlan(providerId, planType);
  const isConcreteVariant = Boolean(catalog?.tierVariant || catalog?.priceVariant) && catalog?.priceVariant !== "from";
  if (!catalog || !isConcreteVariant || !(catalog.monthlyCost > 0)) return null;

  return {
    ...catalog,
    planKey: normalizeSubscriptionPlanKey(planType),
    source: familyMeta.source || "official_pricing_page",
    sourceUrl: familyMeta.sourceUrl || catalog.sourceUrl,
    fetchedAt: familyMeta.fetchedAt || catalog.fetchedAt,
    parserStatus: familyMeta.parserStatus || "parsed",
    priceType: "official_list_price",
    actualBillingKnown: false
  };
}

function publicSubscriptionPlan(providerId, planType) {
  const family = subscriptionCatalogFamily(providerId);
  const entries = family ? PUBLIC_SUBSCRIPTION_PLAN_CATALOG[family] || [] : [];
  const planKey = normalizeSubscriptionPlanKey(planType);
  if (!planKey) return null;
  return entries.find((entry) => entry.aliases.some((alias) => normalizeSubscriptionPlanKey(alias) === planKey)) || null;
}

function regionalSubscriptionPlan(providerId, planType, region) {
  const family = subscriptionCatalogFamily(providerId);
  const entries = family ? REGIONAL_SUBSCRIPTION_PLAN_CATALOG[region]?.[family] || [] : [];
  const planKey = normalizeSubscriptionPlanKey(planType);
  if (!planKey) return null;
  return entries.find((entry) => entry.aliases.some((alias) => normalizeSubscriptionPlanKey(alias) === planKey)) || null;
}

function normalizePricingLocale(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  return normalized.split(/[,;]/u).some((part) => part.trim().startsWith("de")) ? "de" : null;
}

function pricingLocaleFromRequest(req) {
  return req.query.lang || req.query.locale || req.get("accept-language") || "";
}

function subscriptionCostMissingReasonKey(providerId, sourceId) {
  const source = String(sourceId || "").trim();
  if (source === "codex_app_server") return "catalogMissingCodexAppServer";
  if (source === "claude_statusline") return "catalogMissingClaudeStatusline";
  if (source === "claude_auth_status") return "catalogMissingClaudeAuth";
  if (source === "claude_browser_sync" || source === "browser") return "catalogMissingClaudeBrowser";
  if (providerId === "codex" || providerId === "codexSpark") return "catalogMissingCodexAppServer";
  if (providerId === "claudeCode") return "catalogMissingClaudeStatusline";
  return "catalogMissing";
}

function subscriptionCatalogFamily(providerId) {
  if (["codex", "codexSpark", "openai"].includes(providerId)) return "openai";
  if (["claudeCode", "anthropic"].includes(providerId)) return "anthropic";
  return null;
}

function normalizeSubscriptionPlanKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasSubscriptionValue(subscription) {
  return Boolean(subscription?.planType || subscription?.monthlyCost > 0);
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

function normalizeDateOnly(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function currentIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function createHttpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
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

function buildLimitRows(limits, keys) {
  return keys
    .map((key) => {
      const limit = limits?.[key];
      return limit ? { key, ...limit } : null;
    })
    .filter(Boolean);
}

async function readCodexUsage(options = {}) {
  const liveRateLimitsPromise = readCodexLiveRateLimits();
  const { files, roots, duplicatesSkipped } = await listCodexUsageFiles(options.sources || defaultCodexSources());

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
  const usageEvents = [];

  for (const fileRecord of files) {
    const file = fileRecord.file;
    let fileEvents = 0;
    let currentModel = null;
    await readJsonl(file, (event, meta) => {
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
      const rateLimits = event.payload.rate_limits || null;
      const isSparkRateLimit = isCodexSparkRateLimit(rateLimits);
      const isSparkUsage = isCodexSparkUsageEvent(currentModel, rateLimits);
      if (event.payload.rate_limits) {
        const rateLimitEvent = {
          timestamp: event.timestamp,
          rateLimits,
          file
        };
        if (isSparkRateLimit) {
          sparkRateLimitEvents.push(rateLimitEvent);
        } else {
          rateLimitEvents.push(rateLimitEvent);
        }
      }
      usageEvents.push({
        providerId: "codex",
        sourceId: fileRecord.sourceId,
        eventId: event.id || event.payload?.id || null,
        timestampMs,
        model: currentModel || event.payload.rate_limits?.limit_name || null,
        usage,
        evidence: {
          realpath: fileRecord.realPath,
          realpathHash: hashEvidencePath(fileRecord.realPath),
          line: meta?.line,
          sessionId: fileRecord.sessionId,
          rolloutSessionId: fileRecord.sessionId
        },
        metadata: {
          sourceGroupId: isSparkUsage ? "codexSpark" : "codex"
        }
      });
      addUsage(aggregates, usage);
      if (now - timestampMs <= 5 * 60 * 60 * 1000) addUsage(last5h, usage);
      if (now - timestampMs <= 24 * 60 * 60 * 1000) addUsage(last24h, usage);
      if (now - timestampMs <= 7 * 24 * 60 * 60 * 1000) addUsage(last7d, usage);
      if (isSparkUsage) {
        addUsageEvent(sparkUsage, timestampMs, usage);
        if (!sparkFirstEvent || timestampMs < Date.parse(sparkFirstEvent.timestamp)) {
          sparkFirstEvent = {
            timestamp: event.timestamp,
            model: currentModel || rateLimits?.limit_name || "gpt-5.3-codex-spark",
            file
          };
        }
        if (!sparkLatestEvent || timestampMs > Date.parse(sparkLatestEvent.timestamp)) {
          sparkLatestEvent = {
            timestamp: event.timestamp,
            model: currentModel || rateLimits?.limit_name || "gpt-5.3-codex-spark",
            info: event.payload.info || {},
            rateLimits,
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
  const codexPlan = preferredCodexPlan(liveRateLimits?.codex?.planType || null);
  const liveCodexLimits = liveRateLimits?.codex ? codexRateLimitsFromLive(liveRateLimits.codex, "Codex") : null;
  const liveSparkLimits = liveRateLimits?.spark ? codexRateLimitsFromLive(liveRateLimits.spark, "Codex 5.3 Spark") : null;
  const liveCodexCreditRows = codexCreditRowsFromLive(liveRateLimits?.codex);

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
    planType: codexPlan.planType,
    planSource: codexPlan.source,
    creditRows: liveCodexCreditRows,
    creditSource: liveCodexCreditRows.length ? "codex app-server" : null,
    latest: latestEvent
      ? {
          timestamp: latestEvent.timestamp,
          modelContextWindow: latestEvent.info.model_context_window || null,
          last: normalizeUsage(latestEvent.info.last_token_usage || {}),
          sessionTotal: normalizeUsage(latestEvent.info.total_token_usage || {}),
          planType: codexPlan.planType || latestEvent.rateLimits?.plan_type || null,
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
    daily,
    _usageEvents: usageEvents
  };
}

async function readCopilotUsage(options = {}) {
  const liveQuotaPromise = readCopilotLiveQuota();
  const files = await listFilesForSourcePaths(
    options.sources || buildReaderSources().copilot,
    ["session_state"],
    (file) => path.basename(file) === "events.jsonl"
  );
  const usage = createUsageAccumulator();
  const modelMap = new Map();
  let firstEvent = null;
  let latestEvent = null;
  let eventCount = 0;
  let sessionsWithEvents = 0;
  let totalPremiumRequests = 0;
  let totalApiDurationMs = 0;
  let totalNanoAiu = 0;
  const usageEvents = [];

  for (const fileRecord of files) {
    const file = fileRecord.file;
    let fileEvents = 0;
    await readJsonl(file, (event, meta) => {
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

      usageEvents.push({
        providerId: "copilot",
        sourceId: fileRecord.sourceId,
        eventId: data.sessionId || data.conversationId || null,
        timestampMs,
        model: data.currentModel || Object.keys(modelMetrics)[0] || "copilot",
        usage: sessionUsage,
        evidence: {
          realpath: fileRecord.realPath,
          realpathHash: hashEvidencePath(fileRecord.realPath),
          line: meta?.line,
          sessionStart: data.sessionStartTime || timestampMs
        },
        metadata: {
          sourceGroupId: "copilot"
        }
      });
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
  const liveQuota = await liveQuotaPromise;
  const limits = copilotLimitsFromQuota(liveQuota);
  const hasLiveQuota = Boolean(limits?.rows?.length || limits?.fiveHour || limits?.weekly);

  return {
    id: "copilot",
    status: latestEvent || hasLiveQuota ? "live" : "empty",
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
      liveQuota: liveQuota
        ? {
            status: liveQuota.status,
            source: liveQuota.source,
            updatedAt: liveQuota.updatedAt,
            snapshotCount: Object.keys(liveQuota.quotaSnapshots || {}).length,
            message: liveQuota.message || null
          }
        : null,
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
    limits,
    limitSource: hasLiveQuota ? liveQuota.source || "copilot_sdk_account.getQuota" : null,
    quotaStatus: liveQuota
      ? {
          status: liveQuota.status,
          message: liveQuota.message || null,
          updatedAt: liveQuota.updatedAt || null
        }
      : null,
    byModel: Array.from(modelMap.entries())
      .map(([model, modelUsage]) => ({ model, ...modelUsage }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 8),
    daily: buildDaily(usage.dailyMap),
    _usageEvents: usageEvents
  };
}

async function readCopilotLiveQuota() {
  if (!COPILOT_LIVE_QUOTA_ENABLED) {
    return {
      status: "disabled",
      message: "Copilot live quota probe disabled.",
      updatedAt: new Date().toISOString()
    };
  }

  try {
    return await readThroughCache(copilotLiveQuotaCache, COPILOT_LIVE_QUOTA_CACHE_MS, async () => {
      if (!fs.existsSync(COPILOT_QUOTA_PROBE_SCRIPT)) {
        return {
          status: "not_configured",
          message: "Copilot quota probe script missing.",
          updatedAt: new Date().toISOString()
        };
      }

      const copilotBinary = resolveCopilotBinary();
      if (!copilotBinary) {
        return {
          status: "not_configured",
          message: "Copilot CLI not found.",
          updatedAt: new Date().toISOString()
        };
      }

      return runCopilotQuotaProbe(copilotBinary);
    });
  } catch (error) {
    return {
      status: "error",
      message: error.message,
      source: "copilot_sdk_account.getQuota",
      updatedAt: new Date().toISOString()
    };
  }
}

function runCopilotQuotaProbe(copilotBinary) {
  return new Promise((resolve) => {
    const probeEnv = {
      ...process.env,
      COPILOT_CLI_PATH: copilotBinary,
      COPILOT_QUOTA_PROBE_TIMEOUT_MS: String(Math.max(1_000, COPILOT_LIVE_QUOTA_TIMEOUT_MS - 1_000))
    };
    if (process.versions.electron) {
      probeEnv.ELECTRON_RUN_AS_NODE = "1";
    }
    const child = spawn(process.execPath, [COPILOT_QUOTA_PROBE_SCRIPT], {
      cwd: ROOT.endsWith(".asar") ? path.dirname(ROOT) : ROOT,
      env: probeEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, COPILOT_LIVE_QUOTA_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-200_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-20_000);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        status: "error",
        message: error.message,
        source: "copilot_sdk_account.getQuota",
        updatedAt: new Date().toISOString()
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const parsed = parseLastJsonLine(stdout);
      if (parsed) {
        resolve({
          ...parsed,
          source: parsed.source || "copilot_sdk_account.getQuota",
          updatedAt: parsed.updatedAt || new Date().toISOString()
        });
        return;
      }

      resolve({
        status: timedOut ? "timeout" : "error",
        message: timedOut
          ? "Copilot quota probe timed out."
          : trimmedErrorMessage(stderr) || `Copilot quota probe exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""}).`,
        source: "copilot_sdk_account.getQuota",
        updatedAt: new Date().toISOString()
      });
    });
  });
}

function parseLastJsonLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Skip non-JSON runtime noise.
    }
  }
  return null;
}

function trimmedErrorMessage(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ");
}

function resolveCopilotBinary() {
  const candidates = [
    process.env.COPILOT_BIN,
    process.env.COPILOT_CLI_PATH,
    "/opt/homebrew/bin/copilot",
    "/usr/local/bin/copilot"
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  const which = spawnSync("which", ["copilot"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

function copilotLimitsFromQuota(quota) {
  const snapshots = quota?.quotaSnapshots;
  if (!snapshots || typeof snapshots !== "object") return null;

  const rows = Object.entries(snapshots)
    .map(([key, snapshot]) => copilotQuotaRow(key, snapshot))
    .filter(Boolean);
  if (!rows.length) return null;

  const session = rows.find((row) => /session|five.?hour|5h/i.test(`${row.key} ${row.label}`)) || null;
  const weekly = rows.find((row) => /week|weekly|seven.?day|7d/i.test(`${row.key} ${row.label}`)) || null;
  const limits = {
    fiveHour: session,
    weekly,
    currentSession: session,
    allModels: weekly,
    rows
  };
  return limits;
}

function copilotQuotaRow(key, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const remainingPercent = finiteNumberOrNull(snapshot.remainingPercentage);
  const entitlementRequests = finiteNumberOrNull(snapshot.entitlementRequests);
  const usedRequests = finiteNumberOrNull(snapshot.usedRequests);
  const rowKey = `copilot${toPascalCase(key)}`;
  const label = copilotQuotaLabel(key);
  if (!snapshot.isUnlimitedEntitlement && entitlementRequests !== null && entitlementRequests <= 0) {
    return {
      key: rowKey,
      label,
      status: "unavailable",
      usedPercent: null,
      remainingPercent: null,
      resetsAt: null,
      valueLabel: null
    };
  }
  const usedPercent = Number.isFinite(remainingPercent)
    ? Math.max(0, Math.min(100, 100 - remainingPercent))
    : entitlementRequests > 0 && usedRequests !== null
      ? Math.max(0, Math.min(100, (usedRequests / entitlementRequests) * 100))
      : null;
  if (usedPercent === null && !snapshot.resetDate) return null;

  const valueLabel =
    entitlementRequests > 0 && usedRequests !== null ? `${usedRequests} / ${entitlementRequests}` : null;

  return {
    key: rowKey,
    label,
    usedPercent,
    remainingPercent: Number.isFinite(remainingPercent) ? Math.max(0, Math.min(100, remainingPercent)) : null,
    resetsAt: normalizeOptionalDate(snapshot.resetDate),
    valueLabel
  };
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toPascalCase(value) {
  return String(value || "")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function copilotQuotaLabel(key) {
  const normalized = String(key || "").toLowerCase();
  if (normalized === "chat") return "Copilot chat";
  if (normalized === "completions") return "Completions";
  if (normalized === "premium_interactions") return "Premium requests";
  if (normalized === "premium_models") return "Premium models";
  return String(key || "Copilot quota")
    .replaceAll(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isCodexSparkRateLimit(rateLimits) {
  if (!rateLimits) return false;
  return /spark|bengalfox|research/i.test(`${rateLimits.limit_id || ""} ${rateLimits.limit_name || ""}`);
}

function isCodexSparkModel(model) {
  return /spark|bengalfox|research/i.test(String(model || ""));
}

function isCodexSparkUsageEvent(model, rateLimits) {
  if (isCodexSparkModel(model)) return true;
  return !model && isCodexSparkRateLimit(rateLimits);
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

function readClaudeAppCookies() {
  if (!fs.existsSync(CLAUDE_APP_COOKIES)) return null;
  const keyResult = spawnSync(
    "security",
    ["find-generic-password", "-s", "Claude Safe Storage", "-a", "Claude", "-w"],
    { encoding: "utf8", timeout: 3000 }
  );
  if (keyResult.status !== 0 || !keyResult.stdout.trim()) return null;
  const keychainPw = keyResult.stdout.trim();

  const sqlResult = spawnSync(
    "sqlite3",
    [
      CLAUDE_APP_COOKIES,
      'SELECT name, hex(encrypted_value) FROM cookies WHERE name IN ("sessionKey","lastActiveOrg")'
    ],
    { encoding: "utf8", timeout: 3000 }
  );
  if (sqlResult.status !== 0 || !sqlResult.stdout.trim()) return null;

  const cookies = {};
  for (const line of sqlResult.stdout.trim().split("\n")) {
    const sep = line.indexOf("|");
    if (sep === -1) continue;
    const name = line.slice(0, sep);
    const hex = line.slice(sep + 1).trim();
    if (!hex) continue;
    try {
      const encBuf = Buffer.from(hex, "hex");
      if (encBuf.slice(0, 3).toString() !== "v10") continue;
      const key = crypto.pbkdf2Sync(keychainPw, "saltysalt", 1003, 16, "sha1");
      const iv = Buffer.alloc(16, 0x20);
      const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
      const decrypted = Buffer.concat([decipher.update(encBuf.slice(3)), decipher.final()]);
      // v10 decrypted output has a 32-byte prefix before the actual cookie value.
      cookies[name] = decrypted.slice(32).toString("utf8");
    } catch {
      // Skip cookies that fail to decrypt.
    }
  }
  return cookies.sessionKey && cookies.lastActiveOrg ? cookies : null;
}

async function readClaudeOrgUsageFromApi() {
  const now = Date.now();
  if (claudeApiUsageCache.value && now < claudeApiUsageCache.expiresAt) return claudeApiUsageCache.value;
  if (claudeApiUsageCache.pending) return claudeApiUsageCache.pending;

  claudeApiUsageCache.pending = Promise.resolve()
    .then(fetchClaudeOrgUsageFromApi)
    .then((usage) => {
      if (usage) {
        const value = {
          ...usage,
          updatedAt: usage.updatedAt || new Date().toISOString(),
          cache: {
            ...(usage.cache || {}),
            stale: false
          }
        };
        claudeApiUsageCache.value = value;
        claudeApiUsageCache.expiresAt = Date.now() + CLAUDE_API_USAGE_CACHE_MS;
        return value;
      }
      if (isClaudeApiUsageFreshEnoughForFallback(claudeApiUsageCache.value)) {
        claudeApiUsageCache.value = {
          ...claudeApiUsageCache.value,
          cache: {
            ...(claudeApiUsageCache.value.cache || {}),
            stale: true,
            staleReason: "claude_api_unavailable",
            staleAt: new Date().toISOString()
          }
        };
        claudeApiUsageCache.expiresAt = Date.now() + Math.min(CLAUDE_API_USAGE_CACHE_MS, 30_000);
        return claudeApiUsageCache.value;
      }
      return null;
    })
    .catch((error) => {
      if (isClaudeApiUsageFreshEnoughForFallback(claudeApiUsageCache.value)) {
        claudeApiUsageCache.value = {
          ...claudeApiUsageCache.value,
          cache: {
            ...(claudeApiUsageCache.value.cache || {}),
            stale: true,
            staleReason: error.message,
            staleAt: new Date().toISOString()
          }
        };
        claudeApiUsageCache.expiresAt = Date.now() + Math.min(CLAUDE_API_USAGE_CACHE_MS, 30_000);
        return claudeApiUsageCache.value;
      }
      return null;
    })
    .finally(() => {
      claudeApiUsageCache.pending = null;
    });

  return claudeApiUsageCache.pending;
}

function isClaudeApiUsageFreshEnoughForFallback(value) {
  const updatedAtMs = Date.parse(value?.updatedAt || "");
  return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= CLAUDE_API_USAGE_STALE_MS;
}

async function fetchClaudeOrgUsageFromApi() {
  try {
    const cookies = readClaudeAppCookies();
    if (!cookies) return null;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), CLAUDE_API_USAGE_TIMEOUT_MS);
      const req = https.request(
        {
          hostname: "claude.ai",
          path: `/api/organizations/${cookies.lastActiveOrg}/usage`,
          method: "GET",
          headers: {
            Cookie: `sessionKey=${cookies.sessionKey}`,
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
            Accept: "application/json"
          }
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            clearTimeout(timer);
            if (res.statusCode !== 200) {
              resolve(null);
              return;
            }
            try {
              resolve({
                ...JSON.parse(data),
                updatedAt: new Date().toISOString()
              });
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      req.end();
    });
  } catch {
    return null;
  }
}

function claudeApiWindowToLimitWindow(apiWindow, label, windowMinutes) {
  if (!apiWindow || apiWindow.utilization == null) return null;
  return claudeLimitWindow(
    { used_percentage: apiWindow.utilization, resets_at: apiWindow.resets_at },
    label,
    windowMinutes
  );
}

async function readClaudeCodeUsage(options = {}) {
  const files = await listJsonlFileRecordsForSourcePaths(options.sources || buildReaderSources().claudeCode, ["projects"]);
  const seen = new Set();
  const usage = createUsageAccumulator();
  const modelMap = new Map();
  let firstEvent = null;
  let latestEvent = null;
  let responseCount = 0;
  let sessionsWithEvents = 0;
  const usageEvents = [];

  for (const fileRecord of files) {
    const file = fileRecord.file;
    let fileEvents = 0;
    await readJsonl(file, (event, meta) => {
      if (event?.type !== "assistant" || !event?.message?.usage) return;
      const timestampMs = Date.parse(event.timestamp);
      if (Number.isNaN(timestampMs)) return;
      const usageKey = event.requestId || event.message?.id || `${file}:${event.uuid || event.timestamp}`;
      if (seen.has(usageKey)) return;
      seen.add(usageKey);

      const normalized = normalizeClaudeUsage(event.message.usage);
      usageEvents.push({
        providerId: "claudeCode",
        sourceId: fileRecord.sourceId,
        eventId: event.requestId || event.message?.id || event.uuid || null,
        timestampMs,
        model: event.message.model || "unknown",
        usage: normalized,
        evidence: {
          realpath: fileRecord.realPath,
          realpathHash: hashEvidencePath(fileRecord.realPath),
          line: meta?.line,
          requestId: event.requestId || null,
          messageId: event.message?.id || null,
          uuid: event.uuid || null
        },
        metadata: {
          sourceGroupId: "claudeCode"
        }
      });
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

  const [statusline, authStatus, settingsInfo, scriptInstalled, browserCredits, directApiUsage] =
    await Promise.all([
      readClaudeStatusline(),
      readClaudeAuthStatus(),
      readClaudeSettings(),
      pathExists(CLAUDE_STATUSLINE_SCRIPT),
      readClaudeBrowserCreditsSnapshot().catch(() => null),
      readClaudeOrgUsageFromApi().catch(() => null)
    ]);
  const browserSyncedApiUsage = browserCredits?.usage || null;
  const apiUsage = directApiUsage || browserSyncedApiUsage;
  const apiUsageSource = directApiUsage ? "claude_api" : browserSyncedApiUsage ? "claude_browser_sync" : null;
  const apiUsageUpdatedAt = apiUsage?.updatedAt || null;
  const browserSubscription = browserCredits?.subscription || null;
  const planType = browserSubscription?.planType || statusline?.planType || authStatus?.planType || null;
  const statuslineConfigured = isClaudeStatuslineConfigured(settingsInfo.settings);
  const resolvedCredits = hasUsageCredits(browserCredits?.credits) ? browserCredits.credits : statusline?.credits || null;
  let resolvedLimits = statusline?.limits || null;
  let resolvedLimitsUpdatedAt = statusline?.updatedAt || null;
  let limitSource = statusline?.limits ? "claude_statusline" : null;
  if (apiUsage) {
    if (resolvedLimits) {
      const apiFiveHour = claudeApiWindowToLimitWindow(apiUsage.five_hour, "5h", 300);
      const apiWeekly = claudeApiWindowToLimitWindow(apiUsage.seven_day, "Woche", 10080);
      const apiFable = claudeApiWindowToLimitWindow(apiUsage.seven_day_fable, "Fable", 10080);
      const apiSonnet = claudeApiWindowToLimitWindow(apiUsage.seven_day_sonnet, "Nur Sonnet", 10080);
      let updated = false;
      if (apiFiveHour && !apiFiveHour.expired) {
        resolvedLimits = { ...resolvedLimits, fiveHour: apiFiveHour, currentSession: apiFiveHour };
        updated = true;
      }
      if (apiWeekly && !apiWeekly.expired) {
        resolvedLimits = { ...resolvedLimits, weekly: apiWeekly, allModels: apiWeekly };
        updated = true;
      }
      if (apiFable && !apiFable.expired) {
        resolvedLimits = { ...resolvedLimits, fable: apiFable };
        updated = true;
      }
      if (apiSonnet && !apiSonnet.expired) {
        resolvedLimits = { ...resolvedLimits, sonnetOnly: apiSonnet };
        updated = true;
      }
      if (updated) {
        resolvedLimits.rows = buildLimitRows(resolvedLimits, [
          "fiveHour",
          "weekly",
          "fable",
          "claudeDesign",
          "sonnetOnly"
        ]);
        limitSource = apiUsageSource || "claude_api";
        resolvedLimitsUpdatedAt = apiUsageUpdatedAt;
      }
    } else {
      const fiveHour = claudeApiWindowToLimitWindow(apiUsage.five_hour, "5h", 300);
      const weekly = claudeApiWindowToLimitWindow(apiUsage.seven_day, "Woche", 10080);
      const fable = claudeApiWindowToLimitWindow(apiUsage.seven_day_fable, "Fable", 10080);
      const sonnetOnly = claudeApiWindowToLimitWindow(apiUsage.seven_day_sonnet, "Nur Sonnet", 10080);
      if (fiveHour || weekly || fable || sonnetOnly) {
        resolvedLimits = {
          fiveHour: fiveHour && !fiveHour.expired ? fiveHour : null,
          weekly: weekly && !weekly.expired ? weekly : null,
          currentSession: fiveHour && !fiveHour.expired ? fiveHour : null,
          allModels: weekly && !weekly.expired ? weekly : null,
          fable: fable && !fable.expired ? fable : null,
          claudeDesign: null,
          sonnetOnly: sonnetOnly && !sonnetOnly.expired ? sonnetOnly : null
        };
        resolvedLimits.rows = buildLimitRows(resolvedLimits, [
          "fiveHour",
          "weekly",
          "fable",
          "claudeDesign",
          "sonnetOnly"
        ]);
        if (hasActiveClaudeLimits(resolvedLimits)) {
          limitSource = apiUsageSource || "claude_api";
          resolvedLimitsUpdatedAt = apiUsageUpdatedAt;
        } else {
          resolvedLimits = null;
        }
      }
    }
  }
  return {
    id: "claudeCode",
    status: latestEvent || resolvedLimits ? "live" : "empty",
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
      hasLimits: Boolean(resolvedLimits),
      staleLimits: limitSource === "claude_statusline" && Boolean(statusline?.staleLimits)
    },
    browserCredits: summarizeClaudeBrowserCredits(browserCredits),
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
    limits: resolvedLimits,
    limitsUpdatedAt: resolvedLimitsUpdatedAt,
    planType,
    subscription: browserSubscription
      ? {
          ...browserSubscription,
          planType: browserSubscription.planType || planType,
          source: browserSubscription.source || "claude_browser_sync"
        }
      : null,
    credits: resolvedCredits,
    creditRows: buildCreditRows(resolvedCredits),
    limitSource,
    planSource: browserSubscription?.planType
      ? "claude_browser_sync"
      : statusline?.planType
        ? "claude_statusline"
        : authStatus?.planType
          ? "claude_auth_status"
          : null,
    creditSource: hasUsageCredits(browserCredits?.credits) ? browserCredits?.source || "browser" : statusline?.credits ? "claude_statusline" : null,
    message: claudeCodeStatusMessage(statusline, limitSource),
    byModel: Array.from(modelMap.entries())
      .map(([model, modelUsage]) => ({ model, ...modelUsage }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 8),
    daily: buildDaily(usage.dailyMap),
    _usageEvents: usageEvents
  };
}

function claudeCodeStatusMessage(statusline, limitSource) {
  if (limitSource && limitSource !== "claude_statusline") return null;
  if (statusline?.staleLimits) return "Claude live limits are stale. Open Claude Code once to refresh them.";
  if (statusline?.limits) return null;
  if (statusline?.found) return "Claude live data received, but no official Pro/Max quota values yet.";
  return "Claude live limits are not available from local telemetry yet.";
}

const GEMINI_STALE_LOCAL_LOGS_MESSAGE = "Gemini local usage updates only when local log files contain new usage metadata.";

async function readGeminiUsage(options = {}) {
  const candidates = await listGeminiUsageFileRecords(options.sources || buildReaderSources().gemini);
  const usage = createUsageAccumulator();
  const modelMap = new Map();
  let firstEvent = null;
  let latestEvent = null;
  let eventCount = 0;
  let filesWithEvents = 0;
  const usageEvents = [];

  for (const fileRecord of candidates) {
    const file = fileRecord.file;
    let fileEvents = 0;
    await readUsageObjects(file, (event, meta) => {
      const usageMetadata = findGeminiUsageMetadata(event);
      if (!usageMetadata) return;
      const timestampMs = findTimestampMs(event) || (safeStatMtime(file) ?? Date.now());
      const normalized = normalizeGeminiUsage(usageMetadata);
      if (!normalized.total_tokens) return;
      usageEvents.push({
        providerId: "gemini",
        sourceId: fileRecord.sourceId,
        eventId: findFirstValue(event, ["id", "requestId", "request_id"]) || null,
        timestampMs,
        model: findModelName(event) || "gemini",
        usage: normalized,
        evidence: {
          realpath: fileRecord.realPath,
          realpathHash: hashEvidencePath(fileRecord.realPath),
          line: meta?.line,
          index: meta?.index
        },
        metadata: {
          sourceGroupId: "gemini"
        }
      });
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

  const hasRecentUsage = Number(usage.last7d.totalTokens || 0) > 0;
  const staleLocalLogs = Boolean(latestEvent && !hasRecentUsage);

  return {
    id: "gemini",
    status: latestEvent ? "live" : "empty",
    updatedAt: new Date().toISOString(),
    message: latestEvent
      ? staleLocalLogs
        ? GEMINI_STALE_LOCAL_LOGS_MESSAGE
        : null
      : "Keine lokalen Gemini Usage-Logs gefunden.",
    source: {
      geminiHome: GEMINI_HOME,
      filesScanned: candidates.length,
      filesWithEvents,
      eventCount,
      latestUsageAt: latestEvent?.timestamp || null,
      recentWindowDays: 7,
      staleLocalLogs
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
    daily: buildDaily(usage.dailyMap),
    _usageEvents: usageEvents
  };
}

async function readOllamaUsage(options = {}) {
  const usage = createUsageAccumulator();
  const modelMap = new Map();
  let firstEvent = null;
  let latestEvent = null;
  let eventCount = 0;
  const usageEvents = [];
  const files = await ollamaUsageFileRecords(options.sources || buildReaderSources().ollama);

  for (const fileRecord of files) {
    try {
      await readJsonl(fileRecord.file, (event, meta) => {
      const timestampMs = Date.parse(event.timestamp);
      if (Number.isNaN(timestampMs)) return;
      const normalized = normalizeUsage(event.usage || {});
      if (!normalized.totalTokens) return;
      usageEvents.push({
        providerId: "ollama",
        sourceId: fileRecord.sourceId,
        eventId: event.id || null,
        timestampMs,
        model: event.model || "ollama",
        usage: event.usage || {},
        evidence: {
          realpath: fileRecord.realPath,
          realpathHash: hashEvidencePath(fileRecord.realPath),
          line: meta?.line
        },
        metadata: {
          sourceGroupId: "ollama"
        }
      });
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
      // Missing log files just mean the proxy has not recorded requests yet.
    }
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
      filesScanned: files.length,
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
    daily: buildDaily(usage.dailyMap),
    _usageEvents: usageEvents
  };
}

function buildLocalAggregate(providers) {
  const usageEvents = providers.flatMap((provider) => provider?._usageEvents || []);
  if (usageEvents.length) {
    const aggregate = aggregateUsageEvents(usageEvents, { dailyHistoryDays: DAILY_HISTORY_DAYS });
    return {
      id: "local",
      status: aggregate.totals.allTime.totalTokens > 0 ? "live" : "empty",
      updatedAt: new Date().toISOString(),
      totals: aggregate.totals,
      daily: aggregate.daily,
      sources: aggregate.sources,
      eventStats: aggregate.stats
    };
  }

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

async function listCodexUsageFiles(sources = defaultCodexSources()) {
  const roots = sourcePathEntries(sources, ["sessions", "archived_sessions"]);
  const files = [];
  const seenRealPaths = new Set();
  const seenSessionIds = new Set();
  let duplicatesSkipped = 0;

  for (const root of roots) {
    for (const file of await listJsonlFiles(root.path)) {
      const realPath = await safeRealpath(file);
      const sessionId = codexSessionId(file);
      if (seenRealPaths.has(realPath) || (sessionId && seenSessionIds.has(sessionId))) {
        duplicatesSkipped += 1;
        continue;
      }
      seenRealPaths.add(realPath);
      if (sessionId) seenSessionIds.add(sessionId);
      files.push({ file, sourceId: root.source.id, realPath, sessionId });
    }
  }

  return { files, roots: roots.map((entry) => entry.path), duplicatesSkipped };
}

function sourcePathEntries(sources, roles = null) {
  const roleSet = roles ? new Set(roles) : null;
  return (sources || [])
    .flatMap((source) => {
      return (source.paths || []).map((entry) => ({ source, ...entry }));
    })
    .filter((entry) => !roleSet || roleSet.has(entry.role))
    .filter((entry) => entry.path);
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

async function listFilesForSourcePaths(sources, roles, predicate) {
  const records = [];
  const seen = new Set();
  for (const entry of sourcePathEntries(sources, roles)) {
    for (const file of await listFiles(entry.path, predicate)) {
      const realPath = await safeRealpath(file);
      if (seen.has(realPath)) continue;
      seen.add(realPath);
      records.push({
        file,
        realPath,
        sourceId: entry.source.id,
        source: entry.source
      });
    }
  }
  return records;
}

async function listJsonlFileRecordsForSourcePaths(sources, roles) {
  return listFilesForSourcePaths(sources, roles, (file) => path.basename(file).endsWith(".jsonl"));
}

async function ollamaUsageFileRecords(sources) {
  const records = [];
  const seen = new Set();
  for (const entry of sourcePathEntries(sources, ["usage_file"])) {
    const file = entry.path;
    const realPath = await safeRealpath(file);
    if (seen.has(realPath)) continue;
    seen.add(realPath);
    records.push({
      file,
      realPath,
      sourceId: entry.source.id,
      source: entry.source
    });
  }
  return records;
}

async function readJsonl(file, onObject) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      onObject(JSON.parse(line), { file, line: lineNumber });
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
    let index = 0;
    visitJson(parsed, (object) => {
      onObject(object, { file, index });
      index += 1;
    });
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
      fable: fallback?.fable || null,
      claudeDesign: fallback?.claudeDesign || null,
      sonnetOnly: fallback?.sonnetOnly || null
    };
    limits.rows = buildLimitRows(limits, ["fiveHour", "weekly", "fable", "claudeDesign", "sonnetOnly"]);
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
  const fableCandidate = claudeLimitWindow(
    findClaudeLimit(rateLimits, ["seven_day_fable", "sevenDayFable", "fable", "claude_fable", "claudeFable"]),
    "Fable",
    10080
  );
  const staleWindows = staleClaudeWindows(fiveHourCandidate, weeklyCandidate, fableCandidate);
  const fiveHour = freshClaudeWindow(fiveHourCandidate);
  const weekly = freshClaudeWindow(weeklyCandidate);
  const fable = freshClaudeWindow(fableCandidate);
  if (!fiveHour && !weekly && !fable && !staleWindows.length) return null;
  const limits = {
    fiveHour,
    weekly,
    fable,
    currentSession: fiveHour,
    allModels: weekly
  };
  if (staleWindows.length) limits.staleWindows = staleWindows;
  limits.rows = buildLimitRows(limits, ["fiveHour", "weekly", "fable"]);
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
  const fableCandidate = claudeLimitWindow(
    findClaudeLimit(weeklyRoot, ["fable", "claude_fable", "claudeFable", "seven_day_fable", "sevenDayFable"]) ||
      findClaudeLimit(rateLimits, ["fable", "claude_fable", "claudeFable", "seven_day_fable", "sevenDayFable"]),
    "Fable",
    10080
  );
  const sonnetOnlyCandidate = claudeLimitWindow(
    findClaudeLimit(weeklyRoot, ["sonnet_only", "sonnetOnly", "sonnet", "claude_sonnet", "claudeSonnet", "nur_sonnet"]) ||
      findClaudeLimit(rateLimits, ["sonnet_only", "sonnetOnly", "sonnet", "claude_sonnet", "claudeSonnet", "nur_sonnet"]),
    "Nur Sonnet",
    10080
  );
  const staleWindows = staleClaudeWindows(
    currentSessionCandidate,
    allModelsCandidate,
    claudeDesignCandidate,
    fableCandidate,
    sonnetOnlyCandidate
  );
  const currentSession = freshClaudeWindow(currentSessionCandidate);
  const allModels = freshClaudeWindow(allModelsCandidate);
  const claudeDesign = freshClaudeWindow(claudeDesignCandidate);
  const fable = freshClaudeWindow(fableCandidate);
  const sonnetOnly = freshClaudeWindow(sonnetOnlyCandidate);
  const weeklyCandidate = allModelsCandidate || claudeLimitWindow(findClaudeLimit(rateLimits, ["weekly"]), "Woche", 10080);
  const weekly = freshClaudeWindow(weeklyCandidate);
  if (!allModelsCandidate && weeklyCandidate?.expired) staleWindows.push(weeklyCandidate.label);
  const fiveHour = currentSession;
  const limits = {
    fiveHour,
    weekly,
    currentSession,
    allModels,
    claudeDesign,
    fable,
    sonnetOnly
  };
  if (staleWindows.length) limits.staleWindows = staleWindows;
  limits.rows = buildLimitRows(limits, ["currentSession", "allModels", "claudeDesign", "fable", "sonnetOnly"]);
  if (!fiveHour && !weekly && !claudeDesign && !fable && !sonnetOnly && !staleWindows.length) return null;
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
        limits.fable ||
        limits.sonnetOnly ||
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

async function listGeminiUsageFileRecords(sources) {
  const records = [];
  const seen = new Set();
  for (const entry of sourcePathEntries(sources, ["home", "telemetry", "chats", "tmp"])) {
    for (const file of await listGeminiUsageFiles(entry.path)) {
      const realPath = await safeRealpath(file);
      if (seen.has(realPath)) continue;
      seen.add(realPath);
      records.push({
        file,
        realPath,
        sourceId: entry.source.id,
        source: entry.source
      });
    }
  }
  return records;
}

function findGeminiUsageMetadata(event) {
  const wrapper = findFirstObject(event, (object) => {
    const hasCamel =
      object.promptTokenCount !== undefined ||
      object.candidatesTokenCount !== undefined ||
      object.totalTokenCount !== undefined ||
      object.thoughtsTokenCount !== undefined ||
      object.tokens?.total !== undefined;
    const hasSnake =
      object.prompt_token_count !== undefined ||
      object.candidates_token_count !== undefined ||
      object.total_token_count !== undefined ||
      object.tokens?.total !== undefined ||
      object.thoughts_token_count !== undefined;
    return hasCamel || hasSnake || object.usageMetadata !== undefined || object.usage_metadata !== undefined;
  });
  return wrapper?.usageMetadata || wrapper?.usage_metadata || wrapper?.tokens || findFirstObject(event, (object) => {
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
  const tokenStats = usage.tokens || usage;
  const input = Number(tokenStats.promptTokenCount ?? tokenStats.prompt_token_count ?? tokenStats.prompt ?? tokenStats.input ?? 0);
  const cached = Number(tokenStats.cachedContentTokenCount ?? tokenStats.cached_content_token_count ?? tokenStats.cached ?? 0);
  const output = Number(
    tokenStats.candidatesTokenCount ?? tokenStats.candidates_token_count ?? tokenStats.candidates ?? tokenStats.output ?? 0
  );
  const thoughts = Number(tokenStats.thoughtsTokenCount ?? tokenStats.thoughts_token_count ?? tokenStats.thoughts ?? 0);
  const total = Number(tokenStats.totalTokenCount ?? tokenStats.total_token_count ?? tokenStats.total);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: thoughts,
    total_tokens: Number.isFinite(total) && total > 0 ? total : input + cached + output + thoughts
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

function preferredCodexPlan(livePlanType) {
  const livePlan = String(livePlanType || "").trim();
  if (livePlan) return { planType: livePlan, source: "codex_app_server", updatedAt: null };
  return { planType: null, source: null, updatedAt: null };
}

function isConcreteSubscriptionPlanVariant(providerId, planType) {
  const catalog = publicSubscriptionPlan(providerId, planType);
  return Boolean(catalog?.tierVariant || (catalog?.priceVariant && catalog.priceVariant !== "from"));
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

function codexCreditRowsFromLive(snapshot) {
  const credits = snapshot?.credits;
  if (!credits || credits.hasCredits === false) return [];
  if (credits.unlimited) {
    return [{ key: "codexCredits", label: "Codex credits", valueLabel: "Unlimited" }];
  }
  const balance = Number(credits.balance);
  if (!Number.isFinite(balance)) return [];
  return [{ key: "codexCredits", label: "Codex credits", valueLabel: `${formatCodexCreditBalance(balance)} credits` }];
}

function formatCodexCreditBalance(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
  }).format(value);
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

async function fetchText(url, options = {}) {
  const { timeoutMs = EXTERNAL_FETCH_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      ...fetchOptions,
      headers: {
        "user-agent": "LLM Usage Dashboard pricing audit (+https://github.com/kollinger/llm-usage-dashboard)",
        accept: "text/html,application/xhtml+xml",
        ...(fetchOptions.headers || {})
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Timed out fetching ${new URL(url).hostname}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return text;
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

async function readNotificationSettings() {
  try {
    const text = await fsp.readFile(NOTIFICATION_SETTINGS_FILE, "utf8");
    const data = JSON.parse(text);
    return {
      enabled: typeof data.enabled === "boolean" ? data.enabled : true,
      pacingPercent: Number.isFinite(Number(data.pacingPercent)) ? Number(data.pacingPercent) : 100,
      hardLimitPercent: Number.isFinite(Number(data.hardLimitPercent)) ? Number(data.hardLimitPercent) : 95
    };
  } catch {
    return { enabled: true, pacingPercent: 100, hardLimitPercent: 95 };
  }
}

async function saveNotificationSettings(settings) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(NOTIFICATION_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

async function readUpdateSettings() {
  try {
    const text = await fsp.readFile(UPDATE_SETTINGS_FILE, "utf8");
    return sanitizeUpdateSettings(JSON.parse(text));
  } catch {
    return sanitizeUpdateSettings({});
  }
}

function sanitizeUpdateSettings(settings) {
  return {
    enabled: true,
    allowPrerelease: typeof settings?.allowPrerelease === "boolean" ? settings.allowPrerelease : true
  };
}

function mergeUpdateSettingsPatch(current, patch) {
  return sanitizeUpdateSettings({
    ...current,
    allowPrerelease: typeof patch?.allowPrerelease === "boolean" ? patch.allowPrerelease : current.allowPrerelease
  });
}

async function saveUpdateSettings(settings) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(UPDATE_SETTINGS_FILE, `${JSON.stringify(sanitizeUpdateSettings(settings), null, 2)}\n`, { mode: 0o600 });
}

async function readClaudeBrowserCreditsSnapshot() {
  try {
    const text = await fsp.readFile(CLAUDE_BROWSER_CREDITS_FILE, "utf8");
    const data = JSON.parse(text);
    return normalizeClaudeBrowserCreditsSnapshot(data);
  } catch {
    return null;
  }
}

async function saveClaudeBrowserCreditsSnapshot(payload) {
  const snapshot = normalizeClaudeBrowserCreditsSnapshot(payload);
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(CLAUDE_BROWSER_CREDITS_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await appendChangedQuotaEvents(buildClaudeBrowserQuotaEvents(snapshot)).catch(() => {});
  return snapshot;
}

function normalizeClaudeBrowserCreditsSnapshot(payload) {
  const extractedCredits = extractUsageCredits(payload?.credits) || extractUsageCredits(payload?.billingPayload) || payload?.credits || null;
  const credits = sanitizeUsageCredits(extractedCredits);
  const updatedAt = normalizeOptionalDate(payload?.updatedAt) || new Date().toISOString();
  const subscription = normalizeClaudeBrowserSubscriptionSnapshot(payload, updatedAt);
  return {
    status: normalizeClaudeBrowserCreditsStatus(payload?.status, credits, subscription),
    reason: String(payload?.reason || "").trim() || null,
    source: String(payload?.source || "").trim() || null,
    cookieName: String(payload?.cookieName || "").trim() || null,
    updatedAt,
    subscription,
    credits: hasUsageCredits(credits) ? credits : null,
    usage: normalizeClaudeBrowserUsageSnapshot(
      payload?.usage || payload?.usagePayload || payload?.billingPayload?.usage,
      updatedAt
    )
  };
}

function normalizeClaudeBrowserSubscriptionSnapshot(payload, fallbackUpdatedAt) {
  const explicitCandidates = [
    payload?.subscription,
    payload?.billingPayload?.subscription,
    payload?.billingPayload?.account?.subscription,
    payload?.billingPayload?.billing?.subscription
  ];
  for (const candidate of explicitCandidates) {
    const subscription = sanitizeClaudeSubscriptionCandidate(candidate, fallbackUpdatedAt, { explicitPath: true });
    if (subscription) return subscription;
  }
  const scopedCandidates = [
    payload?.billingPayload?.account,
    payload?.billingPayload?.billing,
    payload?.billingPayload
  ];
  for (const candidate of scopedCandidates) {
    const subscription = sanitizeClaudeSubscriptionCandidate(candidate, fallbackUpdatedAt);
    if (subscription) return subscription;
  }
  return null;
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

function sanitizeClaudeSubscriptionCandidate(candidate, fallbackUpdatedAt, options = {}) {
  if (!candidate || typeof candidate !== "object") return null;
  const explicitPlanType = explicitClaudeSubscriptionPlan(candidate);
  const planType = explicitPlanType || (options.explicitPath ? fallbackClaudeSubscriptionPlan(candidate) : "");
  const hasSubscriptionScope = Boolean(options.explicitPath || explicitPlanType);
  if (!hasSubscriptionScope) return null;
  if (planType && !isKnownClaudeBrowserSubscriptionPlan(planType)) return null;
  const monthlyCost = positiveAmount(
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
  const monthlyCostCents = positiveAmount(
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
    currency: normalizeCurrency(candidate.currency || candidate.price?.currency || "EUR"),
    source: "claude_browser_sync",
    actualBillingKnown: normalizedCost > 0,
    updatedAt: normalizeOptionalDate(candidate.updatedAt || candidate.updated_at) || fallbackUpdatedAt
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
  return Boolean(
    planKey &&
      (CLAUDE_BROWSER_SUBSCRIPTION_PLAN_KEYS.has(planKey) ||
        PUBLIC_SUBSCRIPTION_PLAN_CATALOG.anthropic.some((entry) =>
          entry.aliases.some((alias) => normalizeSubscriptionPlanKey(alias) === planKey)
        ))
  );
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeClaudeBrowserUsageSnapshot(payload, fallbackUpdatedAt) {
  if (!payload || typeof payload !== "object") return null;
  const hasUsageWindows = Boolean(payload.five_hour || payload.seven_day || payload.seven_day_sonnet);
  if (!hasUsageWindows) return null;
  return {
    ...payload,
    source: "claude_browser_sync",
    updatedAt: normalizeOptionalDate(payload.updatedAt) || fallbackUpdatedAt
  };
}

function normalizeClaudeBrowserCreditsStatus(value, credits, subscription = null) {
  if (hasUsageCredits(credits)) return "available";
  if (subscription?.planType || subscription?.monthlyCost > 0) return "available";
  const normalized = String(value || "").trim().toLowerCase();
  if (["available", "missing", "expired", "error", "unsupported"].includes(normalized)) return normalized;
  return "missing";
}

function summarizeClaudeBrowserCredits(snapshot) {
  if (!snapshot) return { status: "missing", reason: "not_synced", source: null, updatedAt: null };
  return {
    status: snapshot.status || "missing",
    reason: snapshot.reason || null,
    source: snapshot.source || null,
    updatedAt: snapshot.updatedAt || null,
    usageUpdatedAt: snapshot.usage?.updatedAt || null
  };
}

async function recordProviderQuotaSnapshots(providers) {
  const events = [];
  for (const provider of providers) {
    events.push(...buildProviderQuotaEvents(provider));
  }
  if (events.length) await appendChangedQuotaEvents(events);
}

function buildProviderQuotaEvents(provider) {
  if (!provider || typeof provider !== "object" || !provider.id) return [];
  const capturedAt = provider.limitsUpdatedAt || provider.updatedAt || new Date().toISOString();
  const source =
    provider.limitSource ||
    provider.liveRateLimits?.name ||
    provider.liveRateLimits?.source ||
    provider.source?.liveRateLimits?.name ||
    provider.source?.liveRateLimits?.source ||
    null;
  const events =
    provider.id === "claudeCode" && provider.browserCredits
      ? buildStatusQuotaEvent(
          provider.id,
          provider.browserCredits.status,
          provider.browserCredits.reason,
          provider.browserCredits.source || source,
          provider.browserCredits.updatedAt || capturedAt
        )
      : buildStatusQuotaEvent(provider.id, provider.status, provider.message || null, source, capturedAt);
  const limitWindows = provider.limits?.rows?.length
    ? provider.limits.rows
    : [
        provider.limits?.fiveHour,
        provider.limits?.weekly,
        provider.limits?.currentSession,
        provider.limits?.allModels,
        provider.limits?.claudeDesign,
        provider.limits?.fable,
        provider.limits?.sonnetOnly
      ];
  const windows = [
    provider.fiveHour,
    provider.weekly,
    provider.currentSession,
    provider.allModels,
    ...(provider.limitRows || []),
    ...limitWindows,
    ...(provider.rows || [])
  ];
  const seen = new Set();
  for (const window of windows) {
    const event = quotaWindowEventFromLimitRow(provider.id, window, capturedAt, source);
    if (!event) continue;
    const key = `${event.provider}:${event.windowKey}:${event.resetsAt || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  for (const credit of provider.creditRows || []) {
    const event = quotaCreditEventFromRow(provider.id, credit, capturedAt, provider.creditSource || source);
    if (event) events.push(event);
  }
  return events;
}

function buildClaudeBrowserQuotaEvents(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const capturedAt = snapshot.usage?.updatedAt || snapshot.updatedAt || new Date().toISOString();
  const source = snapshot.usage?.source || snapshot.source || "claude_browser_sync";
  const events = buildStatusQuotaEvent("claudeCode", snapshot.status, snapshot.reason, source, capturedAt);
  const usage = snapshot.usage || {};
  for (const [windowKey, label, windowMinutes] of [
    ["five_hour", "5h", 300],
    ["seven_day", "Woche", 10080],
    ["seven_day_fable", "Fable", 10080],
    ["seven_day_sonnet", "Nur Sonnet", 10080],
    ["seven_day_opus", "Opus", 10080],
    ["seven_day_oauth_apps", "OAuth Apps", 10080],
    ["seven_day_cowork", "Cowork", 10080],
    ["seven_day_omelette", "Omelette", 10080]
  ]) {
    const event = quotaWindowEventFromClaudeUsage("claudeCode", windowKey, label, windowMinutes, usage[windowKey], capturedAt, source);
    if (event) events.push(event);
  }
  const extraUsage = quotaCreditEventFromClaudeExtraUsage(usage.extra_usage, capturedAt, source);
  if (extraUsage) events.push(extraUsage);
  return events;
}

function buildStatusQuotaEvent(provider, status, reason, source, capturedAt) {
  const normalizedStatus = String(status || "").trim() || "unknown";
  if (!normalizedStatus || normalizedStatus === "live") return [];
  return [
    finalizeQuotaEvent({
      type: "quota_status",
      provider,
      windowKey: "sync_status",
      capturedAt,
      status: normalizedStatus,
      reason: reason || null,
      source: source || null
    })
  ];
}

function quotaWindowEventFromClaudeUsage(provider, windowKey, label, windowMinutes, rawWindow, capturedAt, source) {
  if (!rawWindow || typeof rawWindow !== "object") return null;
  const usedPercent = numberOrNull(rawWindow.utilization ?? rawWindow.used_percentage ?? rawWindow.usedPercent);
  if (usedPercent === null) return null;
  return finalizeQuotaEvent({
    type: "quota_window",
    provider,
    windowKey,
    label,
    capturedAt,
    source: source || null,
    usedPercent: clampPercent(usedPercent),
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: normalizeOptionalDate(rawWindow.resets_at ?? rawWindow.resetsAt),
    windowMinutes
  });
}

function quotaWindowEventFromLimitRow(provider, row, capturedAt, source) {
  if (!row || typeof row !== "object") return null;
  const usedPercent = numberOrNull(row.usedPercent ?? row.used_percentage ?? row.usage_percentage ?? row.percent_used);
  if (usedPercent === null) return null;
  const rawWindowKey = row.key || row.windowKey || row.name || row.label || row.limitName || row.limitLabel || "limit";
  return finalizeQuotaEvent({
    type: "quota_window",
    provider,
    windowKey: quotaWindowKey(rawWindowKey),
    label: String(row.label || row.limitLabel || row.name || row.limitName || rawWindowKey),
    capturedAt,
    source: source || null,
    usedPercent: clampPercent(usedPercent),
    remainingPercent: clampPercent(row.remainingPercent ?? row.remaining_percentage ?? 100 - usedPercent),
    resetsAt: normalizeOptionalDate(row.resetsAt ?? row.reset_at ?? row.resets_at),
    windowMinutes: positiveInteger(row.windowMinutes ?? row.window_minutes)
  });
}

function quotaCreditEventFromRow(provider, row, capturedAt, source) {
  if (!row || typeof row !== "object" || row.percent === undefined || row.percent === null) return null;
  const percent = numberOrNull(row.percent);
  if (percent === null) return null;
  return finalizeQuotaEvent({
    type: "quota_credit",
    provider,
    windowKey: quotaWindowKey(row.key || row.label || "credit"),
    label: String(row.label || row.key || "Credit"),
    capturedAt,
    source: source || null,
    usedPercent: clampPercent(percent),
    amount: numberOrNull(row.amount),
    currency: row.currency ? normalizeCurrency(row.currency) : null,
    resetsAt: normalizeOptionalDate(row.resetsAt)
  });
}

function quotaCreditEventFromClaudeExtraUsage(extraUsage, capturedAt, source) {
  if (!extraUsage || typeof extraUsage !== "object") return null;
  const usedCredits = numberOrNull(extraUsage.used_credits ?? extraUsage.usedCredits);
  const monthlyLimit = numberOrNull(extraUsage.monthly_limit ?? extraUsage.monthlyLimit);
  const utilization = numberOrNull(extraUsage.utilization);
  if (usedCredits === null && utilization === null) return null;
  return finalizeQuotaEvent({
    type: "quota_credit",
    provider: "claudeCode",
    windowKey: "extra_usage",
    label: "Extra usage",
    capturedAt,
    source: source || null,
    usedPercent: utilization === null ? null : clampPercent(utilization),
    usedCredits,
    monthlyLimit,
    currency: extraUsage.currency ? normalizeCurrency(extraUsage.currency) : null,
    status: parseBoolean(extraUsage.is_enabled) ? "available" : "disabled",
    reason: extraUsage.disabled_reason || null
  });
}

function finalizeQuotaEvent(event) {
  const capturedAt = normalizeOptionalDate(event.capturedAt) || new Date().toISOString();
  const normalized = {
    type: event.type,
    provider: event.provider,
    windowKey: quotaWindowKey(event.windowKey),
    label: event.label || null,
    capturedAt,
    source: event.source ? String(event.source) : null,
    status: event.status ? String(event.status) : null,
    reason: event.reason || null,
    usedPercent: event.usedPercent === null || event.usedPercent === undefined ? null : clampPercent(event.usedPercent),
    remainingPercent:
      event.remainingPercent === null || event.remainingPercent === undefined ? null : clampPercent(event.remainingPercent),
    resetsAt: normalizeQuotaResetDate(event.resetsAt),
    windowMinutes: positiveInteger(event.windowMinutes),
    amount: numberOrNull(event.amount),
    usedCredits: numberOrNull(event.usedCredits),
    monthlyLimit: numberOrNull(event.monthlyLimit),
    currency: event.currency ? normalizeCurrency(event.currency) : null
  };
  for (const key of Object.keys(normalized)) {
    if (normalized[key] === null || normalized[key] === undefined || normalized[key] === "") delete normalized[key];
  }
  normalized.eventKey = quotaEventKey(normalized);
  normalized.fingerprint = quotaEventFingerprint(normalized);
  return normalized;
}

async function appendChangedQuotaEvents(events) {
  const cleanEvents = events.filter(Boolean);
  if (!cleanEvents.length) return [];
  const latestByKey = await readLatestQuotaEventsByKey();
  const changed = cleanEvents.filter((event) => latestByKey.get(event.eventKey)?.fingerprint !== event.fingerprint);
  if (!changed.length) return [];
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.appendFile(QUOTA_EVENTS_FILE, changed.map((event) => JSON.stringify(event)).join("\n") + "\n", { mode: 0o600 });
  return changed;
}

async function readLatestQuotaEventsByKey() {
  const events = await readQuotaEvents();
  const latestByKey = new Map();
  for (const event of events) {
    latestByKey.set(event.eventKey || quotaEventKey(event), event);
  }
  return latestByKey;
}

async function readQuotaEvents() {
  try {
    const text = await fsp.readFile(QUOTA_EVENTS_FILE, "utf8");
    const events = [];
    const seen = new Set();
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        const event = normalizeStoredQuotaEvent(JSON.parse(line));
        if (!event) continue;
        const key = `${event.eventKey || ""}:${event.capturedAt || ""}:${event.fingerprint || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(event);
      } catch {
        // Ignore corrupt history lines.
      }
    }
    return events;
  } catch {
    return [];
  }
}

function normalizeStoredQuotaEvent(event) {
  if (!event || typeof event !== "object" || !event.provider || !event.type || !event.windowKey) return null;
  const normalized = {
    ...event,
    windowKey: quotaWindowKey(event.windowKey),
    resetsAt: normalizeQuotaResetDate(event.resetsAt)
  };
  normalized.eventKey = quotaEventKey(normalized);
  normalized.fingerprint = quotaEventFingerprint(normalized);
  return normalized;
}

function buildQuotaWindowSummaries(events) {
  const groups = new Map();
  for (const event of events) {
    if (event.type !== "quota_window" || !event.resetsAt) continue;
    const key = `${event.provider}:${event.windowKey}:${event.resetsAt}`;
    const existing = groups.get(key) || {
      provider: event.provider,
      windowKey: event.windowKey,
      label: event.label || event.windowKey,
      source: event.source || null,
      windowMinutes: event.windowMinutes || null,
      startsAt: quotaWindowStartsAt(event.resetsAt, event.windowMinutes),
      resetsAt: event.resetsAt,
      firstCapturedAt: event.capturedAt,
      lastCapturedAt: event.capturedAt,
      maxUsedPercent: event.usedPercent,
      minRemainingPercent: event.remainingPercent,
      eventCount: 0,
      complete: Date.parse(event.resetsAt) <= Date.now()
    };
    existing.eventCount += 1;
    if (Date.parse(event.capturedAt) < Date.parse(existing.firstCapturedAt)) existing.firstCapturedAt = event.capturedAt;
    if (Date.parse(event.capturedAt) > Date.parse(existing.lastCapturedAt)) existing.lastCapturedAt = event.capturedAt;
    if (event.usedPercent !== undefined) {
      existing.maxUsedPercent =
        existing.maxUsedPercent === undefined ? event.usedPercent : Math.max(existing.maxUsedPercent, event.usedPercent);
    }
    if (event.remainingPercent !== undefined) {
      existing.minRemainingPercent =
        existing.minRemainingPercent === undefined
          ? event.remainingPercent
          : Math.min(existing.minRemainingPercent, event.remainingPercent);
    }
    groups.set(key, existing);
  }
  return Array.from(groups.values()).sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
}

function quotaWindowStartsAt(resetsAt, windowMinutes) {
  const resetMs = Date.parse(resetsAt || "");
  const minutes = positiveInteger(windowMinutes);
  if (!Number.isFinite(resetMs) || !minutes) return null;
  return new Date(resetMs - minutes * 60 * 1000).toISOString();
}

function normalizeQuotaResetDate(value) {
  const iso = normalizeOptionalDate(value);
  if (!iso) return null;
  const date = new Date(iso);
  if (date.getSeconds() >= 30) {
    date.setMinutes(date.getMinutes() + 1);
  }
  date.setSeconds(0, 0);
  return date.toISOString();
}

function quotaEventKey(event) {
  return `${event.provider}:${event.type}:${event.windowKey}`;
}

function quotaEventFingerprint(event) {
  return JSON.stringify({
    status: event.status || null,
    reason: event.reason || null,
    usedPercent: event.usedPercent ?? null,
    remainingPercent: event.remainingPercent ?? null,
    resetsAt: event.resetsAt || null,
    windowMinutes: event.windowMinutes || null,
    amount: event.amount ?? null,
    usedCredits: event.usedCredits ?? null,
    monthlyLimit: event.monthlyLimit ?? null,
    currency: event.currency || null,
    source: event.source || null
  });
}

function quotaWindowKey(value) {
  const normalized = String(value || "limit")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "limit";
  const aliases = {
    "5h": "five_hour",
    current_session: "five_hour",
    aktuelle_sitzung: "five_hour",
    woche: "weekly",
    all_models: "weekly",
    alle_modelle: "weekly",
    seven_day: "weekly",
    claude_fable: "fable",
    seven_day_fable: "fable",
    nur_sonnet: "sonnet_only",
    seven_day_sonnet: "sonnet_only"
  };
  return aliases[normalized] || normalized;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function clampPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function buildNotificationAlerts(settings, usageMap) {
  const alerts = [];
  const now = Date.now();
  const windows = collectNotificationWindows(usageMap);
  for (const win of windows) {
    const { key: windowKey, label, usedPercent, windowMinutes, resetsAt } = win;
    if (!Number.isFinite(usedPercent) || usedPercent < 0) continue;

    // Hard limit check
    if (usedPercent >= settings.hardLimitPercent) {
      alerts.push({
        type: "hard_limit",
        windowKey,
        windowLabel: label,
        usedPercent,
        resetsAt: resetsAt || null
      });
      continue;
    }

    // Pacing check: project current pace to end of window
    if (resetsAt && Number.isFinite(windowMinutes) && windowMinutes > 0) {
      const resetMs = Date.parse(resetsAt);
      if (!Number.isFinite(resetMs) || resetMs <= now) continue;
      const windowMs = windowMinutes * 60 * 1000;
      const windowStartMs = resetMs - windowMs;
      const elapsedMs = now - windowStartMs;
      if (elapsedMs <= 0) continue;
      const elapsedRatio = elapsedMs / windowMs;
      // Require at least 5% of the window to have elapsed before projecting
      if (elapsedRatio < 0.05) continue;
      const projectedPercent = usedPercent / elapsedRatio;
      if (projectedPercent >= settings.pacingPercent) {
        const remainingMs = resetMs - now;
        const exhaustMsFromNow = usedPercent < 100
          ? (((100 - usedPercent) / usedPercent) * elapsedMs)
          : 0;
        alerts.push({
          type: "pacing",
          windowKey,
          windowLabel: label,
          usedPercent,
          projectedPercent: Math.round(projectedPercent),
          remainingMinutes: Math.round(remainingMs / 60000),
          exhaustInMinutes: exhaustMsFromNow > 0 ? Math.round(exhaustMsFromNow / 60000) : null,
          resetsAt: resetsAt || null
        });
      }
    }
  }
  return alerts;
}

function collectNotificationWindows(usageMap) {
  const windows = [];
  for (const provider of Object.values(usageMap)) {
    if (!provider || typeof provider !== "object") continue;
    const candidates = [
      provider.fiveHour,
      provider.weekly,
      provider.currentSession,
      provider.allModels,
      provider.limits?.fiveHour,
      provider.limits?.weekly,
      provider.limits?.currentSession,
      provider.limits?.allModels,
      provider.limits?.claudeDesign,
      provider.limits?.fable,
      provider.limits?.sonnetOnly,
      ...(provider.limitRows || []),
      ...(provider.limits?.rows || []),
      ...(provider.rows || [])
    ];
    for (const win of candidates) {
      if (!win || typeof win !== "object") continue;
      const usedPercent =
        win.usedPercent ?? win.used_percent ?? win.usage_percentage ?? null;
      const resetsAt = win.resetsAt ?? win.reset_at ?? null;
      const windowMinutes = win.windowMinutes ?? win.window_minutes ?? null;
      const rawKey = win.key ?? win.windowKey ?? win.window_key ?? win.name ?? win.limitName ?? win.limitLabel ?? win.label;
      const label = win.label ?? win.limitLabel ?? win.name ?? win.limitName ?? "Limit";
      if (usedPercent !== null && Number.isFinite(Number(usedPercent))) {
        windows.push({
          key: quotaWindowKey(rawKey || label),
          label,
          usedPercent: Number(usedPercent),
          windowMinutes: Number(windowMinutes || 0),
          resetsAt
        });
      }
    }
  }
  return windows;
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

module.exports = {
  app,
  startDashboard,
  readCodexUsage,
  readClaudeCodeUsage,
  createTimedCache,
  invalidateTimedCache,
  readThroughCache,
  _test: {
    copilotLimitsFromQuota,
    readGeminiUsage,
    parseDarwinSwapUsage,
    parseLinuxMeminfoSwap,
    parseProcessRows,
    classifyAiProcess,
    aggregateAiProcessMetrics,
    buildLiveProcessMetrics,
    buildAiLoadScore,
    buildSourceDiagnosticsPayload,
    sanitizeUpdateSettings,
    mergeUpdateSettingsPatch,
    normalizeClaudeBrowserCreditsSnapshot,
    buildNotificationAlerts,
    parseOpenAiCodexPricingPage,
    parseClaudePricingPage,
    officialSubscriptionPlan,
    mergeProviderSubscription,
    preferredCodexPlan,
    localizeUsageSubscriptionPrices,
    sanitizeAccountBillingSnapshots,
    accountBillingSubscriptionPlan
  }
};
