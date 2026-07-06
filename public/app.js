const state = {
  auth: null,
  usage: null,
  subscriptionHistory: null,
  loadingUsage: false,
  queuedUsageForce: false,
  queuedUsageIndicator: false,
  refreshIndicator: false,
  showAllProviders: false,
  layoutEditMode: false,
  providerOrder: [],
  keyboardDragProviderId: null,
  keyboardOriginalProviderOrder: null,
  draggingProviderId: null,
  pointerDrag: null,
  chartRendered: false,
  chartScrollToLatest: true,
  chartMode: "tokens",
  chartTimeFilter: "all",
  pricingSort: null,
  language: "en",
  translations: {},
  fallbackTranslations: {},
  sourceDiagnostics: null,
  systemMetrics: null,
  systemMetricsError: "",
  sourceDiagnosticsError: "",
  loadingSourceDiagnostics: false,
  loadingSystemMetrics: false,
  sourceMessage: { text: "", status: "" },
  liveSeriesVisibility: {},
  sourceOps: {},
  settingsAutosaveTimers: {},
  settingsToastTimer: null,
  activeRendererNotifications: new Set(),
  notificationPreviewTimer: null
};

const els = {
  appShell: document.querySelector("main.app-shell"),
  providerGrid: document.getElementById("providerGrid"),
  sourceDiagnosticsSection: document.getElementById("sourceDiagnosticsSection"),
  sourceDiagnosticsMeta: document.getElementById("sourceDiagnosticsMeta"),
  sourceDiagnosticsSummary: document.getElementById("sourceDiagnosticsSummary"),
  sourceDiagnosticsGrid: document.getElementById("sourceDiagnosticsGrid"),
  sourceDiagnosticsInstances: document.getElementById("sourceDiagnosticsInstances"),
  diagnosticsRecheckBtn: document.getElementById("diagnosticsRecheckBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  layoutEditBtn: document.getElementById("layoutEditBtn"),
  layoutResetBtn: document.getElementById("layoutResetBtn"),
  layoutLiveRegion: document.getElementById("layoutLiveRegion"),
  providerFilterBtn: document.getElementById("providerFilterBtn"),
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  loginDialog: document.getElementById("loginDialog"),
  loginForm: document.getElementById("loginForm"),
  passwordInput: document.getElementById("passwordInput"),
  loginError: document.getElementById("loginError"),
  oidcLink: document.getElementById("oidcLink"),
  settingsDialog: document.getElementById("settingsDialog"),
  settingsCloseBtn: document.getElementById("settingsCloseBtn"),
  settingsSourcesRecheckBtn: document.getElementById("settingsSourcesRecheckBtn"),
  settingsSourcesStatus: document.getElementById("settingsSourcesStatus"),
  settingsSourceSummary: document.getElementById("settingsSourceSummary"),
  settingsConnectedSources: document.getElementById("settingsConnectedSources"),
  settingsCandidateSources: document.getElementById("settingsCandidateSources"),
  settingsToast: document.getElementById("settingsToast"),
  subscriptionFields: Array.from(document.querySelectorAll("[data-subscription-field]")),
  updateSettingsSection: document.getElementById("updateSettingsSection"),
  updateChecksEnabled: document.getElementById("updateChecksEnabled"),
  allowPrereleaseUpdates: document.getElementById("allowPrereleaseUpdates"),
  updateDiagState: document.getElementById("updateDiagState"),
  updateDiagSupport: document.getElementById("updateDiagSupport"),
  updateDiagLastCheck: document.getElementById("updateDiagLastCheck"),
  updateDiagVersion: document.getElementById("updateDiagVersion"),
  updateDiagAvailable: document.getElementById("updateDiagAvailable"),
  updateDiagError: document.getElementById("updateDiagError"),
  updateCheckBtn: document.getElementById("updateCheckBtn"),
  updateCheckStatus: document.getElementById("updateCheckStatus"),
  updateNotice: document.getElementById("updateNotice"),
  updateNoticeBody: document.getElementById("updateNoticeBody"),
  notificationsEnabled: document.getElementById("notificationsEnabled"),
  notificationThresholds: document.getElementById("notificationThresholds"),
  notificationPacingPercent: document.getElementById("notificationPacingPercent"),
  notificationHardLimitPercent: document.getElementById("notificationHardLimitPercent"),
  notificationDiagnostics: document.getElementById("notificationDiagnostics"),
  notificationDiagLastCheck: document.getElementById("notificationDiagLastCheck"),
  notificationDiagDuration: document.getElementById("notificationDiagDuration"),
  notificationDiagAlerts: document.getElementById("notificationDiagAlerts"),
  notificationDiagLastShown: document.getElementById("notificationDiagLastShown"),
  notificationDiagSkipped: document.getElementById("notificationDiagSkipped"),
  notificationDiagError: document.getElementById("notificationDiagError"),
  notificationDiagSupported: document.getElementById("notificationDiagSupported"),
  notificationDiagPermission: document.getElementById("notificationDiagPermission"),
  notificationDiagNativeDelivery: document.getElementById("notificationDiagNativeDelivery"),
  notificationPermissionNotice: document.getElementById("notificationPermissionNotice"),
  notificationPermissionNoticeTitle: document.getElementById("notificationPermissionNoticeTitle"),
  notificationPermissionNoticeBody: document.getElementById("notificationPermissionNoticeBody"),
  notificationSettingsBtn: document.getElementById("notificationSettingsBtn"),
  notificationTestBtn: document.getElementById("notificationTestBtn"),
  notificationTestStatus: document.getElementById("notificationTestStatus"),
  notificationTestPreview: document.getElementById("notificationTestPreview"),
  notificationTestPreviewTitle: document.getElementById("notificationTestPreviewTitle"),
  notificationTestPreviewBody: document.getElementById("notificationTestPreviewBody"),
  notificationLastTestDetails: document.getElementById("notificationLastTestDetails"),
  notificationLastTestAt: document.getElementById("notificationLastTestAt"),
  notificationLastTestResult: document.getElementById("notificationLastTestResult"),
  languageSelect: document.getElementById("languageSelect"),
  fiveHourOpen: document.getElementById("fiveHourOpen"),
  weeklyOpen: document.getElementById("weeklyOpen"),
  tokensToday: document.getElementById("tokensToday"),
  tokensTotal: document.getElementById("tokensTotal"),
  recordDay: document.getElementById("recordDay"),
  chartTitle: document.getElementById("chartTitle"),
  chartModeToggle: document.getElementById("chartModeToggle"),
  chart: document.getElementById("chart"),
  chartFilterBar: document.getElementById("chartFilterBar"),
  chartLegend: document.getElementById("chartLegend"),
  sourceTotals: document.getElementById("sourceTotals"),
  liveGaugesSection: document.getElementById("liveGaugesSection"),
  liveMetricsUpdated: document.getElementById("liveMetricsUpdated"),
  liveGaugeGrid: document.getElementById("liveGaugeGrid"),
  liveHistoryChart: document.getElementById("liveHistoryChart"),
  liveHistoryLegend: document.getElementById("liveHistoryLegend"),
  tokenList: document.getElementById("tokenList"),
  priceRows: document.getElementById("priceRows"),
  pricingMeta: document.getElementById("pricingMeta"),
  priceSortButtons: Array.from(document.querySelectorAll("[data-price-sort]"))
};

const providerMeta = {
  codex: { name: "Codex", kickerKey: "providers.codex.kicker", accent: "#23745c" },
  codexSpark: { name: "Codex 5.3 Spark", kickerKey: "providers.codexSpark.kicker", accent: "#5b6ee1" },
  copilot: { name: "GitHub Copilot", kickerKey: "providers.copilot.kicker", accent: "#6f42c1" },
  claudeCode: { name: "Claude Code", kickerKey: "providers.claudeCode.kicker", accent: "#d55e00" },
  anthropic: { name: "Anthropic API", kickerKey: "providers.anthropic.kicker", accent: "#8d5d3b" },
  openai: { name: "OpenAI / GPT", kickerKey: "providers.openai.kicker", accent: "#2e6ea6" },
  gemini: { name: "Gemini", kickerKey: "providers.gemini.kicker", accent: "#b94e5c" },
  ollama: { name: "Ollama", kickerKey: "providers.ollama.kicker", accent: "#4f6d2f" }
};

const USD_PER_EUR = 1.1448;
const FX_DATE = "2026-07-03";
const PRICING_DATE = "2026-07-05";
const SCORE_DATE = "2026-07-05";
const MILLION = 1_000_000;
const CHART_TICK_BASES = [1, 2.5, 5, 10];
const PROVIDER_ORDER_STORAGE_KEY = "llmUsage.providerOrder";
const LANGUAGE_OPTIONS = [
  { code: "bg", flag: "🇧🇬", label: "Български", locale: "bg-BG" },
  { code: "cs", flag: "🇨🇿", label: "Čeština", locale: "cs-CZ" },
  { code: "da", flag: "🇩🇰", label: "Dansk", locale: "da-DK" },
  { code: "de", flag: "🇩🇪", label: "Deutsch", locale: "de-DE" },
  { code: "el", flag: "🇬🇷", label: "Ελληνικά", locale: "el-GR" },
  { code: "en", flag: "🇺🇸", label: "English", locale: "en-US" },
  { code: "es", flag: "🇪🇸", label: "Español", locale: "es-ES" },
  { code: "et", flag: "🇪🇪", label: "Eesti", locale: "et-EE" },
  { code: "fi", flag: "🇫🇮", label: "Suomi", locale: "fi-FI" },
  { code: "fr", flag: "🇫🇷", label: "Français", locale: "fr-FR" },
  { code: "ga", flag: "🇮🇪", label: "Gaeilge", locale: "ga-IE" },
  { code: "hr", flag: "🇭🇷", label: "Hrvatski", locale: "hr-HR" },
  { code: "hu", flag: "🇭🇺", label: "Magyar", locale: "hu-HU" },
  { code: "it", flag: "🇮🇹", label: "Italiano", locale: "it-IT" },
  { code: "lt", flag: "🇱🇹", label: "Lietuvių", locale: "lt-LT" },
  { code: "lv", flag: "🇱🇻", label: "Latviešu", locale: "lv-LV" },
  { code: "mt", flag: "🇲🇹", label: "Malti", locale: "mt-MT" },
  { code: "nl", flag: "🇳🇱", label: "Nederlands", locale: "nl-NL" },
  { code: "pl", flag: "🇵🇱", label: "Polski", locale: "pl-PL" },
  { code: "pt", flag: "🇵🇹", label: "Português", locale: "pt-PT" },
  { code: "ro", flag: "🇷🇴", label: "Română", locale: "ro-RO" },
  { code: "sk", flag: "🇸🇰", label: "Slovenčina", locale: "sk-SK" },
  { code: "sl", flag: "🇸🇮", label: "Slovenščina", locale: "sl-SI" },
  { code: "sv", flag: "🇸🇪", label: "Svenska", locale: "sv-SE" },
  { code: "ar", flag: "🇸🇦", label: "العربية", locale: "ar-SA", dir: "rtl" },
  { code: "ru", flag: "🇷🇺", label: "Русский", locale: "ru-RU" },
  { code: "zh", flag: "🇨🇳", label: "中文（简体）", locale: "zh-CN" }
];
const SUPPORTED_LANGUAGES = LANGUAGE_OPTIONS.map((language) => language.code);
const LANGUAGE_META = Object.fromEntries(LANGUAGE_OPTIONS.map((language) => [language.code, language]));
const DEFAULT_LANGUAGE = "en";
const FALLBACK_LANGUAGE = "de";
const LANGUAGE_STORAGE_KEY = "llmUsage.language";
const PROVIDER_FILTER_STORAGE_KEY = "llmUsage.showAllProviders";
const USAGE_POLL_INTERVAL_MS = 60_000;
const SYSTEM_LIVE_POLL_INTERVAL_MS = 5_000;
const UPDATED_STALE_AFTER_MS = 60 * 60 * 1000;
const SETTINGS_AUTOSAVE_DELAY_MS = 500;
const SETTINGS_TOAST_MS = 1800;
const MODAL_BACKDROP_GRACE_MS = 450;
const translationCache = new Map();
const dialogOpenedAt = new WeakMap();
const chartSourceOrder = ["codex", "codexSpark", "copilot", "claudeCode", "ollama", "gemini", "openai", "anthropic", "local"];
const chartSourceColors = {
  codex: providerMeta.codex.accent,
  codexSpark: providerMeta.codexSpark.accent,
  copilot: providerMeta.copilot.accent,
  claudeCode: providerMeta.claudeCode.accent,
  ollama: providerMeta.ollama.accent,
  gemini: providerMeta.gemini.accent,
  openai: providerMeta.openai.accent,
  anthropic: providerMeta.anthropic.accent,
  local: "#23745c"
};
const liveHistorySeries = [
  { id: "cpu", labelKey: "liveMetrics.series.cpu", kind: "percent", color: "#23745c", value: (point) => point.cpuPercent },
  { id: "ram", labelKey: "liveMetrics.series.ram", kind: "percent", color: "#d55e00", value: (point) => point.ramPercent },
  { id: "aiLoad", labelKey: "liveMetrics.series.aiLoad", kind: "percent", color: "#b94e5c", value: (point) => point.aiLoadScore },
  {
    id: "tokensTotal",
    labelKey: "liveMetrics.series.tokensTotal",
    kind: "tokens",
    color: "#2e6ea6",
    value: (point) => point.tokensPerMinute?.total
  },
  {
    id: "tokensInput",
    labelKey: "liveMetrics.series.tokensInput",
    kind: "tokens",
    color: "#6f42c1",
    value: (point) => point.tokensPerMinute?.input
  },
  {
    id: "tokensOutput",
    labelKey: "liveMetrics.series.tokensOutput",
    kind: "tokens",
    color: "#2e6ea6",
    dashed: true,
    value: (point) => point.tokensPerMinute?.output
  },
  {
    id: "tokensCached",
    labelKey: "liveMetrics.series.tokensCached",
    kind: "tokens",
    color: "#66716b",
    dashed: true,
    value: (point) => point.tokensPerMinute?.cached
  }
];
const pricingSortDefaults = {
  model: "asc",
  score: "desc",
  region: "asc",
  input: "asc",
  cache: "asc",
  output: "asc",
  today: "asc",
  total: "asc",
  source: "asc"
};
const pricingExcludedSourceIds = new Set(["copilot"]);
const DIAGNOSTIC_STATUS_ORDER = [
  "connected_live",
  "current_user_empty",
  "candidates_readable_empty",
  "candidates_denied",
  "no_tools_found",
  "other_dashboard_found",
  "partial_unsupported",
  "discovery_error"
];
const DIAGNOSTIC_STATUS_ICONS = {
  connected_live: "plug-zap",
  current_user_empty: "scan-search",
  candidates_readable_empty: "folder-search-2",
  candidates_denied: "shield-alert",
  no_tools_found: "search-x",
  other_dashboard_found: "monitor-smartphone",
  partial_unsupported: "triangle-alert",
  discovery_error: "octagon-alert"
};

const pricingModels = [
  {
    provider: "OpenAI",
    model: "GPT-5.5",
    region: "API/Codex",
    inputUsd: 5,
    cachedInputUsd: 0.5,
    outputUsd: 30,
    source: "OpenAI",
    sourceUrl: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.4",
    region: "API/Codex",
    inputUsd: 2.5,
    cachedInputUsd: 0.25,
    outputUsd: 15,
    source: "OpenAI",
    sourceUrl: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.4 Mini",
    region: "Codex",
    inputUsd: 0.75,
    cachedInputUsd: 0.075,
    outputUsd: 4.5,
    source: "OpenAI Codex",
    sourceUrl: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.3-Codex",
    region: "Codex",
    inputUsd: 1.75,
    cachedInputUsd: 0.175,
    outputUsd: 14,
    source: "OpenAI Codex",
    sourceUrl: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.3-Codex-Spark",
    region: "Codex Spark",
    inputUsd: 1.75,
    cachedInputUsd: 0.175,
    outputUsd: 14,
    source: "OpenAI Codex",
    sourceUrl: "https://openai.com/blog/introducing-gpt-5-3-codex-spark/"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.2",
    region: "Legacy",
    inputUsd: 1.75,
    cachedInputUsd: 0.175,
    outputUsd: 14,
    source: "OpenAI",
    sourceUrl: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "Anthropic",
    model: "Claude Fable 5",
    region: "Global",
    inputUsd: 10,
    cacheWriteUsd: 12.5,
    cachedInputUsd: 1,
    outputUsd: 50,
    source: "Anthropic",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  {
    provider: "Anthropic",
    model: "Claude Opus 4.8",
    region: "Global",
    inputUsd: 5,
    cacheWriteUsd: 6.25,
    cachedInputUsd: 0.5,
    outputUsd: 25,
    source: "Anthropic",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  {
    provider: "Anthropic",
    model: "Claude Sonnet 4.6",
    region: "Global",
    inputUsd: 3,
    cacheWriteUsd: 3.75,
    cachedInputUsd: 0.3,
    outputUsd: 15,
    source: "Anthropic",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  {
    provider: "Anthropic",
    model: "Claude Haiku 4.5",
    region: "Global",
    inputUsd: 1,
    cacheWriteUsd: 1.25,
    cachedInputUsd: 0.1,
    outputUsd: 5,
    source: "Anthropic",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing"
  },
  {
    provider: "MiniMax",
    model: "MiniMax M3",
    region: "<=512k 7d promo",
    inputUsd: 0.3,
    cachedInputUsd: 0.06,
    outputUsd: 1.2,
    source: "MiniMax",
    sourceUrl: "https://platform.minimax.io/docs/guides/pricing-paygo",
    china: true
  },
  {
    provider: "Google",
    model: "Gemini 3.1 Pro Preview",
    region: "<=200k",
    inputUsd: 2,
    cachedInputUsd: 0.2,
    outputUsd: 12,
    source: "Google",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  {
    provider: "Google",
    model: "Gemini 3.5 Flash",
    region: "Standard",
    inputUsd: 1.5,
    cachedInputUsd: 0.15,
    outputUsd: 9,
    source: "Google",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  {
    provider: "Google",
    model: "Gemini 3.1 Flash-Lite",
    region: "Standard",
    inputUsd: 0.25,
    cachedInputUsd: 0.025,
    outputUsd: 1.5,
    source: "Google",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  {
    provider: "DeepSeek",
    model: "DeepSeek V4 Pro",
    region: "API",
    inputUsd: 0.435,
    cachedInputUsd: 0.003625,
    outputUsd: 0.87,
    source: "DeepSeek",
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
    china: true
  },
  {
    provider: "DeepSeek",
    model: "DeepSeek V4 Flash",
    region: "API",
    inputUsd: 0.14,
    cachedInputUsd: 0.0028,
    outputUsd: 0.28,
    source: "DeepSeek",
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
    china: true
  },
  {
    provider: "Alibaba",
    model: "Qwen3-Max",
    region: "Global <=32k",
    inputUsd: 0.359,
    cachedInputUsd: 0.0718,
    outputUsd: 1.434,
    source: "Alibaba",
    sourceUrl: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
    china: true
  },
  {
    provider: "Alibaba",
    model: "Qwen3.5-Plus",
    region: "Global <=128k",
    inputUsd: 0.115,
    cachedInputUsd: 0.023,
    outputUsd: 0.688,
    source: "Alibaba",
    sourceUrl: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-5.2",
    region: "Global",
    inputUsd: 1.4,
    cachedInputUsd: 0.26,
    outputUsd: 4.4,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-5.1",
    region: "Global",
    inputUsd: 1.4,
    cachedInputUsd: 0.26,
    outputUsd: 4.4,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-5",
    region: "Global",
    inputUsd: 1,
    cachedInputUsd: 0.2,
    outputUsd: 3.2,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-5-Turbo",
    region: "Global",
    inputUsd: 1.2,
    cachedInputUsd: 0.24,
    outputUsd: 4,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.7",
    region: "Global",
    inputUsd: 0.6,
    cachedInputUsd: 0.11,
    outputUsd: 2.2,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.7-FlashX",
    region: "Global",
    inputUsd: 0.07,
    cachedInputUsd: 0.01,
    outputUsd: 0.4,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.7-Flash",
    region: "Global free tier",
    inputUsd: 0,
    cachedInputUsd: 0,
    outputUsd: 0,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.6",
    region: "Global",
    inputUsd: 0.6,
    cachedInputUsd: 0.11,
    outputUsd: 2.2,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.5",
    region: "Global",
    inputUsd: 0.6,
    cachedInputUsd: 0.11,
    outputUsd: 2.2,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.5-X",
    region: "Global",
    inputUsd: 2.2,
    cachedInputUsd: 0.45,
    outputUsd: 8.9,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.5-Air",
    region: "Global",
    inputUsd: 0.2,
    cachedInputUsd: 0.03,
    outputUsd: 1.1,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.5-AirX",
    region: "Global",
    inputUsd: 1.1,
    cachedInputUsd: 0.22,
    outputUsd: 4.5,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.5-Flash",
    region: "Global free tier",
    inputUsd: 0,
    cachedInputUsd: 0,
    outputUsd: 0,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4-32B-0414-128K",
    region: "Global",
    inputUsd: 0.1,
    cachedInputUsd: 0.1,
    outputUsd: 0.1,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "StepFun",
    model: "step-3.7-flash",
    region: "API",
    inputUsd: 0.2,
    cachedInputUsd: 0.04,
    outputUsd: 1.15,
    source: "StepFun",
    sourceUrl: "https://platform.stepfun.ai/docs/en/pricing/details",
    china: true
  },
  {
    provider: "StepFun",
    model: "step-3.5-flash",
    region: "API",
    inputUsd: 0.1,
    cachedInputUsd: 0.02,
    outputUsd: 0.3,
    source: "StepFun",
    sourceUrl: "https://platform.stepfun.ai/docs/en/pricing/details",
    china: true
  }
];

const costPricingModelBySource = {
  codex: pricingModels.find((price) => price.model === "GPT-5.3-Codex") || null,
  codexSpark: pricingModels.find((price) => price.model === "GPT-5.3-Codex-Spark") || null,
  claudeCode: pricingModels.find((price) => price.model === "Claude Sonnet 4.6") || null,
  gemini: pricingModels.find((price) => price.model === "Gemini 3.5 Flash") || null
};

const costPricingQualityBySource = {
  codex: "complete",
  codexSpark: "complete",
  claudeCode: "estimated",
  gemini: "estimated"
};

const pricingModelByCanonicalName = new Map(pricingModels.map((price) => [canonicalModelName(price.model), price]));
const pricingModelAliasByCanonicalName = new Map(
  Object.entries({
    "claude-sonnet-4": "Claude Sonnet 4.6",
    "claude-sonnet-4-5": "Claude Sonnet 4.6",
    "claude-opus-4-7": "Claude Opus 4.8",
    "claude-opus-4-6": "Claude Opus 4.8"
  }).map(([alias, model]) => [alias, model])
);

const modelQualityScores = {
  "Claude Fable 5": 100,
  "Claude Opus 4.8": 98,
  "GPT-5.5": 97,
  "GLM-5.2": 95,
  "Gemini 3.1 Pro Preview": 94,
  "GLM-5.1": 93,
  "DeepSeek V4 Pro": 92,
  "MiniMax M3": 88,
  "GPT-5.4": 87,
  "GPT-5.3-Codex": 86,
  "GPT-5.3-Codex-Spark": 85,
  "Claude Sonnet 4.6": 84,
  "Gemini 3.5 Flash": 83,
  "GLM-5-Turbo": 82,
  "GLM-5": 81,
  "GPT-5.2": 80,
  "Qwen3-Max": 79,
  "GPT-5.4 Mini": 77,
  "GLM-4.6": 74,
  "GLM-4.7": 73,
  "GLM-4.5-X": 72,
  "GLM-4.5-AirX": 71,
  "Qwen3.5-Plus": 70,
  "GLM-4.5": 69,
  "step-3.7-flash": 68,
  "DeepSeek V4 Flash": 67,
  "GLM-4.5-Air": 66,
  "Claude Haiku 4.5": 64,
  "Gemini 3.1 Flash-Lite": 62,
  "GLM-4.7-FlashX": 61,
  "step-3.5-flash": 58,
  "GLM-4-32B-0414-128K": 56,
  "GLM-4.7-Flash": 55,
  "GLM-4.5-Flash": 55
};

init();

async function init() {
  await loadLanguage(detectInitialLanguage(), { persist: false, rerender: false });
  loadProviderFilterPreference();
  loadProviderOrderPreference();
  bindEvents();
  refreshIcons();
  await loadAuth();
  await Promise.all([loadUsage({ showIndicator: true }), loadSourceDiagnostics(), loadSystemMetrics()]);
  setInterval(pollUsage, USAGE_POLL_INTERVAL_MS);
  setInterval(pollSystemMetrics, SYSTEM_LIVE_POLL_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      pollUsage();
      pollSystemMetrics();
    }
  });
}

function bindEvents() {
  els.refreshBtn.addEventListener("click", () => loadUsage({ showIndicator: true, force: true }));
  els.loginBtn.addEventListener("click", () => openModalDialog(els.loginDialog));
  els.logoutBtn.addEventListener("click", logout);
  els.settingsBtn.addEventListener("click", openSettings);
  els.layoutEditBtn?.addEventListener("click", toggleLayoutEditMode);
  els.layoutResetBtn?.addEventListener("click", resetProviderOrder);
  els.providerFilterBtn.addEventListener("click", toggleProviderFilter);
  els.settingsCloseBtn.addEventListener("click", () => els.settingsDialog.close());
  els.diagnosticsRecheckBtn?.addEventListener("click", () => recheckSources());
  els.settingsSourcesRecheckBtn?.addEventListener("click", () => recheckSources());
  els.loginDialog.addEventListener("click", closeDialogOnBackdrop);
  els.settingsDialog.addEventListener("click", closeDialogOnBackdrop);
  els.sourceDiagnosticsSection?.addEventListener("click", handleSourceActionClick);
  els.settingsDialog?.addEventListener("click", handleSourceActionClick);
  els.providerGrid?.addEventListener("dragstart", handleProviderDragStart);
  els.providerGrid?.addEventListener("dragover", handleProviderDragOver);
  els.providerGrid?.addEventListener("drop", handleProviderDrop);
  els.providerGrid?.addEventListener("dragend", endProviderDrag);
  els.providerGrid?.addEventListener("pointerdown", handleProviderPointerDown);
  els.providerGrid?.addEventListener("pointermove", handleProviderPointerMove);
  els.providerGrid?.addEventListener("pointerup", handleProviderPointerUp);
  els.providerGrid?.addEventListener("pointercancel", cancelProviderPointerDrag);
  els.providerGrid?.addEventListener("keydown", handleProviderKeyboardReorder);
  els.liveHistoryLegend?.addEventListener("click", handleLiveHistoryLegendToggle);
  els.liveHistoryLegend?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const button = event.target.closest("[data-live-series]");
    if (!button) return;
    event.preventDefault();
    handleLiveHistoryLegendToggle(event);
  });
  els.subscriptionFields.forEach((field) => {
    field.addEventListener("input", () => scheduleSettingsAutosave("subscriptions"));
  });
  [els.updateChecksEnabled, els.allowPrereleaseUpdates].forEach((field) => {
    field?.addEventListener("change", () => scheduleSettingsAutosave("updates"));
  });
  els.updateCheckBtn?.addEventListener("click", requestUpdateCheck);
  els.notificationsEnabled?.addEventListener("change", () => {
    onNotificationEnabledChange();
    scheduleSettingsAutosave("notifications");
  });
  [els.notificationPacingPercent, els.notificationHardLimitPercent].forEach((field) => {
    field?.addEventListener("input", () => scheduleSettingsAutosave("notifications"));
  });
  els.notificationSettingsBtn?.addEventListener("click", openNotificationSettings);
  els.notificationTestBtn?.addEventListener("click", sendTestNotification);
  els.languageSelect?.addEventListener("change", () => setLanguage(els.languageSelect.value));
  els.priceSortButtons.forEach((button) => {
    button.addEventListener("click", () => sortPricing(button.dataset.priceSort));
  });
  els.loginForm.addEventListener("submit", login);
  els.appShell.addEventListener("click", (e) => {
    const modeBtn = e.target.closest("[data-chart-mode]");
    if (modeBtn) {
      state.chartMode = modeBtn.dataset.chartMode === "costs" ? "costs" : "tokens";
      state.chartScrollToLatest = true;
      if (state.usage) render();
      return;
    }
    const btn = e.target.closest("[data-chart-filter]");
    if (!btn) return;
    state.chartTimeFilter = btn.dataset.chartFilter;
    state.chartScrollToLatest = true;
    if (state.usage) render();
  });
}

async function setLanguage(language) {
  await loadLanguage(language);
}

async function loadLanguage(language, { persist = true, rerender = true } = {}) {
  const normalized = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  const fallback = await fetchTranslations(FALLBACK_LANGUAGE);
  let translations = fallback;
  let nextLanguage = normalized;
  if (normalized !== FALLBACK_LANGUAGE) {
    try {
      translations = await fetchTranslations(normalized);
    } catch {
      nextLanguage = FALLBACK_LANGUAGE;
    }
  }

  state.language = nextLanguage;
  state.translations = translations;
  state.fallbackTranslations = fallback;

  if (persist) {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
    } catch {
      // Keep the selected language for this session if storage is unavailable.
    }
  }

  applyStaticTranslations();
  if (rerender) rerenderLanguageSensitiveViews();
}

async function fetchTranslations(language) {
  if (translationCache.has(language)) return translationCache.get(language);
  const response = await fetch(`/i18n/${language}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${language} translations`);
  const translations = await response.json();
  translationCache.set(language, translations);
  return translations;
}

function detectInitialLanguage() {
  try {
    const stored = normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // Fall back to the browser language below.
  }

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const language of languages) {
    const normalized = normalizeLanguage(language);
    if (normalized) return normalized;
  }
  return DEFAULT_LANGUAGE;
}

function normalizeLanguage(language) {
  const base = String(language || "").trim().toLowerCase().split("-")[0];
  return SUPPORTED_LANGUAGES.includes(base) ? base : null;
}

function applyStaticTranslations() {
  document.documentElement.lang = state.language;
  document.documentElement.dir = LANGUAGE_META[state.language]?.dir || "ltr";
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n, {}, element.textContent);
  });
  const translatedAttributes = [
    ["data-i18n-aria-label", "aria-label"],
    ["data-i18n-title", "title"],
    ["data-i18n-placeholder", "placeholder"]
  ];
  for (const [dataAttribute, attribute] of translatedAttributes) {
    document.querySelectorAll(`[${dataAttribute}]`).forEach((element) => {
      element.setAttribute(attribute, t(element.getAttribute(dataAttribute), {}, element.getAttribute(attribute) || ""));
    });
  }
  renderLanguageOptions();
}

