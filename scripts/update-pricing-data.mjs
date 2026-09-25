#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";

const APP_JS = new URL("../public/app.js", import.meta.url);
const I18N_DIR = new URL("../public/i18n/", import.meta.url);
const ECB_DAILY_XML_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const PRICING_CATALOG_VERSION = "2026.09.25.1";
const PRICING_REVIEW_DATE = "2026-09-25";
const BASELINE_SOURCE_REVIEW_DATE = "2026-09-25";
const BENCHMARK_REVIEW_DATE = "2026-09-13";
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
  "Claude Mythos 5",
  "Claude Opus 4.8",
  "Claude Sonnet 5",
  "Claude Sonnet 4.6",
  "GPT-6 Astra",
  "GPT-6 Sol",
  "GPT-6 Luna",
  "GPT-5.6 Sol",
  "GPT-5.6 Terra",
  "GPT-5.6 Luna",
  "GPT-5.5 Pro",
  "GPT-5.4 Pro",
  "GPT-5.4 Nano",
  "GLM-5.2",
  "GLM-4.7-FlashX",
  "Gemini 3.1 Pro Preview",
  "Gemini 3.8 Flash",
  "Grok 4.6",
  "Grok 4.3",
  "Grok Build 0.1",
  "MiniMax M3",
  "Mistral Large 2",
  "Mistral Large 3",
  "Mistral Medium 3.5",
  "Qwen3.7-Max",
  "Qwen3.8-Max",
  "Qwen3-Max",
  "step-3.7-flash"
];

