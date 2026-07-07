import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.env.CODEX_LIVE_RATE_LIMITS = "false";

const require = createRequire(import.meta.url);
const { readCodexUsage, _test } = require("../server.js");
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await assertProviderVisibility();
await assertFrontendUsageIntelligence();
await assertNotificationLocalizationRegression();
await assertUpdateSettingsAlwaysOn();
await assertCodexSparkRateLimitDoesNotMoveGpt55Usage();

async function assertProviderVisibility() {
  const appPath = path.join(rootDir, "public", "app.js");
  const appSource = await readFile(appPath, "utf8");
  const code = appSource.replace("\ninit();", "\n// init disabled for provider visibility test");
  assert.notEqual(code, appSource, "provider visibility test must disable app bootstrap");

  const context = createAppContext();
  const result = JSON.parse(vm.runInNewContext(
    `${code}
state.translations = {
  filter: {
    showAllNoticeTitle: "All providers view",
    showAllNoticeBody: "Inactive, empty, setup-only, and historical provider cards are visible. Active only is the normal view."
  }
};
state.fallbackTranslations = {};
state.providerOrder = [];
state.usage = {
  claudeCode: {},
  anthropic: {},
  codex: {
    status: "live",
    totals: {
      allTime: { totalTokens: 100 },
      last5h: { totalTokens: 0 },
      last24h: { totalTokens: 0 },
      last7d: { totalTokens: 0 }
    },
    limits: {
      fiveHour: { usedPercent: 11, remainingPercent: 89 },
      weekly: { usedPercent: 16, remainingPercent: 84 }
    },
    spark: {
      status: "live",
      totals: {
        allTime: { totalTokens: 0 },
        last5h: { totalTokens: 0 },
        last24h: { totalTokens: 0 },
        last7d: { totalTokens: 0 }
      },
      limits: {
        fiveHour: { usedPercent: 0, remainingPercent: 100 },
        weekly: { usedPercent: 0, remainingPercent: 100 }
      }
    }
  },
  copilot: {
    status: "live",
    totals: {
      allTime: { totalTokens: 0 },
      last5h: { totalTokens: 0 },
      last24h: { totalTokens: 0 },
      last7d: { totalTokens: 0 }
    },
    limits: {
      rows: [
        { key: "copilotChat", label: "Copilot chat", usedPercent: 0, remainingPercent: 100, valueLabel: "0 / 200" },
        { key: "copilotCompletions", label: "Completions", usedPercent: 0, remainingPercent: 100, valueLabel: "0 / 2000" }
      ]
    }
  },
  ollama: {},
  openai: {},
  gemini: {}
};
state.showAllProviders = false;
const activeIds = currentVisibleProviderIds();
state.showAllProviders = true;
const allIds = currentVisibleProviderIds();
updateProviderViewNotice(orderProviders(buildProviders(state.usage)));
const showAllNoticeVisible = !els.providerViewNotice.hidden;
const showAllNoticeHtml = els.providerViewNotice.innerHTML;
state.showAllProviders = false;
updateProviderViewNotice(orderProviders(buildProviders(state.usage)));
const normalNoticeHidden = els.providerViewNotice.hidden;
JSON.stringify({
  neutralCopilot: providerHasUsage({
    id: "copilot",
    status: "live",
    todayTokens: 0,
    apiTokens: 0,
    cost: 0,
    limitRows: [
      { key: "copilotChat", label: "Copilot chat", usedPercent: 0, remainingPercent: 100, valueLabel: "0 / 200" },
      { key: "copilotCompletions", label: "Completions", usedPercent: 0, remainingPercent: 100, valueLabel: "0 / 2000" }
    ],
    creditRows: []
  }),
  fullCopilot: providerHasUsage({
    id: "copilot",
    status: "live",
    todayTokens: 0,
    apiTokens: 0,
    cost: 0,
    limitRows: [
      { key: "copilotPremiumInteractions", label: "Premium requests", usedPercent: 100, remainingPercent: 0, valueLabel: "16 / 16" }
    ],
    limitAlert: { title: "Limit full", text: "Premium requests is full." },
    creditRows: []
  }),
  neutralSpark: providerHasUsage({
    id: "codexSpark",
    status: "live",
    todayTokens: 0,
    apiTokens: 0,
    cost: 0,
    fiveHour: { usedPercent: 0, remainingPercent: 100 },
    weekly: { usedPercent: 0, remainingPercent: 100 },
    planType: "Pro Max",
    subscription: { monthlyCost: 200 },
    limitRows: [],
    creditRows: []
  }),
  activeCodexLimit: providerHasUsage({
    id: "codex",
    status: "live",
    todayTokens: 0,
    apiTokens: 0,
    cost: 0,
    fiveHour: { usedPercent: 11, remainingPercent: 89 },
    weekly: { usedPercent: 16, remainingPercent: 84 },
    limitRows: [],
    creditRows: []
  }),
  activeIds,
  allIds,
  showAllNoticeVisible,
  showAllNoticeHtml,
  normalNoticeHidden,
  restoredNormalView: state.showAllProviders === false
});`,
    context,
    { filename: appPath }
  ));

  assert.equal(result.neutralCopilot, false);
  assert.equal(result.fullCopilot, true);
  assert.equal(result.neutralSpark, false);
  assert.equal(result.activeCodexLimit, true);
  assert(result.activeIds.includes("codex"));
  assert(!result.activeIds.includes("copilot"));
  assert(!result.activeIds.includes("codexSpark"));
  assert(result.allIds.includes("copilot"));
  assert(result.allIds.includes("codexSpark"));
  assert.equal(result.showAllNoticeVisible, true);
  assert.match(result.showAllNoticeHtml, /All providers view/);
  assert.match(result.showAllNoticeHtml, /Inactive, empty, setup-only, and historical provider cards/);
  assert.equal(result.normalNoticeHidden, true);
  assert.equal(result.restoredNormalView, true);
}

