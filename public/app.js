const state = {
  auth: null,
  usage: null,
  loadingUsage: false,
  showAllProviders: false,
  chartRendered: false,
  pricingSort: null
};

const els = {
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
  settingsForm: document.getElementById("settingsForm"),
  fiveHourOpen: document.getElementById("fiveHourOpen"),
  weeklyOpen: document.getElementById("weeklyOpen"),
  tokensToday: document.getElementById("tokensToday"),
  tokensTotal: document.getElementById("tokensTotal"),
  chart: document.getElementById("chart"),
  chartLegend: document.getElementById("chartLegend"),
  sourceTotals: document.getElementById("sourceTotals"),
  tokenList: document.getElementById("tokenList"),
  priceRows: document.getElementById("priceRows"),
  pricingMeta: document.getElementById("pricingMeta"),
  priceSortButtons: Array.from(document.querySelectorAll("[data-price-sort]"))
};

const providerMeta = {
  codex: { name: "Codex", kicker: "Codex", accent: "#23745c" },
  codexSpark: { name: "Codex 5.3 Spark", kicker: "Codex Spark", accent: "#5b6ee1" },
  claudeCode: { name: "Claude Code", kicker: "Claude lokal", accent: "#d55e00" },
  anthropic: { name: "Anthropic API", kicker: "API Usage", accent: "#8d5d3b" },
  openai: { name: "OpenAI / GPT", kicker: "API & Guthaben", accent: "#2e6ea6" },
  gemini: { name: "Gemini", kicker: "Gemini lokal", accent: "#b94e5c" },
  ollama: { name: "Ollama", kicker: "Ollama lokal", accent: "#4f6d2f" }
};

const USD_PER_EUR = 1.1595;
const FX_DATE = "2026-05-22";
const PRICING_DATE = "2026-05-27";
const SCORE_DATE = "2026-05-23";
const MILLION = 1_000_000;
const PROVIDER_FILTER_STORAGE_KEY = "llmUsage.showAllProviders";
const chartSourceOrder = ["codex", "codexSpark", "claudeCode", "ollama", "gemini", "openai", "anthropic", "local"];
const chartSourceColors = {
  codex: providerMeta.codex.accent,
  codexSpark: providerMeta.codexSpark.accent,
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
    sourceUrl: "https://www.anthropic.com/pricing"
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
    sourceUrl: "https://www.anthropic.com/pricing"
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
    sourceUrl: "https://www.anthropic.com/pricing"
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
    region: "EU Frankfurt <=32k",
    inputUsd: 1.2,
    cacheWriteUsd: 1.5,
    cachedInputUsd: 0.12,
    outputUsd: 6,
    source: "Alibaba",
    sourceUrl: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
    china: true
  },
  {
    provider: "Alibaba",
    model: "Qwen3.5-Plus",
    region: "Global <=128k",
    inputUsd: 0.115,
    cacheWriteUsd: 0.14375,
    cachedInputUsd: 0.0115,
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
  loadProviderFilterPreference();
  bindEvents();
  await loadAuth();
  await loadUsage();
  setInterval(loadUsage, 5_000);
}

function bindEvents() {
  els.refreshBtn.addEventListener("click", loadUsage);
  els.loginBtn.addEventListener("click", () => els.loginDialog.showModal());
  els.logoutBtn.addEventListener("click", logout);
  els.settingsBtn.addEventListener("click", openSettings);
  els.providerFilterBtn.addEventListener("click", toggleProviderFilter);
  els.settingsCloseBtn.addEventListener("click", () => els.settingsDialog.close());
  els.priceSortButtons.forEach((button) => {
    button.addEventListener("click", () => sortPricing(button.dataset.priceSort));
  });
  els.loginForm.addEventListener("submit", login);
  els.settingsForm.addEventListener("submit", saveSettings);
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
    els.loginError.textContent = "Login fehlgeschlagen";
  }
}

async function logout() {
  await fetchJson("/api/auth/logout", { method: "POST" });
  await loadAuth();
  renderLocked();
}

async function loadUsage() {
  if (state.loadingUsage) return;
  if (state.auth && !state.auth.authenticated) {
    renderLocked();
    return;
  }
  state.loadingUsage = true;
  try {
    state.usage = await fetchJson(`/api/usage?ts=${Date.now()}`);
    render();
  } catch (error) {
    if (error.status === 401) {
      await loadAuth();
      renderLocked();
      return;
    }
    els.providerGrid.innerHTML = `<article class="provider-card"><h2>Fehler</h2><p>${escapeHtml(error.message)}</p></article>`;
  } finally {
    state.loadingUsage = false;
  }
}