function renderLanguageOptions() {
  if (!els.languageSelect) return;
  els.languageSelect.innerHTML = LANGUAGE_OPTIONS.map((language) => {
    return `<option value="${escapeHtml(language.code)}">${escapeHtml(`${language.flag} ${language.label}`)}</option>`;
  }).join("");
  els.languageSelect.value = state.language;
}

function rerenderLanguageSensitiveViews() {
  renderAuth();
  if (state.usage) {
    render();
  } else if (state.auth && !state.auth.authenticated) {
    renderLocked();
  } else {
    updateProviderFilterControl([], []);
    updateLayoutControls([], []);
    renderSourceDiagnostics();
    renderLiveGauges(state.systemMetrics);
    renderSourceSettings();
  }
  refreshIcons();
}

function t(key, values = {}, fallback = key) {
  const template = getPath(state.translations, key) ?? getPath(state.fallbackTranslations, key) ?? fallback;
  return interpolate(String(template), values);
}

function interpolate(template, values) {
  return template.replaceAll(/\{(\w+)\}/g, (_match, name) => values[name] ?? "");
}

function sortPricing(key) {
  const current = state.pricingSort;
  const direction =
    current?.key === key
      ? current.direction === "asc"
        ? "desc"
        : "asc"
      : pricingSortDefaults[key] || "asc";
  state.pricingSort = { key, direction };
  if (state.usage) renderPricing(state.usage.local);
}

function loadProviderFilterPreference() {
  try {
    state.showAllProviders = localStorage.getItem(PROVIDER_FILTER_STORAGE_KEY) === "true";
  } catch {
    state.showAllProviders = false;
  }
}

function loadProviderOrderPreference() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROVIDER_ORDER_STORAGE_KEY) || "[]");
    state.providerOrder = Array.isArray(saved) ? saved.map(String).filter(Boolean) : [];
  } catch {
    state.providerOrder = [];
  }
}

function toggleProviderFilter() {
  state.showAllProviders = !state.showAllProviders;
  try {
    localStorage.setItem(PROVIDER_FILTER_STORAGE_KEY, String(state.showAllProviders));
  } catch {
    // Ignore storage failures; the toggle should still work for this session.
  }
  if (state.usage) render();
}

function toggleLayoutEditMode() {
  state.layoutEditMode = !state.layoutEditMode;
  state.keyboardDragProviderId = null;
  state.keyboardOriginalProviderOrder = null;
  clearProviderDropTarget();
  removeProviderDragGhost();
  if (state.usage) render();
  else updateLayoutControls([], []);
}

function resetProviderOrder() {
  const providers = state.usage ? buildProviders(state.usage) : [];
  state.keyboardDragProviderId = null;
  state.keyboardOriginalProviderOrder = null;
  state.providerOrder = providers.map((provider) => provider.id);
  saveProviderOrder();
  announceLayoutChange(t("layout.resetDone"));
  if (state.usage) render();
}

function normalizeProviderOrder(order, providerIds) {
  const validIds = new Set(providerIds);
  const normalized = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (validIds.has(id) && !normalized.includes(id)) normalized.push(id);
  }
  for (const id of providerIds) {
    if (!normalized.includes(id)) normalized.push(id);
  }
  return normalized;
}

function saveProviderOrder() {
  try {
    localStorage.setItem(PROVIDER_ORDER_STORAGE_KEY, JSON.stringify(state.providerOrder));
  } catch {
    // Keep the edited order for this session if storage is unavailable.
  }
}

function applyProviderOrder(nextOrder) {
  const providerIds = state.usage ? buildProviders(state.usage).map((provider) => provider.id) : [];
  state.providerOrder = normalizeProviderOrder(nextOrder, providerIds);
  saveProviderOrder();
}

function orderProviders(providers) {
  const providerIds = providers.map((provider) => provider.id);
  const normalizedOrder = normalizeProviderOrder(state.providerOrder, providerIds);
  state.providerOrder = normalizedOrder;
  const indexById = new Map(normalizedOrder.map((id, index) => [id, index]));
  return providers.slice().sort((a, b) => (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0));
}

function currentVisibleProviderIds() {
  if (!state.usage) return [];
  const providers = orderProviders(buildProviders(state.usage));
  return (state.showAllProviders ? providers : providers.filter(providerHasUsage)).map((provider) => provider.id);
}

function moveProviderRelativeToTarget(draggedId, targetId, afterTarget = false) {
  if (!state.usage || draggedId === targetId) return false;
  const providerIds = buildProviders(state.usage).map((provider) => provider.id);
  const nextOrder = normalizeProviderOrder(state.providerOrder, providerIds);
  const fromIndex = nextOrder.indexOf(draggedId);
  const targetIndex = nextOrder.indexOf(targetId);
  if (fromIndex === -1 || targetIndex === -1) return false;
  let insertIndex = targetIndex + (afterTarget ? 1 : 0);
  nextOrder.splice(fromIndex, 1);
  if (fromIndex < insertIndex) insertIndex -= 1;
  nextOrder.splice(Math.max(0, Math.min(insertIndex, nextOrder.length)), 0, draggedId);
  applyProviderOrder(nextOrder);
  return true;
}

function moveProviderByVisibleDelta(providerId, delta) {
  const visibleIds = currentVisibleProviderIds();
  const fromIndex = visibleIds.indexOf(providerId);
  const toIndex = fromIndex + delta;
  if (fromIndex === -1 || toIndex < 0 || toIndex >= visibleIds.length) return false;
  return moveProviderRelativeToTarget(providerId, visibleIds[toIndex], delta > 0);
}

function providerCardFromEvent(event) {
  return event.target?.closest?.(".provider-card[data-provider-id]");
}

function providerHandleFromEvent(event) {
  return event.target?.closest?.("[data-provider-drag-handle]");
}

function providerName(providerId) {
  if (!state.usage) return providerId;
  return buildProviders(state.usage).find((provider) => provider.id === providerId)?.name || providerId;
}

function providerPosition(providerId) {
  const visibleIds = currentVisibleProviderIds();
  const index = visibleIds.indexOf(providerId);
  return { position: index + 1, total: visibleIds.length };
}

function announceProviderMove(providerId, key = "layout.moved") {
  const { position, total } = providerPosition(providerId);
  announceLayoutChange(t(key, { name: providerName(providerId), position, total }));
}

function announceLayoutChange(message) {
  if (!els.layoutLiveRegion) return;
  els.layoutLiveRegion.textContent = "";
  window.requestAnimationFrame(() => {
    els.layoutLiveRegion.textContent = message;
  });
}

function focusProviderHandle(providerId) {
  window.requestAnimationFrame(() => {
    const selector = `[data-provider-drag-handle][data-provider-id="${escapeSelectorValue(providerId)}"]`;
    els.providerGrid?.querySelector(selector)?.focus();
  });
}

function escapeSelectorValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function handleProviderDragStart(event) {
  if (!state.layoutEditMode) return;
  const handle = providerHandleFromEvent(event);
  const card = providerCardFromEvent(event);
  if (!handle || !card) {
    event.preventDefault();
    return;
  }
  state.draggingProviderId = card.dataset.providerId;
  card.classList.add("is-dragging");
  try {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", state.draggingProviderId);
  } catch {
    // Drag data is advisory; state.draggingProviderId is the source of truth.
  }
}

function handleProviderDragOver(event) {
  if (!state.layoutEditMode || !state.draggingProviderId) return;
  const card = providerCardFromEvent(event);
  if (!card || card.dataset.providerId === state.draggingProviderId) {
    clearProviderDropTarget();
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const placement = resolveDropPlacement(card, event.clientX, event.clientY);
  setProviderDropTarget(card, placement.after);
}

function handleProviderDrop(event) {
  if (!state.layoutEditMode) return;
  const card = providerCardFromEvent(event);
  const draggedId = state.draggingProviderId || event.dataTransfer?.getData("text/plain");
  if (!card || !draggedId || card.dataset.providerId === draggedId) {
    endProviderDrag();
    return;
  }
  event.preventDefault();
  const placement = resolveDropPlacement(card, event.clientX, event.clientY);
  const moved = moveProviderRelativeToTarget(draggedId, card.dataset.providerId, placement.after);
  endProviderDrag();
  if (moved) {
    render();
    announceProviderMove(draggedId, "layout.dropped");
    focusProviderHandle(draggedId);
  }
}

function endProviderDrag() {
  state.draggingProviderId = null;
  els.providerGrid?.querySelectorAll(".is-dragging").forEach((card) => card.classList.remove("is-dragging"));
  clearProviderDropTarget();
}

function resolveDropPlacement(card, clientX, clientY) {
  const rect = card.getBoundingClientRect();
  const horizontal = rect.width > rect.height * 1.15;
  const after = horizontal ? clientX > rect.left + rect.width / 2 : clientY > rect.top + rect.height / 2;
  return { after };
}

function setProviderDropTarget(card, after) {
  clearProviderDropTarget(card);
  card.classList.add("is-drop-target", after ? "is-drop-after" : "is-drop-before");
}

function clearProviderDropTarget(exceptCard = null) {
  els.providerGrid?.querySelectorAll(".is-drop-target").forEach((card) => {
    if (card === exceptCard) return;
    card.classList.remove("is-drop-target", "is-drop-before", "is-drop-after");
  });
}

function handleProviderPointerDown(event) {
  if (!state.layoutEditMode) return;
  const handle = providerHandleFromEvent(event);
  const card = providerCardFromEvent(event);
  if (!handle || !card) return;
  if (event.pointerType !== "mouse") event.preventDefault();
  state.pointerDrag = {
    id: card.dataset.providerId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    targetId: null,
    after: false,
    active: false,
    handle
  };
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is best effort; document.elementFromPoint still drives the drop target.
  }
}

function handleProviderPointerMove(event) {
  const drag = state.pointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.active && Math.hypot(dx, dy) < 6) return;
  event.preventDefault();
  if (!drag.active) {
    drag.active = true;
    createProviderDragGhost(drag.id, event.clientX, event.clientY);
    const sourceCard = providerCardById(drag.id);
    sourceCard?.classList.add("is-dragging");
  }
  moveProviderDragGhost(event.clientX, event.clientY);
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".provider-card[data-provider-id]");
  if (!target || target.dataset.providerId === drag.id) {
    clearProviderDropTarget();
    drag.targetId = null;
    return;
  }
  const placement = resolveDropPlacement(target, event.clientX, event.clientY);
  drag.targetId = target.dataset.providerId;
  drag.after = placement.after;
  setProviderDropTarget(target, placement.after);
}

function handleProviderPointerUp(event) {
  const drag = state.pointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const moved = drag.active && drag.targetId ? moveProviderRelativeToTarget(drag.id, drag.targetId, drag.after) : false;
  cleanupProviderPointerDrag();
  if (moved) {
    render();
    announceProviderMove(drag.id, "layout.dropped");
    focusProviderHandle(drag.id);
  }
}

function cancelProviderPointerDrag(event) {
  if (event && state.pointerDrag?.pointerId !== event.pointerId) return;
  cleanupProviderPointerDrag();
}

function cleanupProviderPointerDrag() {
  removeProviderDragGhost();
  state.pointerDrag = null;
  endProviderDrag();
}

function providerCardById(providerId) {
  const selector = `.provider-card[data-provider-id="${escapeSelectorValue(providerId)}"]`;
  return els.providerGrid?.querySelector(selector);
}

function createProviderDragGhost(providerId, clientX, clientY) {
  removeProviderDragGhost();
  const card = providerCardById(providerId);
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add("provider-drag-ghost");
  ghost.style.width = `${rect.width}px`;
  document.body.appendChild(ghost);
  state.pointerDrag.ghost = ghost;
  moveProviderDragGhost(clientX, clientY);
}

function moveProviderDragGhost(clientX, clientY) {
  const ghost = state.pointerDrag?.ghost;
  if (!ghost) return;
  ghost.style.transform = `translate(${clientX + 12}px, ${clientY + 12}px)`;
}

function removeProviderDragGhost() {
  if (!state.pointerDrag?.ghost) return;
  state.pointerDrag.ghost.remove();
  state.pointerDrag.ghost = null;
}