async function assertCodexSparkRateLimitDoesNotMoveGpt55Usage() {
  await withTempCodexHome(async (sessionsDir) => {
    const timestamp = new Date().toISOString();
    const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
    const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
    const events = [
      {
        timestamp,
        type: "turn_context",
        payload: { model: "gpt-5.5" }
      },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: usage,
            total_token_usage: usage
          },
          rate_limits: {
            limit_id: "codex_bengalfox",
            limit_name: "GPT-5.3-Codex-Spark",
            primary: { used_percent: 0, resets_at: resetSeconds },
            secondary: { used_percent: 0, resets_at: resetSeconds + 86400 }
          }
        }
      }
    ];
    await writeFile(path.join(sessionsDir, "rollout-spark-bucket.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`);

    const result = await readCodexUsage({
      sources: [
        {
          id: "test-codex",
          paths: [{ role: "sessions", path: sessionsDir }]
        }
      ]
    });

    assert.equal(result.totals.allTime.totalTokens, 15);
    assert.equal(result.spark.totals.allTime.totalTokens, 0);
    assert.equal(result._usageEvents.length, 1);
    assert.equal(result._usageEvents[0].model, "gpt-5.5");
    assert.equal(result._usageEvents[0].metadata.sourceGroupId, "codex");
  });
}

