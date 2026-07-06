#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";

const APP_JS = new URL("../public/app.js", import.meta.url);
const I18N_DIR = new URL("../public/i18n/", import.meta.url);
const ECB_DAILY_XML_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const PRICING_CATALOG_VERSION = "2026.07.06";
const PRICING_REVIEW_DATE = "2026-07-06";
const SCORE_REVIEW_DATE = "2026-07-06";
const PRICING_MAX_AGE_DAYS = 45;

const REQUIRED_PROVIDER_COVERAGE = [
  "Alibaba",
  "Anthropic",
  "DeepSeek",
  "Google",
  "MiniMax",
  "Mistral",
  "OpenAI",
  "StepFun",
  "xAI",
  "Z.AI"
];

const REQUIRED_MODEL_COVERAGE = [
  "Claude Fable 5",
  "Claude Haiku 4.5",
  "Claude Opus 4.8",
  "Claude Sonnet 4.6",
  "GLM-5.2",
  "Gemini 3.1 Pro Preview",
  "Grok 4.3",
  "Grok Build 0.1",
  "MiniMax M3",
  "Mistral Large 2",
  "Qwen3-Max",
  "step-3.7-flash"
];

// Pricing reviewed from official provider pricing/model pages. Unknown values are
// kept as null so the UI can expose gaps instead of treating them as zero-cost.
const rawPricingModels = [
  {
    provider: "OpenAI",
    model: "GPT-5.5",
    aliases: ["gpt-5.5", "gpt-5-5"],
    region: "API/Codex",
    inputUsd: 5,
    cachedInputUsd: 0.5,
    outputUsd: 30,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    source: "OpenAI",
    sourceUrl: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.4",
    aliases: ["gpt-5.4", "gpt-5-4"],
    region: "API/Codex",
    inputUsd: 2.5,
    cachedInputUsd: 0.25,
    outputUsd: 15,
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    source: "OpenAI",
    sourceUrl: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.4 Mini",
    aliases: ["gpt-5.4-mini", "gpt-5-4-mini"],
    region: "Codex",
    inputUsd: 0.75,
    cachedInputUsd: 0.075,
    outputUsd: 4.5,
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    source: "OpenAI Codex",
    sourceUrl: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.3-Codex",
    aliases: ["gpt-5.3-codex", "gpt-5-3-codex", "gpt-5.3"],
    region: "Codex",
    inputUsd: 1.75,
    cachedInputUsd: 0.175,
    outputUsd: 14,
    contextTokens: 400_000,
    maxOutputTokens: 64_000,
    source: "OpenAI Codex",
    sourceUrl: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.3-Codex-Spark",
    aliases: ["gpt-5.3-codex-spark", "gpt-5-3-codex-spark", "codex-spark"],
    region: "Codex Spark",
    inputUsd: 1.75,
    cachedInputUsd: 0.175,
    outputUsd: 14,
    contextTokens: 400_000,
    maxOutputTokens: 64_000,
    source: "OpenAI Codex",
    sourceUrl: "https://openai.com/blog/introducing-gpt-5-3-codex-spark/"
  },
  {
    provider: "OpenAI",
    model: "GPT-5.2",
    aliases: ["gpt-5.2", "gpt-5-2"],
    region: "Legacy",
    inputUsd: 1.75,
    cachedInputUsd: 0.175,
    outputUsd: 14,
    contextTokens: 400_000,
    maxOutputTokens: 64_000,
    source: "OpenAI",
    sourceUrl: "https://developers.openai.com/api/docs/pricing"
  },
  {
    provider: "Anthropic",
    model: "Claude Fable 5",
    aliases: ["claude-fable-5", "anthropic.claude-fable-5"],
    region: "Global",
    inputUsd: 10,
    cacheWriteUsd: 12.5,
    cachedInputUsd: 1,
    outputUsd: 50,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    source: "Anthropic",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/models/overview"
  },
  {
    provider: "Anthropic",
    model: "Claude Opus 4.8",
    aliases: [
      "claude-opus-4-8",
      "anthropic.claude-opus-4-8",
      "claude-opus-4.8",
      "claude-opus-4-7",
      "claude-opus-4-6"
    ],
    region: "Global",
    inputUsd: 5,
    cacheWriteUsd: 6.25,
    cachedInputUsd: 0.5,
    outputUsd: 25,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    source: "Anthropic",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/models/overview"
  },
  {
    provider: "Anthropic",
    model: "Claude Sonnet 4.6",
    aliases: [
      "claude-sonnet-4-6",
      "anthropic.claude-sonnet-4-6",
      "claude-sonnet-4.6",
      "claude-sonnet-4-5",
      "claude-sonnet-4"
    ],
    region: "Global",
    inputUsd: 3,
    cacheWriteUsd: 3.75,
    cachedInputUsd: 0.3,
    outputUsd: 15,
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    source: "Anthropic",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/models/overview"
  },
  {
    provider: "Anthropic",
    model: "Claude Haiku 4.5",
    aliases: [
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "anthropic.claude-haiku-4-5-20251001-v1:0"
    ],
    region: "Global",
    inputUsd: 1,
    cacheWriteUsd: 1.25,
    cachedInputUsd: 0.1,
    outputUsd: 5,
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
    source: "Anthropic",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/models/overview"
  },
  {
    provider: "MiniMax",
    model: "MiniMax M3",
    aliases: ["minimax-m3"],
    region: "<=512k 7d promo",
    inputUsd: 0.3,
    cachedInputUsd: 0.06,
    outputUsd: 1.2,
    contextTokens: 512_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "MiniMax",
    sourceUrl: "https://platform.minimax.io/docs/guides/pricing-paygo",
    china: true
  },
  {
    provider: "Google",
    model: "Gemini 3.1 Pro Preview",
    aliases: ["gemini-3.1-pro-preview", "models/gemini-3.1-pro-preview"],
    region: "<=200k",
    inputUsd: 2,
    cachedInputUsd: 0.2,
    outputUsd: 12,
    contextTokens: 1_000_000,
    maxOutputTokens: 65_536,
    availability: "preview",
    source: "Google",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  {
    provider: "Google",
    model: "Gemini 3.5 Flash",
    aliases: ["gemini-3.5-flash", "models/gemini-3.5-flash", "gemini-flash-latest"],
    region: "Standard",
    inputUsd: 1.5,
    cachedInputUsd: 0.15,
    outputUsd: 9,
    contextTokens: 1_000_000,
    maxOutputTokens: 65_536,
    source: "Google",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  {
    provider: "Google",
    model: "Gemini 3.1 Flash-Lite",
    aliases: ["gemini-3.1-flash-lite", "models/gemini-3.1-flash-lite"],
    region: "Standard",
    inputUsd: 0.25,
    cachedInputUsd: 0.025,
    outputUsd: 1.5,
    contextTokens: 1_000_000,
    maxOutputTokens: 65_536,
    source: "Google",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing"
  },
  {
    provider: "DeepSeek",
    model: "DeepSeek V4 Pro",
    aliases: ["deepseek-v4-pro"],
    region: "API",
    inputUsd: 0.435,
    cachedInputUsd: 0.003625,
    outputUsd: 0.87,
    contextTokens: 128_000,
    maxOutputTokens: 8_000,
    source: "DeepSeek",
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
    china: true
  },
  {
    provider: "DeepSeek",
    model: "DeepSeek V4 Flash",
    aliases: ["deepseek-v4-flash"],
    region: "API",
    inputUsd: 0.14,
    cachedInputUsd: 0.0028,
    outputUsd: 0.28,
    contextTokens: 128_000,
    maxOutputTokens: 8_000,
    source: "DeepSeek",
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
    china: true
  },
  {
    provider: "Alibaba",
    model: "Qwen3-Max",
    aliases: ["qwen3-max", "qwen-max"],
    region: "Global <=32k",
    inputUsd: 0.359,
    cachedInputUsd: 0.0718,
    outputUsd: 1.434,
    contextTokens: 32_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "Alibaba",
    sourceUrl: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
    china: true
  },
  {
    provider: "Alibaba",
    model: "Qwen3.5-Plus",
    aliases: ["qwen3.5-plus", "qwen3-5-plus", "qwen-plus"],
    region: "Global <=128k",
    inputUsd: 0.115,
    cachedInputUsd: 0.023,
    outputUsd: 0.688,
    contextTokens: 128_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "Alibaba",
    sourceUrl: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-5.2",
    aliases: ["glm-5.2", "glm-5-2"],
    region: "Global",
    inputUsd: 1.4,
    cachedInputUsd: 0.26,
    outputUsd: 4.4,
    contextTokens: 128_000,
    maxOutputTokens: 64_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-5.1",
    aliases: ["glm-5.1", "glm-5-1"],
    region: "Global",
    inputUsd: 1.4,
    cachedInputUsd: 0.26,
    outputUsd: 4.4,
    contextTokens: 128_000,
    maxOutputTokens: 64_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-5",
    aliases: ["glm-5"],
    region: "Global",
    inputUsd: 1,
    cachedInputUsd: 0.2,
    outputUsd: 3.2,
    contextTokens: 128_000,
    maxOutputTokens: 64_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-5-Turbo",
    aliases: ["glm-5-turbo"],
    region: "Global",
    inputUsd: 1.2,
    cachedInputUsd: 0.24,
    outputUsd: 4,
    contextTokens: 128_000,
    maxOutputTokens: 64_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.7",
    aliases: ["glm-4.7", "glm-4-7"],
    region: "Global",
    inputUsd: 0.6,
    cachedInputUsd: 0.11,
    outputUsd: 2.2,
    contextTokens: 128_000,
    maxOutputTokens: 32_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.7-FlashX",
    aliases: ["glm-4.7-flashx", "glm-4-7-flashx"],
    region: "Global",
    inputUsd: 0.07,
    cachedInputUsd: 0.01,
    outputUsd: 0.4,
    contextTokens: 128_000,
    maxOutputTokens: 32_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.7-Flash",
    aliases: ["glm-4.7-flash", "glm-4-7-flash"],
    region: "Global free tier",
    inputUsd: 0,
    cachedInputUsd: 0,
    outputUsd: 0,
    contextTokens: 128_000,
    maxOutputTokens: 32_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.6",
    aliases: ["glm-4.6", "glm-4-6"],
    region: "Global",
    inputUsd: 0.6,
    cachedInputUsd: 0.11,
    outputUsd: 2.2,
    contextTokens: 128_000,
    maxOutputTokens: 32_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.5",
    aliases: ["glm-4.5", "glm-4-5"],
    region: "Global",
    inputUsd: 0.6,
    cachedInputUsd: 0.11,
    outputUsd: 2.2,
    contextTokens: 128_000,
    maxOutputTokens: 32_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.5-X",
    aliases: ["glm-4.5-x", "glm-4-5-x"],
    region: "Global",
    inputUsd: 2.2,
    cachedInputUsd: 0.45,
    outputUsd: 8.9,
    contextTokens: 128_000,
    maxOutputTokens: 32_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.5-Air",
    aliases: ["glm-4.5-air", "glm-4-5-air"],
    region: "Global",
    inputUsd: 0.2,
    cachedInputUsd: 0.03,
    outputUsd: 1.1,
    contextTokens: 128_000,
    maxOutputTokens: 32_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.5-AirX",
    aliases: ["glm-4.5-airx", "glm-4-5-airx"],
    region: "Global",
    inputUsd: 1.1,
    cachedInputUsd: 0.22,
    outputUsd: 4.5,
    contextTokens: 128_000,
    maxOutputTokens: 32_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4.5-Flash",
    aliases: ["glm-4.5-flash", "glm-4-5-flash"],
    region: "Global free tier",
    inputUsd: 0,
    cachedInputUsd: 0,
    outputUsd: 0,
    contextTokens: 128_000,
    maxOutputTokens: 32_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "Z.AI",
    model: "GLM-4-32B-0414-128K",
    aliases: ["glm-4-32b-0414-128k"],
    region: "Global",
    inputUsd: 0.1,
    cachedInputUsd: 0.1,
    outputUsd: 0.1,
    contextTokens: 128_000,
    maxOutputTokens: 32_000,
    source: "Z.AI",
    sourceUrl: "https://docs.z.ai/guides/overview/pricing",
    china: true
  },
  {
    provider: "StepFun",
    model: "step-3.7-flash",
    aliases: ["step-3.7-flash", "step-3-7-flash"],
    region: "API",
    inputUsd: 0.2,
    cachedInputUsd: 0.04,
    outputUsd: 1.15,
    contextTokens: 128_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "StepFun",
    sourceUrl: "https://platform.stepfun.ai/docs/en/pricing/details",
    china: true
  },
  {
    provider: "StepFun",
    model: "step-3.5-flash",
    aliases: ["step-3.5-flash", "step-3-5-flash"],
    region: "API",
    inputUsd: 0.1,
    cachedInputUsd: 0.02,
    outputUsd: 0.3,
    contextTokens: 128_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "StepFun",
    sourceUrl: "https://platform.stepfun.ai/docs/en/pricing/details",
    china: true
  },
  {
    provider: "xAI",
    model: "Grok 4.3",
    aliases: ["grok-4.3", "grok-4-3"],
    region: "Chat API",
    inputUsd: 1.25,
    cachedInputUsd: 0.2,
    outputUsd: 2.5,
    contextTokens: 1_000_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "xAI",
    sourceUrl: "https://docs.x.ai/developers/pricing",
    sourceNotes: "Chat API table lists Cached input at $0.20 per 1M tokens."
  },
  {
    provider: "xAI",
    model: "Grok Build 0.1",
    aliases: ["grok-build-0.1", "grok-build-0-1"],
    region: "Code API",
    inputUsd: 1,
    cachedInputUsd: 0.2,
    outputUsd: 2,
    contextTokens: 256_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "xAI",
    sourceUrl: "https://docs.x.ai/developers/pricing",
    sourceNotes: "Code API table lists Cached input at $0.20 per 1M tokens."
  },
  {
    provider: "Mistral",
    model: "Mistral Large 2",
    aliases: ["mistral-large-2", "mistral-large-latest"],
    region: "API",
    inputUsd: null,
    cachedInputUsd: null,
    outputUsd: null,
    priceStatus: "unknown",
    contextTokens: 128_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "Mistral",
    sourceUrl: "https://docs.mistral.ai/getting-started/models/"
  },
  {
    provider: "Mistral",
    model: "Mistral Small 3.2",
    aliases: ["mistral-small-3.2", "mistral-small-latest"],
    region: "API",
    inputUsd: null,
    cachedInputUsd: null,
    outputUsd: null,
    priceStatus: "unknown",
    contextTokens: 128_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "Mistral",
    sourceUrl: "https://docs.mistral.ai/getting-started/models/"
  }
];

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
  "Grok 4.3": 81,
  "GPT-5.2": 80,
  "Qwen3-Max": 79,
  "GPT-5.4 Mini": 77,
  "Grok Build 0.1": 76,
  "Mistral Large 2": 75,
  "GLM-4.6": 74,
  "GLM-4.7": 73,
  "GLM-4.5-X": 72,
  "GLM-4.5-AirX": 71,
  "Qwen3.5-Plus": 70,
  "GLM-4.5": 69,
  "step-3.7-flash": 68,
  "DeepSeek V4 Flash": 67,
  "GLM-4.5-Air": 66,
  "Mistral Small 3.2": 65,
  "Claude Haiku 4.5": 64,
  "Gemini 3.1 Flash-Lite": 62,
  "GLM-4.7-FlashX": 61,
  "step-3.5-flash": 58,
  "GLM-4-32B-0414-128K": 56,
  "GLM-4.7-Flash": 55,
  "GLM-4.5-Flash": 55
};

const args = new Set(process.argv.slice(2));
const pricingModels = enrichPricingModels(rawPricingModels);

await validatePricingData();

if (args.has("--validate")) {
  console.log(
    `Pricing catalog ${PRICING_CATALOG_VERSION} is valid: ${pricingModels.length} models, ${REQUIRED_PROVIDER_COVERAGE.length} required providers.`
  );
  process.exit(0);
}

const { rate, date } = await fetchUsdPerEur();
const appJs = await readFile(APP_JS, "utf8");
const nextAppJs = updateAppJs(appJs, { rate, date });

if (args.has("--check")) {
  if (nextAppJs !== appJs) {
    console.error("Pricing data is stale. Run `npm run pricing:update`.");
    process.exitCode = 1;
  } else {
    console.log(`Pricing data is current. ECB USD/EUR ${rate} from ${date}.`);
  }
} else if (args.has("--dry-run")) {
  console.log(nextAppJs);
} else {
  await writeFile(APP_JS, nextAppJs);
  console.log(`Updated public/app.js with ECB USD/EUR ${rate} from ${date}.`);
}

function enrichPricingModels(rows) {
  return rows.map((row) => {
    const contextTokens = row.contextTokens ?? null;
    const maxOutputTokens = row.maxOutputTokens ?? null;
    return {
      provider: row.provider,
      model: row.model,
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      region: row.region,
      inputUsd: row.inputUsd ?? null,
      cacheWriteUsd: row.cacheWriteUsd,
      cachedInputUsd: row.cachedInputUsd ?? null,
      outputUsd: row.outputUsd ?? null,
      currency: "USD",
      unit: "1M tokens",
      priceStatus: row.priceStatus || "official",
      availability: row.availability || "ga",
      contextTokens,
      maxOutputTokens,
      limitStatus: row.limitStatus || (contextTokens || maxOutputTokens ? "official" : "unknown"),
      source: row.source,
      sourceUrl: row.sourceUrl,
      sourceReviewDate: row.sourceReviewDate || PRICING_REVIEW_DATE,
      sourceNotes: row.sourceNotes,
      china: row.china || undefined
    };
  });
}

async function fetchUsdPerEur() {
  const response = await fetch(ECB_DAILY_XML_URL);
  if (!response.ok) {
    throw new Error(`Could not fetch ECB reference rates: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const dateMatch = xml.match(/<Cube time='([^']+)'/);
  const usdMatch = xml.match(/<Cube currency='USD' rate='([^']+)'/);

  if (!dateMatch || !usdMatch) {
    throw new Error("Could not find USD rate in ECB reference-rate XML.");
  }

  return { date: dateMatch[1], rate: usdMatch[1] };
}

function updateAppJs(source, { rate, date }) {
  const metaPattern =
    /const USD_PER_EUR = [\d.]+;\nconst FX_DATE = "[^"]+";\nconst PRICING_DATE = "[^"]+";\nconst SCORE_DATE = "[^"]+";(?:\nconst PRICING_CATALOG_VERSION = "[^"]+";\nconst PRICING_MAX_AGE_DAYS = \d+;)?/;
  const pricingPattern = /const pricingModels = \[[\s\S]*?\];/;
  const scoresPattern = /const modelQualityScores = \{[\s\S]*?\};/;

  const metaReplacement =
    `const USD_PER_EUR = ${rate};\n` +
    `const FX_DATE = "${date}";\n` +
    `const PRICING_DATE = "${PRICING_REVIEW_DATE}";\n` +
    `const SCORE_DATE = "${SCORE_REVIEW_DATE}";\n` +
    `const PRICING_CATALOG_VERSION = "${PRICING_CATALOG_VERSION}";\n` +
    `const PRICING_MAX_AGE_DAYS = ${PRICING_MAX_AGE_DAYS};`;
  const pricingReplacement = `const pricingModels = ${formatValue(pricingModels, 0)};`;
  const scoresReplacement = `const modelQualityScores = ${formatValue(modelQualityScores, 0)};`;

  if (!metaPattern.test(source)) {
    throw new Error("Could not find pricing metadata in public/app.js.");
  }
  const withMeta = source.replace(metaPattern, metaReplacement);

  if (!pricingPattern.test(withMeta)) {
    throw new Error("Could not find pricing model data in public/app.js.");
  }
  const withPricing = withMeta.replace(pricingPattern, pricingReplacement);

  if (!scoresPattern.test(withPricing)) {
    throw new Error("Could not find model quality scores in public/app.js.");
  }
  return withPricing.replace(scoresPattern, scoresReplacement);
}

async function validatePricingData() {
  validateFreshReviewDate();
  validateCatalogRows();
  await validatePricingTranslations();
}

function validateFreshReviewDate() {
  const reviewMs = Date.parse(`${PRICING_REVIEW_DATE}T00:00:00Z`);
  if (!Number.isFinite(reviewMs)) throw new Error(`Invalid pricing review date: ${PRICING_REVIEW_DATE}`);

  const ageMs = Date.now() - reviewMs;
  const ageDays = Math.floor(ageMs / 86_400_000);
  if (ageDays > PRICING_MAX_AGE_DAYS) {
    throw new Error(
      `Pricing catalog review date ${PRICING_REVIEW_DATE} is ${ageDays} days old; refresh it before ${PRICING_MAX_AGE_DAYS} days.`
    );
  }
}

function validateCatalogRows() {
  const models = new Set(pricingModels.map((row) => row.model));
  const providers = new Set(pricingModels.map((row) => row.provider));
  const missingScores = pricingModels.filter((row) => !modelQualityScores[row.model]).map((row) => row.model);
  const staleScores = Object.keys(modelQualityScores).filter((model) => !models.has(model));
  const missingProviders = REQUIRED_PROVIDER_COVERAGE.filter((provider) => !providers.has(provider));
  const missingRequiredModels = REQUIRED_MODEL_COVERAGE.filter((model) => !models.has(model));

  if (missingScores.length) throw new Error(`Missing quality scores: ${missingScores.join(", ")}`);
  if (staleScores.length) throw new Error(`Scores without pricing rows: ${staleScores.join(", ")}`);
  if (missingProviders.length) throw new Error(`Missing required providers: ${missingProviders.join(", ")}`);
  if (missingRequiredModels.length) throw new Error(`Missing required models: ${missingRequiredModels.join(", ")}`);

  const canonicalNames = new Map();
  for (const row of pricingModels) {
    validateCatalogRow(row);
    addCanonicalName(canonicalNames, row.model, row.model);
    for (const alias of row.aliases) addCanonicalName(canonicalNames, alias, row.model);
  }
}

function validateCatalogRow(row) {
  for (const key of [
    "provider",
    "model",
    "region",
    "currency",
    "unit",
    "priceStatus",
    "availability",
    "limitStatus",
    "source",
    "sourceUrl",
    "sourceReviewDate"
  ]) {
    if (!row[key]) throw new Error(`Pricing row for ${row.model || "unknown model"} misses ${key}.`);
  }

  if (!["official", "estimated", "unknown", "mixed"].includes(row.priceStatus)) {
    throw new Error(`Pricing row for ${row.model} has invalid priceStatus ${row.priceStatus}.`);
  }
  if (!["ga", "preview", "deprecated", "unknown"].includes(row.availability)) {
    throw new Error(`Pricing row for ${row.model} has invalid availability ${row.availability}.`);
  }
  if (!["official", "estimated", "unknown"].includes(row.limitStatus)) {
    throw new Error(`Pricing row for ${row.model} has invalid limitStatus ${row.limitStatus}.`);
  }

  for (const key of ["inputUsd", "cachedInputUsd", "outputUsd"]) validateNullableNumber(row, key);
  if (row.cacheWriteUsd !== undefined) validateNullableNumber(row, "cacheWriteUsd");
  for (const key of ["contextTokens", "maxOutputTokens"]) validateNullableInteger(row, key);

  if (row.priceStatus !== "unknown" && row.inputUsd == null && row.outputUsd == null) {
    throw new Error(`Pricing row for ${row.model} is priced as ${row.priceStatus} but lacks input/output prices.`);
  }
  if (row.limitStatus === "official" && row.contextTokens == null && row.maxOutputTokens == null) {
    throw new Error(`Pricing row for ${row.model} marks limits official but lacks token limits.`);
  }
}

function validateNullableNumber(row, key) {
  if (row[key] == null) return;
  if (!Number.isFinite(row[key]) || row[key] < 0) {
    throw new Error(`Pricing row for ${row.model} has invalid ${key}.`);
  }
}

function validateNullableInteger(row, key) {
  if (row[key] == null) return;
  if (!Number.isInteger(row[key]) || row[key] <= 0) {
    throw new Error(`Pricing row for ${row.model} has invalid ${key}.`);
  }
}

function addCanonicalName(index, alias, model) {
  const canonical = canonicalModelName(alias);
  if (!canonical) return;
  const existing = index.get(canonical);
  if (existing && existing !== model) {
    throw new Error(`Catalog alias collision: ${alias} maps to both ${existing} and ${model}.`);
  }
  index.set(canonical, model);
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

async function validatePricingTranslations() {
  const files = (await readdir(I18N_DIR)).filter((file) => file.endsWith(".json")).sort();
  if (!files.includes("en.json")) throw new Error("Missing public/i18n/en.json.");

  const locales = new Map();
  for (const file of files) {
    const data = JSON.parse(await readFile(new URL(file, I18N_DIR), "utf8"));
    locales.set(file, data);
  }

  const expected = flattenObject(locales.get("en.json").pricing || {}, "pricing");
  const expectedKeys = Object.keys(expected).sort();
  for (const [file, data] of locales.entries()) {
    const actual = flattenObject(data.pricing || {}, "pricing");
    const actualKeys = Object.keys(actual).sort();
    const missingKeys = expectedKeys.filter((key) => !actualKeys.includes(key));
    const extraKeys = actualKeys.filter((key) => !expectedKeys.includes(key));
    if (missingKeys.length || extraKeys.length) {
      throw new Error(
        `${file} pricing i18n mismatch. Missing: ${missingKeys.join(", ") || "none"}; extra: ${extraKeys.join(", ") || "none"}.`
      );
    }
    for (const key of expectedKeys) {
      const expectedPlaceholders = placeholders(expected[key]);
      const actualPlaceholders = placeholders(actual[key]);
      if (expectedPlaceholders.join(",") !== actualPlaceholders.join(",")) {
        throw new Error(
          `${file} ${key} placeholders mismatch. Expected ${expectedPlaceholders.join(",") || "none"}, got ${
            actualPlaceholders.join(",") || "none"
          }.`
        );
      }
    }
  }
}

function flattenObject(value, prefix) {
  const result = {};
  for (const [key, item] of Object.entries(value || {})) {
    const nextKey = `${prefix}.${key}`;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      Object.assign(result, flattenObject(item, nextKey));
    } else {
      result[nextKey] = String(item ?? "");
    }
  }
  return result;
}

function placeholders(value) {
  return Array.from(String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g), (match) => match[1]).sort();
}

function formatValue(value, indent) {
  if (Array.isArray(value)) return formatArray(value, indent);
  if (value && typeof value === "object") return formatObject(value, indent);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "null";
  throw new Error(`Unsupported value type: ${typeof value}`);
}

function formatArray(values, indent) {
  const current = " ".repeat(indent);
  const child = " ".repeat(indent + 2);
  return `[\n${values.map((value) => `${child}${formatValue(value, indent + 2)}`).join(",\n")}\n${current}]`;
}

function formatObject(object, indent) {
  const current = " ".repeat(indent);
  const child = " ".repeat(indent + 2);
  const entries = Object.entries(object).filter(([, value]) => value !== undefined);

  return `{\n${entries
    .map(([key, value]) => `${child}${formatKey(key)}: ${formatValue(value, indent + 2)}`)
    .join(",\n")}\n${current}}`;
}

function formatKey(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}
