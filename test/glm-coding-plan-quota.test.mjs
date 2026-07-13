import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.env.CODEX_LIVE_RATE_LIMITS = "false";

const require = createRequire(import.meta.url);
const { _test } = require("../server.js");
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

assertOfficialBaseDomainDetection();
await assertOpenCodeAuthDetectionIsRedacted();
await assertLooseConfigParsingDoesNotPairUnrelatedTokens();
assertQuotaNormalizationKeepsZeroAndKnownWindowsOnly();
await assertQuotaFetchIsSanitizedAndTimeouts();
await assertGlmUsageMergesOfficialQuotaWithoutChangingTokens();
await assertGenericOpenCodeConfigDoesNotActivateGlmCard();
await assertFrontendRendersGlmQuotaRows();

function assertOfficialBaseDomainDetection() {
  assert.deepEqual(_test.resolveGlmCodingPlanBase("https://api.z.ai/api/anthropic"), {
    provider: "zai",
    platform: "ZAI",
    baseDomain: "https://api.z.ai",
    quotaLimitUrl: "https://api.z.ai/api/monitor/usage/quota/limit"
  });
  assert.equal(_test.resolveGlmCodingPlanBase("https://open.bigmodel.cn/api/anthropic").provider, "bigmodel");
  assert.equal(_test.resolveGlmCodingPlanBase("https://dev.bigmodel.cn/api/anthropic").platform, "ZHIPU");
  assert.equal(_test.resolveGlmCodingPlanBase("https://api.z.ai.evil.test/api/anthropic"), null);
  assert.equal(_test.resolveGlmCodingPlanBase("http://api.z.ai/api/anthropic"), null);
}