function renderLocked() {
  els.providerGrid.innerHTML = "";
  els.fiveHourOpen.textContent = "--";
  els.weeklyOpen.textContent = "--";
  els.tokensToday.textContent = "--";
  els.tokensTotal.textContent = "--";
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
    normalizeCodexProvider(usage.codex),
    normalizeCodexSparkProvider(usage.codex?.spark),
    normalizeLocalProvider("claudeCode", usage.claudeCode),
    normalizeLocalProvider("ollama", usage.ollama),
    normalizeApiProvider("anthropic", usage.anthropic),
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
      <span>Gesamtverbrauch</span>
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
  return {
    id: "codex",
    name: meta.name,
    kicker: meta.kicker,
    accent: meta.accent,
    status: codex?.status || "empty",
    fiveHour: codex?.limits?.fiveHour || null,
    weekly: codex?.limits?.weekly || null,
    limitRows,
    creditRows: [],
    planType: codex?.latest?.planType || codex?.planType || null,
    primaryLabel: "5h",
    secondaryLabel: "Woche",
    todayTokens: last24hTokens,
    allTimeTokens,
    foot: [
      ["Heute", formatTokens(last24hTokens)],
      ["5h genutzt", formatPercent(codex?.limits?.fiveHour?.usedPercent)],
      ["Woche genutzt", formatPercent(codex?.limits?.weekly?.usedPercent)],
      ["Seit", formatDate(codex?.first?.timestamp)],
      ["Stand", formatTime(codex?.latest?.timestamp)]
    ]
  };
}

function subtractTokenTotals(total, subset) {
  return Math.max(0, Number(total?.totalTokens || 0) - Number(subset?.totalTokens || 0));
}

function normalizeCodexSparkProvider(spark) {
  const meta = providerMeta.codexSpark;
  const limitRows = normalizeLimitRows(spark?.limits);
  return {
    id: "codexSpark",
    name: meta.name,
    kicker: meta.kicker,
    accent: meta.accent,
    status: spark?.status || "empty",
    fiveHour: spark?.limits?.fiveHour || null,
    weekly: spark?.limits?.weekly || null,
    limitRows,
    creditRows: [],
    planType: spark?.planType || null,
    primaryLabel: "5h",
    secondaryLabel: "Woche",
    todayTokens: spark?.totals?.last24h?.totalTokens,
    allTimeTokens: spark?.totals?.allTime?.totalTokens,
    apiTokens: spark?.totals?.last24h?.totalTokens,
    message: spark?.message || "Spark-Tokens 24h",
    foot: [
      ["Heute", formatTokens(spark?.totals?.last24h?.totalTokens)],
      ["5h genutzt", formatPercent(spark?.limits?.fiveHour?.usedPercent)],
      ["Woche genutzt", formatPercent(spark?.limits?.weekly?.usedPercent)],
      ["Seit", formatDate(spark?.first?.timestamp)],
      ["Stand", formatTime(spark?.latest?.timestamp)]
    ]
  };
}

function normalizeLocalProvider(id, provider) {
  const meta = providerMeta[id];
  const hasLimits = Boolean(provider?.limits?.fiveHour || provider?.limits?.weekly);
  const limitRows = normalizeLimitRows(provider?.limits);
  const creditRows = normalizeCreditRows(provider?.creditRows, provider?.credits);
  const planType = provider?.planType || provider?.plan || null;
  const foot = [
    ["5h Tokens", formatTokens(provider?.totals?.last5h?.totalTokens)],
    ["Heute", formatTokens(provider?.totals?.last24h?.totalTokens)],
    ["Gesamt", formatTokens(provider?.totals?.allTime?.totalTokens)],
    ["Seit", formatDate(provider?.first?.timestamp)],
    ["Stand", formatTime(provider?.latest?.timestamp)]
  ];
  if (planType) foot.splice(3, 0, ["Plan", planType]);
  return {
    id,
    name: meta.name,
    kicker: meta.kicker,
    accent: meta.accent,
    status: provider?.status || "empty",
    fiveHour: hasLimits ? provider?.limits?.fiveHour || null : null,
    weekly: hasLimits ? provider?.limits?.weekly || null : null,
    limitRows,
    creditRows,
    planType,
    primaryLabel: "5h",
    secondaryLabel: "Woche",
    todayTokens: provider?.totals?.last24h?.totalTokens,
    allTimeTokens: provider?.totals?.allTime?.totalTokens,
    apiTokens: provider?.totals?.last24h?.totalTokens,
    message: provider?.message || "Log-Tokens 24h",
    foot
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
      label: "Nutzungsguthaben",
      amount: spentAmount,
      currency,
      percent,
      resetsAt: credits.resetsAt,
      resetLabel: credits.resetLabel
    },
    monthlyLimitAmount > 0
      ? { key: "monthlyLimit", label: "Monatliches Limit", amount: monthlyLimitAmount, currency }
      : null,
    credits.enabled || currentCreditAmount > 0
      ? { key: "currentCredit", label: "Aktuelles Guthaben", amount: currentCreditAmount, currency }
      : null,
    { key: "autoTopUp", label: "Automatisch aufladen", valueLabel: credits.autoTopUp ? "An" : "Aus" }
  ].filter(Boolean);
}