// Pricing reviewed from official provider pricing/model pages. Unknown values are
// kept as null so the UI can expose gaps instead of treating them as zero-cost.
const rawPricingModels = [
  {
    provider: "OpenAI",
    model: "GPT-6 Astra",
    aliases: ["gpt-6-astra"],
    region: "API/Codex",
    inputUsd: 10,
    cacheWriteUsd: 12.5,
    cachedInputUsd: 1,
    outputUsd: 50,
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    source: "OpenAI",
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-astra",
    sourceReviewDate: PRICING_REVIEW_DATE,
    sourceNotes: "Over 272K input tokens: 2x input/cache rates and 1.5x output for the full request."
  },
  {
    provider: "OpenAI",
    model: "GPT-5.6 Sol",
    aliases: ["gpt-5.6-sol", "gpt-5-6-sol", "gpt-5.6", "gpt-5-6"],
    region: "API/Codex",
    inputUsd: 4,
    cacheWriteUsd: 5,
    cachedInputUsd: 0.4,
    outputUsd: 20,
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    source: "OpenAI",
    sourceUrl: "https://developers.openai.com/api/docs/models/compare",
    sourceReviewDate: PRICING_REVIEW_DATE
  },
  {
    provider: "OpenAI",
    model: "GPT-6 Sol",
    aliases: ["gpt-6-sol", "gpt-6.0-sol", "gpt-6-0-sol"],
    region: "API/Codex",
    inputUsd: 2,
    cacheWriteUsd: 2.5,
    cachedInputUsd: 0.2,
    outputUsd: 10,
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    source: "OpenAI",
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-sol",
    sourceReviewDate: PRICING_REVIEW_DATE,
    sourceNotes: "Over 272K input tokens: 2x input/cache rates and 1.5x output for the full request. Batch and Flex are 50% of Standard rates."
  },
  {
    provider: "OpenAI",
    model: "GPT-6 Luna",
    aliases: ["gpt-6-luna", "gpt-6.0-luna", "gpt-6-0-luna"],
    region: "API/Codex",
    inputUsd: 0.1,
    cacheWriteUsd: 0.125,
    cachedInputUsd: 0.01,
    outputUsd: 0.5,
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    source: "OpenAI",
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-luna",
    sourceReviewDate: PRICING_REVIEW_DATE,
    sourceNotes: "Over 272K input tokens: 2x input/cache rates and 1.5x output for the full request. Batch and Flex are 50% of Standard rates."
  },
  {
    provider: "OpenAI",
    model: "GPT-5.6 Terra",
    aliases: ["gpt-5.6-terra", "gpt-5-6-terra"],
    region: "API/Codex",
    inputUsd: 2,
    cacheWriteUsd: 2.5,
    cachedInputUsd: 0.2,
    outputUsd: 12,
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    source: "OpenAI",
    sourceUrl: "https://developers.openai.com/api/docs/models/compare",
    sourceReviewDate: PRICING_REVIEW_DATE
  },
  {
    provider: "OpenAI",
    model: "GPT-5.6 Luna",
    aliases: ["gpt-5.6-luna", "gpt-5-6-luna"],
    region: "API/Codex",
    inputUsd: 0.2,
    cacheWriteUsd: 0.25,
    cachedInputUsd: 0.02,
    outputUsd: 1.2,
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    source: "OpenAI",
    sourceUrl: "https://developers.openai.com/api/docs/models/compare",
    sourceReviewDate: PRICING_REVIEW_DATE
  },
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
    model: "GPT-5.5 Pro",
    aliases: ["gpt-5.5-pro", "gpt-5-5-pro"],
    region: "API/Codex",
    inputUsd: 30,
    cachedInputUsd: null,
    outputUsd: 180,
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
    model: "GPT-5.4 Pro",
    aliases: ["gpt-5.4-pro", "gpt-5-4-pro"],
    region: "API/Codex",
    inputUsd: 30,
    cachedInputUsd: null,
    outputUsd: 180,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
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
    model: "GPT-5.4 Nano",
    aliases: ["gpt-5.4-nano", "gpt-5-4-nano"],
    region: "API/Codex",
    inputUsd: 0.2,
    cachedInputUsd: 0.02,
    outputUsd: 1.25,
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    source: "OpenAI",
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
    model: "Claude Mythos 5",
    aliases: ["claude-mythos-5", "anthropic.claude-mythos-5"],
    region: "Limited availability",
    inputUsd: 10,
    cacheWriteUsd: 12.5,
    cachedInputUsd: 1,
    outputUsd: 50,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    availability: "preview",
    source: "Anthropic",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    sourceNotes: "Invitation-only Project Glasswing model with Fable 5 specs and pricing."
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
    model: "Claude Sonnet 5",
    aliases: [
      "claude-sonnet-5",
      "anthropic.claude-sonnet-5",
      "claude-sonnet-5-0"
    ],
    region: "Global",
    inputUsd: 2,
    cacheWriteUsd: 2.5,
    cachedInputUsd: 0.2,
    outputUsd: 10,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    source: "Anthropic",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
    sourceNotes: "Current first-party global API rates. US-only inference carries a 1.1x multiplier."
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
    region: "<=512k permanent 50% off",
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
    model: "Gemini 3.8 Flash",
    aliases: ["gemini-3.8-flash", "models/gemini-3.8-flash"],
    region: "Standard through 2026-12-31",
    inputUsd: 0.75,
    cachedInputUsd: 0.075,
    outputUsd: 3.75,
    contextTokens: null,
    maxOutputTokens: null,
    source: "Google",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    sourceNotes: "Standard paid-tier pricing through December 31, 2026; Google lists higher rates from January 1, 2027."
  },
  {
    provider: "Google",
    model: "Gemini 3.7 Flash",
    aliases: ["gemini-3.7-flash", "models/gemini-3.7-flash"],
    region: "Standard through 2026-12-31",
    inputUsd: 0.75,
    cachedInputUsd: 0.075,
    outputUsd: 3.75,
    contextTokens: null,
    maxOutputTokens: null,
    source: "Google",
    sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    sourceNotes: "Standard paid-tier pricing through December 31, 2026; Google lists higher rates from January 1, 2027."
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
    inputUsd: 1.32,
    cachedInputUsd: 0.044,
    outputUsd: 3.96,
    contextTokens: 1_000_000,
    maxOutputTokens: 384_000,
    source: "DeepSeek",
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
    sourceNotes: "Peak rates. DeepSeek documents half-price off-peak billing outside weekday 01:00–04:00 and 06:00–10:00 UTC.",
    china: true
  },
  {
    provider: "DeepSeek",
    model: "DeepSeek V4.1 Flash",
    aliases: ["deepseek-flash", "deepseek-v4.1-flash", "deepseek-v4-1-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
    region: "API",
    inputUsd: 0.3,
    cachedInputUsd: 0.006,
    outputUsd: 1.2,
    contextTokens: 1_000_000,
    maxOutputTokens: 384_000,
    source: "DeepSeek",
    sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
    sourceNotes: "Peak rates. Legacy DeepSeek V4 Flash requests are served and billed as V4.1 Flash; off-peak rates are 50% lower.",
    china: true
  },
  {
    provider: "Alibaba",
    model: "Qwen3.8-Max",
    aliases: ["qwen3.8-max", "qwen3-8-max", "qwen3.8-max-0902"],
    region: "Global <=1M",
    inputUsd: 1.65,
    cacheWriteUsd: 2.063,
    cachedInputUsd: 0.165,
    outputUsd: 4.951,
    contextTokens: 1_000_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "Alibaba",
    sourceUrl: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
    china: true
  },
  {
    provider: "Alibaba",
    model: "Qwen3.7-Max",
    aliases: ["qwen3.7-max", "qwen3-7-max", "qwen3.7-max-2026-06-08", "qwen3.7-max-2026-05-20"],
    region: "Global <=1M",
    inputUsd: 1.65,
    cacheWriteUsd: 2.063,
    cachedInputUsd: 0.165,
    outputUsd: 4.951,
    contextTokens: 1_000_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "Alibaba",
    sourceUrl: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
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
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
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
    contextTokens: 200_000,
    maxOutputTokens: 128_000,
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
    contextTokens: 200_000,
    maxOutputTokens: 128_000,
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
    contextTokens: 200_000,
    maxOutputTokens: 128_000,
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
    contextTokens: 200_000,
    maxOutputTokens: 128_000,
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
    contextTokens: 200_000,
    maxOutputTokens: 128_000,
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
    contextTokens: 200_000,
    maxOutputTokens: 128_000,
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
    contextTokens: 200_000,
    maxOutputTokens: 128_000,
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
    maxOutputTokens: 96_000,
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
    maxOutputTokens: 96_000,
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
    maxOutputTokens: 96_000,
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
    maxOutputTokens: 96_000,
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
    maxOutputTokens: 96_000,
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
    maxOutputTokens: 16_000,
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
    model: "Grok 4.6",
    aliases: ["grok-4.6", "grok-4-6"],
    region: "Text API, <200k prompt",
    inputUsd: 2,
    cachedInputUsd: 0.5,
    outputUsd: 6,
    contextTokens: 500_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "xAI",
    sourceUrl: "https://docs.x.ai/developers/pricing",
    sourceNotes: "For prompts of 200k tokens or more, xAI bills the full request at $4 input, $1 cached input, and $12 output per 1M tokens."
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
    model: "Mistral Large 3",
    aliases: ["mistral-large-3", "mistral-large-latest"],
    region: "API",
    inputUsd: 0.5,
    cachedInputUsd: 0.05,
    outputUsd: 1.5,
    contextTokens: null,
    maxOutputTokens: null,
    source: "Mistral",
    sourceUrl: "https://docs.mistral.ai/inference/pricing"
  },
  {
    provider: "Mistral",
    model: "Mistral Medium 3.5",
    aliases: ["mistral-medium-3.5", "mistral-medium-latest"],
    region: "API",
    inputUsd: 1.5,
    cachedInputUsd: 0.15,
    outputUsd: 7.5,
    contextTokens: null,
    maxOutputTokens: null,
    source: "Mistral",
    sourceUrl: "https://docs.mistral.ai/inference/pricing"
  },
  {
    provider: "Mistral",
    model: "Mistral Small 4",
    aliases: ["mistral-small-4", "mistral-small-latest"],
    region: "API",
    inputUsd: 0.15,
    cachedInputUsd: 0.015,
    outputUsd: 0.6,
    contextTokens: null,
    maxOutputTokens: null,
    source: "Mistral",
    sourceUrl: "https://docs.mistral.ai/inference/pricing"
  },
  {
    provider: "Mistral",
    model: "Mistral Large 2",
    aliases: ["mistral-large-2"],
    region: "API",
    inputUsd: null,
    cachedInputUsd: null,
    outputUsd: null,
    priceStatus: "unknown",
    availability: "deprecated",
    contextTokens: 128_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "Mistral",
    sourceUrl: "https://docs.mistral.ai/getting-started/models/"
  },
  {
    provider: "Mistral",
    model: "Mistral Small 3.2",
    aliases: ["mistral-small-3.2"],
    region: "API",
    inputUsd: null,
    cachedInputUsd: null,
    outputUsd: null,
    priceStatus: "unknown",
    availability: "deprecated",
    contextTokens: 128_000,
    maxOutputTokens: null,
    limitStatus: "official",
    source: "Mistral",
    sourceUrl: "https://docs.mistral.ai/getting-started/models/"
  }
];