async function assertFrontendUsageIntelligence() {
  const appPath = path.join(rootDir, "public", "app.js");
  const appSource = await readFile(appPath, "utf8");
  const code = appSource.replace("\ninit();", "\n// init disabled for usage intelligence test");
  assert.notEqual(code, appSource, "usage intelligence test must disable app bootstrap");
  assert.equal(appSource.includes("function renderRings"), false, "legacy quota ring renderer must stay removed");
  assert.equal(appSource.includes("function renderRing("), false, "legacy quota ring renderer must stay removed");
  const stylesSource = await readFile(path.join(rootDir, "public", "styles.css"), "utf8");
  assert.match(stylesSource, /\.limit-bars\s*\{[^}]*width:\s*100%/su, "Current Usage grid must stretch to provider card width");
  assert.match(stylesSource, /\.limit-bars-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/su, "5h/week grid must use full-width equal columns");
  assert.match(stylesSource, /\.limit-tachometer-svg\s*\{[^}]*max-width:\s*none/su, "tachometer SVG must not keep a narrow fixed max-width");
  const translations = JSON.parse(await readFile(path.join(rootDir, "public", "i18n", "en.json"), "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const result = JSON.parse(vm.runInNewContext(
    `${code}
state.translations = ${JSON.stringify(translations)};
state.fallbackTranslations = {};
const daily = [
  {
    date: "${yesterday}",
    totalTokens: 500,
    sources: [
      { id: "claudeCode", totalTokens: 500, models: [{ model: "claude-fable-5", inputTokens: 200, cachedInputTokens: 40, outputTokens: 100, totalTokens: 340 }] }
    ]
  },
  {
    date: "${today}",
    totalTokens: 222,
    inputTokens: 100,
    outputTokens: 80,
    cachedInputTokens: 20,
    sources: [
      { id: "codex", totalTokens: 222, models: [{ model: "gpt-5.5", inputTokens: 120, cachedInputTokens: 20, outputTokens: 82, totalTokens: 222 }] }
    ]
  }
];
const multiProviderDaily = [
  {
    date: "${today}",
    totalTokens: 750,
    sources: [
      { id: "codex", totalTokens: 300, models: [{ model: "gpt-5.5", inputTokens: 160, cachedInputTokens: 20, outputTokens: 120, totalTokens: 300 }] },
      { id: "claudeCode", totalTokens: 450, models: [{ model: "claude-fable-5", inputTokens: 260, cachedInputTokens: 40, outputTokens: 150, totalTokens: 450 }] }
    ]
  }
];
const local = {
  daily,
  totals: {
    last24h: { totalTokens: 1234 },
    last7d: { totalTokens: 3456 },
    allTime: { totalTokens: 789 }
  }
};
state.chartTimeFilter = "h24";
const h24Total = usageTotalsForSelectedRange(local, filterDailyByRange(daily, "h24")).totalTokens;
state.chartTimeFilter = "today";
const todayTotal = usageTotalsForSelectedRange(local, filterDailyByRange(daily, "today")).totalTokens;
const todaySummaryTotal = usageTotalsForToday({ daily }, []).totalTokens;
const recordDay = findRecordDay(daily);
renderSummary([], local, filterDailyByRange(daily, "today"));
const renderedTokensToday = document.getElementById("tokensToday").textContent;
const renderedTokensTotal = document.getElementById("tokensTotal").textContent;
const renderedRecordDayNote = document.getElementById("recordDay").textContent;
const models = summarizeModelUsageForDaily(daily);
const manualSubscription = normalizeSubscription({ planType: "Pro", monthlyCost: 20, currency: "EUR", source: "local_settings" }, {}, "codex");
const detectedSubscription = normalizeSubscription(null, { planType: "Pro", source: "codex_app_server" }, "codex");
const missingCatalogSubscription = normalizeSubscription(null, { planType: "Enterprise", source: "codex_app_server" }, "codex");
const claudeCatalogSubscription = normalizeSubscription(null, { planType: "Max", source: "claude_statusline" }, "claudeCode");
const genericCodexOfficialSubscription = normalizeSubscription({
  planType: "Pro",
  monthlyCost: 100,
  currency: "USD",
  source: "official_pricing_page",
  priceSourceType: "official_pricing_page",
  sourceUrl: "https://developers.openai.com/codex/pricing",
  fetchedAt: "${today}T10:00:00Z",
  planKey: "pro",
  parserStatus: "parsed",
  priceType: "official_starting_list_price",
  priceVariant: "from",
  actualBillingKnown: false
}, {}, "codex");
const detectedSubscriptionCard = renderSubscriptionPricingCard({
  provider: { id: "codex", name: "Codex", accent: providerMeta.codex.accent },
  subscription: detectedSubscription,
  previous: null
});
const genericCodexOfficialCard = renderSubscriptionPricingCard({
  provider: { id: "codex", name: "Codex", accent: providerMeta.codex.accent },
  subscription: genericCodexOfficialSubscription,
  previous: null
});
const genericCodexOfficialProviderSummary = renderProviderSubscription({ subscription: genericCodexOfficialSubscription });
const usedModelPricingHtml = renderUsedModelPricingView(daily);
const unknownModelPricingHtml = renderUsedModelPricingView([
  {
    date: "${today}",
    totalTokens: 25,
    sources: [
      { id: "local", totalTokens: 25, models: [{ model: "unpriced-local-model", inputTokens: 10, outputTokens: 15, totalTokens: 25 }] }
    ]
  }
]);
const mixedApiCostSummary = summarizeUsedModelApiCost([
  { cost: { costed: true, eur: 1, currency: "EUR" } },
  { cost: { costed: true, eur: 2, currency: "USD" } }
]);
const partialApiCostSummary = summarizeUsedModelApiCost([
  { cost: { costed: true, eur: 1, currency: "EUR" } },
  { cost: { costed: false, eur: null } }
]);
const noWindowLimit = { usedPercent: 85 };
const earlyWeekReset = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
const okFiveHourReset = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
const earlyWeekLimit = { usedPercent: 50, windowMinutes: 10080, resetsAt: earlyWeekReset };
const okFiveHourLimit = { usedPercent: 10, windowMinutes: 300, resetsAt: okFiveHourReset };
const defaultCodexProjectionMode = usageProjectionModeForProvider("codex");
const defaultClaudeProjectionMode = usageProjectionModeForProvider("claudeCode");
const sourceBarsHtml = renderSourceTotalBars([
  {
    date: "${today}",
    totalTokens: 300,
    sources: [
      { id: "codex", totalTokens: 200 },
      { id: "claudeCode", totalTokens: 100 }
    ]
  }
]);
state.chartBreakdownMode = "provider";
renderChart(multiProviderDaily);
const providerBreakdownChartHtml = els.chart.innerHTML;
const providerBreakdownLegendHtml = els.chartLegend.innerHTML;
state.chartBreakdownMode = "model";
renderChart(multiProviderDaily);
const modelBreakdownChartHtml = els.chart.innerHTML;
const modelBreakdownLegendHtml = els.chartLegend.innerHTML;
state.chartBreakdownMode = "total";
renderChart(multiProviderDaily);
const totalBreakdownChartHtml = els.chart.innerHTML;
const providerCardHtml = renderProvider({
  id: "claudeCode",
  name: "Claude Code",
  kicker: "local CLI capture",
  accent: providerMeta.claudeCode.accent,
  status: "live",
  limitRows: [
    { label: "5h", usedPercent: 0, remainingPercent: 100, windowMinutes: 300, resetsAt: okFiveHourReset },
    { label: "Week", usedPercent: 0, remainingPercent: 100, windowMinutes: 10080, resetsAt: earlyWeekReset }
  ],
  creditRows: [],
  usageUpdatedAt: "${today}T10:15:00Z",
  limitsUpdatedAt: "${today}T10:14:00Z",
  catalogReviewedAt: "2026-07-07",
  foot: [],
  apiTokens: 100,
  message: "Logged tokens"
});
const limitBarsHtml = renderLimitBars({
  id: "codex",
  accent: providerMeta.codex.accent,
  limitRows: [
    { label: "5h", usedPercent: 10, remainingPercent: 90, windowMinutes: 300, resetsAt: okFiveHourReset },
    { label: "Week", usedPercent: 50, remainingPercent: 50, windowMinutes: 10080, resetsAt: earlyWeekReset }
  ]
});
const claudeWithFableHtml = renderProvider(normalizeLocalProvider("claudeCode", {
  status: "live",
  planType: "max",
  limits: {
    fable: { usedPercent: 29, remainingPercent: 71, windowMinutes: 10080, resetsAt: earlyWeekReset, resetLabel: "in 6d" }
  },
  totals: { last24h: { totalTokens: 100 }, allTime: { totalTokens: 500 } }
}));
const riskLimitTachometerHtml = renderLimitBar({ label: "Week", usedPercent: 50, remainingPercent: 50, windowMinutes: 10080, resetsAt: earlyWeekReset }, providerMeta.codex.accent);
let storedProjectionModes = "";
localStorage.setItem = (key, value) => {
  if (key === USAGE_PROJECTION_MODES_STORAGE_KEY) storedProjectionModes = value;
};
setUsageProjectionMode("codex", "bar");
const codexProjectionModeAfterToggle = usageProjectionModeForProvider("codex");
const claudeProjectionModeAfterCodexToggle = usageProjectionModeForProvider("claudeCode");
const storedProjectionModesParsed = JSON.parse(storedProjectionModes || "{}");
const codexBarLimitBarsHtml = renderLimitBars({
  id: "codex",
  accent: providerMeta.codex.accent,
  limitRows: [
    { label: "5h", usedPercent: 10, remainingPercent: 90, windowMinutes: 300, resetsAt: okFiveHourReset },
    { label: "Week", usedPercent: 50, remainingPercent: 50, windowMinutes: 10080, resetsAt: earlyWeekReset }
  ]
});
const claudeTachometerLimitBarsHtml = renderLimitBars({
  id: "claudeCode",
  accent: providerMeta.claudeCode.accent,
  limitRows: [
    { label: "5h", usedPercent: 0, remainingPercent: 100, windowMinutes: 300, resetsAt: okFiveHourReset },
    { label: "Week", usedPercent: 0, remainingPercent: 100, windowMinutes: 10080, resetsAt: earlyWeekReset }
  ]
});
const riskLimitBarHtml = renderLimitBar({ label: "Week", usedPercent: 50, remainingPercent: 50, windowMinutes: 10080, resetsAt: earlyWeekReset }, providerMeta.codex.accent, "bar");
const zeroUsageLimit = normalizeLimitRow({ label: "Claude Code", usedPercent: "0%", remainingPercent: 100, windowMinutes: 300, resetsAt: okFiveHourReset });
const zeroUsageLimitHtml = renderLimitBar(zeroUsageLimit, providerMeta.claudeCode.accent);
const emptyUsageLimit = normalizeLimitRow({ label: "Claude Code", usedPercent: "", remainingPercent: 100, windowMinutes: 300, resetsAt: okFiveHourReset });
const liveRateBase = Date.parse("${today}T10:00:00Z");
const risingLiveRate = smoothedLiveTokenRateForDisplay({
  timestamp: new Date(liveRateBase + 30_000).toISOString(),
  tokensPerMinute: {
    value: 900,
    quality: "calculated",
    input: { value: 500, quality: "calculated" },
    output: { value: 300, quality: "calculated" },
    cached: { value: 100, quality: "calculated" }
  },
  timeSeries: [
    { timestamp: new Date(liveRateBase).toISOString(), tokensPerMinute: { total: 0, input: 0, output: 0, cached: 0 } },
    { timestamp: new Date(liveRateBase + 15_000).toISOString(), tokensPerMinute: { total: 400, input: 220, output: 140, cached: 40 } },
    { timestamp: new Date(liveRateBase + 30_000).toISOString(), tokensPerMinute: { total: 900, input: 500, output: 300, cached: 100 } }
  ]
}, liveRateBase + 31_000);
const decayedLiveRate = smoothedLiveTokenRateForDisplay({
  timestamp: new Date(liveRateBase).toISOString(),
  tokensPerMinute: {
    value: 600,
    quality: "calculated",
    input: { value: 300, quality: "calculated" },
    output: { value: 300, quality: "calculated" },
    cached: { value: 0, quality: "calculated" }
  },
  timeSeries: [
    { timestamp: new Date(liveRateBase).toISOString(), tokensPerMinute: { total: 600, input: 300, output: 300, cached: 0 } }
  ]
}, liveRateBase + 60_000);
const zeroLiveRate = smoothedLiveTokenRateForDisplay({
  timestamp: new Date(liveRateBase).toISOString(),
  tokensPerMinute: {
    value: 0,
    quality: "calculated",
    input: { value: 0, quality: "calculated" },
    output: { value: 0, quality: "calculated" },
    cached: { value: 0, quality: "calculated" }
  },
  timeSeries: [
    { timestamp: new Date(liveRateBase).toISOString(), tokensPerMinute: { total: 0, input: 0, output: 0, cached: 0 } }
  ]
}, liveRateBase + 10_000);
const logoSamples = [
  renderProviderMark("Z.AI"),
  renderProviderMark("MiniMax"),
  renderProviderMark("DeepSeek"),
  renderProviderMark("Alibaba"),
  renderProviderMark("xAI"),
  renderProviderMark("Mistral"),
  renderProviderMark("StepFun"),
  renderProviderMark("OpenAI"),
  renderProviderMark("Anthropic"),
  renderProviderMark("GitHub Copilot"),
  renderProviderMark("Google")
].join("");
const mixedCurrencySubscriptionCard = renderSubscriptionPricingCard({
  provider: { name: "Codex" },
  subscription: detectedSubscription,
  previous: { monthlyCost: 20, currency: "EUR" }
});
const sameCurrencySubscriptionCard = renderSubscriptionPricingCard({
  provider: { name: "Codex" },
  subscription: detectedSubscription,
  previous: { monthlyCost: 80, currency: "USD" }
});
JSON.stringify({
  filters: CHART_FILTERS,
  h24Total,
  todayTotal,
  todaySummaryTotal,
  recordDayTokens: recordDay?.totalTokens,
  recordDayLabel: t("summary.tokensTotal"),
  renderedTokensToday,
  renderedTokensTotal,
  renderedRecordDayNote,
  topModel: models[0]?.model,
  topModelCosted: models[0]?.cost?.costed,
  usedModelPricingHasTotal:
    usedModelPricingHtml.includes("API cost total") &&
    usedModelPricingHtml.includes("<tfoot>") &&
    usedModelPricingHtml.includes("Cost status"),
  unknownModelPricingHonest: unknownModelPricingHtml.includes("No displayed row has a trusted API price"),
  mixedApiCostStatus: mixedApiCostSummary.status,
  mixedApiCostNote: mixedApiCostSummary.note,
  partialApiCostStatus: partialApiCostSummary.status,
  partialApiCostNote: partialApiCostSummary.note,
  manualQuality: manualSubscription.quality,
  detectedQuality: detectedSubscription.quality,
  detectedCost: detectedSubscription.monthlyCost,
  detectedCurrency: detectedSubscription.currency,
  detectedSource: detectedSubscription.source,
	  missingCatalogQuality: missingCatalogSubscription.quality,
	  missingCatalogStatus: missingCatalogSubscription.costStatus,
	  missingCatalogReason: renderProviderSubscription({ subscription: missingCatalogSubscription }),
  claudeCatalogCopy: renderProviderSubscription({ subscription: claudeCatalogSubscription }),
	  limitOk: limitDisplayStatus(okFiveHourLimit),
	  limitNoWindow: limitDisplayStatus(noWindowLimit),
	  limitEarlyWeekRisk: limitDisplayStatus(earlyWeekLimit),
	  earlyWeekPaceMessage: limitPaceAssessment(earlyWeekLimit).message,
	  okFiveHourPaceMessage: limitPaceAssessment(okFiveHourLimit).message,
	  limitFull: limitDisplayStatus({ usedPercent: 100 }),
	  limitUnknown: limitDisplayStatus({ status: "unavailable" }),
	  limitOkLabel: t("limits.status.ok"),
	  limitRiskLabel: t("limits.status.risk"),
  catalogQualityLabel: t("subscriptions.quality.catalog"),
	  manualQualityLabel: t("subscriptions.quality.manual"),
	  manualSourceLabel: subscriptionSourceLabel("local_settings"),
  detectedSubscriptionCardShowsCost:
    detectedSubscriptionCard.includes("from $100.00/mo") &&
    detectedSubscriptionCard.includes("Catalog value"),
  detectedSubscriptionCardSourceAudit:
    detectedSubscriptionCard.includes("Read-only price sources") &&
    detectedSubscriptionCard.includes("plan/limits only; no monthly price exposed") &&
    detectedSubscriptionCard.includes("catalog fallback price"),
  genericCodexProStartingPrice:
    genericCodexOfficialSubscription.quality === "officialStarting" &&
    genericCodexOfficialCard.includes("from $100.00/mo") &&
    genericCodexOfficialCard.includes("Actual billing known") &&
    genericCodexOfficialCard.includes("<dd>no</dd>") &&
    genericCodexOfficialProviderSummary.includes("Official starting list price") &&
    genericCodexOfficialProviderSummary.includes("Actual billing known: no") &&
    !genericCodexOfficialCard.includes("<strong>$100.00/mo</strong>"),
  aliasesHiddenByDefault: renderPricingAliases(pricingModels[0]) === "",
  aliasesCollapsedInDebug: /<details/.test(renderPricingAliases(pricingModels[0], { debug: true })),
	  sourceBarsUseProviderColors:
	    sourceBarsHtml.includes("--accent: " + providerMeta.codex.accent) &&
	    sourceBarsHtml.includes("--accent: " + providerMeta.claudeCode.accent),
  providerBreakdownSegments:
    providerBreakdownChartHtml.includes('fill="' + providerMeta.codex.accent + '"') &&
    providerBreakdownChartHtml.includes('fill="' + providerMeta.claudeCode.accent + '"') &&
    providerBreakdownLegendHtml.includes("Codex") &&
    providerBreakdownLegendHtml.includes("Claude Code"),
  modelBreakdownSegments:
    modelBreakdownChartHtml.includes("gpt-5.5") &&
    modelBreakdownChartHtml.includes("claude-fable-5") &&
    modelBreakdownLegendHtml.includes("gpt-5.5") &&
    modelBreakdownLegendHtml.includes("claude-fable-5") &&
    modelBreakdownLegendHtml.includes("provider-mark-codex") &&
    modelBreakdownLegendHtml.includes("provider-mark-claudeCode"),
  totalBreakdownSegment:
    totalBreakdownChartHtml.includes("Total") &&
    chartTokenSegmentEntries(multiProviderDaily, "total")[0].label === "Total",
	  providerCardUsesProviderAccent: providerCardHtml.includes("--provider-accent: " + providerMeta.claudeCode.accent),
  providerCardHasLogo:
    providerCardHtml.includes("provider-mark-claudeCode") &&
    providerCardHtml.includes("assets/provider-logos/claude.svg"),
  providerCardFreshness:
    providerCardHtml.includes("provider-freshness") &&
    providerCardHtml.includes("Usage") &&
    providerCardHtml.includes("Limits") &&
    providerCardHtml.includes("Catalog"),
  providerCardFableQuotaAudit:
    providerCardHtml.includes("Fable quota source") &&
    providerCardHtml.includes("no synthetic quota is shown") &&
    providerCardHtml.includes("limit-context-row") &&
    providerCardHtml.includes("limit-tachometer-gauge") &&
    !providerCardHtml.includes("ring-row"),
  claudeCodeUsesCurrentUsageComponent:
    providerCardHtml.includes("limit-bars") &&
    providerCardHtml.includes("usage-projection-toggle") &&
    providerCardHtml.includes("data-usage-projection-mode=\\"tachometer\\"") &&
    providerCardHtml.includes("data-usage-projection-mode=\\"bar\\"") &&
    providerCardHtml.includes("limit-tachometer-gauge") &&
    !providerCardHtml.includes("ring-row") &&
    !providerCardHtml.includes("ring-box") &&
    !providerCardHtml.includes("ring-sub"),
  logoSamplesCoverCatalogProviders:
    logoSamples.includes("provider-mark-zai") &&
    logoSamples.includes("assets/provider-logos/zai.svg") &&
    logoSamples.includes("provider-mark-minimax") &&
    logoSamples.includes("assets/provider-logos/minimax.svg") &&
    logoSamples.includes("provider-mark-deepseek") &&
    logoSamples.includes("assets/provider-logos/deepseek.svg") &&
    logoSamples.includes("provider-mark-alibaba") &&
    logoSamples.includes("assets/provider-logos/qwen.svg") &&
    logoSamples.includes("provider-mark-xai") &&
    logoSamples.includes("assets/provider-logos/xai.svg") &&
    logoSamples.includes("provider-mark-mistral") &&
    logoSamples.includes("assets/provider-logos/mistral.svg") &&
    logoSamples.includes("provider-mark-stepfun") &&
    logoSamples.includes("assets/provider-logos/stepfun.svg") &&
    logoSamples.includes("provider-mark-openai") &&
    logoSamples.includes("assets/provider-logos/openai.svg") &&
    logoSamples.includes("provider-mark-anthropic") &&
    logoSamples.includes("assets/provider-logos/anthropic.svg") &&
    logoSamples.includes("provider-mark-copilot") &&
    logoSamples.includes("assets/provider-logos/github-copilot.svg") &&
    logoSamples.includes("provider-mark-gemini") &&
    logoSamples.includes("assets/provider-logos/gemini.svg"),
	  riskLimitBarUsesProviderAccent:
	    riskLimitTachometerHtml.includes("--accent: " + providerMeta.codex.accent) &&
	    !riskLimitTachometerHtml.includes("--accent: #b76b00"),
  defaultCodexProjectionMode,
  defaultClaudeProjectionMode,
  codexProjectionModeAfterToggle,
  claudeProjectionModeAfterCodexToggle,
  storedProjectionModes:
    storedProjectionModesParsed.codex === "bar" &&
    !Object.prototype.hasOwnProperty.call(storedProjectionModesParsed, "claudeCode"),
  invalidProjectionModeFallsBack: normalizeUsageProjectionMode("bogus"),
  limitBarsHasProjectionToggle:
    limitBarsHtml.includes("usage-projection-toggle") &&
    limitBarsHtml.includes("data-usage-projection-provider=\\"codex\\"") &&
    limitBarsHtml.includes("data-usage-projection-mode=\\"tachometer\\"") &&
    limitBarsHtml.includes("data-usage-projection-mode=\\"bar\\""),
  providerProjectionModesIndependent:
    codexBarLimitBarsHtml.includes("limit-bars-mode-bar") &&
    codexBarLimitBarsHtml.includes("limit-projection-bar") &&
    !codexBarLimitBarsHtml.includes("limit-tachometer-gauge") &&
    claudeTachometerLimitBarsHtml.includes("limit-bars-mode-tachometer") &&
    claudeTachometerLimitBarsHtml.includes("limit-tachometer-gauge") &&
    !claudeTachometerLimitBarsHtml.includes("limit-projection-bar"),
  rejectedPaceLegendRemoved: !limitBarsHtml.includes("limit-status-note"),
  riskLimitBarHasTachometerGauge:
    riskLimitTachometerHtml.includes("limit-tachometer-gauge") &&
    riskLimitTachometerHtml.includes("limit-tachometer-svg") &&
    riskLimitTachometerHtml.includes("100%") &&
    riskLimitTachometerHtml.includes("projected"),
  riskLimitBarHasProjectionBarMode:
    riskLimitBarHtml.includes("limit-projection-bar") &&
    !riskLimitBarHtml.includes("limit-tachometer-gauge") &&
    riskLimitBarHtml.includes("100%") &&
    riskLimitBarHtml.includes("projected"),
  zeroUsageProjectionValid:
    zeroUsageLimit?.usedPercent === 0 &&
    limitProjectedEndPercent(zeroUsageLimit) === 0 &&
    zeroUsageLimitHtml.includes("0% projected") &&
    !zeroUsageLimitHtml.includes("Projection unavailable"),
  emptyUsageProjectionUnavailable:
    emptyUsageLimit === null,
  liveRateRisesFromSamples:
    risingLiveRate.value > 400 &&
    risingLiveRate.value <= 900 &&
    risingLiveRate.input.value > 0,
  liveRateDecaysToZero: decayedLiveRate.value === 0,
  liveRateKeepsZero: zeroLiveRate.value === 0,
	  fableLimitRowVisible:
	    claudeWithFableHtml.includes(">Fable<") &&
	    claudeWithFableHtml.includes("--accent: " + providerMeta.claudeCode.accent),
  fableQuotaAvailableAudit:
    claudeWithFableHtml.includes("Distinct Fable quota was machine-readable"),
	  mixedCurrencyDeltaUnknown: mixedCurrencySubscriptionCard.includes("<dd>Unknown</dd>"),
  sameCurrencyDeltaShown: sameCurrencySubscriptionCard.includes("$20.00")
});`,
    createAppContext(),
    { filename: appPath }
  ));

  assert.deepEqual(result.filters, ["h24", "today", "week", "month", "all"]);
  assert.equal(result.h24Total, 1234);
  assert.equal(result.todayTotal, 222);
  assert.equal(result.todaySummaryTotal, 222);
  assert.equal(result.recordDayTokens, 500);
  assert.equal(result.recordDayLabel, "Logged tokens total");
  assert.equal(result.renderedTokensToday, "222");
  assert.equal(result.renderedTokensTotal, "789");
  assert.equal(result.renderedRecordDayNote.includes("Record day:"), true);
  assert.equal(result.renderedRecordDayNote.includes("500"), true);
  assert.equal(result.topModel, "claude-fable-5");
  assert.equal(result.topModelCosted, true);
  assert.equal(result.usedModelPricingHasTotal, true);
  assert.equal(result.unknownModelPricingHonest, true);
  assert.equal(result.mixedApiCostStatus, "mixed");
  assert.equal(result.mixedApiCostNote.includes("multiple currencies"), true);
  assert.equal(result.partialApiCostStatus, "partial");
  assert.equal(result.partialApiCostNote.includes("partial"), true);
  assert.equal(result.manualQuality, "manual");
  assert.equal(result.detectedQuality, "catalog");
  assert.equal(result.detectedCost, 100);
  assert.equal(result.detectedCurrency, "USD");
  assert.equal(result.detectedSource, "bundled_catalog");
  assert.equal(result.missingCatalogQuality, "estimated");
  assert.equal(result.missingCatalogStatus, "catalog_missing");
  assert.equal(result.missingCatalogReason.includes("Codex app-server exposed the plan"), true);
  assert.equal(result.claudeCatalogCopy.includes("Plan/limits from Claude Code statusline"), true);
  assert.equal(result.claudeCatalogCopy.includes("Monthly price is a catalog fallback"), true);
  assert.equal(result.limitOk, "ok");
  assert.equal(result.limitNoWindow, "unknown");
  assert.equal(result.limitEarlyWeekRisk, "risk");
  assert.equal(result.earlyWeekPaceMessage.includes("before reset"), true);
  assert.equal(result.okFiveHourPaceMessage.includes("remains by reset"), true);
  assert.equal(result.limitFull, "full");
  assert.equal(result.limitUnknown, "unknown");
  assert.equal(result.limitOkLabel, "On track");
  assert.equal(result.limitRiskLabel, "Fast pace");
  assert.equal(result.catalogQualityLabel, "Catalog value");
  assert.equal(result.manualQualityLabel, "Saved fallback estimate");
  assert.equal(result.manualSourceLabel, "saved fallback");
  assert.equal(result.detectedSubscriptionCardShowsCost, true);
  assert.equal(result.detectedSubscriptionCardSourceAudit, true);
  assert.equal(result.genericCodexProStartingPrice, true);
  assert.equal(result.aliasesHiddenByDefault, true);
  assert.equal(result.aliasesCollapsedInDebug, true);
  assert.equal(result.sourceBarsUseProviderColors, true);
  assert.equal(result.providerBreakdownSegments, true);
  assert.equal(result.modelBreakdownSegments, true);
  assert.equal(result.totalBreakdownSegment, true);
  assert.equal(result.providerCardUsesProviderAccent, true);
  assert.equal(result.providerCardHasLogo, true);
  assert.equal(result.providerCardFreshness, true);
  assert.equal(result.providerCardFableQuotaAudit, true);
  assert.equal(result.claudeCodeUsesCurrentUsageComponent, true);
  assert.equal(result.logoSamplesCoverCatalogProviders, true);
  assert.equal(result.riskLimitBarUsesProviderAccent, true);
  assert.equal(result.defaultCodexProjectionMode, "tachometer");
  assert.equal(result.defaultClaudeProjectionMode, "tachometer");
  assert.equal(result.codexProjectionModeAfterToggle, "bar");
  assert.equal(result.claudeProjectionModeAfterCodexToggle, "tachometer");
  assert.equal(result.storedProjectionModes, true);
  assert.equal(result.invalidProjectionModeFallsBack, "tachometer");
  assert.equal(result.limitBarsHasProjectionToggle, true);
  assert.equal(result.providerProjectionModesIndependent, true);
  assert.equal(result.rejectedPaceLegendRemoved, true);
  assert.equal(result.riskLimitBarHasTachometerGauge, true);
  assert.equal(result.riskLimitBarHasProjectionBarMode, true);
  assert.equal(result.zeroUsageProjectionValid, true);
  assert.equal(result.emptyUsageProjectionUnavailable, true);
  assert.equal(result.liveRateRisesFromSamples, true);
  assert.equal(result.liveRateDecaysToZero, true);
  assert.equal(result.liveRateKeepsZero, true);
  assert.equal(result.fableLimitRowVisible, true);
  assert.equal(result.fableQuotaAvailableAudit, true);
  assert.equal(result.mixedCurrencyDeltaUnknown, true);
  assert.equal(result.sameCurrencyDeltaShown, true);

  const indexHtml = await readFile(path.join(rootDir, "public", "index.html"), "utf8");
  assert.equal(indexHtml.includes('data-price-sort="region"'), false);

  const browserSnapshot = _test.normalizeClaudeBrowserCreditsSnapshot({
    subscription: { planType: "Max", monthlyPrice: 100, currency: "USD" }
  });
  assert.equal(browserSnapshot.status, "available");
  assert.equal(browserSnapshot.subscription.planType, "Max");
  assert.equal(browserSnapshot.subscription.monthlyCost, 100);
  assert.equal(browserSnapshot.subscription.source, "claude_browser_sync");

const browserScopedSnapshot = _test.normalizeClaudeBrowserCreditsSnapshot({
    subscription: { name: "Claude Max", unit_amount: 10000, currency: "USD" }
  });
  assert.equal(browserScopedSnapshot.status, "available");
  assert.equal(browserScopedSnapshot.subscription.planType, "Claude Max");
  assert.equal(browserScopedSnapshot.subscription.monthlyCost, 100);

  const prepaidCreditsSnapshot = _test.normalizeClaudeBrowserCreditsSnapshot({
    billingPayload: {
      prepaidCredits: {
        line_items: [{ name: "Prepaid credits", unit_amount: 2000, currency: "USD" }]
      }
    }
  });
  assert.equal(prepaidCreditsSnapshot.status, "missing");
  assert.equal(prepaidCreditsSnapshot.subscription, null);

  const openAiPricing = _test.parseOpenAiCodexPricingPage(
    '<section><h3 class="heading-lg">Plus</h3><span class="heading-2xl">$20</span><span>/month</span></section>' +
      '<section><h3 class="heading-lg">Pro</h3><span>From</span><span class="heading-2xl">$100</span><span>/month</span></section>',
    { sourceUrl: "https://developers.openai.com/codex/pricing", fetchedAt: "2026-07-07T10:00:00Z" }
  );
  assert.equal(openAiPricing.parserStatus, "parsed");
  assert.equal(openAiPricing.entries.find((entry) => entry.planKey === "plus").monthlyCost, 20);
  assert.equal(openAiPricing.entries.find((entry) => entry.planKey === "pro").monthlyCost, 100);
  assert.equal(openAiPricing.entries.find((entry) => entry.planKey === "pro").priceType, "official_starting_list_price");
  assert.equal(openAiPricing.entries.find((entry) => entry.planKey === "pro").priceVariant, "from");
  assert.equal(openAiPricing.entries.find((entry) => entry.planKey === "pro").actualBillingKnown, false);

  const claudePricing = _test.parseClaudePricingPage(
    '<span data-plan="pro_monthly">$20</span><div data-plan="max_5x_monthly">From $100</div>',
    { sourceUrl: "https://claude.com/pricing", fetchedAt: "2026-07-07T10:00:00Z" }
  );
  assert.equal(claudePricing.parserStatus, "parsed");
  assert.equal(claudePricing.entries.find((entry) => entry.planKey === "pro").monthlyCost, 20);
  assert.equal(claudePricing.entries.find((entry) => entry.planKey === "max").monthlyCost, 100);

  const officialPricing = {
    families: {
      openai: openAiPricing,
      anthropic: claudePricing
    }
  };
  assert.equal(_test.officialSubscriptionPlan("codex", "pro", officialPricing).source, "official_pricing_page");
  assert.equal(_test.officialSubscriptionPlan("codex", "pro", officialPricing).priceType, "official_starting_list_price");
  assert.equal(_test.officialSubscriptionPlan("codex", "pro", officialPricing).priceVariant, "from");
  assert.equal(_test.officialSubscriptionPlan("codex", "pro", officialPricing).actualBillingKnown, false);
  assert.equal(_test.officialSubscriptionPlan("codex", "Pro 5x", officialPricing).priceType, "official_list_price");
  assert.equal(_test.officialSubscriptionPlan("codex", "Pro 5x", officialPricing).tierVariant, "pro_5x");
  assert.equal(_test.officialSubscriptionPlan("claudeCode", "max", officialPricing).monthlyCost, 100);
  assert.equal(_test.parseOpenAiCodexPricingPage("<html>No pricing cards</html>", { sourceUrl: "https://developers.openai.com/codex/pricing" }).parserStatus, "parse_failed");

  const officialMerged = _test.mergeProviderSubscription({ id: "codex", status: "live", planType: "Pro" }, null, "codex", officialPricing);
  assert.equal(officialMerged.subscription.source, "official_pricing_page");
  assert.equal(officialMerged.subscription.monthlyCost, 100);
  assert.equal(officialMerged.subscription.priceType, "official_starting_list_price");
  assert.equal(officialMerged.subscription.priceVariant, "from");
  assert.equal(officialMerged.subscription.actualBillingKnown, false);
  const bundledMerged = _test.mergeProviderSubscription({ id: "codex", status: "live", planType: "Pro 20x" }, null, "codex", officialPricing);
  assert.equal(bundledMerged.subscription.source, "bundled_catalog");
  assert.equal(bundledMerged.subscription.monthlyCost, 200);
  assert.equal(bundledMerged.subscription.tierVariant, "pro_20x");
  const bundledGenericPro = _test.mergeProviderSubscription({ id: "codex", status: "live", planType: "Pro" }, null, "codex", { families: {} });
  assert.equal(bundledGenericPro.subscription.source, "bundled_catalog");
  assert.equal(bundledGenericPro.subscription.monthlyCost, 100);
  assert.equal(bundledGenericPro.subscription.priceType, "official_starting_list_price");
  assert.equal(bundledGenericPro.subscription.actualBillingKnown, false);
  const unknownMerged = _test.mergeProviderSubscription({ id: "codex", status: "live", planType: "Enterprise" }, null, "codex", officialPricing);
  assert.equal(unknownMerged.subscription.monthlyCost, 0);
  assert.equal(unknownMerged.subscription.costStatus, "catalog_missing");
  const manualCostWins = _test.mergeProviderSubscription(
    { id: "codex", status: "live", planType: "Pro" },
    { planType: "Pro", monthlyCost: 88, currency: "EUR" },
    "codex",
    officialPricing
  );
  assert.equal(manualCostWins.subscription.source, "local_settings");
  assert.equal(manualCostWins.subscription.priceSourceType, "local_settings");
  assert.equal(manualCostWins.subscription.costStatus, "local_settings");
  assert.equal(manualCostWins.subscription.monthlyCost, 88);
}