function normalizeCreditRow(row) {
  if (!row) return null;
  const amount = Number(row.amount);
  const percent = Number(row.percent);
  return {
    key: row.key || row.label || "credit",
    label: row.label || row.key || "Guthaben",
    amount: Number.isFinite(amount) ? amount : null,
    currency: row.currency || "EUR",
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    valueLabel: row.valueLabel || null,
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
    normalizeLimitRow(limits.fiveHour ? { key: "fiveHour", label: "5h", ...limits.fiveHour } : null),
    normalizeLimitRow(limits.weekly ? { key: "weekly", label: "Woche", ...limits.weekly } : null)
  ].filter(Boolean);
}

function normalizeLimitRow(row) {
  if (!row || !Number.isFinite(Number(row.usedPercent))) return null;
  const usedPercent = Math.max(0, Math.min(100, Number(row.usedPercent)));
  return {
    key: row.key || row.label || "limit",
    label: row.label || row.limitLabel || row.key || "Limit",
    usedPercent,
    remainingPercent: Number.isFinite(Number(row.remainingPercent))
      ? Math.max(0, Math.min(100, Number(row.remainingPercent)))
      : Math.max(0, 100 - usedPercent),
    resetsAt: row.resetsAt || null,
    resetLabel: row.resetLabel || null
  };
}

function sourceLabel(id) {
  return providerMeta[id]?.name || id;
}

function normalizeApiProvider(id, provider) {
  const meta = providerMeta[id];
  const totalTokens = provider?.usage?.totals?.totalTokens;
  const costs = provider?.costs;
  const creditRows = normalizeCreditRows(provider?.creditRows, provider?.credits);
  const planType = provider?.planType || provider?.plan || null;
  const foot = [
    ["Tokens 7d", formatTokens(totalTokens)],
    ["Kosten 7d", formatMoney(costs?.total, costs?.currency)]
  ];
  if (planType) foot.push(["Plan", planType]);
  return {
    id,
    name: meta.name,
    kicker: meta.kicker,
    accent: meta.accent,
    status: provider?.status || "not_configured",
    fiveHour: null,
    weekly: null,
    limitRows: [],
    creditRows,
    planType,
    primaryLabel: "7d",
    secondaryLabel: "Kosten",
    apiTokens: totalTokens,
    allTimeTokens: totalTokens,
    cost: costs?.total,
    currency: costs?.currency,
    message:
      provider?.status === "manual"
        ? "Guthaben erfasst"
        : provider?.status === "not_configured"
          ? "Backend-Key fehlt"
          : provider?.error || "",
    foot
  };
}

function providerHasUsage(provider) {
  const hasTrackedUsage = [
    provider.todayTokens,
    provider.allTimeTokens,
    provider.apiTokens,
    provider.cost
  ].some((value) => Number(value || 0) > 0);
  const hasLimitTelemetry = Boolean(
    provider.fiveHour || provider.weekly || provider.limitRows?.length || provider.creditRows?.length || provider.planType
  );
  const needsAttention = provider.status === "error";
  const configuredApi = provider.status === "live" && (provider.id === "anthropic" || provider.id === "openai");
  return hasTrackedUsage || hasLimitTelemetry || needsAttention || configuredApi;
}

