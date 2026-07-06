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
  totals: {
    last24h: { totalTokens: 1234 },
    last7d: { totalTokens: 3456 },
    allTime: { totalTokens: 7890 }
  }
};
state.chartTimeFilter = "h24";
const h24Total = usageTotalsForSelectedRange(local, filterDailyByRange(daily, "h24")).totalTokens;
state.chartTimeFilter = "today";
const todayTotal = usageTotalsForSelectedRange(local, filterDailyByRange(daily, "today")).totalTokens;
const models = summarizeModelUsageForDaily(daily);
const manualSubscription = normalizeSubscription({ planType: "Pro", monthlyCost: 20, currency: "EUR", source: "local_settings" });
const detectedSubscription = normalizeSubscription(null, { planType: "Max", source: "claude_auth_status" });
JSON.stringify({
  filters: CHART_FILTERS,
  h24Total,
  todayTotal,
  topModel: models[0]?.model,
  topModelCosted: models[0]?.cost?.costed,
  manualQuality: manualSubscription.quality,
  detectedQuality: detectedSubscription.quality,
  detectedCost: detectedSubscription.monthlyCost,
  limitOk: limitDisplayStatus({ usedPercent: 20 }),
  limitRisk: limitDisplayStatus({ usedPercent: 85 }),
  limitFull: limitDisplayStatus({ usedPercent: 100 }),
  limitUnknown: limitDisplayStatus({ status: "unavailable" }),
  aliasesCollapsed: /<details/.test(renderPricingAliases(pricingModels[0]))
});`,
    createAppContext(),
    { filename: appPath }
  ));

  assert.deepEqual(result.filters, ["h24", "today", "week", "month", "all"]);
  assert.equal(result.h24Total, 1234);
  assert.equal(result.todayTotal, 222);
  assert.equal(result.topModel, "claude-fable-5");
  assert.equal(result.topModelCosted, true);
  assert.equal(result.manualQuality, "manual");
  assert.equal(result.detectedQuality, "estimated");
  assert.equal(result.detectedCost, 0);
  assert.equal(result.limitOk, "ok");
  assert.equal(result.limitRisk, "risk");
  assert.equal(result.limitFull, "full");
  assert.equal(result.limitUnknown, "unknown");
  assert.equal(result.aliasesCollapsed, true);
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