function handleProviderKeyboardReorder(event) {
  if (!state.layoutEditMode) return;
  const handle = providerHandleFromEvent(event);
  if (!handle) return;
  const providerId = handle.dataset.providerId;
  const isGrabbed = state.keyboardDragProviderId === providerId;

  if (!isGrabbed && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    state.keyboardDragProviderId = providerId;
    state.keyboardOriginalProviderOrder = state.providerOrder.slice();
    announceProviderMove(providerId, "layout.grabbed");
    render();
    focusProviderHandle(providerId);
    return;
  }

  if (!isGrabbed) return;

  if (event.key === "Escape") {
    event.preventDefault();
    if (state.keyboardOriginalProviderOrder) applyProviderOrder(state.keyboardOriginalProviderOrder);
    state.keyboardDragProviderId = null;
    state.keyboardOriginalProviderOrder = null;
    announceLayoutChange(t("layout.cancelled"));
    render();
    focusProviderHandle(providerId);
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    state.keyboardDragProviderId = null;
    state.keyboardOriginalProviderOrder = null;
    announceProviderMove(providerId, "layout.dropped");
    render();
    focusProviderHandle(providerId);
    return;
  }

  const direction = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : 0;
  if (!direction) return;
  event.preventDefault();
  const moved = moveProviderByVisibleDelta(providerId, direction);
  if (moved) {
    announceProviderMove(providerId);
    render();
    focusProviderHandle(providerId);
  }
}

async function loadAuth() {
  state.auth = await fetchJson("/api/auth/me");
  renderAuth();
}

async function loadSourceDiagnostics() {
  if (state.loadingSourceDiagnostics) return state.sourceDiagnostics;
  if (state.auth && !state.auth.authenticated) {
    state.sourceDiagnostics = null;
    state.sourceDiagnosticsError = "";
    renderSourceDiagnostics();
    renderSourceSettings();
    return null;
  }

  state.loadingSourceDiagnostics = true;
  try {
    state.sourceDiagnostics = await fetchJson(`/api/sources/diagnostics?ts=${Date.now()}`);
    state.sourceDiagnosticsError = "";
    renderSourceDiagnostics();
    renderSourceSettings();
    return state.sourceDiagnostics;
  } catch (error) {
    if (error.status === 401) {
      await loadAuth();
      state.sourceDiagnostics = null;
      state.sourceDiagnosticsError = "";
    } else {
      state.sourceDiagnosticsError = error.message || t("diagnostics.errors.load");
    }
    renderSourceDiagnostics();
    renderSourceSettings();
    return null;
  } finally {
    state.loadingSourceDiagnostics = false;
  }
}

async function loadSystemMetrics() {
  if (state.loadingSystemMetrics) return state.systemMetrics;
  if (state.auth && !state.auth.authenticated) {
    state.systemMetrics = null;
    state.systemMetricsError = "";
    renderLiveGauges(null);
    return null;
  }

  state.loadingSystemMetrics = true;
  try {
    state.systemMetrics = await fetchJson(`/api/system/live?ts=${Date.now()}`);
    state.systemMetricsError = "";
    renderLiveGauges(state.systemMetrics);
    return state.systemMetrics;
  } catch (error) {
    if (error.status === 401) {
      await loadAuth();
      state.systemMetricsError = "";
    } else {
      state.systemMetricsError = error.message || t("liveMetrics.errors.load");
    }
    state.systemMetrics = null;
    renderLiveGauges(null);
    return null;
  } finally {
    state.loadingSystemMetrics = false;
  }
}

function renderAuth() {
  const authed = state.auth?.authenticated;
  els.loginBtn.hidden = authed;
  els.logoutBtn.hidden = !authed || !state.auth?.protected;
  els.oidcLink.hidden = !state.auth?.methods?.oidc;
}

async function login(event) {
  event.preventDefault();
  els.loginError.textContent = "";
  try {
    await fetchJson("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: els.passwordInput.value })
    });
    els.loginDialog.close();
    els.passwordInput.value = "";
    await loadAuth();
    await Promise.all([loadUsage(), loadSourceDiagnostics(), loadSystemMetrics()]);
  } catch {
    els.loginError.textContent = t("auth.loginFailed");
  }
}

async function logout() {
  await fetchJson("/api/auth/logout", { method: "POST" });
  await loadAuth();
  renderLocked();
}

async function pollUsage() {
  if (document.hidden) return;
  await loadUsage();
}

async function pollSystemMetrics() {
  if (document.hidden) return;
  await loadSystemMetrics();
}

async function loadUsage({ showIndicator = false, force = false } = {}) {
  if (state.loadingUsage) {
    if (force) {
      state.queuedUsageForce = true;
      state.queuedUsageIndicator ||= showIndicator;
    }
    if (showIndicator) {
      state.refreshIndicator = true;
      setRefreshIndicator(true);
    }
    return;
  }
  if (state.auth && !state.auth.authenticated) {
    renderLocked();
    return;
  }
  setUsageLoading(true, showIndicator);
  try {
    const params = new URLSearchParams({ ts: String(Date.now()) });
    if (force) params.set("force", "1");
    const [usage, subscriptionHistory] = await Promise.all([
      fetchJson(`/api/usage?${params.toString()}`),
      fetchJson("/api/subscription-history").catch((error) => {
        if (error.status === 401) throw error;
        return { version: 1, entries: [] };
      })
    ]);
    state.usage = usage;
    state.subscriptionHistory = subscriptionHistory;
    render();
  } catch (error) {
    if (error.status === 401) {
      await loadAuth();
      renderLocked();
      return;
    }
    els.providerGrid.innerHTML = `<article class="provider-card"><h2>${escapeHtml(t("errors.loadUsage"))}</h2><p>${escapeHtml(error.message)}</p></article>`;
  } finally {
    setUsageLoading(false);
    if (state.queuedUsageForce) {
      const shouldRunQueuedUsage = !state.auth || state.auth.authenticated;
      const queuedShowIndicator = state.queuedUsageIndicator;
      state.queuedUsageForce = false;
      state.queuedUsageIndicator = false;
      if (shouldRunQueuedUsage) {
        await loadUsage({ showIndicator: queuedShowIndicator, force: true });
      }
    }
  }
}

function setUsageLoading(isLoading, showIndicator = false) {
  state.loadingUsage = isLoading;
  if (isLoading && showIndicator) state.refreshIndicator = true;
  if (!isLoading) state.refreshIndicator = false;
  setRefreshIndicator(state.refreshIndicator);
  const isInitialLoad = isLoading && state.usage === null;
  els.appShell.toggleAttribute("data-loading", isInitialLoad);
  if (isInitialLoad) renderSkeletonProviderGrid();
}

function setRefreshIndicator(isLoading) {
  els.refreshBtn.disabled = isLoading;
  els.refreshBtn.classList.toggle("is-loading", isLoading);
  els.refreshBtn.toggleAttribute("aria-busy", isLoading);
}

function renderSkeletonProviderGrid() {
  const card = `
    <div class="provider-card-skeleton">
      <div class="sk-head">
        <div>
          <div class="skeleton-block sk-eyebrow"></div>
          <div class="skeleton-block sk-name"></div>
        </div>
        <div class="skeleton-block sk-pill"></div>
      </div>
      <div class="sk-rings">
        <div class="skeleton-block sk-ring"></div>
        <div class="skeleton-block sk-ring"></div>
      </div>
      <div class="sk-foot">
        <div class="skeleton-block sk-foot-item"></div>
        <div class="skeleton-block sk-foot-item"></div>
      </div>
    </div>`;
  els.providerGrid.innerHTML = card.repeat(4);
}

function renderLocked() {
  state.sourceDiagnostics = null;
  state.sourceDiagnosticsError = "";
  els.providerGrid.innerHTML = "";
  els.fiveHourOpen.textContent = "--";
  els.weeklyOpen.textContent = "--";
  els.tokensToday.textContent = "--";
  els.tokensTotal.textContent = "--";
  els.recordDay.textContent = "";
  els.recordDay.hidden = true;
  if (els.chartTitle) els.chartTitle.textContent = t("chart.heading");
  if (els.chartModeToggle) els.chartModeToggle.innerHTML = "";
  els.chart.innerHTML = "";
  els.chartLegend.innerHTML = "";
  els.chartFilterBar.innerHTML = "";
  els.sourceTotals.textContent = "--";
  renderLiveGauges(null);
  els.tokenList.innerHTML = "";
  els.priceRows.innerHTML = "";
  els.pricingMeta.textContent = "--";
  state.chartRendered = false;
  state.layoutEditMode = false;
  els.providerGrid.classList.remove("layout-edit-mode");
  updateProviderFilterControl([], []);
  updateLayoutControls([], []);
  renderSourceDiagnostics();
  renderSourceSettings();
}

function render() {
  const usage = state.usage;
  const providers = orderProviders(buildProviders(usage));
  const visibleProviders = state.showAllProviders ? providers : providers.filter(providerHasUsage);

  els.providerGrid.classList.toggle("layout-edit-mode", state.layoutEditMode);
  els.providerGrid.setAttribute("role", visibleProviders.length ? "list" : "group");
  els.providerGrid.innerHTML = visibleProviders.length
    ? visibleProviders.map((provider, index) => renderProvider(provider, index, visibleProviders.length)).join("")
    : renderNoActiveProviders();
  updateProviderFilterControl(providers, visibleProviders);
  updateLayoutControls(providers, visibleProviders);
  renderSummary(visibleProviders, usage.local);
  const allDaily = usage.local?.daily || [];
  syncChartTimeFilter(allDaily);
  const filteredDaily = filterDailyByRange(allDaily, state.chartTimeFilter);
  if (els.chartTitle) {
    els.chartTitle.textContent = state.chartMode === "costs" ? t("chart.headingCosts") : t("chart.heading");
  }
  if (els.chartModeToggle) {
    els.chartModeToggle.innerHTML = renderChartModeToggle();
  }
  els.chartFilterBar.innerHTML = renderChartFilterBar(allDaily);
  if (state.chartMode === "costs") {
    renderCostChart(filteredDaily);
    els.sourceTotals.innerHTML = renderCostSummary(filteredDaily, state.subscriptionHistory);
  } else {
    renderChart(filteredDaily);
    els.sourceTotals.innerHTML = renderSourceTotalBars(filteredDaily);
  }
  renderTokenList(usage.local?.totals?.allTime);
  renderLiveGauges(state.systemMetrics);
  renderPricing(usage.local);
  renderSourceDiagnostics();
  renderSourceSettings();
  refreshIcons();
}

function buildProviders(usage) {
  return [
    normalizeLocalProvider("claudeCode", usage.claudeCode),
    normalizeApiProvider("anthropic", usage.anthropic),
    normalizeCodexProvider(usage.codex),
    normalizeCodexSparkProvider(usage.codex?.spark, usage.codex?.subscription),
    normalizeLocalProvider("copilot", usage.copilot),
    normalizeLocalProvider("ollama", usage.ollama),
    normalizeApiProvider("openai", usage.openai),
    normalizeLocalProvider("gemini", usage.gemini)
  ];
}

function renderChartModeToggle() {
  return ["tokens", "costs"]
    .map((mode) => {
      const active = state.chartMode === mode;
      return `
        <button type="button" class="chart-mode-btn${active ? " active" : ""}" data-chart-mode="${mode}" aria-pressed="${active}">
          ${escapeHtml(t(`chart.mode.${mode}`))}
        </button>
      `;
    })
    .join("");
}

function renderSourceTotalBars(daily) {
  const sources = sourceTotalsForDaily(daily);
  if (!sources.length) return "--";
  const max = Math.max(...sources.map((source) => source.totalTokens), 1);
  const total = sources.reduce((sum, source) => sum + source.totalTokens, 0);
  return `
    <div class="source-bars-title">
      <span>${escapeHtml(t("chart.sourceTotalTitle"))}</span>
      <strong>${formatTokens(total)}</strong>
    </div>
    ${sources
      .map((source) => {
        const share = total ? (source.totalTokens / total) * 100 : 0;
        const width = Math.max(0.8, (source.totalTokens / max) * 100);
        return `
          <div class="source-bar-row" title="${escapeHtml(`${sourceLabel(source.id)} · ${formatTokens(source.totalTokens)} · ${formatSharePercent(share)}`)}">
            <span class="source-bar-name">${escapeHtml(sourceLabel(source.id))}</span>
            <span class="source-bar-track" aria-hidden="true">
              <span class="source-bar-fill" style="--bar-width: ${width}; --accent: ${chartSourceColor(source.id)}"></span>
            </span>
            <span class="source-bar-value">${formatTokens(source.totalTokens)}</span>
          </div>
        `;
      })
      .join("")}
  `;
}

function sourceTotalsForDaily(daily) {
  const totals = new Map();
  for (const day of Array.isArray(daily) ? daily : []) {
    const sources = Array.isArray(day.sources) ? day.sources : [];
    if (!sources.length && Number(day.totalTokens || 0) > 0) {
      totals.set("local", Number(totals.get("local") || 0) + Number(day.totalTokens || 0));
    }
    for (const source of sources) {
      const totalTokens = Number(source.totalTokens || 0);
      if (!totalTokens) continue;
      totals.set(source.id, Number(totals.get(source.id) || 0) + totalTokens);
    }
  }
  const sources = Array.from(totals.entries()).map(([id, totalTokens]) => ({ id, totalTokens }));
  if (sources.length) return sortSourceTotals(sources);
  return [];
}

function sortSourceTotals(sources) {
  return [...sources].sort((a, b) => {
    if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
    const left = chartSourceOrder.indexOf(a.id);
    const right = chartSourceOrder.indexOf(b.id);
    return (left === -1 ? Number.MAX_SAFE_INTEGER : left) - (right === -1 ? Number.MAX_SAFE_INTEGER : right);
  });
}

function normalizeCodexProvider(codex) {
  const meta = providerMeta.codex;
  const last24hTokens = subtractTokenTotals(codex?.totals?.last24h, codex?.spark?.totals?.last24h);
  const allTimeTokens = subtractTokenTotals(codex?.totals?.allTime, codex?.spark?.totals?.allTime);
  const limitRows = normalizeLimitRows(codex?.limits);
  const limitUpdatedAt = codex?.liveRateLimits?.updatedAt || codex?.latest?.timestamp;
  const creditRows = normalizeCreditRows(codex?.creditRows, codex?.credits);
  const subscription = normalizeSubscription(codex?.subscription);
  const foot = buildQuotaFoot({
    providerId: "codex",
    todayTokens: last24hTokens,
    since: codex?.first?.timestamp,
    fiveHour: codex?.limits?.fiveHour,
    weekly: codex?.limits?.weekly,
    updated: limitUpdatedAt
  });
  insertSubscriptionFoot(foot, subscription);
  return {
    id: "codex",
    name: meta.name,
    kicker: providerKicker("codex"),
    accent: meta.accent,
    status: codex?.status || "empty",
    fiveHour: codex?.limits?.fiveHour || null,
    weekly: codex?.limits?.weekly || null,
    limitRows,
    limitAlert: buildLimitFullAlert({ limitRows, totals: codex?.totals }),
    creditRows,
    planType: codex?.planType || codex?.latest?.planType || null,
    primaryLabel: t("limits.fiveHour"),
    secondaryLabel: t("limits.weekly"),
    todayTokens: last24hTokens,
    allTimeTokens,
    subscription,
    foot
  };
}

function subtractTokenTotals(total, subset) {
  return Math.max(0, Number(total?.totalTokens || 0) - Number(subset?.totalTokens || 0));
}

function normalizeCodexSparkProvider(spark, codexSubscription) {
  const meta = providerMeta.codexSpark;
  const limitRows = normalizeLimitRows(spark?.limits);
  const limitUpdatedAt = spark?.limitsUpdatedAt || spark?.latest?.timestamp;
  const subscription = normalizeSubscription(codexSubscription);
  return {
    id: "codexSpark",
    name: meta.name,
    kicker: providerKicker("codexSpark"),
    accent: meta.accent,
    status: spark?.status || "empty",
    fiveHour: spark?.limits?.fiveHour || null,
    weekly: spark?.limits?.weekly || null,
    limitRows,
    limitAlert: buildLimitFullAlert({ limitRows, totals: spark?.totals }),
    creditRows: [],
    planType: subscription?.planType || spark?.planType || null,
    primaryLabel: t("limits.fiveHour"),
    secondaryLabel: t("limits.weekly"),
    todayTokens: spark?.totals?.last24h?.totalTokens,
    allTimeTokens: spark?.totals?.allTime?.totalTokens,
    apiTokens: spark?.totals?.last24h?.totalTokens,
    message: localizeProviderMessage(spark?.message, "providers.messages.sparkTokens24h"),
    foot: buildQuotaFoot({
      providerId: "codexSpark",
      todayTokens: spark?.totals?.last24h?.totalTokens,
      since: spark?.first?.timestamp,
      fiveHour: spark?.limits?.fiveHour,
      weekly: spark?.limits?.weekly,
      updated: limitUpdatedAt
    })
  };
}

function buildQuotaFoot({ providerId, todayTokens, since, fiveHour, weekly, updated }) {
  const rows = [
    footRow(t("labels.last24h"), formatTokens(todayTokens)),
    footRow(t("labels.since"), formatDate(since))
  ];
  if (fiveHour) rows.push(footRow(t("labels.fiveHourLeft"), formatLimitRemainingPercent(fiveHour)));
  if (weekly) rows.push(footRow(t("labels.weekLeft"), formatLimitRemainingPercent(weekly)));
  rows.push(
    footRow(t("labels.updated"), formatUpdatedAt(updated), {
      hint: updatedDelayHint(providerId, updated),
      title: updated ? formatUpdatedAtFull(updated) : null
    })
  );
  return rows;
}

function insertSubscriptionFoot(rows, subscription) {
  if (!subscription?.monthlyCost) return;
  const index = Math.max(rows.length - 1, 0);
  rows.splice(index, 0, footRow(t("labels.subscription"), formatMonthlyCost(subscription)));
}

function footRow(label, value, options = {}) {
  return { label, value, ...options };
}

function normalizeSubscription(subscription) {
  if (!subscription || typeof subscription !== "object") return null;
  const monthlyCost = Number(subscription.monthlyCost || 0);
  const planType = String(subscription.planType || "").trim();
  if (!planType && !(monthlyCost > 0)) return null;
  return {
    planType: planType || null,
    monthlyCost: monthlyCost > 0 ? monthlyCost : 0,
    currency: subscription.currency || "EUR"
  };
}

function normalizeLocalProvider(id, provider) {
  const meta = providerMeta[id];
  const hasLimits = Boolean(provider?.limits?.fiveHour || provider?.limits?.weekly);
  const limitRows = normalizeLimitRows(provider?.limits);
  const hasLimitData = hasLimits || Boolean(limitRows.length);
  const creditRows = normalizeCreditRows(provider?.creditRows, provider?.credits);
  const planType = provider?.planType || provider?.plan || null;
  const subscription = normalizeSubscription(provider?.subscription);
  const limitsUpdatedAt =
    id === "claudeCode" ? provider?.limitsUpdatedAt : id === "copilot" && hasLimitData ? provider?.quotaStatus?.updatedAt : null;
  const updatedAt = limitsUpdatedAt || provider?.latest?.timestamp;
  const foot = buildQuotaFoot({
    providerId: id,
    todayTokens: provider?.totals?.last24h?.totalTokens,
    since: provider?.first?.timestamp,
    fiveHour: provider?.limits?.fiveHour,
    weekly: provider?.limits?.weekly,
    updated: updatedAt
  });
  insertSubscriptionFoot(foot, subscription);
  const limitUsageFootRows = id === "copilot" ? copilotLimitUsageFootRows(provider, limitRows) : [];
  if (limitUsageFootRows.length) foot.splice(Math.max(foot.length - 1, 0), 0, ...limitUsageFootRows);
  const limitAlert = buildLimitFullAlert({
    limitRows,
    totals: provider?.totals,
    usageUnits: provider?.usageUnits
  });
  return {
    id,
    name: meta.name,
    kicker: providerKicker(id),
    accent: meta.accent,
    status: provider?.status || "empty",
    fiveHour: hasLimits ? provider?.limits?.fiveHour || null : null,
    weekly: hasLimits ? provider?.limits?.weekly || null : null,
    limitRows,
    limitAlert,
    creditRows,
    claudeBrowserCredits: id === "claudeCode" ? provider?.browserCredits || null : null,
    planType,
    primaryLabel: t("limits.fiveHour"),
    secondaryLabel: t("limits.weekly"),
    todayTokens: provider?.totals?.last24h?.totalTokens,
    allTimeTokens: provider?.totals?.allTime?.totalTokens,
    apiTokens: provider?.totals?.last24h?.totalTokens,
    subscription,
    message: localizeProviderMessage(
      provider?.message,
      id === "copilot" ? "providers.messages.copilotLogTokens" : "providers.messages.logTokens24h"
    ),
    foot
  };
}

function copilotLimitUsageFootRows(provider, limitRows) {
  const hasFullLimit = limitRows.some((row) => Number(row.usedPercent || 0) >= 99.5);
  if (!hasFullLimit) return [];
  const rows = [];
  const tokens7d = Number(provider?.totals?.last7d?.totalTokens || 0);
  if (tokens7d > 0) rows.push(footRow(t("labels.tokens7d"), formatTokens(tokens7d)));
  const premiumRequests = Number(provider?.usageUnits?.premiumRequests || 0);
  const premiumLimit = limitRows.find((row) => /premium/i.test(`${row.key || ""} ${row.label || ""}`));
  if (premiumRequests > 0 && premiumLimit) rows.push(footRow(premiumLimit.label, formatNumber(premiumRequests)));
  return rows;
}