// Arena Text is an independent, human-preference benchmark. Keep the exact
// tested deployment instead of projecting a nearby model's result onto a
// catalog row. Scores from other benchmarks are intentionally not mixed into
// this Elo scale.
const ARENA_TEXT_SOURCE = "Arena Text";
const ARENA_TEXT_SOURCE_URL = "https://arena.ai/leaderboard/";
const arenaTextSnapshot = {
  "GPT-6 Astra": { score: 1480, rank: 24, votes: 2693, testedModel: "gpt-6-astra-max" },
  "GPT-5.6 Sol": { score: 1483, rank: 18, votes: 27069, testedModel: "gpt-5.6-sol-xhigh" },
  "GPT-5.6 Terra": { score: 1466, rank: 45, votes: 28119, testedModel: "gpt-5.6-terra-xhigh" },
  "GPT-5.6 Luna": { score: 1452, rank: 67, votes: 28547, testedModel: "gpt-5.6-luna-xhigh" },
  "GPT-5.5": { score: 1476, rank: 28, votes: 66317, testedModel: "gpt-5.5" },
  "GPT-5.4": { score: 1466, rank: 46, votes: 63526, testedModel: "gpt-5.4" },
  "GPT-5.4 Mini": { score: 1448, rank: 74, votes: 59387, testedModel: "gpt-5.4-mini-high" },
  "GPT-5.4 Nano": { score: 1402, rank: 146, votes: 58424, testedModel: "gpt-5.4-nano-high" },
  "GPT-5.2": { score: 1436, rank: 91, votes: 78967, testedModel: "gpt-5.2" },
  "Claude Fable 5": { score: 1506, rank: 1, votes: 30057, testedModel: "claude-fable-5-high" },
  "Claude Opus 4.8": { score: 1473, rank: 35, votes: 53446, testedModel: "claude-opus-4-8" },
  "Claude Sonnet 5": { score: 1461, rank: 51, votes: 35301, testedModel: "claude-sonnet-5-high" },
  "Claude Sonnet 4.6": { score: 1473, rank: 37, votes: 66208, testedModel: "claude-sonnet-4-6" },
  "Claude Haiku 4.5": { score: 1415, rank: 129, votes: 129278, testedModel: "claude-haiku-4-5-20251001" },
  "MiniMax M3": { score: 1441, rank: 84, votes: 48540, testedModel: "minimax-m3" },
  "Gemini 3.8 Flash": { score: 1493, rank: 9, votes: 5076, testedModel: "gemini-3.8-flash-high" },
  "Gemini 3.7 Flash": { score: 1490, rank: 12, votes: 5640, testedModel: "gemini-3.7-flash-high" },
  "Gemini 3.5 Flash": { score: 1478, rank: 25, votes: 38257, testedModel: "gemini-3.5-flash-high" },
  "Gemini 3.1 Pro Preview": { score: 1487, rank: 15, votes: 106951, testedModel: "gemini-3.1-pro-preview" },
  "Gemini 3.1 Flash-Lite": { score: 1432, rank: 98, votes: 60405, testedModel: "gemini-3.1-flash-lite-preview" },
  "DeepSeek V4 Pro": { score: 1457, rank: 57, votes: 54130, testedModel: "deepseek-v4-pro" },
  "DeepSeek V4.1 Flash": { score: 1436, rank: 92, votes: 48887, testedModel: "deepseek-v4-flash" },
  "Qwen3.8-Max": { score: 1481, rank: 22, votes: 16670, testedModel: "qwen3.8-max" },
  "Qwen3.7-Max": { score: 1473, rank: 34, votes: 3705, testedModel: "qwen3.7-max-preview" },
  "Qwen3-Max": { score: 1435, rank: 94, votes: 27194, testedModel: "qwen3-max-preview" },
  "GLM-5.2": { score: 1472, rank: 38, votes: 36798, testedModel: "glm-5.2-max" },
  "GLM-5.1": { score: 1466, rank: 47, votes: 48901, testedModel: "glm-5.1" },
  "GLM-5": { score: 1458, rank: 56, votes: 27605, testedModel: "glm-5" },
  "GLM-4.7": { score: 1442, rank: 83, votes: 11893, testedModel: "glm-4.7" },
  "GLM-4.7-Flash": { score: 1366, rank: 186, votes: 11491, testedModel: "glm-4.7-flash" },
  "GLM-4.6": { score: 1425, rank: 112, votes: 35061, testedModel: "glm-4.6" },
  "GLM-4.5": { score: 1411, rank: 136, votes: 23712, testedModel: "glm-4.5" },
  "GLM-4.5-Air": { score: 1373, rank: 182, votes: 30367, testedModel: "glm-4.5-air" },
  "step-3.5-flash": { score: 1394, rank: 158, votes: 57137, testedModel: "step-3.5-flash" },
  "Grok 4.6": { score: 1456, rank: 63, votes: 15521, testedModel: "grok-4.6-high" },
  "Grok 4.3": { score: 1443, rank: 81, votes: 66801, testedModel: "grok-4.3" },
  "Mistral Large 3": { score: 1413, rank: 133, votes: 69028, testedModel: "mistral-large-3" },
  "Mistral Medium 3.5": { score: 1426, rank: 106, votes: 10996, testedModel: "mistral-medium-3.5" }
};