function updateProviderFilterControl(providers, visibleProviders) {
  const hiddenCount = Math.max(providers.length - visibleProviders.length, 0);
  els.providerFilterBtn.textContent = state.showAllProviders ? "Nur aktive" : "Alle anzeigen";
  els.providerFilterBtn.disabled = !providers.length;
  els.providerFilterBtn.title = state.showAllProviders
    ? "Inaktive Anbieter ausblenden"
    : hiddenCount
      ? `${hiddenCount} inaktive Anbieter anzeigen`
      : "Alle Anbieter sind sichtbar";
  els.providerFilterBtn.setAttribute("aria-pressed", String(state.showAllProviders));
}

function renderNoActiveProviders() {
  return `
    <article class="provider-card provider-empty-state">
      <div class="provider-head">
        <div>
          <p class="eyebrow">Provider</p>
          <h2 class="provider-name">Keine aktive Nutzung</h2>
        </div>
        <span class="status-pill status-empty">Leer</span>
      </div>
      <p class="empty-message">Alle Anbieter sind aktuell ohne geloggte Tokens oder Limitdaten.</p>
      <div class="provider-foot">
        <div class="mini-stat"><span>Sichtbar</span><strong>0</strong></div>
        <div class="mini-stat"><span>Ausgeblendet</span><strong>Alle</strong></div>
      </div>
    </article>
  `;
}

function renderProvider(provider) {
  const statusClass = `status-${provider.status}`;
  const showLimitBars = provider.limitRows?.length > 2 || Boolean(provider.planType);
  const main = provider.limitRows?.length || provider.fiveHour || provider.weekly
    ? showLimitBars
      ? renderLimitBars(provider)
      : renderRings(provider)
    : `<div class="api-total">
        <div class="ring" style="--percent: ${Math.min(100, Number(provider.apiTokens || 0) ? 72 : 0)}; --accent: ${provider.accent}">
          <strong>${formatTokens(provider.apiTokens)}</strong>
        </div>
        <span class="ring-label">${escapeHtml(provider.message || "7 Tage")}</span>
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
      ${provider.creditRows?.length ? renderCreditRows(provider) : ""}
      <div class="provider-foot">
        ${provider.foot
          .map(
            ([label, value]) => `<div class="mini-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
          )
          .join("")}
      </div>
    </article>
  `;
}

function renderCreditRows(provider) {
  return `
    <div class="credit-rows">
      <div class="credit-rows-title">Guthaben</div>
      ${provider.creditRows.map((row) => renderCreditRow(row, provider.accent)).join("")}
    </div>
  `;
}

function renderCreditRow(row, accent) {
  const value =
    row.valueLabel ||
    (row.amount === null || row.amount === undefined ? "--" : formatMoney(row.amount, row.currency || "EUR"));
  const detail = row.resetLabel || (row.resetsAt ? `Reset ${formatDateTime(row.resetsAt)}` : "");
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
  const used = Math.round(row.usedPercent || 0);
  const detail = row.resetLabel || (row.resetsAt ? `Reset ${formatDateTime(row.resetsAt)}` : "");
  return `
    <div class="limit-bar">
      <div class="limit-bar-top">
        <strong>${escapeHtml(row.label)}</strong>
        <span>${used}% genutzt</span>
      </div>
      <div class="limit-bar-track" aria-hidden="true">
        <span class="limit-bar-fill" style="--percent: ${used}; --accent: ${accent}"></span>
      </div>
      ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
    </div>
  `;
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
  return `
    <div class="ring-box">
      <div class="ring" style="--percent: ${remaining}; --accent: ${accent}">
        <strong>${remaining}%</strong>
      </div>
      <span class="ring-label">${escapeHtml(label)} frei</span>
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
}

function renderTokenList(totals) {
  const rows = [
    ["Input", totals?.inputTokens],
    ["Cache Creation", totals?.cacheCreationInputTokens],
    ["Cached Input", totals?.cachedInputTokens],
    ["Output", totals?.outputTokens],
    ["Reasoning Output", totals?.reasoningOutputTokens],
    ["Total", totals?.totalTokens]
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
              ${price.china ? '<em class="china-badge">China</em>' : ""}
            </div>
          </td>
          <td class="score-cell">${renderQualityScore(price)}</td>
          <td>${escapeHtml(price.region)}</td>
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

  els.pricingMeta.textContent = `EUR via ECB ${FX_DATE} · Preise ${PRICING_DATE} · Score ${SCORE_DATE}`;
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
      region: price.region,
      input: price.inputUsd,
      cache: price.cachedInputUsd ?? price.cacheWriteUsd ?? price.inputUsd,
      output: price.outputUsd,
      today: today.eur,
      total: total.eur,
      source: price.source
    }[key] ?? ""
  );
}