function buildLimitFullAlert({ limitRows, totals, usageUnits }) {
  const fullRows = (limitRows || []).filter((row) => Number(row.usedPercent || 0) >= 99.5);
  if (!fullRows.length) return null;
  const details = [];
  const quotaDetails = fullRows
    .map((row) => row.valueLabel)
    .filter(Boolean)
    .join(", ");
  if (quotaDetails) details.push(t("limits.fullQuotaDetail", { usage: quotaDetails }));
  const tokens = limitAlertTokenTotal(fullRows, totals);
  if (tokens.value > 0) {
    details.push(t("limits.fullTokenDetail", { tokens: formatTokens(tokens.value), period: tokens.period }));
  }
  const premiumRequests = Number(usageUnits?.premiumRequests || 0);
  const hasPremiumLimit = fullRows.some((row) => /premium/i.test(`${row.key || ""} ${row.label || ""}`));
  if (premiumRequests > 0 && hasPremiumLimit) {
    details.push(t("limits.fullPremiumRequestsDetail", { requests: formatNumber(premiumRequests) }));
  }
  const resetsAt = fullRows.find((row) => row.resetsAt)?.resetsAt;
  if (resetsAt) details.push(t("limits.fullResetDetail", { time: formatDateTime(resetsAt) }));
  return {
    title: t("limits.fullTitle"),
    text: [t("limits.fullDescription", { limit: fullRows.map((row) => row.label).join(", ") }), ...details].join(" · ")
  };
}

function limitAlertTokenTotal(fullRows, totals) {
  const labelText = fullRows.map((row) => `${row.key || ""} ${row.label || ""}`).join(" ");
  if (/5h|five.?hour|session/i.test(labelText)) {
    return { value: Number(totals?.last5h?.totalTokens || 0), period: t("limits.period5h") };
  }
  if (/week|weekly|7d|seven.?day|premium/i.test(labelText)) {
    return { value: Number(totals?.last7d?.totalTokens || 0), period: t("limits.period7d") };
  }
  return { value: Number(totals?.last24h?.totalTokens || 0), period: t("limits.period24h") };
}

function normalizeCreditRows(rows, credits) {
  const sourceRows = Array.isArray(rows) && rows.length ? rows : buildCreditRowsFromCredits(credits);
  return sourceRows.map(normalizeCreditRow).filter(Boolean);
}

function buildCreditRowsFromCredits(credits) {
  if (!credits) return [];
  const currency = credits.currency || "EUR";
  const spentAmount = Number(credits.spentAmount || 0);
  const monthlyLimitAmount = Number(credits.monthlyLimitAmount || 0);
  const currentCreditAmount = Number(credits.currentCreditAmount || 0);
  const hasCreditData =
    credits.enabled ||
    spentAmount > 0 ||
    monthlyLimitAmount > 0 ||
    currentCreditAmount > 0 ||
    credits.autoTopUp ||
    credits.resetsAt ||
    credits.resetLabel;
  if (!hasCreditData) return [];
  const percent = monthlyLimitAmount > 0 ? (spentAmount / monthlyLimitAmount) * 100 : null;
  return [
    {
      key: "monthlySpend",
      label: t("credits.monthlySpend"),
      amount: spentAmount,
      currency,
      percent,
      resetsAt: credits.resetsAt,
      resetLabel: credits.resetLabel
    },
    monthlyLimitAmount > 0
      ? { key: "monthlyLimit", label: t("credits.monthlyLimit"), amount: monthlyLimitAmount, currency }
      : null,
    credits.enabled || currentCreditAmount > 0
      ? { key: "currentCredit", label: t("credits.currentCredit"), amount: currentCreditAmount, currency }
      : null,
    { key: "autoTopUp", label: t("credits.autoTopUp"), valueLabel: credits.autoTopUp ? t("credits.on") : t("credits.off") }
  ].filter(Boolean);
}

function normalizeCreditRow(row) {
  if (!row) return null;
  const amount = Number(row.amount);
  const percent = Number(row.percent);
  return {
    key: row.key || row.label || "credit",
    label: creditLabel(row),
    amount: Number.isFinite(amount) ? amount : null,
    currency: row.currency || "EUR",
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    valueLabel: creditValueLabel(row),
    resetsAt: row.resetsAt || null,
    resetLabel: row.resetLabel || null
  };
}

function normalizeLimitRows(limits) {
  if (!limits) return [];
  if (Array.isArray(limits.rows) && limits.rows.length) {
    return limits.rows.map(normalizeLimitRow).filter(Boolean);
  }
  return [
    normalizeLimitRow(limits.fiveHour ? { key: "fiveHour", label: t("limits.fiveHour"), ...limits.fiveHour } : null),
    normalizeLimitRow(limits.weekly ? { key: "weekly", label: t("limits.weekly"), ...limits.weekly } : null),
    normalizeLimitRow(limits.fable ? { key: "fable", label: t("limits.fable"), ...limits.fable } : null),
    normalizeLimitRow(limits.sonnetOnly ? { key: "sonnetOnly", label: t("limits.sonnetOnly"), ...limits.sonnetOnly } : null)
  ].filter(Boolean);
}

function normalizeLimitRow(row) {
  if (!row) return null;
  const hasUsedPercent = Number.isFinite(Number(row.usedPercent));
  if (!hasUsedPercent && !row.valueLabel) return null;
  const usedPercent = hasUsedPercent ? Math.max(0, Math.min(100, Number(row.usedPercent))) : null;
  return {
    key: row.key || row.label || "limit",
    label: limitLabel(row),
    usedPercent,
    remainingPercent:
      usedPercent === null
        ? null
        : Number.isFinite(Number(row.remainingPercent))
          ? Math.max(0, Math.min(100, Number(row.remainingPercent)))
          : Math.max(0, 100 - usedPercent),
    valueLabel: row.valueLabel || null,
    resetsAt: row.resetsAt || null,
    resetLabel: row.resetLabel || row.detail || null
  };
}

function sourceLabel(id) {
  return providerMeta[id]?.name || (id === "local" ? t("providers.local.name") : id);
}

function providerKicker(id) {
  const meta = providerMeta[id];
  return meta ? t(meta.kickerKey, {}, meta.name) : id;
}

function localizeProviderMessage(message, fallbackKey) {
  const knownMessages = {
    "Keine Codex 5.3 Spark Events gefunden.": "providers.messages.noCodexSparkEvents",
    "Claude statusline captured, but no official Pro/Max quota values yet.": "providers.messages.claudeStatuslineNoQuotas",
    "Claude live data received, but no official Pro/Max quota values yet.": "providers.messages.claudeStatuslineNoQuotas",
    "Claude statusline not configured. Enable the dashboard statusline command for Pro/Max live quotas.":
      "providers.messages.claudeStatuslineMissing",
    "Claude live limits are not available from local telemetry yet.":
      "providers.messages.claudeLiveLimitsMissing",
    "Claude live limits are stale. Open Claude Code once to refresh them.":
      "providers.messages.claudeLimitsStale",
    "Keine lokalen Copilot CLI Session-Metriken gefunden.": "providers.messages.noCopilotSessionMetrics",
    "Keine lokalen Gemini Usage-Logs gefunden.": "providers.messages.noGeminiLogs",
    "Lokale Ollama-Tokens aus Logs": "providers.messages.ollamaLogTokens",
    "Keine lokalen Ollama-Logs gefunden.": "providers.messages.noOllamaLogs"
  };
  if (!message) return t(fallbackKey);
  return knownMessages[message] ? t(knownMessages[message]) : message;
}

function creditLabel(row) {
  const key = row.key ? `credits.${row.key}` : "";
  return key ? t(key, {}, row.label || row.key) : row.label || t("credits.default");
}

function creditValueLabel(row) {
  if (row.key !== "autoTopUp") return row.valueLabel || null;
  const value = String(row.valueLabel || "").trim().toLowerCase();
  if (["an", "on", "true", "1"].includes(value)) return t("credits.on");
  if (["aus", "off", "false", "0"].includes(value)) return t("credits.off");
  return row.valueLabel || null;
}

function limitLabel(row) {
  const key = row.key ? `limits.${row.key}` : "";
  if (key) return t(key, {}, row.label || row.limitLabel || row.key);
  return row.label || row.limitLabel || t("limits.default");
}

function limitSummaryLabel(limits) {
  const rows = Array.isArray(limits?.rows) ? limits.rows : [];
  return rows.length ? t("limits.limitGroups", { count: rows.length }) : t("limits.noModelLimits");
}

function normalizeApiProvider(id, provider) {
  const meta = providerMeta[id];
  const totalTokens = provider?.usage?.totals?.totalTokens;
  const costs = provider?.costs;
  const creditRows = normalizeCreditRows(provider?.creditRows, provider?.credits);
  const limitRows = normalizeLimitRows(provider?.limits);
  const planType = provider?.planType || provider?.plan || null;
  const subscription = normalizeSubscription(provider?.subscription);
  const foot = [
    [t("labels.tokens7d"), formatTokens(totalTokens)],
    [t("labels.cost7d"), formatMoney(costs?.total, costs?.currency)]
  ];
  if (provider?.limits?.summaryLabel) foot.push([t("labels.limits"), limitSummaryLabel(provider.limits)]);
  if (planType) foot.push([t("labels.plan"), planType]);
  if (subscription?.monthlyCost) foot.push([t("labels.subscription"), formatMonthlyCost(subscription)]);
  return {
    id,
    name: meta.name,
    kicker: providerKicker(id),
    accent: meta.accent,
    status: provider?.status || "not_configured",
    fiveHour: null,
    weekly: null,
    limitRows,
    limitAlert: buildLimitFullAlert({ limitRows, totals: provider?.usage?.totals ? { last7d: provider.usage.totals } : null }),
    creditRows,
    planType,
    primaryLabel: "7d",
    secondaryLabel: t("labels.cost"),
    apiTokens: totalTokens,
    allTimeTokens: totalTokens,
    cost: costs?.total,
    currency: costs?.currency,
    subscription,
    message:
      provider?.status === "not_configured"
        ? t("providers.messages.missingBackendKey")
        : provider?.error || "",
    foot
  };
}

function providerHasUsage(provider) {
  const hasActiveUsage = [
    provider.todayTokens,
    provider.apiTokens,
    provider.cost
  ].some((value) => Number(value || 0) > 0);
  const hasLimitTelemetry = Boolean(
    provider.fiveHour ||
      provider.weekly ||
      provider.limitRows?.length ||
      provider.creditRows?.length ||
      provider.planType ||
      provider.subscription?.monthlyCost
  );
  const needsAttention = provider.status === "error";
  const configuredApi = provider.status === "live" && (provider.id === "anthropic" || provider.id === "openai");
  return hasActiveUsage || hasLimitTelemetry || needsAttention || configuredApi;
}

function updateProviderFilterControl(providers, visibleProviders) {
  const hiddenCount = Math.max(providers.length - visibleProviders.length, 0);
  els.providerFilterBtn.textContent = state.showAllProviders ? t("filter.showActive") : t("filter.showAll");
  els.providerFilterBtn.disabled = !providers.length;
  els.providerFilterBtn.title = state.showAllProviders
    ? t("filter.hideInactive")
    : hiddenCount
      ? t("filter.showInactiveCount", { count: hiddenCount })
      : t("filter.allVisible");
  els.providerFilterBtn.setAttribute("aria-pressed", String(state.showAllProviders));
}

function updateLayoutControls(providers, visibleProviders) {
  if (!els.layoutEditBtn) return;
  const label = state.layoutEditMode ? t("layout.done") : t("layout.edit");
  els.layoutEditBtn.disabled = !providers.length;
  els.layoutEditBtn.setAttribute("aria-label", label);
  els.layoutEditBtn.setAttribute("title", label);
  els.layoutEditBtn.setAttribute("aria-pressed", String(state.layoutEditMode));
  if (els.layoutResetBtn) {
    els.layoutResetBtn.hidden = !state.layoutEditMode || !visibleProviders.length;
    els.layoutResetBtn.textContent = t("layout.reset");
  }
}

function renderNoActiveProviders() {
  return `
    <article class="provider-card provider-empty-state">
      <div class="provider-head">
        <div>
          <p class="eyebrow">${escapeHtml(t("providers.emptyState.eyebrow"))}</p>
          <h2 class="provider-name">${escapeHtml(t("providers.emptyState.heading"))}</h2>
        </div>
        <span class="status-pill status-empty">${escapeHtml(t("providers.emptyState.status"))}</span>
      </div>
      <p class="empty-message">${escapeHtml(t("providers.emptyState.message"))}</p>
      <div class="provider-foot">
        <div class="mini-stat"><span>${escapeHtml(t("providers.emptyState.visible"))}</span><strong>0</strong></div>
        <div class="mini-stat"><span>${escapeHtml(t("providers.emptyState.hidden"))}</span><strong>${escapeHtml(t("providers.emptyState.all"))}</strong></div>
      </div>
    </article>
  `;
}

function renderProvider(provider, index = 0, total = 1) {
  const statusClass = `status-${provider.status}`;
  const hasConfiguredLimitRows = provider.limitRows?.some((row) => row.valueLabel);
  const showLimitBars = hasConfiguredLimitRows || provider.limitRows?.length > 2 || Boolean(provider.planType);
  const main = provider.limitRows?.length || provider.fiveHour || provider.weekly
    ? showLimitBars
      ? renderLimitBars(provider)
      : renderRings(provider)
    : `<div class="api-total">
        <div class="ring" style="--percent: ${Math.min(100, Number(provider.apiTokens || 0) ? 72 : 0)}; --accent: ${provider.accent}">
          <strong>${formatTokens(provider.apiTokens)}</strong>
        </div>
        <span class="ring-label">${escapeHtml(provider.message || t("providers.messages.sevenDays"))}</span>
      </div>`;

  return `
    <article class="provider-card" data-provider-id="${escapeHtml(provider.id)}" role="listitem" draggable="${state.layoutEditMode ? "true" : "false"}">
      ${state.layoutEditMode ? renderProviderDragHandle(provider, index, total) : ""}
      <div class="provider-head">
        <div>
          <p class="eyebrow">${escapeHtml(provider.kicker || provider.id)}</p>
          <h2 class="provider-name">
            ${escapeHtml(provider.name)}
            ${provider.planType ? `<span class="plan-badge">${escapeHtml(provider.planType)}</span>` : ""}
          </h2>
        </div>
        <span class="status-pill ${statusClass}">${statusText(provider.status)}</span>
      </div>
      ${main}
      ${renderLimitAlert(provider)}
      ${provider.creditRows?.length ? renderCreditRows(provider) : ""}
      ${renderClaudeCreditHint(provider)}
      <div class="provider-foot">
        ${provider.foot
          .map(renderProviderFootRow)
          .join("")}
      </div>
    </article>
  `;
}

function renderProviderDragHandle(provider, index, total) {
  const active = state.keyboardDragProviderId === provider.id;
  return `
    <button
      type="button"
      class="provider-drag-handle${active ? " is-active" : ""}"
      data-provider-drag-handle
      data-provider-id="${escapeHtml(provider.id)}"
      aria-label="${escapeHtml(t("layout.dragHandle", { name: provider.name }))}"
      aria-pressed="${active}"
      title="${escapeHtml(t("layout.dragHandle", { name: provider.name }))}"
    >
      <i data-lucide="grip-vertical"></i>
      <span class="provider-position">${escapeHtml(`${index + 1}/${total}`)}</span>
    </button>
  `;
}

function renderLimitAlert(provider) {
  if (!provider.limitAlert) return "";
  return `
    <div class="limit-alert" role="status">
      <strong>${escapeHtml(provider.limitAlert.title)}</strong>
      <span>${escapeHtml(provider.limitAlert.text)}</span>
    </div>
  `;
}

function renderProviderFootRow(row) {
  const normalized = Array.isArray(row) ? footRow(row[0], row[1]) : row;
  const title = normalized.title ? ` title="${escapeHtml(normalized.title)}"` : "";
  const hint = normalized.hint
    ? `<button type="button" class="mini-stat-help" aria-label="${escapeHtml(`${t("labels.updatedHelp")}: ${normalized.hint}`)}" title="${escapeHtml(normalized.hint)}">?</button>`
    : "";
  return `
    <div class="mini-stat">
      <span class="mini-stat-label">${escapeHtml(normalized.label)}${hint}</span>
      <strong${title}>${escapeHtml(normalized.value)}</strong>
    </div>
  `;
}

function renderClaudeCreditHint(provider) {
  if (provider.id !== "claudeCode" || provider.creditRows?.length) return "";
  const status = provider.claudeBrowserCredits?.status || "missing";
  if (status === "available") return "";
  const hint = t("providers.messages.claudeBrowserLoginHint");
  return `
    <p class="provider-note">${escapeHtml(hint)}</p>
  `;
}

function renderCreditRows(provider) {
  return `
    <div class="credit-rows">
      <div class="credit-rows-title">${escapeHtml(t("credits.title"))}</div>
      ${provider.creditRows.map((row) => renderCreditRow(row, provider.accent)).join("")}
    </div>
  `;
}

function renderCreditRow(row, accent) {
  const value =
    row.valueLabel ||
    (row.amount === null || row.amount === undefined ? "--" : formatMoney(row.amount, row.currency || "EUR"));
  const detail = row.resetLabel || (row.resetsAt ? t("limits.resetPrefix", { time: formatDateTime(row.resetsAt) }) : "");
  const bar =
    row.percent === null || row.percent === undefined
      ? ""
      : `<div class="credit-track" aria-hidden="true">
          <span class="credit-fill" style="--percent: ${Math.round(row.percent)}; --accent: ${accent}"></span>
        </div>`;
  return `
    <div class="credit-row">
      <div class="credit-row-top">
        <span>${escapeHtml(row.label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
      ${bar}
      ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
    </div>
  `;
}

function renderLimitBars(provider) {
  const rows = provider.limitRows?.length
    ? provider.limitRows
    : normalizeLimitRows({ fiveHour: provider.fiveHour, weekly: provider.weekly });
  if (!rows.length) return "";
  return `
    <div class="limit-bars">
      ${rows.map((row) => renderLimitBar(row, provider.accent)).join("")}
    </div>
  `;
}

function renderLimitBar(row, accent) {
  const hasUsedPercent = row.usedPercent !== null && row.usedPercent !== undefined;
  const used = Math.round(row.usedPercent || 0);
  const remaining = Math.round(row.remainingPercent ?? Math.max(0, 100 - used));
  const leftDetail = hasUsedPercent ? t("limits.leftValue", { percent: remaining }) : "";
  const resetDetail = row.resetLabel || renderLimitRemaining(row.resetsAt);
  const detail = [leftDetail, resetDetail].filter(Boolean).join(" · ");
  const value = row.valueLabel || t("limits.usedValue", { percent: used });
  return `
    <div class="limit-bar">
      <div class="limit-bar-top">
        <strong>${escapeHtml(row.label)}</strong>
        <span>${escapeHtml(value)}</span>
      </div>
      ${
        hasUsedPercent
          ? `<div class="limit-bar-track" aria-hidden="true">
              <span class="limit-bar-fill" style="--percent: ${used}; --accent: ${accent}"></span>
            </div>`
          : ""
      }
      ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
    </div>
  `;
}

function renderLimitRemaining(resetsAt) {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return t("limits.resetPrefix", { time: formatDateTime(resetsAt) });
  const remainingMs = ms - Date.now();
  if (remainingMs > 0) {
    const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
    const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
    return `${t("limits.remainingShort", { days, hours, minutes })} · ${formatDateTime(resetsAt)}`;
  }
  return t("limits.resetPrefix", { time: formatDateTime(resetsAt) });
}

function renderRings(provider) {
  return `
    <div class="ring-row">
      ${renderRing(provider.fiveHour, provider.primaryLabel, provider.accent)}
      ${renderRing(provider.weekly, provider.secondaryLabel, provider.accent)}
    </div>
  `;
}

function renderRing(limit, label, accent) {
  if (!limit) {
    return `
      <div class="ring-box">
        <div class="ring" style="--percent: 0; --accent: ${accent}"><strong>--</strong></div>
        <span class="ring-label">${escapeHtml(label)}</span>
      </div>
    `;
  }
  const remaining = Math.round(limit.remainingPercent ?? 0);
  let sub = "";
  if (limit.resetsAt) {
    sub = `<div class="ring-sub">${escapeHtml(renderLimitRemaining(limit.resetsAt))}</div>`;
  }
  return `
    <div class="ring-box">
      <div class="ring" style="--percent: ${remaining}; --accent: ${accent}">
        <strong>${remaining}%</strong>
      </div>
      <span class="ring-label">${escapeHtml(t("limits.freeLabel", { label }))}</span>
      ${sub}
    </div>
  `;
}

function renderSummary(providers, codex) {
  const withFiveHour = providers.filter((p) => p.fiveHour);
  const withWeekly = providers.filter((p) => p.weekly);
  els.fiveHourOpen.textContent = percentAverage(withFiveHour.map((p) => p.fiveHour.remainingPercent));
  els.weeklyOpen.textContent = percentAverage(withWeekly.map((p) => p.weekly.remainingPercent));
  els.tokensToday.textContent = formatTokens(codex?.totals?.last24h?.totalTokens);
  els.tokensTotal.textContent = formatTokens(codex?.totals?.allTime?.totalTokens);
  renderRecordDay(codex?.daily || []);
}

function renderRecordDay(daily) {
  const record = findRecordDay(daily);
  if (!record) {
    els.recordDay.textContent = "";
    els.recordDay.hidden = true;
    return;
  }
  els.recordDay.textContent = t("summary.recordDay", {
    date: formatFullDate(record.date),
    tokens: formatTokens(record.totalTokens)
  });
  els.recordDay.hidden = false;
}

function findRecordDay(daily) {
  return (Array.isArray(daily) ? daily : [])
    .map((day) => ({ date: day.date, totalTokens: Number(day.totalTokens ?? day.totals?.totalTokens ?? 0) }))
    .filter((day) => day.date && day.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens || String(b.date).localeCompare(String(a.date)))[0];
}

