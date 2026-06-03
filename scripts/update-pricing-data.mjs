#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const APP_JS = new URL("../public/app.js", import.meta.url);
const ECB_DAILY_XML_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const PRICING_REVIEW_DATE = "2026-06-03";
const SCORE_REVIEW_DATE = "2026-06-03";

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
    model: "GPT-5.4 Mini",
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
    sourceUrl: "https://platform.openai.com/docs/pricing/"
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
    sourceUrl: "https://platform.openai.com/docs/pricing/"
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

const modelQualityScores = {
  "Claude Opus 4.8": 100,
  "GPT-5.5": 97,
  "Gemini 3.1 Pro Preview": 94,
  "GLM-5.1": 93,
  "DeepSeek V4 Pro": 92,
  "MiniMax M3": 88,
  "GPT-5.4": 87,
  "GPT-5.3-Codex": 86,
  "GPT-5.3-Codex-Spark": 85,
  "Claude Sonnet 4.6": 84,
  "Gemini 3.5 Flash": 83,
  "GPT-5.2": 80,
  "Qwen3-Max": 79,
  "GPT-5.4 Mini": 77,
  "GLM-4.7": 73,
  "Qwen3.5-Plus": 70,
  "step-3.7-flash": 68,
  "DeepSeek V4 Flash": 67,
  "Claude Haiku 4.5": 64,
  "Gemini 3.1 Flash-Lite": 62,
  "step-3.5-flash": 58
};

const args = new Set(process.argv.slice(2));

validatePricingData();

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
    /const USD_PER_EUR = [\d.]+;\nconst FX_DATE = "[^"]+";\nconst PRICING_DATE = "[^"]+";\nconst SCORE_DATE = "[^"]+";/;
  const dataPattern =
    /const pricingModels = \[[\s\S]*?\];\n\nconst modelQualityScores = \{[\s\S]*?\};/;

  const metaReplacement =
    `const USD_PER_EUR = ${rate};\n` +
    `const FX_DATE = "${date}";\n` +
    `const PRICING_DATE = "${PRICING_REVIEW_DATE}";\n` +
    `const SCORE_DATE = "${SCORE_REVIEW_DATE}";`;
  const dataReplacement =
    `const pricingModels = ${formatValue(pricingModels, 0)};\n\n` +
    `const modelQualityScores = ${formatValue(modelQualityScores, 0)};`;

  if (!metaPattern.test(source)) {
    throw new Error("Could not find pricing metadata in public/app.js.");
  }
  const withMeta = source.replace(metaPattern, metaReplacement);

  if (!dataPattern.test(withMeta)) {
    throw new Error("Could not find pricing model data in public/app.js.");
  }
  const withData = withMeta.replace(dataPattern, dataReplacement);

  return withData;
}

function validatePricingData() {
  const models = new Set(pricingModels.map((row) => row.model));
  const missingScores = pricingModels.filter((row) => !modelQualityScores[row.model]).map((row) => row.model);
  const staleScores = Object.keys(modelQualityScores).filter((model) => !models.has(model));

  if (missingScores.length) {
    throw new Error(`Missing quality scores: ${missingScores.join(", ")}`);
  }
  if (staleScores.length) {
    throw new Error(`Scores without pricing rows: ${staleScores.join(", ")}`);
  }

  for (const row of pricingModels) {
    for (const key of ["provider", "model", "region", "source", "sourceUrl"]) {
      if (!row[key]) throw new Error(`Pricing row for ${row.model || "unknown model"} misses ${key}.`);
    }
    for (const key of ["inputUsd", "cachedInputUsd", "outputUsd"]) {
      if (!Number.isFinite(row[key])) throw new Error(`Pricing row for ${row.model} has invalid ${key}.`);
    }
  }
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