function compareSortValues(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return String(left ?? "").localeCompare(String(right ?? ""), "de-DE", {
    numeric: true,
    sensitivity: "base"
  });
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
    <div class="score-meter" title="Benchmark-Mix ${SCORE_DATE}: ${score}/100">
      <span class="score-track"><span class="score-fill" style="width: ${score}%"></span></span>
      <strong>${score}</strong>
    </div>
  `;
}

function billingTotalsForWindow(local, windowKey) {
  const sources = Array.isArray(local?.sources)
    ? local.sources.filter((source) => source?.totals?.[windowKey])
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
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Token Verlauf" style="width: ${width}px">
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
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit"
  }).format(date);
}

function formatFullDate(value) {
  const date = parseDateOnly(value);
  if (!date) return value;
  return new Intl.DateTimeFormat("de-DE", {
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
  const manual = await fetchJson("/api/manual-limits");
  fillSettings(manual);
  els.settingsDialog.showModal();
}

function fillSettings(manual) {
  for (const element of els.settingsForm.elements) {
    if (!element.name) continue;
    const value = getPath(manual, element.name);
    if (element.type === "checkbox") {
      element.checked = Boolean(value);
    } else if (element.type === "datetime-local") {
      element.value = isoToLocalInput(value);
    } else {
      element.value = value ?? "";
    }
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const payload = { claude: {}, gemini: {}, openai: {} };
  for (const element of els.settingsForm.elements) {
    if (!element.name) continue;
    const value =
      element.type === "checkbox"
        ? element.checked
        : element.type === "datetime-local"
        ? localInputToIso(element.value)
        : element.type === "number"
          ? Number(element.value || 0)
          : String(element.value || "").trim();
    setPath(payload, element.name, value);
  }
  await fetchJson("/api/manual-limits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  els.settingsDialog.close();
  await loadUsage();
}

function getPath(object, dotted) {
  return dotted.split(".").reduce((acc, key) => acc?.[key], object);
}

function setPath(object, dotted, value) {
  const parts = dotted.split(".");
  let cursor = object;
  while (parts.length > 1) {
    const key = parts.shift();
    cursor[key] ||= {};
    cursor = cursor[key];
  }
  cursor[parts[0]] = value;
}

function isoToLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function localInputToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

function formatSharePercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  if (num > 0 && num < 0.1) return "<0,1%";
  return `${new Intl.NumberFormat("de-DE", {
    maximumFractionDigits: num < 10 ? 1 : 0
  }).format(num)}%`;
}

function formatTokens(value) {
  const num = Number(value || 0);
  if (!num) return "0";
  if (num >= 1_000_000_000) return `${formatCompact(num / 1_000_000_000)} Mrd`;
  if (num >= 1_000_000) return `${formatCompact(num / 1_000_000)} Mio`;
  if (num >= 1_000) return `${formatCompact(num / 1_000)} Tsd`;
  return formatNumber(num);
}

function formatCompact(value) {
  return new Intl.NumberFormat("de-DE", {
    maximumFractionDigits: value >= 10 ? 0 : 1
  }).format(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat("de-DE").format(Number(value || 0));
}

function formatUsdPerM(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  const maxDigits = num < 0.01 ? 6 : num < 1 ? 3 : 2;
  return `${new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: num < 1 ? 2 : 0,
    maximumFractionDigits: maxDigits
  }).format(num)} $/M`;
}

function formatCacheRate(price) {
  const read = price.cachedInputUsd;
  const write = price.cacheWriteUsd;
  if (read !== undefined && write !== undefined) {
    return `${formatUsdPerM(read)} read / ${formatUsdPerM(write)} write`;
  }
  if (read !== undefined) return formatUsdPerM(read);
  return "wie Input";
}

function formatEuro(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  if (num > 0 && num < 0.01) return "< 0,01 EUR";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR"
  }).format(num);
}

function formatMoney(value, currency = "usd") {
  if (value === undefined || value === null) return "--";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: String(currency || "usd").toUpperCase()
  }).format(Number(value || 0));
}

function shortReset(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("de-DE", {
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
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function statusText(status) {
  return (
    {
      live: "Live",
      manual: "Manuell",
      empty: "Leer",
      not_configured: "Setup",
      error: "Fehler"
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