const modelBenchmarkScores = Object.fromEntries(
  rawPricingModels.map(({ model }) => {
    const score = arenaTextSnapshot[model];
    return [
      model,
      score
        ? { source: ARENA_TEXT_SOURCE, sourceUrl: ARENA_TEXT_SOURCE_URL, measuredOn: BENCHMARK_REVIEW_DATE, ...score }
        : null
    ];
  })
);

const args = new Set(process.argv.slice(2));
const pricingModels = enrichPricingModels(rawPricingModels);

await validatePricingData();

if (args.has("--validate")) {
  console.log(
    `Pricing catalog ${PRICING_CATALOG_VERSION} is valid: ${pricingModels.length} models, ${benchmarkCoverageCount()} independently benchmarked, ${REQUIRED_PROVIDER_COVERAGE.length} required providers.`
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
      sourceReviewDate: row.sourceReviewDate || BASELINE_SOURCE_REVIEW_DATE,
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
    /const USD_PER_EUR = [\d.]+;\nconst FX_DATE = "[^"]+";\nconst PRICING_DATE = "[^"]+";\nconst (?:SCORE_DATE|BENCHMARK_DATE) = "[^"]+";(?:\nconst PRICING_CATALOG_VERSION = "[^"]+";\nconst PRICING_MAX_AGE_DAYS = \d+;)?/;
  const pricingPattern = /const pricingModels = \[[\s\S]*?\];/;
  const benchmarkPattern = /const model(?:Quality|Benchmark)Scores = \{[\s\S]*?\};/;

  const metaReplacement =
    `const USD_PER_EUR = ${rate};\n` +
    `const FX_DATE = "${date}";\n` +
    `const PRICING_DATE = "${PRICING_REVIEW_DATE}";\n` +
    `const BENCHMARK_DATE = "${BENCHMARK_REVIEW_DATE}";\n` +
    `const PRICING_CATALOG_VERSION = "${PRICING_CATALOG_VERSION}";\n` +
    `const PRICING_MAX_AGE_DAYS = ${PRICING_MAX_AGE_DAYS};`;
  const pricingReplacement = `const pricingModels = ${formatValue(pricingModels, 0)};`;
  const benchmarkReplacement = `const modelBenchmarkScores = ${formatValue(modelBenchmarkScores, 0)};`;

  if (!metaPattern.test(source)) {
    throw new Error("Could not find pricing metadata in public/app.js.");
  }
  const withMeta = source.replace(metaPattern, metaReplacement);

  if (!pricingPattern.test(withMeta)) {
    throw new Error("Could not find pricing model data in public/app.js.");
  }
  const withPricing = withMeta.replace(pricingPattern, pricingReplacement);

  if (!benchmarkPattern.test(withPricing)) {
    throw new Error("Could not find model benchmark scores in public/app.js.");
  }
  return withPricing.replace(benchmarkPattern, benchmarkReplacement);
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
  const missingScores = pricingModels.filter((row) => !Object.hasOwn(modelBenchmarkScores, row.model)).map((row) => row.model);
  const staleScores = Object.keys(modelBenchmarkScores).filter((model) => !models.has(model));
  const missingProviders = REQUIRED_PROVIDER_COVERAGE.filter((provider) => !providers.has(provider));
  const missingRequiredModels = REQUIRED_MODEL_COVERAGE.filter((model) => !models.has(model));

  if (missingScores.length) throw new Error(`Missing benchmark coverage entries: ${missingScores.join(", ")}`);
  if (staleScores.length) throw new Error(`Benchmark entries without pricing rows: ${staleScores.join(", ")}`);
  if (missingProviders.length) throw new Error(`Missing required providers: ${missingProviders.join(", ")}`);
  if (missingRequiredModels.length) throw new Error(`Missing required models: ${missingRequiredModels.join(", ")}`);

  const canonicalNames = new Map();
  for (const row of pricingModels) {
    validateCatalogRow(row);
    validateBenchmarkScore(row.model, modelBenchmarkScores[row.model]);
    addCanonicalName(canonicalNames, row.model, row.model);
    for (const alias of row.aliases) addCanonicalName(canonicalNames, alias, row.model);
  }
}

function benchmarkCoverageCount() {
  return Object.values(modelBenchmarkScores).filter(Boolean).length;
}

function validateBenchmarkScore(model, benchmark) {
  if (benchmark == null) return;
  for (const key of ["source", "sourceUrl", "measuredOn", "testedModel"]) {
    if (!benchmark[key]) throw new Error(`Benchmark entry for ${model} misses ${key}.`);
  }
  for (const key of ["score", "rank", "votes"]) {
    if (!Number.isFinite(benchmark[key]) || benchmark[key] < 0) {
      throw new Error(`Benchmark entry for ${model} has invalid ${key}.`);
    }
  }
  if (!Number.isInteger(benchmark.rank) || !Number.isInteger(benchmark.votes)) {
    throw new Error(`Benchmark entry for ${model} has a non-integer rank or vote count.`);
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