async function assertNotificationLocalizationRegression() {
  const electronMain = await readFile(path.join(rootDir, "electron", "main.js"), "utf8");
  const deTranslations = JSON.parse(await readFile(path.join(rootDir, "public", "i18n", "de.json"), "utf8"));
  const nativeNotificationCopy = [
    "nativeAlertTitle",
    "nativeUsedPercent",
    "nativeHardLimit",
    "nativePacingProjected",
    "nativeEstimatedExhaustion",
    "nativeWindowFiveHour",
    "nativeWindowWeekly"
  ].map((key) => deTranslations.settings.notifications[key]).join("\n");

  for (const fragment of [
    "Limit warning:",
    "Limit nearly exhausted",
    "pace projects",
    "Estimated exhaustion in",
    "% used"
  ]) {
    assert.equal(electronMain.includes(fragment), false, `Electron native notifications must not hardcode English fragment: ${fragment}`);
    assert.equal(nativeNotificationCopy.includes(fragment), false, `German native notification copy must not contain English fragment: ${fragment}`);
  }
  assert.equal(electronMain.includes("settings.notifications.nativeAlertTitle"), true);
  assert.equal(electronMain.includes("settings.notifications.nativePacingProjected"), true);
  assert.equal(deTranslations.settings.notifications.nativeAlertTitle, "Limit-Warnung: {window}");
  assert.equal(deTranslations.settings.notifications.nativeWindowWeekly, "Wochenlimit");

  const reset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const alerts = _test.buildNotificationAlerts(
    { hardLimitPercent: 80, pacingPercent: 90 },
    { codex: { limits: { weekly: { key: "weekly", label: "Weekly Codex limit", usedPercent: 85, windowMinutes: 10080, resetsAt: reset } } } }
  );
  assert.equal(alerts[0]?.windowKey, "weekly");
}