async function assertOpenCodeAuthDetectionIsRedacted() {
  const root = await mkdtemp(path.join(os.tmpdir(), "glm-auth-"));
  try {
    const configFile = path.join(root, "opencode.json");
    await writeFile(configFile, `${JSON.stringify({
      provider: {
        baseURL: "https://open.bigmodel.cn/api/anthropic",
        authToken: "secret-config-token"
      }
    })}\n`);
    const auth = await _test.readGlmCodingPlanAuth({
      env: {},
      sources: [{
        id: "glm-test-source",
        providerId: "glm",
        paths: [{ role: "opencode_config", path: configFile, kind: "file" }]
      }]
    });

    assert.equal(auth.status, "available");
    assert.equal(auth.provider, "bigmodel");
    assert.equal(auth.accessToken, "secret-config-token");
    const summary = _test.summarizeGlmCodingPlanAuth(auth);
    assert.equal(summary.hasAuth, true);
    assert.equal(summary.configFilesScanned, 1);
    assert.equal(JSON.stringify(summary).includes("secret-config-token"), false);

    const envAuth = await _test.readGlmCodingPlanAuth({
      env: {
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "secret-env-token"
      },
      sources: []
    });
    assert.equal(envAuth.status, "available");
    assert.equal(envAuth.provider, "zai");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertLooseConfigParsingDoesNotPairUnrelatedTokens() {
  const root = await mkdtemp(path.join(os.tmpdir(), "glm-auth-loose-"));
  try {
    const configFile = path.join(root, "broken-config.txt");
    await writeFile(configFile, [
      "provider openai",
      "apiKey = secret-other-provider-token",
      "baseURL = https://api.z.ai/api/anthropic"
    ].join("\n"));

    const auth = await _test.readGlmCodingPlanAuth({
      env: {},
      sources: [{
        id: "glm-test-source",
        providerId: "glm",
        paths: [{ role: "opencode_config", path: configFile, kind: "file" }]
      }]
    });

    assert.equal(auth.status, "missing");
    assert.equal(auth.reason, "glm_coding_plan_auth_missing");
    assert.equal(auth.baseDomain, "https://api.z.ai");
    assert.equal(auth.hasAuth, false);
    assert.equal(auth.accessToken, undefined);
    assert.equal(JSON.stringify(_test.summarizeGlmCodingPlanAuth(auth)).includes("secret-other-provider-token"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertQuotaNormalizationKeepsZeroAndKnownWindowsOnly() {
  const limits = _test.normalizeGlmCodingPlanQuotaPayload({
    data: {
      limits: [
        {
          type: "TOKENS_LIMIT",
          percentage: 0,
          currentValue: 0,
          usage: 100000,
          resetTime: "2099-01-01T00:00:00.000Z"
        },
        {
          type: "WEEKLY_LIMIT",
          percentage: 12.5,
          currentValue: 125,
          usage: 1000
        },
        {
          type: "TIME_LIMIT",
          percentage: 25,
          currentValue: 5,
          usage: 20,
          periodLabel: "monthly"
        },
        {
          type: "UNKNOWN_LIMIT",
          percentage: 99
        }
      ]
    }
  });

  assert.equal(limits.rows.length, 3);
  assert.equal(limits.fiveHour.key, "glmFiveHourTokens");
  assert.equal(limits.fiveHour.usedPercent, 0);
  assert.equal(limits.fiveHour.remainingPercent, 100);
  assert.equal(limits.fiveHour.valueLabel, "0 / 100,000");
  assert.equal(limits.weekly.key, "glmWeekly");
  assert.equal(limits.rows.some((row) => row.key === "UNKNOWN_LIMIT"), false);
  assert.equal(limits.rows.find((row) => row.key === "glmMcpMonthly").valueLabel, "5 / 20");
}

async function assertQuotaFetchIsSanitizedAndTimeouts() {
  const auth = {
    status: "available",
    source: "environment",
    provider: "zai",
    platform: "ZAI",
    baseDomain: "https://api.z.ai",
    quotaLimitUrl: "https://api.z.ai/api/monitor/usage/quota/limit",
    accessToken: "secret-fetch-token",
    hasAuth: true
  };
  let observedUrl = null;
  let observedAuthorization = null;
  const probe = await _test.fetchGlmCodingPlanQuota({
    auth,
    timeoutMs: 100,
    fetchImpl: async (url, options) => {
      observedUrl = url;
      observedAuthorization = options.headers.Authorization;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: {
              limits: [{ type: "TOKENS_LIMIT", percentage: 42 }],
              accessToken: "must-not-survive"
            }
          });
        }
      };
    }
  });

  assert.equal(observedUrl, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(observedAuthorization, "secret-fetch-token");
  assert.equal(probe.status, "available");
  assert.equal(probe.limits.rows[0].usedPercent, 42);
  const serializedProbe = JSON.stringify(probe);
  assert.equal(serializedProbe.includes("secret-fetch-token"), false);
  assert.equal(serializedProbe.includes("must-not-survive"), false);

  const timeoutProbe = await _test.fetchGlmCodingPlanQuota({
    auth,
    timeoutMs: 1,
    fetchImpl: () => new Promise(() => {})
  });
  assert.equal(timeoutProbe.status, "unavailable");
  assert.equal(timeoutProbe.reason, "glm_coding_plan_timeout");
}

async function assertGlmUsageMergesOfficialQuotaWithoutChangingTokens() {
  const root = await mkdtemp(path.join(os.tmpdir(), "glm-usage-"));
  try {
    const usageFile = path.join(root, "glm-usage-events.jsonl");
    await writeFile(usageFile, `${JSON.stringify({
      provider: "zai",
      model: "glm-5.2",
      timestamp: "2099-01-01T00:00:00.000Z",
      usage: {
        input_tokens: 2,
        output_tokens: 1
      }
    })}\n`);
    const quotaLimits = _test.normalizeGlmCodingPlanQuotaPayload({
      data: { limits: [{ type: "TOKENS_LIMIT", percentage: 10, currentValue: 10, usage: 100 }] }
    });
    const usage = await _test.readGlmUsage({
      sources: [{
        id: "glm-test-source",
        providerId: "glm",
        paths: [{ role: "usage_events_jsonl", path: usageFile, kind: "file" }]
      }],
      quotaReader: async () => ({
        status: "available",
        source: "zai_usage_api_quota_limit",
        updatedAt: "2099-01-01T00:00:01.000Z",
        limits: quotaLimits,
        auth: { status: "available", hasAuth: true, configFilesScanned: 0, configFilesWithBaseUrl: 0 }
      })
    });

    assert.equal(usage.status, "live");
    assert.equal(usage.totals.allTime.totalTokens, 3);
    assert.equal(usage.limits.rows[0].key, "glmFiveHourTokens");
    assert.equal(usage.limitsUpdatedAt, "2099-01-01T00:00:01.000Z");
    assert.equal(usage.quotaStatus.hasLimits, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertGenericOpenCodeConfigDoesNotActivateGlmCard() {
  const usage = await _test.readGlmUsage({
    sources: [],
    quotaReader: async () => ({
      status: "missing",
      reason: "glm_coding_plan_auth_missing",
      source: "opencode_config",
      updatedAt: "2099-01-01T00:00:01.000Z",
      limits: null,
      auth: {
        status: "missing",
        reason: "glm_coding_plan_auth_missing",
        source: "opencode_config",
        hasAuth: false,
        configFilesScanned: 1,
        configFilesWithBaseUrl: 0
      }
    })
  });

  assert.equal(usage.status, "empty");
  assert.equal(usage.usageQuality, null);
  assert.equal(usage.source.hasConfiguredSource, false);
  assert.equal(usage.message, "No local GLM/Z.AI usage events found.");
}

async function assertFrontendRendersGlmQuotaRows() {
  const appPath = path.join(rootDir, "public", "app.js");
  const i18nPath = path.join(rootDir, "public", "i18n", "en.json");
  const appSource = await readFile(appPath, "utf8");
  const translations = JSON.parse(await readFile(i18nPath, "utf8"));
  const code = appSource.replace("\ninit();", "\n// init disabled for GLM quota render test");
  assert.notEqual(code, appSource, "GLM quota render test must disable app bootstrap");

  const result = JSON.parse(vm.runInNewContext(
    `${code}
state.translations = ${JSON.stringify(translations)};
state.fallbackTranslations = {};
const provider = normalizeLocalProvider("glm", {
  status: "live",
  totals: {
    allTime: { totalTokens: 3 },
    last5h: { totalTokens: 3 },
    last24h: { totalTokens: 3 },
    last7d: { totalTokens: 3 }
  },
  limits: {
    rows: [
      { key: "glmFiveHourTokens", label: "5h tokens", usedPercent: 0, remainingPercent: 100, valueLabel: "0 / 100", windowMinutes: 300 },
      { key: "glmMcpMonthly", label: "Monthly MCP", usedPercent: 25, remainingPercent: 75, valueLabel: "5 / 20", windowMinutes: 43200 }
    ]
  },
  limitsUpdatedAt: "2099-01-01T00:00:01.000Z",
  quotaStatus: { updatedAt: "2099-01-01T00:00:01.000Z" }
});
const html = renderLimitBars(provider);
JSON.stringify({
  limitsUpdatedAt: provider.limitsUpdatedAt,
  rowCount: provider.limitRows.length,
  firstLabel: provider.limitRows[0].label,
  firstUsed: provider.limitRows[0].usedPercent,
  htmlHasZero: html.includes("0% used"),
  htmlHasMonthly: html.includes("Monthly MCP")
});`,
    createAppContext(),
    { filename: appPath }
  ));

  assert.equal(result.limitsUpdatedAt, "2099-01-01T00:00:01.000Z");
  assert.equal(result.rowCount, 2);
  assert.equal(result.firstLabel, "5h tokens");
  assert.equal(result.firstUsed, 0);
  assert.equal(result.htmlHasZero, true);
  assert.equal(result.htmlHasMonthly, true);
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
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      addEventListener() {},
      querySelectorAll() { return []; },
      querySelector() { return null; },
      closest() { return null; }
    };
  }
  const document = {
    documentElement: makeElement("html"),
    querySelector(selector) {
      if (selector === "main.app-shell") return makeElement("appShell");
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    addEventListener() {}
  };
  return {
    document,
    window: { requestAnimationFrame(callback) { callback(); } },
    navigator: { language: "en-US", languages: ["en-US"] },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    Intl,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    JSON,
    RegExp,
    console
  };
}