function renderTokenList(totals) {
  const rows = [
    [t("tokens.input"), totals?.inputTokens],
    [t("tokens.cacheCreation"), totals?.cacheCreationInputTokens],
    [t("tokens.cachedInput"), totals?.cachedInputTokens],
    [t("tokens.output"), totals?.outputTokens],
    [t("tokens.reasoningOutput"), totals?.reasoningOutputTokens],
    [t("tokens.total"), totals?.totalTokens]
  ];
  els.tokenList.innerHTML = rows
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${formatTokens(value)}</dd></div>`)
    .join("");
}

function renderLiveGauges(metrics) {
  if (!els.liveGaugeGrid) return;
  const live = metrics || unavailableLiveMetrics();
  els.liveMetricsUpdated.textContent = metrics?.timestamp
    ? t("liveMetrics.updated", { time: formatUpdatedAt(metrics.timestamp) })
    : state.systemMetricsError
      ? t("liveMetrics.error")
      : t("liveMetrics.notAvailable");
  els.liveGaugeGrid.innerHTML = liveGaugeDefinitions(live).map(renderLiveGaugeCard).join("");
  renderLiveHistory(metrics);
  refreshIcons();
}

function unavailableLiveMetrics() {
  return {
    cpu: { usedPercent: null, quality: "unavailable" },
    ram: { usedPercent: null, usedGb: null, totalGb: null, quality: "unavailable" },
    aiLoadScore: { score: null, quality: "unavailable", factors: {} },
    tokensPerMinute: {
      value: null,
      quality: "unavailable",
      input: { value: null, quality: "unavailable" },
      output: { value: null, quality: "unavailable" },
      cached: { value: null, quality: "unavailable" }
    },
    timeSeries: []
  };
}

function liveGaugeDefinitions(metrics) {
  const tokens = metrics.tokensPerMinute || {};
  return [
    {
      id: "cpu",
      label: t("liveMetrics.cpu"),
      value: formatLivePercent(metrics.cpu?.usedPercent),
      percent: metrics.cpu?.usedPercent,
      quality: metrics.cpu?.quality,
      accent: "#23745c",
      sub: t("liveMetrics.percentScale")
    },
    {
      id: "ram",
      label: t("liveMetrics.ram"),
      value: formatLivePercent(metrics.ram?.usedPercent),
      percent: metrics.ram?.usedPercent,
      quality: metrics.ram?.quality,
      accent: "#d55e00",
      sub:
        metrics.ram?.usedGb !== null && metrics.ram?.totalGb !== null
          ? t("liveMetrics.ramSub", { used: formatGb(metrics.ram.usedGb), total: formatGb(metrics.ram.totalGb) })
          : t("liveMetrics.unavailable")
    },
    {
      id: "aiLoad",
      label: t("liveMetrics.aiLoad"),
      value: formatLivePercent(metrics.aiLoadScore?.score),
      percent: metrics.aiLoadScore?.score,
      quality: metrics.aiLoadScore?.quality,
      accent: "#b94e5c",
      sub: t("liveMetrics.aiLoadSub"),
      help: t("liveMetrics.aiLoadHelp")
    },
    {
      id: "tokensPerMin",
      label: t("liveMetrics.tokensPerMinute"),
      value: formatTokensPerMin(tokens.value),
      percent: tokens.value === null || tokens.value === undefined ? 0 : clampUiPercent((Number(tokens.value) / 1_000_000) * 100),
      quality: tokens.quality,
      accent: "#2e6ea6",
      sub: formatLiveTokenBreakdown(tokens),
      help: t("liveMetrics.tokensPerMinuteHelp")
    }
  ];
}

function renderLiveGaugeCard(gauge) {
  const percent = clampUiPercent(gauge.percent || 0);
  const quality = gauge.quality || "unavailable";
  const valueLen = String(gauge.value || "").length;
  return `
    <article class="live-gauge-card">
      <div class="live-gauge-top">
        <span class="live-gauge-label">${escapeHtml(gauge.label)}</span>
        ${gauge.help ? `<button type="button" class="mini-stat-help live-gauge-help" aria-label="${escapeHtml(gauge.help)}" title="${escapeHtml(gauge.help)}"><i data-lucide="info"></i></button>` : ""}
      </div>
      <div class="live-gauge-ring" style="--percent: ${percent}; --accent: ${gauge.accent}" data-value-len="${valueLen}">
        <strong>${escapeHtml(gauge.value)}</strong>
      </div>
      <span class="live-gauge-sub">${escapeHtml(gauge.sub || "")}</span>
      <span class="live-quality-badge live-quality-${escapeHtml(quality)}">${escapeHtml(liveQualityLabel(quality))}</span>
    </article>
  `;
}

function renderLiveHistory(metrics) {
  if (!els.liveHistoryChart || !els.liveHistoryLegend) return;
  const points = Array.isArray(metrics?.timeSeries) ? metrics.timeSeries : [];
  const availableSeries = liveHistorySeries.filter((series) => points.some((point) => liveSeriesHasValue(series, point)));
  for (const series of availableSeries) {
    if (state.liveSeriesVisibility[series.id] === undefined) state.liveSeriesVisibility[series.id] = true;
  }
  els.liveHistoryLegend.innerHTML = renderLiveHistoryLegend(availableSeries);

  if (!metrics) {
    els.liveHistoryChart.innerHTML = `<div class="chart-empty">${escapeHtml(state.systemMetricsError || t("liveMetrics.notAvailable"))}</div>`;
    return;
  }
  if (points.length < 2 || !availableSeries.length) {
    els.liveHistoryChart.innerHTML = `<div class="chart-empty">${escapeHtml(t("liveMetrics.historyLoading"))}</div>`;
    return;
  }

  const activeSeries = availableSeries.filter((series) => state.liveSeriesVisibility[series.id] !== false);
  if (!activeSeries.length) {
    els.liveHistoryChart.innerHTML = `<div class="chart-empty">${escapeHtml(t("liveMetrics.historyNoSeries"))}</div>`;
    return;
  }

  const viewportWidth = Math.max(620, els.liveHistoryChart.clientWidth || 760);
  const height = 260;
  const padLeft = 52;
  const padRight = 76;
  const chartTop = 24;
  const axisY = height - 48;
  const dateLabelY = height - 24;
  const chartHeight = axisY - chartTop;
  const width = Math.max(viewportWidth, 620);
  const tokenValues = activeSeries
    .filter((series) => series.kind === "tokens")
    .flatMap((series) => points.map((point) => normalizeLiveSeriesValue(series.value(point))))
    .filter((value) => value !== null);
  const tokenScale = chartTokenScale(Math.max(...tokenValues, 1));
  const percentTicks = [25, 50, 75, 100];

  const gridLines = percentTicks
    .map((tick) => {
      const y = axisY - (chartHeight * tick) / 100;
      return `
        <line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" class="chart-grid-line"></line>
        <text x="${padLeft - 8}" y="${Math.max(14, y - 6)}" text-anchor="end" class="axis-label">${tick}%</text>
      `;
    })
    .join("");
  const tokenAxis = tokenScale.ticks
    .map((tick) => {
      const y = axisY - (chartHeight * tick) / tokenScale.max;
      return `<text x="${width - 8}" y="${Math.max(14, y - 6)}" text-anchor="end" class="axis-label">${escapeHtml(formatTokensPerMinTick(tick))}</text>`;
    })
    .join("");
  const lines = activeSeries.map((series) => renderLiveSeriesLine(series, points, {
    width,
    padLeft,
    padRight,
    chartTop,
    axisY,
    chartHeight,
    tokenScale
  })).join("");
  const first = points[0]?.timestamp;
  const last = points[points.length - 1]?.timestamp;

  els.liveHistoryChart.innerHTML = `
    <div class="live-history-canvas" style="width: ${width}px">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t("liveMetrics.historyAria"))}" style="width: ${width}px">
        ${gridLines}
        ${tokenAxis}
        <line x1="${padLeft}" y1="${axisY}" x2="${width - padRight}" y2="${axisY}" stroke="#dfe5dd"></line>
        ${lines}
        <text x="${padLeft}" y="${dateLabelY}" text-anchor="start" class="axis-label">${escapeHtml(formatTime(first))}</text>
        <text x="${width - padRight}" y="${dateLabelY}" text-anchor="end" class="axis-label">${escapeHtml(formatTime(last))}</text>
      </svg>
    </div>
  `;
}

function renderLiveHistoryLegend(seriesList) {
  return seriesList
    .map((series) => {
      const active = state.liveSeriesVisibility[series.id] !== false;
      return `
        <button type="button" class="live-history-legend-item${active ? " active" : ""}" data-live-series="${escapeHtml(series.id)}" aria-pressed="${active}" style="--series-color: ${series.color}">
          <span class="live-history-legend-swatch${series.dashed ? " dashed" : ""}" style="--series-color: ${series.color}"></span>
          <span>${escapeHtml(t(series.labelKey))}</span>
        </button>
      `;
    })
    .join("");
}

function handleLiveHistoryLegendToggle(event) {
  const button = event.target.closest("[data-live-series]");
  if (!button) return;
  const id = button.dataset.liveSeries;
  state.liveSeriesVisibility[id] = !(state.liveSeriesVisibility[id] !== false);
  renderLiveHistory(state.systemMetrics);
}

function renderLiveSeriesLine(series, points, dims) {
  const denominator = Math.max(points.length - 1, 1);
  const plotWidth = dims.width - dims.padLeft - dims.padRight;
  const segments = [];
  let current = [];
  points.forEach((point, index) => {
    const raw = normalizeLiveSeriesValue(series.value(point));
    if (raw === null) {
      if (current.length > 1) segments.push(current);
      current = [];
      return;
    }
    const x = dims.padLeft + (plotWidth * index) / denominator;
    const y = series.kind === "tokens"
      ? dims.axisY - (dims.chartHeight * Math.min(raw, dims.tokenScale.max)) / dims.tokenScale.max
      : dims.axisY - (dims.chartHeight * clampUiPercent(raw)) / 100;
    current.push(`${roundSvg(x)},${roundSvg(y)}`);
  });
  if (current.length > 1) segments.push(current);
  if (!segments.length) return "";
  return segments
    .map((segment) => `
      <polyline
        points="${segment.join(" ")}"
        fill="none"
        stroke="${series.color}"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        ${series.dashed ? 'stroke-dasharray="6 5"' : ""}
      ></polyline>
    `)
    .join("");
}

function liveSeriesHasValue(series, point) {
  return normalizeLiveSeriesValue(series.value(point)) !== null;
}

function normalizeLiveSeriesValue(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatLivePercent(value) {
  return value === null || value === undefined ? t("liveMetrics.unavailableShort") : formatPercent(value);
}

function formatGb(value) {
  return new Intl.NumberFormat(currentLocale(), {
    maximumFractionDigits: 1
  }).format(Number(value || 0));
}

function formatLiveTokenBreakdown(tokens) {
  const rows = [
    [t("tokens.input"), tokens.input?.value],
    [t("tokens.output"), tokens.output?.value],
    [t("tokens.cachedInput"), tokens.cached?.value]
  ].filter(([, value]) => value !== null && value !== undefined);
  if (!rows.length) return tokens.value === null || tokens.value === undefined ? t("liveMetrics.noTokenWindow") : t("liveMetrics.noTokenBreakdown");
  return rows.map(([label, value]) => `${label} ${formatTokensPerMin(value)}`).join(" · ");
}

function formatTokensPerMin(value) {
  if (value === null || value === undefined) return t("liveMetrics.unavailableShort");
  const num = Math.max(0, Number(value) || 0);
  if (num >= 100_000) return `${formatNumber(Math.round(num / 1000))}${t("format.thousand")}/min`;
  if (num >= 1000) return `${formatCompact(num / 1000)}${t("format.thousand")}/min`;
  return `${formatNumber(Math.round(num))}/min`;
}

function formatTokensPerMinTick(value) {
  if (!value) return "0/min";
  return formatTokensPerMin(value);
}

function liveQualityLabel(quality) {
  return t(`liveMetrics.quality.${quality || "unavailable"}`, {}, quality || "unavailable");
}

function clampUiPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}

function roundSvg(value) {
  return Math.round(Number(value) * 10) / 10;
}

function renderPricing(local) {
  const todayUsage = billingTotalsForWindow(local, "last24h");
  const totalUsage = billingTotalsForWindow(local, "allTime");
  const rows = pricingModels.map((price) => ({
    price,
    today: estimateCost(todayUsage, price),
    total: estimateCost(totalUsage, price)
  }));

  updatePricingSortButtons();
  els.priceRows.innerHTML = sortPricingRows(rows)
    .map(({ price, today, total }) => {
      return `
        <tr>
          <td>
            <div class="model-cell">
              <strong>${escapeHtml(price.model)}</strong>
              <span>${escapeHtml(price.provider)}</span>
              ${price.china ? `<em class="china-badge">${escapeHtml(t("pricing.chinaBadge"))}</em>` : ""}
            </div>
          </td>
          <td class="score-cell">${renderQualityScore(price)}</td>
          <td>${escapeHtml(priceRegion(price))}</td>
          <td class="numeric">${formatUsdPerM(price.inputUsd)}</td>
          <td class="numeric">${formatCacheRate(price)}</td>
          <td class="numeric">${formatUsdPerM(price.outputUsd)}</td>
          <td class="numeric cost-cell">${formatEuro(today.eur)}</td>
          <td class="numeric cost-cell">${formatEuro(total.eur)}</td>
          <td><a href="${price.sourceUrl}" target="_blank" rel="noreferrer">${escapeHtml(price.source)}</a></td>
        </tr>
      `;
    })
    .join("");

  els.pricingMeta.textContent = t("pricing.meta", {
    fxDate: FX_DATE,
    pricingDate: PRICING_DATE,
    scoreDate: SCORE_DATE
  });
}

function sortPricingRows(rows) {
  const sort = state.pricingSort;
  if (!sort) return rows;
  const multiplier = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = pricingSortValue(a, sort.key);
    const right = pricingSortValue(b, sort.key);
    const result = compareSortValues(left, right);
    if (result) return result * multiplier;
    return compareSortValues(a.price.model, b.price.model);
  });
}

function pricingSortValue(row, key) {
  const { price, today, total } = row;
  return (
    {
      model: `${price.provider} ${price.model}`,
      score: modelQualityScores[price.model] || 0,
      region: priceRegion(price),
      input: price.inputUsd,
      cache: price.cachedInputUsd ?? price.cacheWriteUsd ?? price.inputUsd,
      output: price.outputUsd,
      today: today.eur,
      total: total.eur,
      source: price.source
    }[key] ?? ""
  );
}

function priceRegion(price) {
  return price.regionKey ? t(price.regionKey, {}, price.region) : price.region;
}

function pricingModelForUsageModel(model) {
  const canonical = canonicalModelName(model);
  if (!canonical) return null;
  const direct = pricingModelByCanonicalName.get(canonical);
  if (direct) return direct;
  const alias = pricingModelAliasByCanonicalName.get(canonical);
  return alias ? pricingModelByCanonicalName.get(canonicalModelName(alias)) || null : null;
}

function canonicalModelName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^anthropic[.:/-]+/u, "")
    .replace(/^models[/:]+/u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function compareSortValues(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return String(left ?? "").localeCompare(String(right ?? ""), currentLocale(), {
    numeric: true,
    sensitivity: "base"
  });
}

function currentLocale() {
  return LANGUAGE_META[state.language]?.locale || "en-US";
}

function updatePricingSortButtons() {
  for (const button of els.priceSortButtons) {
    const active = state.pricingSort?.key === button.dataset.priceSort;
    button.classList.toggle("active", active);
    button.dataset.direction = active ? state.pricingSort.direction : "";
    button.setAttribute("aria-sort", active ? (state.pricingSort.direction === "asc" ? "ascending" : "descending") : "none");
  }
}

function renderQualityScore(price) {
  const score = modelQualityScores[price.model];
  if (!score) return "--";
  return `
    <div class="score-meter" title="${escapeHtml(t("pricing.qualityScoreTitle", { scoreDate: SCORE_DATE, score }))}">
      <span class="score-track"><span class="score-fill" style="width: ${score}%"></span></span>
      <strong>${score}</strong>
    </div>
  `;
}

function billingTotalsForWindow(local, windowKey) {
  const sources = Array.isArray(local?.sources)
    ? local.sources.filter((source) => source?.totals?.[windowKey] && !pricingExcludedSourceIds.has(source.id))
    : [];
  if (!sources.length) return normalizeBillingTotals("mixed", local?.totals?.[windowKey]);

  const acc = createBillingTotals();
  for (const source of sources) {
    addBillingTotals(acc, normalizeBillingTotals(source.id, source.totals[windowKey]));
  }
  return acc;
}

function normalizeBillingTotals(sourceId, totals) {
  const input = Number(totals?.inputTokens || 0);
  const cached = Number(totals?.cachedInputTokens || 0);
  const cacheCreation = Number(totals?.cacheCreationInputTokens || 0);
  const output = Number(totals?.outputTokens || 0);
  const reasoning = Number(totals?.reasoningOutputTokens || 0);
  const inputIncludesCached = ["codex", "codexSpark", "gemini", "openai"].includes(sourceId);
  const outputIncludesReasoning = ["codex", "codexSpark", "openai"].includes(sourceId);

  return {
    inputTokens: inputIncludesCached ? Math.max(input - cached, 0) : input,
    cacheCreationInputTokens: cacheCreation,
    cachedInputTokens: cached,
    outputTokens: outputIncludesReasoning ? output : output + reasoning
  };
}

function createBillingTotals() {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0
  };
}

function addBillingTotals(target, source) {
  target.inputTokens += source.inputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.outputTokens += source.outputTokens;
}

function estimateCost(usage, price) {
  const inputUsd = (usage.inputTokens * price.inputUsd) / MILLION;
  const cacheWriteUsd =
    (usage.cacheCreationInputTokens * (price.cacheWriteUsd ?? price.inputUsd)) / MILLION;
  const cachedUsd =
    (usage.cachedInputTokens * (price.cachedInputUsd ?? price.inputUsd)) / MILLION;
  const outputUsd = (usage.outputTokens * price.outputUsd) / MILLION;
  const usd = inputUsd + cacheWriteUsd + cachedUsd + outputUsd;
  return { usd, eur: usd / USD_PER_EUR };
}

const CHART_FILTERS = ["h24", "today", "week", "month", "year", "all"];

function isoDateDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function filterDailyByRange(daily, filter) {
  const today = new Date().toISOString().slice(0, 10);
  const cutoffs = {
    h24: isoDateDaysAgo(1),
    today: today,
    week: isoDateDaysAgo(6),
    month: isoDateDaysAgo(29),
    year: isoDateDaysAgo(364)
  };
  if (filter === "all" || !cutoffs[filter]) return daily;
  return daily.filter((d) => d.date >= cutoffs[filter]);
}

function availableChartFilters(daily) {
  if (!daily.length) return ["all"];
  const limited = CHART_FILTERS.filter((f) => {
    if (f === "all") return true;
    const filtered = filterDailyByRange(daily, f);
    return filtered.length > 0 && filtered.length < daily.length;
  });
  return limited;
}

function syncChartTimeFilter(daily) {
  const available = availableChartFilters(daily);
  if (!available.includes(state.chartTimeFilter)) {
    state.chartTimeFilter = "all";
    state.chartScrollToLatest = true;
  }
}

function renderChartFilterBar(daily) {
  const available = availableChartFilters(daily);
  if (available.length <= 1) return "";
  const labels = {
    h24: t("chart.filters.h24"),
    today: t("chart.filters.today"),
    week: t("chart.filters.week"),
    month: t("chart.filters.month"),
    year: t("chart.filters.year"),
    all: t("chart.filters.all")
  };
  return available
    .map((f) => {
      const active = state.chartTimeFilter === f;
      return `<button type="button" class="time-filter-btn${active ? " active" : ""}" data-chart-filter="${f}" aria-pressed="${active}">${escapeHtml(labels[f] || f)}</button>`;
    })
    .join("");
}

function renderChart(daily) {
  if (!daily.length) {
    els.chart.innerHTML = "";
    els.chartLegend.innerHTML = "";
    state.chartRendered = false;
    return;
  }

  const viewportWidth = Math.max(900, els.chart.clientWidth || 900);
  const height = 300;
  const pad = 64;
  const chartTop = 28;
  const axisY = height - 64;
  const dateLabelY = height - 42;
  const chartHeight = axisY - chartTop;
  const sourceIds = chartSourcesInUse(daily);
  const max = Math.max(...daily.map((d) => d.totalTokens), 1);
  const scale = chartTokenScale(max);
  const visibleDays = Math.min(daily.length, viewportWidth >= 1200 ? 21 : 16);
  const barGap = 8;
  const barWidth = Math.max(
    24,
    (viewportWidth - pad * 2 - barGap * Math.max(0, visibleDays - 1)) / Math.max(visibleDays, 1)
  );
  const width = Math.max(viewportWidth, pad * 2 + daily.length * barWidth + Math.max(0, daily.length - 1) * barGap);
  const previousScrollLeft = els.chart.scrollLeft;
  const wasPinnedToEnd = shouldScrollChartToLatest(previousScrollLeft);

  const bars = daily
    .map((d, index) => {
      const x = pad + index * (barWidth + barGap);
      const label = formatChartDate(d.date);
      const fullLabel = formatFullDate(d.date);
      const segments = chartSegmentsForDay(d, sourceIds);
      const visibleSegments = chartVisibleSegments(segments, scale.max, chartHeight);
      let yCursor = axisY;
      const segmentRects = visibleSegments
        .map((segment, segmentIndex) => {
          const h = segment.height;
          if (h <= 0) return "";
          yCursor -= h;
          const radius = 3;
          const clipId = `barClip-${index}-${segmentIndex}`;
          const isOnlySegment = visibleSegments.length === 1;
          const isTopSegment = segmentIndex === visibleSegments.length - 1;
          const isBottomSegment = segmentIndex === 0;
          const clipPath = isOnlySegment
            ? roundedRectPath(x, yCursor, barWidth, h, radius, radius, radius, radius)
            : isTopSegment
              ? roundedRectPath(x, yCursor, barWidth, h, radius, radius, 0, 0)
              : isBottomSegment
                ? roundedRectPath(x, yCursor, barWidth, h, 0, 0, radius, radius)
                : roundedRectPath(x, yCursor, barWidth, h, 0, 0, 0, 0);
          return `
            <clipPath id="${clipId}">
              <path d="${clipPath}"></path>
            </clipPath>
            <rect x="${x}" y="${yCursor}" width="${barWidth}" height="${h}" clip-path="url(#${clipId})" fill="${chartSourceColor(segment.id)}">
              <title>${escapeHtml(`${fullLabel} · ${sourceLabel(segment.id)} · ${formatTokens(segment.totalTokens)}`)}</title>
            </rect>
          `;
        })
        .join("");
      return `
        ${segmentRects}
        <text x="${x + barWidth / 2}" y="${dateLabelY}" text-anchor="middle" class="axis-label">${label}</text>
      `;
    })
    .join("");
  const gridLines = scale.ticks
    .map((tick) => {
      const y = axisY - (chartHeight * tick) / scale.max;
      return `
        <line x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}" class="chart-grid-line"></line>
        <text x="${pad - 8}" y="${Math.max(14, y - 6)}" text-anchor="end" class="axis-label">${formatTokens(tick)}</text>
        <text x="${width - 8}" y="${Math.max(14, y - 6)}" text-anchor="end" class="axis-label">${formatTokens(tick)}</text>
      `;
    })
    .join("");
  els.chart.innerHTML = `
    <div class="chart-canvas" style="width: ${width}px">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t("chart.svgAria"))}" style="width: ${width}px">
      ${gridLines}
      <line x1="${pad}" y1="${axisY}" x2="${width - pad}" y2="${axisY}" stroke="#dfe5dd"></line>
      ${bars}
    </svg>
    </div>
  `;
  els.chartLegend.innerHTML = renderChartLegend(sourceIds);
  finishChartRenderScroll(previousScrollLeft, wasPinnedToEnd);
}

function renderCostChart(daily) {
  const costDaily = buildCostDaily(daily);
  const rowsWithCost = costDaily.filter((row) => row.totalEur > 0);
  if (!rowsWithCost.length) {
    els.chart.innerHTML = `<div class="chart-empty">${escapeHtml(t("chart.costs.noData"))}</div>`;
    els.chartLegend.innerHTML = "";
    state.chartRendered = false;
    return;
  }

  const viewportWidth = Math.max(900, els.chart.clientWidth || 900);
  const height = 300;
  const pad = 64;
  const chartTop = 28;
  const axisY = height - 64;
  const dateLabelY = height - 42;
  const chartHeight = axisY - chartTop;
  const sourceIds = costSourcesInUse(rowsWithCost);
  const max = Math.max(...rowsWithCost.map((row) => row.totalEur), 0.01);
  const scale = chartCostScale(max);
  const visibleDays = Math.min(rowsWithCost.length, viewportWidth >= 1200 ? 21 : 16);
  const barGap = 8;
  const barWidth = Math.max(
    24,
    (viewportWidth - pad * 2 - barGap * Math.max(0, visibleDays - 1)) / Math.max(visibleDays, 1)
  );
  const width = Math.max(viewportWidth, pad * 2 + rowsWithCost.length * barWidth + Math.max(0, rowsWithCost.length - 1) * barGap);
  const previousScrollLeft = els.chart.scrollLeft;
  const wasPinnedToEnd = shouldScrollChartToLatest(previousScrollLeft);

  const bars = rowsWithCost
    .map((day, index) => {
      const x = pad + index * (barWidth + barGap);
      const label = formatChartDate(day.date);
      const fullLabel = formatFullDate(day.date);
      const segments = sourceIds
        .map((id) => ({ id, totalEur: Number(day.sourcesById.get(id) || 0) }))
        .filter((segment) => segment.totalEur > 0);
      const visibleSegments = chartVisibleCostSegments(segments, scale.max, chartHeight);
      let yCursor = axisY;
      const segmentRects = visibleSegments
        .map((segment, segmentIndex) => {
          const h = segment.height;
          if (h <= 0) return "";
          yCursor -= h;
          const radius = 3;
          const clipId = `costBarClip-${index}-${segmentIndex}`;
          const isOnlySegment = visibleSegments.length === 1;
          const isTopSegment = segmentIndex === visibleSegments.length - 1;
          const isBottomSegment = segmentIndex === 0;
          const clipPath = isOnlySegment
            ? roundedRectPath(x, yCursor, barWidth, h, radius, radius, radius, radius)
            : isTopSegment
              ? roundedRectPath(x, yCursor, barWidth, h, radius, radius, 0, 0)
              : isBottomSegment
                ? roundedRectPath(x, yCursor, barWidth, h, 0, 0, radius, radius)
                : roundedRectPath(x, yCursor, barWidth, h, 0, 0, 0, 0);
          return `
            <clipPath id="${clipId}">
              <path d="${clipPath}"></path>
            </clipPath>
            <rect x="${x}" y="${yCursor}" width="${barWidth}" height="${h}" clip-path="url(#${clipId})" fill="${chartSourceColor(segment.id)}">
              <title>${escapeHtml(`${fullLabel} · ${sourceLabel(segment.id)} · ${formatEuro(segment.totalEur)}`)}</title>
            </rect>
          `;
        })
        .join("");
      return `
        ${segmentRects}
        <text x="${x + barWidth / 2}" y="${dateLabelY}" text-anchor="middle" class="axis-label">${label}</text>
      `;
    })
    .join("");
  const gridLines = scale.ticks
    .map((tick) => {
      const y = axisY - (chartHeight * tick) / scale.max;
      return `
        <line x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}" class="chart-grid-line"></line>
        <text x="${pad - 8}" y="${Math.max(14, y - 6)}" text-anchor="end" class="axis-label">${escapeHtml(formatChartEuro(tick))}</text>
        <text x="${width - 8}" y="${Math.max(14, y - 6)}" text-anchor="end" class="axis-label">${escapeHtml(formatChartEuro(tick))}</text>
      `;
    })
    .join("");
  els.chart.innerHTML = `
    <div class="chart-canvas" style="width: ${width}px">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t("chart.costs.svgAria"))}" style="width: ${width}px">
      ${gridLines}
      <line x1="${pad}" y1="${axisY}" x2="${width - pad}" y2="${axisY}" stroke="#dfe5dd"></line>
      ${bars}
    </svg>
    </div>
  `;
  els.chartLegend.innerHTML = renderChartLegend(sourceIds);
  finishChartRenderScroll(previousScrollLeft, wasPinnedToEnd);
}

function shouldScrollChartToLatest(previousScrollLeft) {
  const maxScrollLeft = Math.max(0, els.chart.scrollWidth - els.chart.clientWidth);
  return state.chartScrollToLatest || !state.chartRendered || maxScrollLeft - previousScrollLeft < 24;
}

function finishChartRenderScroll(previousScrollLeft, scrollToLatest) {
  window.requestAnimationFrame(() => {
    const maxScrollLeft = Math.max(0, els.chart.scrollWidth - els.chart.clientWidth);
    els.chart.scrollLeft = scrollToLatest ? maxScrollLeft : Math.min(previousScrollLeft, maxScrollLeft);
    state.chartRendered = true;
    state.chartScrollToLatest = false;
  });
}

function buildCostDaily(daily) {
  return (Array.isArray(daily) ? daily : []).map((day) => {
    const sources = Array.isArray(day.sources) ? day.sources : [];
    const sourcesById = new Map();
    const estimatedSources = new Set();
    const unsupportedSources = new Set();
    if (!sources.length && Number(day.totalTokens || 0) > 0) unsupportedSources.add("local");
    for (const source of sources) {
      const totalTokens = Number(source.totalTokens || 0);
      if (!totalTokens) continue;
      const result = estimateSourceCost(source);
      for (const id of result.estimatedSources) estimatedSources.add(id);
      for (const id of result.unsupportedSources) unsupportedSources.add(id);
      if (result.eur > 0) sourcesById.set(source.id, Number(sourcesById.get(source.id) || 0) + result.eur);
    }
    return {
      date: day.date,
      totalEur: Array.from(sourcesById.values()).reduce((sum, value) => sum + value, 0),
      sourcesById,
      estimatedSources: Array.from(estimatedSources),
      unsupportedSources: Array.from(unsupportedSources)
    };
  });
}

function estimateSourceCost(source) {
  const modelRows = Array.isArray(source.models)
    ? source.models.filter((row) => Number(row?.totalTokens || 0) > 0)
    : [];
  if (modelRows.length) {
    let eur = 0;
    const estimatedSources = new Set();
    const unsupportedSources = new Set();
    for (const modelRow of modelRows) {
      const price = pricingModelForUsageModel(modelRow.model);
      if (!price) {
        unsupportedSources.add(costModelGapKey(source.id, modelRow.model));
        continue;
      }
      estimatedSources.add(source.id);
      eur += estimateCost(normalizeBillingTotals(source.id, modelRow), price).eur;
    }
    return {
      eur,
      estimatedSources: Array.from(estimatedSources),
      unsupportedSources: Array.from(unsupportedSources)
    };
  }

  const price = costPricingModelBySource[source.id];
  if (!price) {
    return { eur: 0, estimatedSources: [], unsupportedSources: [source.id] };
  }
  return {
    eur: estimateCost(normalizeBillingTotals(source.id, source), price).eur,
    estimatedSources: costPricingQualityBySource[source.id] === "estimated" ? [source.id] : [],
    unsupportedSources: []
  };
}

function costModelGapKey(sourceId, model) {
  return `${sourceId}::${String(model || "unknown model").trim() || "unknown model"}`;
}

function costSourcesInUse(costDaily) {
  const ids = new Set();
  for (const day of costDaily) {
    for (const id of day.sourcesById.keys()) ids.add(id);
  }
  return [
    ...chartSourceOrder.filter((id) => ids.has(id)),
    ...Array.from(ids).filter((id) => !chartSourceOrder.includes(id)).sort()
  ];
}

function chartCostScale(maxCost) {
  const max = Math.max(0.01, Number(maxCost) || 0.01);
  const step = chartNiceDecimalStep(max / 4);
  const scaleMax = Math.max(step, step * Math.ceil(max / step));
  const ticks = [];
  for (let tick = step; tick <= scaleMax + step / 2; tick += step) {
    ticks.push(Number(tick.toFixed(4)));
  }
  return { max: scaleMax, ticks };
}

function chartNiceDecimalStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 0.01;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const base = CHART_TICK_BASES.find((candidate) => normalized <= candidate) || 10;
  return Number((base * magnitude).toFixed(4));
}

function chartVisibleCostSegments(segments, max, chartHeight) {
  const withHeights = segments.map((segment) => ({
    ...segment,
    height: (chartHeight * segment.totalEur) / max
  }));
  const targetHeight = Math.max(
    2,
    withHeights.reduce((sum, segment) => sum + segment.height, 0)
  );
  const minHeight = withHeights.length > 1 ? 2 : 0;
  for (const segment of withHeights) {
    if (segment.height > 0 && segment.height < minHeight) segment.height = minHeight;
  }
  let overflow = withHeights.reduce((sum, segment) => sum + segment.height, 0) - targetHeight;
  while (overflow > 0.01) {
    const reducible = withHeights
      .filter((segment) => segment.height > minHeight)
      .sort((a, b) => b.height - a.height)[0];
    if (!reducible) break;
    const reduction = Math.min(overflow, reducible.height - minHeight);
    reducible.height -= reduction;
    overflow -= reduction;
  }
  return withHeights;
}

function renderChartLegend(sourceIds) {
  return sourceIds
    .map(
      (id) => `
        <span class="chart-legend-item">
          <span class="chart-legend-swatch" style="background: ${chartSourceColor(id)}"></span>
          <span>${escapeHtml(sourceLabel(id))}</span>
        </span>
      `
    )
    .join("");
}

function renderCostSummary(daily, subscriptionHistory) {
  const summary = summarizeCostWindow(daily, subscriptionHistory);
  const rows = [
    [t("chart.costSummary.apiEquivalent"), summary.apiEquivalent],
    [t("chart.costSummary.paid"), summary.paid],
    [t("chart.costSummary.saved"), summary.saved],
    [t("chart.costSummary.quote"), summary.quote],
    [t("chart.costSummary.quality"), summary.qualityLabel]
  ];
  return `
    <div class="source-bars-title">
      <span>${escapeHtml(t("chart.costSummary.title"))}</span>
      <strong>${escapeHtml(summary.totalLabel)}</strong>
    </div>
    ${rows
      .map(([label, value]) => {
        return `
          <div class="source-bar-row">
            <span class="source-bar-name">${escapeHtml(label)}</span>
            <span class="source-bar-track cost-summary-track" aria-hidden="true"></span>
            <span class="source-bar-value">${escapeHtml(value)}</span>
          </div>
        `;
      })
      .join("")}
    ${summary.note ? `<p class="cost-summary-note">${escapeHtml(summary.note)}</p>` : ""}
  `;
}

function summarizeCostWindow(daily, subscriptionHistory) {
  const costDaily = buildCostDaily(daily);
  const apiEquivalentEur = costDaily.reduce((sum, day) => sum + day.totalEur, 0);
  const allEstimated = new Set(costDaily.flatMap((day) => day.estimatedSources));
  const allUnsupported = new Set(costDaily.flatMap((day) => day.unsupportedSources));
  const range = chartRangeForDaily(daily);
  const paidResult = range
    ? calculatePaidSubscriptionCost(subscriptionHistory, range.start, range.end)
    : { known: false, totalEur: 0, unsupportedCurrencies: [] };
  const savedEur = paidResult.known ? apiEquivalentEur - paidResult.totalEur : null;
  const quote = paidResult.known && apiEquivalentEur > 0 ? (savedEur / apiEquivalentEur) * 100 : null;
  const quality = summarizeCostQuality({
    apiEquivalentEur,
    hasRange: Boolean(range),
    paidKnown: paidResult.known,
    estimatedSources: Array.from(allEstimated),
    unsupportedSources: Array.from(allUnsupported),
    unsupportedCurrencies: paidResult.unsupportedCurrencies
  });

  return {
    totalLabel: apiEquivalentEur > 0 ? formatEuro(apiEquivalentEur) : "--",
    apiEquivalent: apiEquivalentEur > 0 ? formatEuro(apiEquivalentEur) : "--",
    paid: paidResult.known ? formatEuro(paidResult.totalEur) : "--",
    saved: savedEur === null ? "--" : formatEuro(savedEur),
    quote: quote === null ? "--" : formatSharePercent(quote),
    qualityLabel: quality.label,
    note: quality.note
  };
}

function summarizeCostQuality({ apiEquivalentEur, hasRange, paidKnown, estimatedSources, unsupportedSources, unsupportedCurrencies }) {
  if (!hasRange || apiEquivalentEur <= 0) {
    return {
      label: t("chart.costSummary.qualityUnavailable"),
      note: t("chart.costs.noData")
    };
  }
  if (!paidKnown) {
    return {
      label: t("chart.costSummary.qualityPartial"),
      note: t("chart.costSummary.missingSubscriptions")
    };
  }

  const details = [];
  if (estimatedSources.length) {
    details.push(t("chart.costSummary.estimatedSources", { providers: estimatedSources.map(costSourceLabel).join(", ") }));
  }
  if (unsupportedSources.length) {
    details.push(t("chart.costSummary.missingSources", { providers: unsupportedSources.map(costSourceLabel).join(", ") }));
  }
  if (unsupportedCurrencies.length) {
    details.push(t("chart.costSummary.unsupportedCurrencies", { currencies: unsupportedCurrencies.join(", ") }));
  }
  return {
    label: details.length ? t("chart.costSummary.qualityPartial") : t("chart.costSummary.qualityComplete"),
    note: details.join(" ")
  };
}

function costSourceLabel(id) {
  const [sourceId, model] = String(id || "").split("::");
  return model ? `${sourceLabel(sourceId)} (${model})` : sourceLabel(sourceId);
}

function chartRangeForDaily(daily) {
  const dates = (Array.isArray(daily) ? daily : [])
    .map((day) => day.date)
    .filter(Boolean)
    .sort();
  if (!dates.length) return null;
  return { start: dates[0], end: dates[dates.length - 1] };
}

function calculatePaidSubscriptionCost(subscriptionHistory, startDate, endDate) {
  const entries = Array.isArray(subscriptionHistory?.entries) ? subscriptionHistory.entries : [];
  if (!entries.length) {
    return { known: false, totalEur: 0, unsupportedCurrencies: [] };
  }
  let totalEur = 0;
  let anyOverlap = false;
  const unsupportedCurrencies = new Set();
  for (const entry of entries) {
    const rangeStart = entry.effectiveFrom && entry.effectiveFrom > startDate ? entry.effectiveFrom : startDate;
    const rangeEnd = entry.effectiveTo && entry.effectiveTo < endDate ? entry.effectiveTo : endDate;
    if (!rangeStart || !rangeEnd || rangeStart > rangeEnd) continue;
    anyOverlap = true;
    const amount = proratedSubscriptionEntryCost(entry, startDate, endDate);
    if (amount === null) {
      unsupportedCurrencies.add(String(entry.currency || "").toUpperCase());
      continue;
    }
    totalEur += amount;
  }
  if (!anyOverlap) {
    return { known: false, totalEur: 0, unsupportedCurrencies: [] };
  }
  return {
    known: true,
    totalEur,
    unsupportedCurrencies: Array.from(unsupportedCurrencies).filter(Boolean)
  };
}

function proratedSubscriptionEntryCost(entry, startDate, endDate) {
  const rangeStart = entry.effectiveFrom && entry.effectiveFrom > startDate ? entry.effectiveFrom : startDate;
  const rangeEnd = entry.effectiveTo && entry.effectiveTo < endDate ? entry.effectiveTo : endDate;
  if (!rangeStart || !rangeEnd || rangeStart > rangeEnd) return 0;

  const monthlyCost = Number(entry.monthlyCost || 0);
  if (!(monthlyCost > 0)) return 0;

  let total = 0;
  const cursor = parseDateOnly(rangeStart);
  const end = parseDateOnly(rangeEnd);
  if (!cursor || !end) return 0;

  while (cursor <= end) {
    const dailyAmount = convertSubscriptionAmountToEur(monthlyCost, entry.currency, cursor);
    if (dailyAmount === null) return null;
    total += dailyAmount;
    cursor.setDate(cursor.getDate() + 1);
  }

  return total;
}

function convertSubscriptionAmountToEur(monthlyCost, currency, date) {
  const normalizedCurrency = String(currency || "EUR").toUpperCase();
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const dailyAmount = monthlyCost / Math.max(daysInMonth, 1);
  if (normalizedCurrency === "EUR") return dailyAmount;
  if (normalizedCurrency === "USD") return dailyAmount / USD_PER_EUR;
  return null;
}

function chartTokenScale(maxTokens) {
  const max = Math.max(1, Number(maxTokens) || 0);
  if (max > 250_000_000 && max <= 500_000_000) {
    return {
      max: 500_000_000,
      ticks: [100_000_000, 200_000_000, 300_000_000, 400_000_000, 500_000_000]
    };
  }
  if (max > 500_000_000 && max <= 1_000_000_000) {
    return {
      max: 1_000_000_000,
      ticks: [250_000_000, 500_000_000, 750_000_000, 1_000_000_000]
    };
  }
  const step = chartNiceTickStep(max / 4);
  return chartScaleFromStep(max, step);
}

function chartScaleFromStep(max, step) {
  const tickStep = Math.max(1, Number(step) || 1);
  const scaleMax = Math.max(tickStep, tickStep * Math.ceil(max / tickStep));
  const ticks = [];
  for (let tick = tickStep; tick <= scaleMax + tickStep / 2; tick += tickStep) {
    ticks.push(Math.round(tick));
  }
  return { max: scaleMax, ticks };
}

function chartNiceTickStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const base = CHART_TICK_BASES.find((candidate) => normalized <= candidate) || 10;
  return Math.max(1, base * magnitude);
}

function chartSourcesInUse(daily) {
  const ids = new Set(chartSourceTotals(daily).map((source) => source.id));
  if (!ids.size) return ["local"];
  return [
    ...chartSourceOrder.filter((id) => ids.has(id)),
    ...Array.from(ids).filter((id) => !chartSourceOrder.includes(id)).sort()
  ];
}

function chartSourceTotals(daily) {
  const totals = new Map();
  for (const day of daily) {
    const sources = Array.isArray(day.sources) ? day.sources : [];
    if (!sources.length && Number(day.totalTokens || 0) > 0) {
      totals.set("local", Number(totals.get("local") || 0) + Number(day.totalTokens || 0));
    }
    for (const source of sources) {
      const tokens = Number(source.totalTokens || 0);
      if (!tokens) continue;
      totals.set(source.id, Number(totals.get(source.id) || 0) + tokens);
    }
  }
  return [
    ...chartSourceOrder
      .filter((id) => totals.has(id))
      .map((id) => ({ id, totalTokens: totals.get(id) })),
    ...Array.from(totals.entries())
      .filter(([id]) => !chartSourceOrder.includes(id))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, totalTokens]) => ({ id, totalTokens }))
  ];
}

function chartSegmentsForDay(day, sourceIds) {
  const sources = Array.isArray(day.sources) ? day.sources : [];
  if (!sources.length) return [{ id: "local", totalTokens: day.totalTokens || 0 }];
  const byId = new Map(sources.map((source) => [source.id, Number(source.totalTokens || 0)]));
  return sourceIds
    .map((id) => ({ id, totalTokens: byId.get(id) || 0 }))
    .filter((source) => source.totalTokens > 0);
}

function chartVisibleSegments(segments, max, chartHeight) {
  const withHeights = segments.map((segment) => ({
    ...segment,
    height: (chartHeight * segment.totalTokens) / max
  }));
  const targetHeight = Math.max(
    2,
    withHeights.reduce((sum, segment) => sum + segment.height, 0)
  );
  const minHeight = withHeights.length > 1 ? 2 : 0;
  for (const segment of withHeights) {
    if (segment.height > 0 && segment.height < minHeight) segment.height = minHeight;
  }
  let overflow = withHeights.reduce((sum, segment) => sum + segment.height, 0) - targetHeight;
  while (overflow > 0.01) {
    const reducible = withHeights
      .filter((segment) => segment.height > minHeight)
      .sort((a, b) => b.height - a.height)[0];
    if (!reducible) break;
    const reduction = Math.min(overflow, reducible.height - minHeight);
    reducible.height -= reduction;
    overflow -= reduction;
  }
  return withHeights;
}

function roundedRectPath(x, y, width, height, topLeft, topRight, bottomRight, bottomLeft) {
  const maxRadius = Math.max(0, Math.min(width / 2, height / 2));
  const tl = Math.min(topLeft, maxRadius);
  const tr = Math.min(topRight, maxRadius);
  const br = Math.min(bottomRight, maxRadius);
  const bl = Math.min(bottomLeft, maxRadius);
  return [
    `M ${x + tl} ${y}`,
    `H ${x + width - tr}`,
    tr ? `Q ${x + width} ${y} ${x + width} ${y + tr}` : `L ${x + width} ${y}`,
    `V ${y + height - br}`,
    br ? `Q ${x + width} ${y + height} ${x + width - br} ${y + height}` : `L ${x + width} ${y + height}`,
    `H ${x + bl}`,
    bl ? `Q ${x} ${y + height} ${x} ${y + height - bl}` : `L ${x} ${y + height}`,
    `V ${y + tl}`,
    tl ? `Q ${x} ${y} ${x + tl} ${y}` : `L ${x} ${y}`,
    "Z"
  ].join(" ");
}

function chartSourceColor(id) {
  return chartSourceColors[id] || "#66716b";
}

function formatChartDate(value) {
  const date = parseDateOnly(value);
  if (!date) return value;
  return new Intl.DateTimeFormat(currentLocale(), {
    day: "2-digit",
    month: "2-digit"
  }).format(date);
}

function formatFullDate(value) {
  const date = parseDateOnly(value);
  if (!date) return value;
  return new Intl.DateTimeFormat(currentLocale(), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function parseDateOnly(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function openSettings() {
  if (!state.auth?.authenticated) return openModalDialog(els.loginDialog);
  openModalDialog(els.settingsDialog);
  renderSourceSettings();
  await Promise.all([
    loadSubscriptionSettings(),
    loadUpdateSettingsAndStatus(),
    loadNotificationSettings(),
    loadNotificationStatus(),
    loadSourceDiagnostics()
  ]);
}

async function loadSubscriptionSettings() {
  if (!els.subscriptionFields.length) return;
  hideSettingsToast();
  try {
    const settings = await fetchJson("/api/subscriptions/settings");
    fillSubscriptionSettings(settings);
  } catch {
    showSettingsToast(t("settings.subscriptions.saveError"), "error");
  }
}

function fillSubscriptionSettings(settings) {
  for (const field of els.subscriptionFields) {
    const provider = field.dataset.subscriptionProvider;
    const key = field.dataset.subscriptionField;
    if (!provider || !key) continue;
    const value = settings?.[provider]?.[key];
    field.value = field.type === "number" && Number(value || 0) === 0 ? "" : value ?? "";
  }
}

async function saveSubscriptionSettings() {
  const payload = {};
  for (const field of els.subscriptionFields) {
    const provider = field.dataset.subscriptionProvider;
    const key = field.dataset.subscriptionField;
    if (!provider || !key) continue;
    payload[provider] ||= {};
    payload[provider][key] = field.type === "number" ? Number(field.value || 0) : String(field.value || "").trim();
    payload[provider].currency ||= "EUR";
  }
  try {
    const settings = await fetchJson("/api/subscriptions/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    fillSubscriptionSettings(settings);
    showSettingsToast(t("settings.subscriptions.saved"), "ready");
    await loadUsage({ force: true });
  } catch {
    showSettingsToast(t("settings.subscriptions.saveError"), "error", { persistMs: 5000 });
  }
}

async function loadUpdateSettings() {
  if (!els.updateSettingsSection) return;
  try {
    const settings = await fetchJson("/api/updates/settings");
    if (els.updateChecksEnabled) els.updateChecksEnabled.checked = Boolean(settings.enabled);
    if (els.allowPrereleaseUpdates) els.allowPrereleaseUpdates.checked = Boolean(settings.allowPrerelease);
  } catch {
    // Ignore; update settings are only useful in the desktop shell.
  }
}

async function loadUpdateSettingsAndStatus() {
  await loadUpdateSettings();
  await loadUpdateStatus();
}

async function saveUpdateSettings() {
  if (!els.updateSettingsSection) return;
  const payload = {
    enabled: Boolean(els.updateChecksEnabled?.checked),
    allowPrerelease: Boolean(els.allowPrereleaseUpdates?.checked)
  };
  try {
    const settings = await fetchJson("/api/updates/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (els.updateChecksEnabled) els.updateChecksEnabled.checked = Boolean(settings.enabled);
    if (els.allowPrereleaseUpdates) els.allowPrereleaseUpdates.checked = Boolean(settings.allowPrerelease);
    showSettingsToast(t("settings.updates.saved"), "ready");
    await loadUpdateStatus();
  } catch {
    showSettingsToast(t("settings.updates.saveError"), "error", { persistMs: 5000 });
  }
}

async function loadUpdateStatus() {
  if (!els.updateSettingsSection) return;
  try {
    const status = await fetchJson("/api/updates/status");
    if (!status?.isElectron) {
      els.updateSettingsSection.hidden = true;
      return;
    }
    els.updateSettingsSection.hidden = false;
    renderUpdateStatus(status);
  } catch {
    els.updateSettingsSection.hidden = true;
  }
}

function renderUpdateStatus(status) {
  const none = t("settings.updates.diagNone");
  const state = status?.state || "unknown";
  const support = status?.supportStatus || (status?.supported ? "ready" : "unknown");
  if (els.updateDiagState) {
    const key = `settings.updates.state_${state}`;
    const text = t(key, { percent: status?.downloadPercent ?? "" }, state);
    els.updateDiagState.textContent = status?.downloadPercent && state === "downloading"
      ? `${text} (${status.downloadPercent}%)`
      : text;
    els.updateDiagState.className = ["error", "macos_signing_required", "unsupported_platform"].includes(state)
      ? "diag-error"
      : "";
  }
  if (els.updateDiagSupport) {
    els.updateDiagSupport.textContent = t(`settings.updates.support_${support}`, {}, support || none);
    els.updateDiagSupport.className = status?.supported === false ? "diag-error" : "";
  }
  if (els.updateDiagLastCheck) els.updateDiagLastCheck.textContent = formatUpdateTime(status?.lastCheckAt, none);
  if (els.updateDiagVersion) els.updateDiagVersion.textContent = status?.appVersion || none;
  if (els.updateDiagAvailable) {
    els.updateDiagAvailable.textContent = status?.downloadedVersion || status?.availableVersion || none;
  }
  if (els.updateDiagError) {
    els.updateDiagError.textContent = status?.lastError || none;
    els.updateDiagError.className = status?.lastError ? "diag-error" : "";
  }
  if (els.updateCheckBtn) {
    els.updateCheckBtn.disabled = status?.supported === false || !els.updateChecksEnabled?.checked;
  }
  renderUpdateNotice(status);
}

function formatUpdateTime(iso, fallback) {
  if (!iso) return fallback;
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function renderUpdateNotice(status) {
  if (!els.updateNotice || !els.updateNoticeBody) return;
  const key = updateNoticeKey(status);
  if (!key) {
    els.updateNotice.hidden = true;
    return;
  }
  els.updateNoticeBody.textContent = t(key);
  els.updateNotice.hidden = false;
}

function updateNoticeKey(status) {
  if (!status?.isElectron) return "";
  if (status.supportStatus === "macos_signing_required") return "settings.updates.noticeMacSigning";
  if (status.supportStatus === "development_build") return "settings.updates.noticeDevelopment";
  if (status.supportStatus === "unsupported_platform") return "settings.updates.noticeUnsupported";
  if (status.supportStatus === "macos_gatekeeper_warning") return "settings.updates.noticeGatekeeper";
  if (status.state === "downloaded") return "settings.updates.noticeDownloaded";
  if (status.state === "error") return "settings.updates.noticeError";
  return "";
}

async function requestUpdateCheck() {
  if (!els.updateCheckBtn) return;
  els.updateCheckBtn.disabled = true;
  try {
    await fetchJson("/api/updates/check", { method: "POST" });
    if (els.updateCheckStatus) {
      els.updateCheckStatus.textContent = t("settings.updates.checkQueued");
      els.updateCheckStatus.hidden = false;
    }
    setTimeout(() => loadUpdateStatus().catch(() => {}), 2000);
    setTimeout(() => loadUpdateStatus().catch(() => {}), 8000);
  } catch {
    if (els.updateCheckStatus) {
      els.updateCheckStatus.textContent = t("settings.updates.checkError");
      els.updateCheckStatus.hidden = false;
    }
  } finally {
    setTimeout(() => {
      if (els.updateCheckStatus) els.updateCheckStatus.hidden = true;
      loadUpdateStatus().catch(() => {});
    }, 12000);
  }
}

function scheduleSettingsAutosave(type) {
  clearTimeout(state.settingsAutosaveTimers[type]);
  state.settingsAutosaveTimers[type] = setTimeout(() => {
    if (type === "subscriptions") saveSubscriptionSettings().catch(() => {});
    if (type === "notifications") saveNotificationSettings().catch(() => {});
    if (type === "updates") saveUpdateSettings().catch(() => {});
  }, SETTINGS_AUTOSAVE_DELAY_MS);
}

async function loadNotificationSettings() {
  if (!els.notificationsEnabled) return;
  try {
    const settings = await fetchJson("/api/notifications/settings");
    els.notificationsEnabled.checked = Boolean(settings.enabled);
    if (els.notificationPacingPercent) els.notificationPacingPercent.value = settings.pacingPercent ?? 100;
    if (els.notificationHardLimitPercent) els.notificationHardLimitPercent.value = settings.hardLimitPercent ?? 95;
    if (els.notificationThresholds) els.notificationThresholds.hidden = !settings.enabled;
  } catch {
    // Ignore; notification settings are non-critical.
  }
}

function onNotificationEnabledChange() {
  if (els.notificationThresholds) els.notificationThresholds.hidden = !els.notificationsEnabled.checked;
}

async function saveNotificationSettings() {
  if (!els.notificationsEnabled) return;
  const payload = {
    enabled: els.notificationsEnabled.checked,
    pacingPercent: Number(els.notificationPacingPercent?.value ?? 100),
    hardLimitPercent: Number(els.notificationHardLimitPercent?.value ?? 95)
  };
  try {
    await fetchJson("/api/notifications/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    showSettingsToast(t("settings.notifications.saved"), "ready");
  } catch {
    showSettingsToast(t("settings.notifications.saveError"), "error", { persistMs: 5000 });
  }
}

async function loadNotificationStatus() {
  if (!els.notificationDiagLastCheck) return;
  try {
    const status = await fetchJson("/api/notifications/status");
    const none = t("settings.notifications.diagNone");
    const never = t("settings.notifications.diagNever");
    const formatStatusTime = (iso) => {
      if (!iso) return never;
      try { return new Date(iso).toLocaleString(); } catch { return iso; }
    };
    const formatMs = (ms) => (Number.isFinite(ms) ? `${ms} ms` : none);

    if (els.notificationDiagLastCheck) els.notificationDiagLastCheck.textContent = formatStatusTime(status?.lastCheckAt);
    if (els.notificationDiagDuration) els.notificationDiagDuration.textContent = formatMs(status?.lastCheckDurationMs);
    if (els.notificationDiagAlerts) {
      els.notificationDiagAlerts.textContent = status != null ? String(status.lastAlertCount ?? 0) : none;
    }
    if (els.notificationDiagLastShown) els.notificationDiagLastShown.textContent = formatStatusTime(status?.lastShownAt);
    if (els.notificationDiagSkipped) els.notificationDiagSkipped.textContent = status?.lastSkippedReason || none;
    if (els.notificationDiagError) {
      const error = status?.lastError;
      els.notificationDiagError.textContent = error || none;
      els.notificationDiagError.className = error ? "diag-error" : "";
    }
    if (els.notificationDiagSupported) {
      const supported = status?.notificationSupported;
      els.notificationDiagSupported.textContent =
        supported == null ? none :
        supported ? t("settings.notifications.diagYes") : t("settings.notifications.diagNo");
    }
    if (els.notificationDiagNativeDelivery) {
      const nativeDelivery = status?.macNotificationDiagnostics?.nativeDelivery || "unknown";
      els.notificationDiagNativeDelivery.textContent =
        status?.macNotificationDiagnostics == null
          ? none
          : t(`settings.notifications.nativeDelivery_${nativeDelivery}`, {}, nativeDelivery);
      els.notificationDiagNativeDelivery.className =
        ["ad_hoc", "gatekeeper_rejected", "invalid"].includes(nativeDelivery) ? "diag-error" : "";
    }
    const permission = updateNotificationPermissionDiagnostic();
    renderNotificationSystemGuidance(status, { permission });
    if (status?.lastTestAt && els.notificationLastTestDetails) {
      els.notificationLastTestDetails.hidden = false;
      if (els.notificationLastTestAt) els.notificationLastTestAt.textContent = formatStatusTime(status.lastTestAt);
      if (els.notificationLastTestResult) {
        const resultKey = `settings.notifications.testResult_${status.lastTestResult}`;
        els.notificationLastTestResult.textContent = t(resultKey, {}, status.lastTestResult || none);
      }
    }
  } catch {
    // Diagnostic info is non-critical; ignore errors silently.
  }
}

function getNotificationPermissionStatus() {
  if (typeof window.Notification !== "function") return "unsupported";
  return window.Notification.permission || "unknown";
}

function updateNotificationPermissionDiagnostic() {
  const permission = getNotificationPermissionStatus();
  if (els.notificationDiagPermission) {
    els.notificationDiagPermission.textContent = t(`settings.notifications.permission_${permission}`, {}, permission);
  }
  return permission;
}

function renderNotificationSystemGuidance(status, { permission = getNotificationPermissionStatus(), force = false, bodyKey = "" } = {}) {
  if (!els.notificationPermissionNotice) return;
  const guidanceKey = bodyKey || notificationSystemGuidanceKey(status, permission);
  if (!force && !guidanceKey) {
    els.notificationPermissionNotice.hidden = true;
    return;
  }
  if (els.notificationPermissionNoticeTitle) {
    els.notificationPermissionNoticeTitle.textContent = t("settings.notifications.systemGuideTitle");
  }
  if (els.notificationPermissionNoticeBody) {
    els.notificationPermissionNoticeBody.textContent = t(guidanceKey || "settings.notifications.systemGuideDefault");
  }
  els.notificationPermissionNotice.hidden = false;
}

function notificationSystemGuidanceKey(status, permission) {
  if (permission === "unsupported") return "settings.notifications.systemGuideUnsupported";
  if (permission && permission !== "granted") return "settings.notifications.systemGuidePermission";
  const nativeDelivery = status?.macNotificationDiagnostics?.nativeDelivery || "";
  if (["ad_hoc", "gatekeeper_rejected", "invalid", "unverified"].includes(nativeDelivery)) {
    return "settings.notifications.systemGuideNativeUnverified";
  }
  if (status?.lastTestResult === "error" || String(status?.lastSkippedReason || "").startsWith("notification_failed")) {
    return "settings.notifications.systemGuideTestFailed";
  }
  return "";
}

async function requestNotificationPermissionForTest() {
  if (typeof window.Notification !== "function") return "unsupported";
  const current = window.Notification.permission || "unknown";
  if (current !== "default") return current;
  if (typeof window.Notification.requestPermission !== "function") return current;
  try {
    return await window.Notification.requestPermission();
  } catch {
    return "error";
  }
}

function showRendererTestNotification() {
  if (typeof window.Notification !== "function") return { result: "unsupported", error: null };
  if (window.Notification.permission !== "granted") {
    return { result: "permission_denied", error: null };
  }
  try {
    const notification = new window.Notification(t("settings.notifications.testTitle"), {
      body: t("settings.notifications.testBody"),
      tag: "llm-usage-dashboard-test",
      silent: false
    });
    state.activeRendererNotifications.add(notification);
    const release = () => state.activeRendererNotifications.delete(notification);
    notification.onclick = () => {
      window.focus();
      release();
    };
    notification.onclose = release;
    notification.onerror = release;
    setTimeout(release, 60_000);
    return { result: "sent", error: null };
  } catch (error) {
    return { result: "error", error: error?.message || String(error) };
  }
}

function showInAppTestNotification({ status = "ready", bodyKey = "settings.notifications.inAppTestBody", bodyValues = {} } = {}) {
  if (!els.notificationTestPreview) return;
  clearTimeout(state.notificationPreviewTimer);
  els.notificationTestPreview.hidden = false;
  els.notificationTestPreview.dataset.status = status;
  if (els.notificationTestPreviewTitle) {
    els.notificationTestPreviewTitle.textContent = status === "error"
      ? t("settings.notifications.inAppTestErrorTitle")
      : t("settings.notifications.inAppTestTitle");
  }
  if (els.notificationTestPreviewBody) {
    els.notificationTestPreviewBody.textContent = t(bodyKey, bodyValues);
  }
  state.notificationPreviewTimer = setTimeout(() => {
    if (els.notificationTestPreview) els.notificationTestPreview.hidden = true;
  }, 30_000);
}

async function openNotificationSettings({ silent = false } = {}) {
  if (!els.notificationSettingsBtn) return;
  els.notificationSettingsBtn.disabled = true;
  try {
    await fetchJson("/api/notifications/open-settings", { method: "POST" });
    if (!silent && els.notificationTestStatus) {
      els.notificationTestStatus.textContent = t("settings.notifications.openSettingsQueued");
      els.notificationTestStatus.hidden = false;
    }
    renderNotificationSystemGuidance(null, { force: true, bodyKey: "settings.notifications.systemGuideDefault" });
    if (!silent) {
      showInAppTestNotification({
        bodyKey: "settings.notifications.openSettingsQueued"
      });
    }
  } catch {
    if (!silent && els.notificationTestStatus) {
      els.notificationTestStatus.textContent = t("settings.notifications.openSettingsError");
      els.notificationTestStatus.hidden = false;
    }
    if (!silent) {
      showInAppTestNotification({
        status: "error",
        bodyKey: "settings.notifications.openSettingsError"
      });
    }
  } finally {
    els.notificationSettingsBtn.disabled = false;
  }
}

async function sendTestNotification() {
  if (!els.notificationTestBtn) return;
  els.notificationTestBtn.disabled = true;
  if (els.notificationTestStatus) els.notificationTestStatus.hidden = true;
  let hideStatus = true;
  try {
    const permission = await requestNotificationPermissionForTest();
    updateNotificationPermissionDiagnostic();
    if (permission === "unsupported") {
      await openNotificationSettings({ silent: true });
      if (els.notificationTestStatus) {
        els.notificationTestStatus.textContent = t("settings.notifications.permissionUnsupported");
        els.notificationTestStatus.hidden = false;
      }
      renderNotificationSystemGuidance(null, {
        force: true,
        bodyKey: "settings.notifications.systemGuideUnsupported"
      });
      showInAppTestNotification({
        status: "error",
        bodyKey: "settings.notifications.permissionUnsupported"
      });
      hideStatus = false;
      return;
    }
    if (permission !== "granted") {
      await openNotificationSettings({ silent: true });
      if (els.notificationTestStatus) {
        els.notificationTestStatus.textContent = t("settings.notifications.permissionNotGranted");
        els.notificationTestStatus.hidden = false;
      }
      renderNotificationSystemGuidance(null, {
        force: true,
        bodyKey: "settings.notifications.systemGuidePermission"
      });
      showInAppTestNotification({
        status: "error",
        bodyKey: "settings.notifications.permissionNotGranted"
      });
      hideStatus = false;
      return;
    }
    const rendererDelivery = showRendererTestNotification();
    await fetchJson("/api/notifications/test", { method: "POST" });
    renderNotificationSystemGuidance(null, {
      force: true,
      bodyKey: "settings.notifications.systemGuideAfterTest"
    });
    showInAppTestNotification(
      rendererDelivery.result === "error"
        ? {
            status: "error",
            bodyKey: "settings.notifications.testQueuedRendererError",
            bodyValues: { error: rendererDelivery.error || "" }
          }
        : {}
    );
    if (els.notificationTestStatus) {
      els.notificationTestStatus.textContent = rendererDelivery.result === "error"
        ? t("settings.notifications.testQueuedRendererError", { error: rendererDelivery.error || "" })
        : t("settings.notifications.testQueued");
      els.notificationTestStatus.hidden = false;
    }
    setTimeout(() => loadNotificationStatus().catch(() => {}), 8000);
  } catch {
    if (els.notificationTestStatus) {
      els.notificationTestStatus.textContent = t("settings.notifications.testError");
      els.notificationTestStatus.hidden = false;
    }
    showInAppTestNotification({
      status: "error",
      bodyKey: "settings.notifications.testError"
    });
    hideStatus = false;
  } finally {
    if (els.notificationTestBtn) els.notificationTestBtn.disabled = false;
    if (hideStatus) {
      setTimeout(() => {
        if (els.notificationTestStatus) els.notificationTestStatus.hidden = true;
      }, 10000);
    }
  }
}

function renderSourceDiagnostics() {
  if (!els.sourceDiagnosticsSection) return;
  const authed = state.auth?.authenticated;
  els.sourceDiagnosticsSection.hidden = !authed;
  if (!authed) return;

  const diagnostics = state.sourceDiagnostics;
  const status = state.sourceDiagnosticsError ? "discovery_error" : diagnostics?.status || "current_user_empty";
  const currentUser = diagnostics?.currentUser || {};
  const generatedAt = diagnostics?.generatedAt ? formatUpdatedAt(diagnostics.generatedAt) : "--";
  const supportLevel = diagnostics?.os?.supportLevel || "full";

  els.sourceDiagnosticsMeta.textContent = t("diagnostics.meta", {
    user: currentUser.name || "--",
    home: currentUser.home || "--",
    checkedAt: generatedAt,
    platform: diagnostics?.os?.platform || navigator.platform || "--",
    support: t(`diagnostics.support.${supportLevel}`, {}, supportLevel)
  });
  els.sourceDiagnosticsSummary.innerHTML = renderDiagnosticsSummary(diagnostics);
  els.sourceDiagnosticsGrid.innerHTML = DIAGNOSTIC_STATUS_ORDER.map((entry) => renderDiagnosticStatusCard(entry, status)).join("");
  els.sourceDiagnosticsInstances.innerHTML = renderOtherDashboardInstances(diagnostics?.otherDashboardInstances || []);
  els.diagnosticsRecheckBtn.disabled = isSourceOpPending("recheck", "global");
}

function renderDiagnosticsSummary(diagnostics) {
  if (state.sourceDiagnosticsError) {
    return `<div class="diagnostics-summary-card diagnostics-summary-error">${escapeHtml(
      t("diagnostics.errors.load", { message: state.sourceDiagnosticsError }, state.sourceDiagnosticsError)
    )}</div>`;
  }
  if (!diagnostics) {
    return `<div class="diagnostics-summary-card">${escapeHtml(t("diagnostics.loading"))}</div>`;
  }
  const counts = diagnostics.counts || {};
  const bits = [
    t("diagnostics.summary.connected", { count: formatNumber(counts.connected || 0) }),
    t("diagnostics.summary.readable", { count: formatNumber(counts.readable || 0) }),
    t("diagnostics.summary.denied", { count: formatNumber(counts.denied || 0) }),
    t("diagnostics.summary.processOnly", { count: formatNumber(counts.processOnly || 0) })
  ];
  return `
    <div class="diagnostics-summary-card">
      <strong>${escapeHtml(t(`diagnostics.statuses.${diagnostics.status}.title`))}</strong>
      <span>${escapeHtml(bits.join(" · "))}</span>
    </div>
  `;
}

function renderDiagnosticStatusCard(statusId, activeStatus) {
  const active = statusId === activeStatus;
  return `
    <article class="diagnostic-state-card${active ? " is-active" : ""}">
      <div class="diagnostic-state-head">
        <i data-lucide="${escapeHtml(DIAGNOSTIC_STATUS_ICONS[statusId] || "circle")}"></i>
        <strong>${escapeHtml(t(`diagnostics.statuses.${statusId}.title`))}</strong>
      </div>
      <p>${escapeHtml(t(`diagnostics.statuses.${statusId}.body`))}</p>
    </article>
  `;
}

function renderOtherDashboardInstances(instances) {
  if (!Array.isArray(instances) || !instances.length) return "";
  return `
    <div class="diagnostics-instances-card">
      <strong>${escapeHtml(t("diagnostics.instances.title"))}</strong>
      ${instances
        .map((instance) => {
          return `
            <div class="diagnostics-instance-row">
              <span>${escapeHtml(t("diagnostics.instances.item", {
                user: instance.user || "--",
                port: formatNumber(instance.port || 0),
                pid: formatNumber(instance.pid || 0)
              }))}</span>
              <strong>${escapeHtml(instance.url || "--")}</strong>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderSourceSettings() {
  if (!els.settingsConnectedSources || !els.settingsCandidateSources || !els.settingsSourceSummary) return;
  const diagnostics = state.sourceDiagnostics;
  const connected = Array.isArray(diagnostics?.connected) ? diagnostics.connected : [];
  const candidates = Array.isArray(diagnostics?.candidates) ? diagnostics.candidates : [];
  const availableCandidates = candidates.filter((source) => !source.connected);

  if (els.settingsSourcesStatus) {
    const fallback = state.sourceDiagnosticsError ? t("diagnostics.errors.load", { message: state.sourceDiagnosticsError }) : "";
    const message = state.sourceMessage.text || fallback;
    els.settingsSourcesStatus.textContent = message;
    els.settingsSourcesStatus.hidden = !message;
    els.settingsSourcesStatus.dataset.status = state.sourceMessage.text ? state.sourceMessage.status || "" : "error";
  }

  els.settingsSourcesRecheckBtn.disabled = isSourceOpPending("recheck", "global");
  els.settingsSourceSummary.innerHTML = diagnostics
    ? `
        <div class="settings-source-pill">${escapeHtml(t("settings.sources.summaryStatus", {
          status: t(`diagnostics.statuses.${diagnostics.status}.title`)
        }))}</div>
        <div class="settings-source-pill">${escapeHtml(t("settings.sources.summaryCounts", {
          connected: formatNumber(connected.length),
          candidates: formatNumber(candidates.length)
        }))}</div>
      `
    : `<div class="settings-source-pill">${escapeHtml(t("diagnostics.loading"))}</div>`;
  els.settingsConnectedSources.innerHTML = connected.length
    ? connected.map((source) => renderSourceCard(source, { mode: "connected" })).join("")
    : `<p class="source-list-empty">${escapeHtml(t("settings.sources.connectedEmpty"))}</p>`;
  els.settingsCandidateSources.innerHTML = availableCandidates.length
    ? availableCandidates.map((source) => renderSourceCard(source, { mode: "candidate" })).join("")
    : `<p class="source-list-empty">${escapeHtml(t("settings.sources.candidatesEmpty"))}</p>`;
  refreshIcons();
}

function renderSourceCard(source, { mode }) {
  const provider = providerName(source.providerId);
  const owner = source.owner?.current ? t("settings.sources.currentUser") : source.owner?.name || "--";
  const access = t(`settings.sources.access.${source.accessStatus}`, {}, source.accessStatus || "--");
  const paths = Array.isArray(source.paths) ? source.paths : [];
  const grantCommands = source.suggestedAction?.commands || [];
  const revokeCommands = source.suggestedAction?.revokeCommands || [];
  const canConnect = mode === "candidate" && ["readable", "mixed"].includes(source.accessStatus);
  const canDisable = mode === "connected";
  const pathMarkup = paths.length
    ? paths
        .map((entry) => {
          return `
            <li>
              <strong>${escapeHtml(pathRoleLabel(entry.role))}</strong>
              <span>${escapeHtml(entry.path || "--")}</span>
              <em>${escapeHtml(t(`settings.sources.permissions.${entry.permission}`, {}, entry.permission || "--"))}</em>
            </li>
          `;
        })
        .join("")
    : `<li><span>${escapeHtml(t("settings.sources.noPaths"))}</span></li>`;

  return `
    <article class="source-card">
      <div class="source-card-head">
        <div>
          <p class="eyebrow">${escapeHtml(provider)}</p>
          <h5>${escapeHtml(source.label || provider)}</h5>
        </div>
        <span class="status-pill status-${escapeHtml(source.accessStatus || "empty")}">${escapeHtml(access)}</span>
      </div>
      <div class="source-card-meta">
        <span>${escapeHtml(t("settings.sources.owner", { owner }))}</span>
        <span>${escapeHtml(t("settings.sources.discovery", {
          method: source.discovery?.method || "--",
          confidence: source.discovery?.confidence || "--"
        }))}</span>
      </div>
      <ul class="source-path-list">${pathMarkup}</ul>
      <div class="source-card-actions">
        ${canConnect ? renderSourceActionButton("connect", source.id, "settings.sources.connect") : ""}
        ${canDisable ? renderSourceActionButton("disable", source.id, "settings.sources.disable") : ""}
        ${renderSourceActionButton("recheck", source.id, "settings.sources.recheckOne", "ghost")}
      </div>
      ${
        grantCommands.length
          ? renderCommandBlock(source.id, "grant", "settings.sources.grantCommands", grantCommands, "settings.sources.copyGrant")
          : ""
      }
      ${
        revokeCommands.length
          ? renderCommandBlock(source.id, "revoke", "settings.sources.revokeCommands", revokeCommands, "settings.sources.copyRevoke")
          : ""
      }
    </article>
  `;
}

function renderSourceActionButton(action, sourceId, labelKey, variant = "primary") {
  const pending = isSourceOpPending(action, action === "recheck" ? "global" : sourceId);
  const pendingKey = `settings.sources.${action}Pending`;
  const classes = variant === "ghost" ? "text-button ghost" : "text-button";
  return `
    <button type="button" class="${classes}" data-source-action="${escapeHtml(action)}" data-source-id="${escapeHtml(sourceId)}" ${
      pending ? "disabled" : ""
    }>
      ${escapeHtml(pending ? t(pendingKey) : t(labelKey))}
    </button>
  `;
}

function renderCommandBlock(sourceId, commandType, titleKey, commands, copyKey) {
  return `
    <div class="source-command-block">
      <div class="source-command-head">
        <strong>${escapeHtml(t(titleKey))}</strong>
        <button
          type="button"
          class="text-button ghost"
          data-source-action="copy"
          data-source-id="${escapeHtml(sourceId)}"
          data-command-type="${escapeHtml(commandType)}"
        >
          ${escapeHtml(t(copyKey))}
        </button>
      </div>
      <pre>${escapeHtml(commands.join("\n"))}</pre>
    </div>
  `;
}

async function handleSourceActionClick(event) {
  const button = event.target.closest("[data-source-action]");
  if (!button) return;
  const action = button.dataset.sourceAction;
  const sourceId = button.dataset.sourceId || "global";
  if (action === "connect") await connectCandidateSource(sourceId);
  if (action === "disable") await disableConnectedSource(sourceId);
  if (action === "recheck") await recheckSources();
  if (action === "copy") await copySourceCommands(sourceId, button.dataset.commandType);
}

async function recheckSources() {
  const opKey = "global";
  setSourceOpPending("recheck", opKey, true);
  renderSourceDiagnostics();
  renderSourceSettings();
  setSourceMessage("", "");
  try {
    state.sourceDiagnostics = await fetchJson("/api/sources/recheck", { method: "POST" });
    state.sourceDiagnosticsError = "";
    setSourceMessage(t("settings.sources.rechecked"), "ready");
  } catch (error) {
    setSourceMessage(error.message || t("settings.sources.recheckError"), "error");
  } finally {
    setSourceOpPending("recheck", opKey, false);
    renderSourceDiagnostics();
    renderSourceSettings();
  }
}

async function connectCandidateSource(sourceId) {
  const previous = cloneJson(state.sourceDiagnostics);
  setSourceOpPending("connect", sourceId, true);
  setSourceMessage("", "");
  applyOptimisticSourceConnection(sourceId);
  try {
    await fetchJson("/api/sources/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId })
    });
    setSourceMessage(t("settings.sources.connectSuccess"), "ready");
    await Promise.all([loadSourceDiagnostics(), loadUsage()]);
  } catch (error) {
    state.sourceDiagnostics = previous;
    setSourceMessage(error.message || t("settings.sources.connectError"), "error");
    renderSourceDiagnostics();
    renderSourceSettings();
  } finally {
    setSourceOpPending("connect", sourceId, false);
  }
}

async function disableConnectedSource(sourceId) {
  const previous = cloneJson(state.sourceDiagnostics);
  setSourceOpPending("disable", sourceId, true);
  setSourceMessage("", "");
  applyOptimisticSourceDisable(sourceId);
  try {
    await fetchJson(`/api/sources/${encodeURIComponent(sourceId)}/disable`, { method: "POST" });
    setSourceMessage(t("settings.sources.disableSuccess"), "ready");
    await Promise.all([loadSourceDiagnostics(), loadUsage()]);
  } catch (error) {
    state.sourceDiagnostics = previous;
    setSourceMessage(error.message || t("settings.sources.disableError"), "error");
    renderSourceDiagnostics();
    renderSourceSettings();
  } finally {
    setSourceOpPending("disable", sourceId, false);
  }
}

async function copySourceCommands(sourceId, commandType) {
  const source = findSourceDiagnosticsCandidate(sourceId);
  const commands = commandType === "revoke" ? source?.suggestedAction?.revokeCommands : source?.suggestedAction?.commands;
  if (!commands?.length) return;
  try {
    await navigator.clipboard.writeText(commands.join("\n"));
    setSourceMessage(t(commandType === "revoke" ? "settings.sources.copyRevokeSuccess" : "settings.sources.copyGrantSuccess"), "ready");
  } catch {
    setSourceMessage(t("settings.sources.copyError"), "error");
  }
  renderSourceSettings();
}

function findSourceDiagnosticsCandidate(sourceId) {
  return (
    state.sourceDiagnostics?.candidates?.find((source) => source.id === sourceId) ||
    state.sourceDiagnostics?.connected?.find((source) => source.id === sourceId) ||
    null
  );
}

function applyOptimisticSourceConnection(sourceId) {
  if (!state.sourceDiagnostics) return;
  const diagnostics = cloneJson(state.sourceDiagnostics);
  const candidate = diagnostics.candidates?.find((entry) => entry.id === sourceId);
  if (!candidate) return;
  candidate.connected = true;
  diagnostics.connected ||= [];
  if (!diagnostics.connected.some((entry) => entry.id === sourceId)) {
    diagnostics.connected.push({ ...candidate, currentCandidate: candidate });
  }
  diagnostics.status = deriveUiDiagnosticsStatus(diagnostics);
  state.sourceDiagnostics = diagnostics;
  renderSourceDiagnostics();
  renderSourceSettings();
}

function applyOptimisticSourceDisable(sourceId) {
  if (!state.sourceDiagnostics) return;
  const diagnostics = cloneJson(state.sourceDiagnostics);
  diagnostics.connected = (diagnostics.connected || []).filter((entry) => entry.id !== sourceId);
  diagnostics.candidates = (diagnostics.candidates || []).map((entry) =>
    entry.id === sourceId ? { ...entry, connected: false } : entry
  );
  diagnostics.status = deriveUiDiagnosticsStatus(diagnostics);
  state.sourceDiagnostics = diagnostics;
  renderSourceDiagnostics();
  renderSourceSettings();
}

function deriveUiDiagnosticsStatus(diagnostics) {
  if (!diagnostics) return "current_user_empty";
  const connected = diagnostics.connected || [];
  const candidates = diagnostics.candidates || [];
  if (connected.length && candidates.some((source) => source.connected && ["readable", "mixed"].includes(source.accessStatus))) {
    return "connected_live";
  }
  if ((diagnostics.otherDashboardInstances || []).length) return "other_dashboard_found";
  if (candidates.some((source) => source.accessStatus === "denied")) return "candidates_denied";
  if (candidates.some((source) => ["readable", "mixed"].includes(source.accessStatus))) return "candidates_readable_empty";
  if (diagnostics.os?.supportLevel === "partial_container" || diagnostics.os?.supported === false) return "partial_unsupported";
  if (candidates.some((source) => source.owner?.current)) return "current_user_empty";
  return "no_tools_found";
}

function setSourceMessage(text, status) {
  state.sourceMessage = { text: text || "", status: status || "" };
}

function setSourceOpPending(action, sourceId, pending) {
  const key = `${action}:${sourceId}`;
  state.sourceOps[key] = pending;
}

function isSourceOpPending(action, sourceId) {
  return Boolean(state.sourceOps[`${action}:${sourceId}`]);
}

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function providerName(providerId) {
  return providerMeta[providerId]?.name || providerId;
}

function pathRoleLabel(role) {
  const key = role ? `settings.sources.roles.${role}` : "";
  return key ? t(key, {}, role || "--") : role || "--";
}

function openModalDialog(dialog) {
  if (!dialog) return;
  if (dialog.open) return;
  dialogOpenedAt.set(dialog, Date.now());
  dialog.showModal();
}

function closeDialogOnBackdrop(event) {
  if (event.target !== event.currentTarget) return;
  const openedAt = dialogOpenedAt.get(event.currentTarget) || 0;
  if (Date.now() - openedAt < MODAL_BACKDROP_GRACE_MS) return;
  const body = event.currentTarget.querySelector(".modal-body");
  if (!body) return event.currentTarget.close();
  const rect = body.getBoundingClientRect();
  const inside =
    event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) event.currentTarget.close();
}

function showSettingsToast(message, status, { persistMs = SETTINGS_TOAST_MS } = {}) {
  if (!els.settingsToast) return;
  clearTimeout(state.settingsToastTimer);
  els.settingsToast.textContent = message || "";
  els.settingsToast.hidden = !message;
  els.settingsToast.dataset.status = status || "";
  if (message && persistMs > 0) {
    state.settingsToastTimer = setTimeout(hideSettingsToast, persistMs);
  }
}

function hideSettingsToast() {
  if (!els.settingsToast) return;
  clearTimeout(state.settingsToastTimer);
  state.settingsToastTimer = null;
  els.settingsToast.textContent = "";
  els.settingsToast.hidden = true;
  els.settingsToast.dataset.status = "";
}

function getPath(object, dotted) {
  return dotted.split(".").reduce((acc, key) => acc?.[key], object);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: {
      "cache-control": "no-cache",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text };
  }
  if (!response.ok) {
    const error = new Error(json.error || json.message || response.statusText);
    error.status = response.status;
    throw error;
  }
  return json;
}

function percentAverage(values) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return "--";
  return `${Math.round(nums.reduce((a, b) => a + b, 0) / nums.length)}%`;
}

function formatPercent(value) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return "--";
  return `${Math.round(Number(value))}%`;
}

function formatLimitRemainingPercent(limit) {
  if (!limit) return "--";
  if (Number.isFinite(Number(limit.remainingPercent))) return formatPercent(limit.remainingPercent);
  if (Number.isFinite(Number(limit.usedPercent))) return formatPercent(Math.max(0, 100 - Number(limit.usedPercent)));
  return "--";
}

function formatSharePercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  if (num > 0 && num < 0.1) return t("format.lessThanSharePercent");
  return `${new Intl.NumberFormat(currentLocale(), {
    maximumFractionDigits: num < 10 ? 1 : 0
  }).format(num)}%`;
}

function formatTokens(value) {
  const num = Number(value || 0);
  if (!num) return "0";
  if (num >= 1_000_000_000) return `${formatCompact(num / 1_000_000_000)} ${t("format.billion")}`;
  if (num >= 1_000_000) return `${formatCompact(num / 1_000_000)} ${t("format.million")}`;
  if (num >= 1_000) return `${formatCompact(num / 1_000)} ${t("format.thousand")}`;
  return formatNumber(num);
}

function formatCompact(value) {
  return new Intl.NumberFormat(currentLocale(), {
    maximumFractionDigits: value >= 10 ? 0 : 1
  }).format(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat(currentLocale()).format(Number(value || 0));
}

function formatUsdPerM(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  const maxDigits = num < 0.01 ? 6 : num < 1 ? 3 : 2;
  const formatted = new Intl.NumberFormat(currentLocale(), {
    minimumFractionDigits: num < 1 ? 2 : 0,
    maximumFractionDigits: maxDigits
  }).format(num);
  return t("format.usdPerMillion", { value: formatted });
}

function formatCacheRate(price) {
  const read = price.cachedInputUsd;
  const write = price.cacheWriteUsd;
  if (read !== undefined && write !== undefined) {
    return t("format.cacheReadWrite", { read: formatUsdPerM(read), write: formatUsdPerM(write) });
  }
  if (read !== undefined) return formatUsdPerM(read);
  return t("format.cacheSameAsInput");
}

function formatEuro(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  if (num > 0 && num < 0.01) return t("format.lessThanCent");
  return new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: "EUR"
  }).format(num);
}

function formatChartEuro(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  return new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: num < 10 ? 2 : num < 100 ? 1 : 0
  }).format(num);
}

function formatMoney(value, currency = "usd") {
  if (value === undefined || value === null) return "--";
  return new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: String(currency || "usd").toUpperCase()
  }).format(Number(value || 0));
}

function formatMonthlyCost(subscription) {
  return t("format.perMonth", {
    amount: formatMoney(subscription.monthlyCost, subscription.currency || "EUR")
  });
}

function shortReset(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat(currentLocale(), {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat(currentLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatUpdatedAt(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  if (isSameLocalDay(date, new Date())) return formatTime(value);
  return new Intl.DateTimeFormat(currentLocale(), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatUpdatedAtFull(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat(currentLocale(), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function isSameLocalDay(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function updatedDelayHint(providerId, value) {
  if (!value) return null;
  const date = new Date(value);
  const ageMs = Date.now() - date.getTime();
  if (Number.isNaN(date.getTime()) || ageMs <= UPDATED_STALE_AFTER_MS) return null;
  const minutes = Math.round(UPDATED_STALE_AFTER_MS / 60_000);
  const fallback = t("providers.updateDelayHints.default", { minutes });
  return t(`providers.updateDelayHints.${providerId}`, { minutes }, fallback);
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat(currentLocale(), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat(currentLocale(), {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function statusText(status) {
  return (
    {
      live: t("status.live"),
      empty: t("status.empty"),
      not_configured: t("status.not_configured"),
      error: t("status.error")
    }[status] || status
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}