function assertUpdateSettingsAlwaysOn() {
  assert.equal(_test.sanitizeUpdateSettings({ enabled: false, allowPrerelease: false }).enabled, true);
  assert.equal(_test.sanitizeUpdateSettings({ enabled: false, allowPrerelease: false }).allowPrerelease, false);
  assert.deepEqual(
    _test.mergeUpdateSettingsPatch({ enabled: true, allowPrerelease: true }, { enabled: false, allowPrerelease: false }),
    { enabled: true, allowPrerelease: false }
  );
}

async function withTempCodexHome(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-provider-recency-"));
  const sessionsDir = path.join(root, "sessions");
  try {
    await mkdir(sessionsDir, { recursive: true });
    await callback(sessionsDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createAppContext() {
  const elements = new Map();
  function makeElement(id = "") {
    return {
      id,
      hidden: false,
      disabled: false,
      textContent: "",
      innerHTML: "",
      value: "",
      checked: false,
      dataset: {},
      style: {},
      classList: {
        add() {},
        remove() {},
        toggle() {},
        contains() {
          return false;
        }
      },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      closest() {
        return null;
      },
      cloneNode() {
        return makeElement(`${id}-clone`);
      },
      getBoundingClientRect() {
        return { width: 100, height: 50, top: 0, left: 0 };
      },
      appendChild() {},
      remove() {},
      focus() {},
      showModal() {},
      close() {}
    };
  }
  function getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  }
  const document = {
    hidden: false,
    documentElement: makeElement("html"),
    body: makeElement("body"),
    getElementById,
    querySelector(selector) {
      if (selector === "main.app-shell") return getElementById("appShell");
      return makeElement(selector);
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    createElement(tag) {
      return makeElement(tag);
    }
  };
  return {
    console,
    document,
    navigator: { platform: "MacIntel", clipboard: { writeText: async () => {} } },
    window: { lucide: null, requestAnimationFrame: (fn) => fn(), Notification: undefined, focus() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout,
    clearTimeout,
    setInterval() {
      return 0;
    },
    clearInterval() {},
    URLSearchParams,
    Intl,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    Map,
    Set,
    RegExp,
    Error
  };
}
