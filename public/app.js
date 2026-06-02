const state = {
  auth: null,
  usage: null,
  loadingUsage: false,
  refreshIndicator: false,
  showAllProviders: false,
  chartRendered: false,
  pricingSort: null,
  language: "en",
  translations: {},
  fallbackTranslations: {},
  claudeSetup: {
    status: null,
    loading: false,
    opening: false,
    pollTimer: null,
    pollAttempts: 0
  }
};

const els = {
  appShell: document.querySelector("main.app-shell"),
  providerGrid: document.getElementById("providerGrid"),
  refreshBtn: document.getElementById("refreshBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
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
  claudeSetupStatus: document.getElementById("claudeSetupStatus"),
  claudeSetupEnableBtn: document.getElementById("claudeSetupEnableBtn"),
  claudeSetupOpenBtn: document.getElementById("claudeSetupOpenBtn"),
  languageSelect: document.getElementById("languageSelect"),
  fiveHourOpen: document.getElementById("fiveHourOpen"),
  weeklyOpen: document.getElementById("weeklyOpen"),
  tokensToday: document.getElementById("tokensToday"),
  tokensTotal: document.getElementById("tokensTotal"),
  recordDay: document.getElementById("recordDay"),
  chart: document.getElementById("chart"),
  chartLegend: document.getElementById("chartLegend"),
  sourceTotals: document.getElementById("sourceTotals"),
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

const USD_PER_EUR = 1.1595;
const FX_DATE = "2026-05-22";
const PRICING_DATE = "2026-05-29";
const SCORE_DATE = "2026-05-29";
const MILLION = 1_000_000;
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
const translationCache = new Map();
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

const pricingModels = [
  {
    provider: "OpenAI",
    model: "GPT-5.5",
    region: "API/Codex",
    inputUsd: 5,
    cachedInputUsd: 0.5,
    outputUsd: 30,
    source: "OpenAI",
    sourceUrl: "https://openai.com/api/pricing/"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.4",
    region: "API/Codex",
    inputUsd: 2.5,
    cachedInputUsd: 0.25,
    outputUsd: 15,
    source: "OpenAI",
    sourceUrl: "https://openai.com/api/pricing/"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.4-Mini",
    region: "Codex",
    inputUsd: 0.75,
    cachedInputUsd: 0.075,
    outputUsd: 4.5,
    source: "OpenAI Codex",
    sourceUrl: "https://openai.com/api/pricing/"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.3-Codex",
    region: "Codex",
    inputUsd: 1.75,
    cachedInputUsd: 0.175,
    outputUsd: 14,
    source: "OpenAI Codex",
    sourceUrl: "https://openai.com/api/pricing/"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.3-Codex-Spark",
    region: "Codex Spark",
    inputUsd: 1.75,
    cachedInputUsd: 0.175,
    outputUsd: 14,
    source: "OpenAI Codex",
    sourceUrl: "https://openai.com/api/pricing/"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.2",
    region: "Legacy",
    inputUsd: 1.75,
    cachedInputUsd: 0.175,
    outputUsd: 14,
    source: "OpenAI",
    sourceUrl: "https://openai.com/api/pricing/"
  },
  {
    provider: "Anthropic",
    model: "Claude Opus 4.7",
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
    model: "Gemini 3 Flash Preview",
    region: "Standard",
    inputUsd: 0.5,
    cachedInputUsd: 0.05,
    outputUsd: 3,
    source: "Google",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  {
    provider: "DeepSeek",
    model: "DeepSeek V4 Pro",
    region: "API Rabatt",
    regionKey: "pricing.regions.apiDiscount",
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

const modelQualityScores = {
  "GPT-5.5": 100,
  "GPT-5.4": 94,
  "GPT-5.3-Codex": 90,
  "GPT-5.3-Codex-Spark": 90,
  "Claude Opus 4.7": 88,
  "Gemini 3.1 Pro Preview": 87,
  "Claude Sonnet 4.6": 84,
  "GPT-5.2": 82,
  "GPT-5.4-Mini": 76,
  "GLM-5.1": 87,
  "DeepSeek V4 Pro": 80,
  "Qwen3-Max": 78,
  "Gemini 3 Flash Preview": 74,
  "GLM-4.6": 72,
  "Qwen3.5-Plus": 69,
  "DeepSeek V4 Flash": 66,
  "Claude Haiku 4.5": 64,
  "step-3.5-flash": 58
};

init();

async function init() {
  await loadLanguage(detectInitialLanguage(), { persist: false, rerender: false });
  loadProviderFilterPreference();
  bindEvents();
  refreshIcons();
  await loadAuth();
  await loadUsage({ showIndicator: true });
  setInterval(loadUsage, 5_000);
}

function bindEvents() {
  els.refreshBtn.addEventListener("click", () => loadUsage({ showIndicator: true }));
  els.loginBtn.addEventListener("click", () => els.loginDialog.showModal());
  els.logoutBtn.addEventListener("click", logout);
  els.settingsBtn.addEventListener("click", openSettings);
  els.providerFilterBtn.addEventListener("click", toggleProviderFilter);
  els.providerGrid.addEventListener("click", handleProviderActionClick);
  els.settingsCloseBtn.addEventListener("click", () => els.settingsDialog.close());
  els.loginDialog.addEventListener("click", closeDialogOnBackdrop);
  els.settingsDialog.addEventListener("click", closeDialogOnBackdrop);
  els.settingsDialog.addEventListener("close", clearClaudeSetupPoll);
  els.claudeSetupEnableBtn?.addEventListener("click", enableClaudeSetup);
  els.claudeSetupOpenBtn?.addEventListener("click", openClaudeCode);
  els.languageSelect?.addEventListener("change", () => setLanguage(els.languageSelect.value));
  els.priceSortButtons.forEach((button) => {
    button.addEventListener("click", () => sortPricing(button.dataset.priceSort));
  });
  els.loginForm.addEventListener("submit", login);
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
  }
  renderClaudeSetupStatus(state.claudeSetup.status);
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

function toggleProviderFilter() {
  state.showAllProviders = !state.showAllProviders;
  try {
    localStorage.setItem(PROVIDER_FILTER_STORAGE_KEY, String(state.showAllProviders));
  } catch {
    // Ignore storage failures; the toggle should still work for this session.
  }
  if (state.usage) render();
}

async function handleProviderActionClick(event) {
  const button = event.target.closest("[data-provider-action]");
  if (!button) return;
  if (button.dataset.providerAction !== "claude-setup") return;
  button.disabled = true;
  try {
    const status = await fetchJson("/api/claude/statusline-setup");
    state.claudeSetup.status = status;
    if (status?.configured) {
      await openClaudeCode({ requireSettingsControls: false });
    } else {
      await enableClaudeSetup({ requireSettingsControls: false });
    }
  } finally {
    button.disabled = false;
    await loadUsage({ showIndicator: true });
  }
}

function claudeSetupPrompt() {
  return t("settings.claudeSetup.prompt");
}

async function loadAuth() {
  state.auth = await fetchJson("/api/auth/me");
  renderAuth();
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
    await loadUsage();
  } catch {
    els.loginError.textContent = t("auth.loginFailed");
  }
}

async function logout() {
  await fetchJson("/api/auth/logout", { method: "POST" });
  await loadAuth();
  renderLocked();
}

async function loadUsage({ showIndicator = false } = {}) {
  if (state.loadingUsage) {
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
    state.usage = await fetchJson(`/api/usage?ts=${Date.now()}`);
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
  els.providerGrid.innerHTML = "";
  els.fiveHourOpen.textContent = "--";
  els.weeklyOpen.textContent = "--";
  els.tokensToday.textContent = "--";
  els.tokensTotal.textContent = "--";
  els.recordDay.textContent = "";
  els.recordDay.hidden = true;
  els.chart.innerHTML = "";
  els.chartLegend.innerHTML = "";
  els.sourceTotals.textContent = "--";
  els.tokenList.innerHTML = "";
  els.priceRows.innerHTML = "";
  els.pricingMeta.textContent = "--";
  state.chartRendered = false;
  updateProviderFilterControl([], []);
}

function render() {
  const usage = state.usage;
  const providers = [
    normalizeLocalProvider("claudeCode", usage.claudeCode),
    normalizeApiProvider("anthropic", usage.anthropic),
    normalizeCodexProvider(usage.codex),
    normalizeCodexSparkProvider(usage.codex?.spark),
    normalizeLocalProvider("copilot", usage.copilot),
    normalizeLocalProvider("ollama", usage.ollama),
    normalizeApiProvider("openai", usage.openai),
    normalizeLocalProvider("gemini", usage.gemini)
  ];
  const visibleProviders = state.showAllProviders ? providers : providers.filter(providerHasUsage);

  els.providerGrid.innerHTML = visibleProviders.length
    ? visibleProviders.map(renderProvider).join("")
    : renderNoActiveProviders();
  updateProviderFilterControl(providers, visibleProviders);
  renderSummary(visibleProviders, usage.local);
  renderChart(usage.local?.daily || []);
  renderTokenList(usage.local?.totals?.allTime);
  renderPricing(usage.local);
  els.sourceTotals.innerHTML = renderSourceTotalBars(usage.local);
  refreshIcons();
}

function renderSourceTotalBars(local) {
  const sources = sourceTotalsForWindow(local, "allTime");
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

function sourceTotalsForWindow(local, windowKey) {
  const sources = Array.isArray(local?.sources)
    ? local.sources
        .map((source) => ({
          id: source.id,
          totalTokens: Number(source.totals?.[windowKey]?.totalTokens || 0)
        }))
        .filter((source) => source.totalTokens > 0)
    : [];
  if (sources.length) return sortSourceTotals(sources);
  const fallback = Number(local?.totals?.[windowKey]?.totalTokens || 0);
  return fallback > 0 ? [{ id: "local", totalTokens: fallback }] : [];
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
  return {
    id: "codex",
    name: meta.name,
    kicker: providerKicker("codex"),
    accent: meta.accent,
    status: codex?.status || "empty",
    fiveHour: codex?.limits?.fiveHour || null,
    weekly: codex?.limits?.weekly || null,
    limitRows,
    creditRows,
    planType: codex?.latest?.planType || codex?.planType || null,
    primaryLabel: t("limits.fiveHour"),
    secondaryLabel: t("limits.weekly"),
    todayTokens: last24hTokens,
    allTimeTokens,
    foot: buildQuotaFoot({
      todayTokens: last24hTokens,
      since: codex?.first?.timestamp,
      fiveHour: codex?.limits?.fiveHour,
      weekly: codex?.limits?.weekly,
      updated: limitUpdatedAt
    })
  };
}

function subtractTokenTotals(total, subset) {
  return Math.max(0, Number(total?.totalTokens || 0) - Number(subset?.totalTokens || 0));
}

function normalizeCodexSparkProvider(spark) {
  const meta = providerMeta.codexSpark;
  const limitRows = normalizeLimitRows(spark?.limits);
  const limitUpdatedAt = spark?.limitsUpdatedAt || spark?.latest?.timestamp;
  return {
    id: "codexSpark",
    name: meta.name,
    kicker: providerKicker("codexSpark"),
    accent: meta.accent,
    status: spark?.status || "empty",
    fiveHour: spark?.limits?.fiveHour || null,
    weekly: spark?.limits?.weekly || null,
    limitRows,
    creditRows: [],
    planType: spark?.planType || null,
    primaryLabel: t("limits.fiveHour"),
    secondaryLabel: t("limits.weekly"),
    todayTokens: spark?.totals?.last24h?.totalTokens,
    allTimeTokens: spark?.totals?.allTime?.totalTokens,
    apiTokens: spark?.totals?.last24h?.totalTokens,
    message: localizeProviderMessage(spark?.message, "providers.messages.sparkTokens24h"),
    foot: buildQuotaFoot({
      todayTokens: spark?.totals?.last24h?.totalTokens,
      since: spark?.first?.timestamp,
      fiveHour: spark?.limits?.fiveHour,
      weekly: spark?.limits?.weekly,
      updated: limitUpdatedAt
    })
  };
}

function buildQuotaFoot({ todayTokens, since, fiveHour, weekly, updated }) {
  const rows = [
    [t("labels.today"), formatTokens(todayTokens)],
    [t("labels.since"), formatDate(since)]
  ];
  if (fiveHour) rows.push([t("labels.fiveHourLeft"), formatLimitRemainingPercent(fiveHour)]);
  if (weekly) rows.push([t("labels.weekLeft"), formatLimitRemainingPercent(weekly)]);
  rows.push([t("labels.updated"), formatTime(updated)]);
  return rows;
}

function normalizeLocalProvider(id, provider) {
  const meta = providerMeta[id];
  const hasLimits = Boolean(provider?.limits?.fiveHour || provider?.limits?.weekly);
  const limitRows = normalizeLimitRows(provider?.limits);
  const creditRows = normalizeCreditRows(provider?.creditRows, provider?.credits);
  const planType = provider?.planType || provider?.plan || null;
  const updatedAt = id === "claudeCode" ? provider?.limitsUpdatedAt || provider?.latest?.timestamp : provider?.latest?.timestamp;
  return {
    id,
    name: meta.name,
    kicker: providerKicker(id),
    accent: meta.accent,
    status: provider?.status || "empty",
    fiveHour: hasLimits ? provider?.limits?.fiveHour || null : null,
    weekly: hasLimits ? provider?.limits?.weekly || null : null,
    limitRows,
    creditRows,
    claudeSetup: id === "claudeCode" ? provider?.setup || null : null,
    claudeBrowserCredits: id === "claudeCode" ? provider?.browserCredits || null : null,
    planType,
    primaryLabel: t("limits.fiveHour"),
    secondaryLabel: t("limits.weekly"),
    todayTokens: provider?.totals?.last24h?.totalTokens,
    allTimeTokens: provider?.totals?.allTime?.totalTokens,
    apiTokens: provider?.totals?.last24h?.totalTokens,
    message: localizeProviderMessage(
      provider?.message,
      id === "copilot" ? "providers.messages.copilotLogTokens" : "providers.messages.logTokens24h"
    ),
    foot: buildQuotaFoot({
      todayTokens: provider?.totals?.last24h?.totalTokens,
      since: provider?.first?.timestamp,
      fiveHour: provider?.limits?.fiveHour,
      weekly: provider?.limits?.weekly,
      updated: updatedAt
    })
  };
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
    "Claude live limits are not set up yet. Open Settings to enable them once.":
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
  const foot = [
    [t("labels.tokens7d"), formatTokens(totalTokens)],
    [t("labels.cost7d"), formatMoney(costs?.total, costs?.currency)]
  ];
  if (provider?.limits?.summaryLabel) foot.push([t("labels.limits"), limitSummaryLabel(provider.limits)]);
  if (planType) foot.push([t("labels.plan"), planType]);
  return {
    id,
    name: meta.name,
    kicker: providerKicker(id),
    accent: meta.accent,
    status: provider?.status || "not_configured",
    fiveHour: null,
    weekly: null,
    limitRows,
    creditRows,
    planType,
    primaryLabel: "7d",
    secondaryLabel: t("labels.cost"),
    apiTokens: totalTokens,
    allTimeTokens: totalTokens,
    cost: costs?.total,
    currency: costs?.currency,
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
    provider.fiveHour || provider.weekly || provider.limitRows?.length || provider.creditRows?.length || provider.planType
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

function renderProvider(provider) {
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
    <article class="provider-card">
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
      ${provider.message && (provider.limitRows?.length || provider.fiveHour || provider.weekly)
        ? `<p class="provider-note">${escapeHtml(provider.message)}</p>`
        : ""}
      ${provider.creditRows?.length ? renderCreditRows(provider) : ""}
      ${renderClaudeCreditHint(provider)}
      <div class="provider-foot">
        ${provider.foot
          .map(
            ([label, value]) => `<div class="mini-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
          )
          .join("")}
      </div>
      ${renderProviderAction(provider)}
    </article>
  `;
}

function renderClaudeCreditHint(provider) {
  if (provider.id !== "claudeCode" || provider.creditRows?.length) return "";
  const status = provider.claudeBrowserCredits?.status || "missing";
  if (status === "available") return "";
  const hint = t("providers.messages.claudeBrowserLoginHint", {}, "Log in to Claude.ai in your browser to enable credit tracking.");
  return `<p class="provider-note">${escapeHtml(hint)}</p>`;
}

function renderProviderAction(provider) {
  if (provider.id !== "claudeCode" || !provider.claudeSetup?.claudeAvailable) return "";
  const configured = Boolean(provider.claudeSetup.configured);
  const hasLimits = Boolean(provider.claudeSetup.hasLimits);
  const staleLimits = Boolean(provider.claudeSetup.staleLimits);
  if (hasLimits && !staleLimits) return "";
  const label = staleLimits
    ? t("settings.claudeSetup.refreshClaude")
    : configured
      ? t("settings.claudeSetup.openClaude")
      : t("settings.claudeSetup.enable");
  const title = staleLimits
    ? t("settings.claudeSetup.statusStale")
    : configured
      ? t("settings.claudeSetup.statusConfiguredWaiting")
      : t("settings.claudeSetup.statusNotConfigured");
  return `
    <button
      class="text-button provider-action"
      type="button"
      data-provider-action="claude-setup"
      title="${escapeHtml(title)}"
    >${escapeHtml(label)}</button>
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

function renderChart(daily) {
  if (!daily.length) {
    els.chart.innerHTML = "";
    els.chartLegend.innerHTML = "";
    state.chartRendered = false;
    return;
  }

  const viewportWidth = Math.max(900, els.chart.clientWidth || 900);
  const height = 300;
  const pad = 38;
  const chartTop = 28;
  const axisY = height - 64;
  const dateLabelY = height - 42;
  const sourceIds = chartSourcesInUse(daily);
  const max = Math.max(...daily.map((d) => d.totalTokens), 1);
  const visibleDays = Math.min(daily.length, viewportWidth >= 1200 ? 21 : 16);
  const barGap = 8;
  const barWidth = Math.max(
    24,
    (viewportWidth - pad * 2 - barGap * Math.max(0, visibleDays - 1)) / Math.max(visibleDays, 1)
  );
  const width = Math.max(viewportWidth, pad * 2 + daily.length * barWidth + Math.max(0, daily.length - 1) * barGap);
  const previousScrollLeft = els.chart.scrollLeft;
  const wasPinnedToEnd =
    !state.chartRendered || els.chart.scrollWidth - els.chart.clientWidth - previousScrollLeft < 24;

  const bars = daily
    .map((d, index) => {
      const x = pad + index * (barWidth + barGap);
      const label = formatChartDate(d.date);
      const fullLabel = formatFullDate(d.date);
      const segments = chartSegmentsForDay(d, sourceIds);
      const visibleSegments = chartVisibleSegments(segments, max, axisY - chartTop);
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
  els.chart.innerHTML = `
    <div class="chart-canvas" style="width: ${width}px">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t("chart.svgAria"))}" style="width: ${width}px">
      <line x1="${pad}" y1="${axisY}" x2="${width - pad}" y2="${axisY}" stroke="#dfe5dd"></line>
      <text x="${pad}" y="18" class="axis-label">${formatTokens(max)}</text>
      ${bars}
    </svg>
    </div>
  `;
  els.chartLegend.innerHTML = renderChartLegend(sourceIds);
  window.requestAnimationFrame(() => {
    els.chart.scrollLeft = wasPinnedToEnd
      ? els.chart.scrollWidth - els.chart.clientWidth
      : previousScrollLeft;
    state.chartRendered = true;
  });
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
  if (!state.auth?.authenticated) return els.loginDialog.showModal();
  els.settingsDialog.showModal();
  await loadClaudeSetupStatus();
}

function closeDialogOnBackdrop(event) {
  if (event.target !== event.currentTarget) return;
  const body = event.currentTarget.querySelector(".modal-body");
  if (!body) return event.currentTarget.close();
  const rect = body.getBoundingClientRect();
  const inside =
    event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) event.currentTarget.close();
}

async function loadClaudeSetupStatus({ silent = false } = {}) {
  if (!els.claudeSetupStatus) return null;
  if (!silent) setClaudeSetupStatus(t("settings.claudeSetup.statusLoading"), "loading");
  try {
    const status = await fetchJson(`/api/claude/statusline-setup?ts=${Date.now()}`);
    state.claudeSetup.status = status;
    renderClaudeSetupStatus(status);
    return status;
  } catch (error) {
    state.claudeSetup.status = { error: error.message };
    setClaudeSetupStatus(t("settings.claudeSetup.statusError"), "error");
    renderClaudeSetupControls();
    return null;
  }
}

async function enableClaudeSetup({ requireSettingsControls = true } = {}) {
  if (requireSettingsControls && !els.claudeSetupEnableBtn) return;
  clearClaudeSetupPoll();
  state.claudeSetup.loading = true;
  setClaudeSetupStatus(t("settings.claudeSetup.enabling"), "loading");
  renderClaudeSetupControls();
  try {
    const status = await fetchJson("/api/claude/statusline-setup", { method: "POST" });
    state.claudeSetup.status = status;
    renderClaudeSetupStatus(status);
    await openClaudeCode({ requireSettingsControls });
    await loadUsage();
  } catch (error) {
    state.claudeSetup.status = { ...(state.claudeSetup.status || {}), error: error.message };
    setClaudeSetupStatus(t("settings.claudeSetup.statusError"), "error");
  } finally {
    state.claudeSetup.loading = false;
    renderClaudeSetupControls();
  }
}

async function openClaudeCode({ requireSettingsControls = true } = {}) {
  if (requireSettingsControls && !els.claudeSetupOpenBtn) return;
  state.claudeSetup.opening = true;
  setClaudeSetupStatus(t("settings.claudeSetup.opening"), "loading");
  renderClaudeSetupControls();
  try {
    await fetchJson("/api/claude/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: claudeSetupPrompt(), focusBackDelayMs: 10000 })
    });
    setClaudeSetupStatus(t("settings.claudeSetup.opened"), "loading");
    scheduleClaudeSetupPoll({ requireSettingsOpen: requireSettingsControls });
  } catch (error) {
    state.claudeSetup.status = { ...(state.claudeSetup.status || {}), error: error.message };
    setClaudeSetupStatus(t("settings.claudeSetup.openError"), "error");
  } finally {
    state.claudeSetup.opening = false;
    renderClaudeSetupControls();
  }
}

function renderClaudeSetupStatus(status) {
  if (!els.claudeSetupStatus) return;
  if (!status) {
    setClaudeSetupStatus(t("settings.claudeSetup.statusLoading"), "loading");
    renderClaudeSetupControls();
    return;
  }
  if (status.error) {
    setClaudeSetupStatus(t("settings.claudeSetup.statusError"), "error");
  } else if (status.settingsError) {
    setClaudeSetupStatus(t("settings.claudeSetup.statusSettingsInvalid"), "error");
  } else if (!status.claudeAvailable) {
    setClaudeSetupStatus(t("settings.claudeSetup.statusMissingClaude"), "error");
  } else if (status.configured && status.staleLimits) {
    setClaudeSetupStatus(t("settings.claudeSetup.statusStale"), "waiting");
  } else if (status.configured && status.hasLimits) {
    setClaudeSetupStatus(t("settings.claudeSetup.statusReady"), "ready");
  } else if (status.configured && status.statusFileFound) {
    setClaudeSetupStatus(t("settings.claudeSetup.statusCapturedNoQuotas"), "waiting");
  } else if (status.configured) {
    setClaudeSetupStatus(t("settings.claudeSetup.statusConfiguredWaiting"), "waiting");
  } else {
    setClaudeSetupStatus(t("settings.claudeSetup.statusNotConfigured"), "waiting");
  }
  renderClaudeSetupControls();
}

function setClaudeSetupStatus(message, status) {
  if (!els.claudeSetupStatus) return;
  els.claudeSetupStatus.textContent = message;
  els.claudeSetupStatus.dataset.status = status;
}

function renderClaudeSetupControls() {
  const busy = state.claudeSetup.loading || state.claudeSetup.opening;
  const configured = Boolean(state.claudeSetup.status?.configured);
  if (els.claudeSetupEnableBtn) {
    els.claudeSetupEnableBtn.hidden = configured && !state.claudeSetup.loading;
    els.claudeSetupEnableBtn.disabled = busy;
    els.claudeSetupEnableBtn.textContent = state.claudeSetup.loading
      ? t("settings.claudeSetup.enabling")
      : t("settings.claudeSetup.enable");
  }
  if (els.claudeSetupOpenBtn) {
    els.claudeSetupOpenBtn.hidden = !configured && !state.claudeSetup.opening;
    els.claudeSetupOpenBtn.disabled =
      busy || !state.claudeSetup.status?.claudeAvailable || !configured;
    els.claudeSetupOpenBtn.textContent = state.claudeSetup.opening
      ? t("settings.claudeSetup.opening")
      : t("settings.claudeSetup.openClaude");
  }
}

function scheduleClaudeSetupPoll({ requireSettingsOpen = false } = {}) {
  clearClaudeSetupPoll();
  state.claudeSetup.pollAttempts = 0;
  pollClaudeSetupSoon({ requireSettingsOpen });
}

function pollClaudeSetupSoon({ requireSettingsOpen = false } = {}) {
  state.claudeSetup.pollTimer = window.setTimeout(async () => {
    const status = await loadClaudeSetupStatus({ silent: true });
    await loadUsage({ showIndicator: false });
    state.claudeSetup.pollAttempts += 1;
    const ready = status?.hasLimits && !status?.staleLimits;
    const shouldContinue =
      !ready &&
      state.claudeSetup.pollAttempts < 10 &&
      (!requireSettingsOpen || els.settingsDialog.open);
    if (shouldContinue) {
      pollClaudeSetupSoon({ requireSettingsOpen });
    }
  }, 4000);
}

function clearClaudeSetupPoll() {
  if (state.claudeSetup.pollTimer) window.clearTimeout(state.claudeSetup.pollTimer);
  state.claudeSetup.pollTimer = null;
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

function formatMoney(value, currency = "usd") {
  if (value === undefined || value === null) return "--";
  return new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: String(currency || "usd").toUpperCase()
  }).format(Number(value || 0));
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
