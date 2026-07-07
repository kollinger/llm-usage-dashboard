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
const detectedSubscriptionCard = renderSubscriptionPricingCard({
  provider: { id: "codex", name: "Codex", accent: providerMeta.codex.accent },
  subscription: detectedSubscription,
  previous: null
});
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
const providerCardHtml = renderProvider({
  id: "claudeCode",
  name: "Claude Code",
  kicker: "local CLI capture",
  accent: providerMeta.claudeCode.accent,
  status: "live",
  limitRows: [],
  creditRows: [],
  foot: [],
  apiTokens: 100,
  message: "Logged tokens"
});
const claudeWithFableHtml = renderProvider(normalizeLocalProvider("claudeCode", {
  status: "live",
  planType: "max",
  limits: {
    fable: { usedPercent: 29, remainingPercent: 71, windowMinutes: 10080, resetsAt: earlyWeekReset, resetLabel: "in 6d" }
  },
  totals: { last24h: { totalTokens: 100 }, allTime: { totalTokens: 500 } }
}));
const riskLimitBarHtml = renderLimitBar({ label: "Week", usedPercent: 50, remainingPercent: 50, windowMinutes: 10080, resetsAt: earlyWeekReset }, providerMeta.codex.accent);
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
    detectedSubscriptionCard.includes("$100.00/mo") &&
    detectedSubscriptionCard.includes("Catalog value"),
  aliasesHiddenByDefault: renderPricingAliases(pricingModels[0]) === "",
  aliasesCollapsedInDebug: /<details/.test(renderPricingAliases(pricingModels[0], { debug: true })),
	  sourceBarsUseProviderColors:
	    sourceBarsHtml.includes("--accent: " + providerMeta.codex.accent) &&
	    sourceBarsHtml.includes("--accent: " + providerMeta.claudeCode.accent),
	  providerCardUsesProviderAccent: providerCardHtml.includes("--provider-accent: " + providerMeta.claudeCode.accent),
  providerCardHasLogo: providerCardHtml.includes("provider-mark-claudeCode"),
  logoSamplesCoverCatalogProviders:
    logoSamples.includes("provider-mark-zai") &&
    logoSamples.includes("provider-mark-minimax") &&
    logoSamples.includes("provider-mark-deepseek") &&
    logoSamples.includes("provider-mark-alibaba") &&
    logoSamples.includes("provider-mark-xai") &&
    logoSamples.includes("provider-mark-mistral") &&
    logoSamples.includes("provider-mark-stepfun") &&
    logoSamples.includes("provider-mark-openai") &&
    logoSamples.includes("provider-mark-anthropic") &&
    logoSamples.includes("provider-mark-copilot") &&
    logoSamples.includes("provider-mark-gemini"),
	  riskLimitBarUsesProviderAccent:
	    riskLimitBarHtml.includes("--accent: " + providerMeta.codex.accent) &&
	    !riskLimitBarHtml.includes("--accent: #b76b00"),
  riskLimitBarHasProjectionGauge:
    riskLimitBarHtml.includes("limit-projection-gauge") &&
    riskLimitBarHtml.includes("Current Usage") &&
    riskLimitBarHtml.includes("100%") &&
    riskLimitBarHtml.includes("projected"),
	  fableLimitRowVisible:
	    claudeWithFableHtml.includes(">Fable<") &&
	    claudeWithFableHtml.includes("--accent: " + providerMeta.claudeCode.accent),
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
  assert.equal(result.detectedSource, "openai_public_catalog");
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
  assert.equal(result.aliasesHiddenByDefault, true);
  assert.equal(result.aliasesCollapsedInDebug, true);
  assert.equal(result.sourceBarsUseProviderColors, true);
  assert.equal(result.providerCardUsesProviderAccent, true);
  assert.equal(result.providerCardHasLogo, true);
  assert.equal(result.logoSamplesCoverCatalogProviders, true);
  assert.equal(result.riskLimitBarUsesProviderAccent, true);
  assert.equal(result.riskLimitBarHasProjectionGauge, true);
  assert.equal(result.fableLimitRowVisible, true);
  assert.equal(result.mixedCurrencyDeltaUnknown, true);
  assert.equal(result.sameCurrencyDeltaShown, true);

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
