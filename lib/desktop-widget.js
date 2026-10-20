"use strict";

const crypto = require("node:crypto");
const { mergeClaudeLocalAccounts } = require("./claude-accounts");

const STALE_AFTER_MS = 15 * 60_000;
const PROVIDERS = Object.freeze({
  gpt: "ChatGPT / Codex", claude: "Claude Code", kimi: "Kimi Code", glm: "GLM / Z.AI",
  openai: "OpenAI API", anthropic: "Anthropic API", moonshot: "Moonshot API",
  copilot: "GitHub Copilot", gemini: "Gemini CLI"
});
const cleanLabel = (value, fallback = "") => typeof value === "string"
  ? value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 100) || fallback : fallback;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const percent = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const opaqueId = (provider, id) => `widget-${crypto.createHash("sha256").update(JSON.stringify([provider, id])).digest("hex").slice(0, 24)}`;

function quotaWindows(limits, updatedAt, current, now, quality = "measured") {
  return (Array.isArray(limits?.rows) ? limits.rows : []).map((row, index) => {
    const measuredAt = Object.hasOwn(row, "updatedAt") ? timestamp(row.updatedAt) : timestamp(updatedAt);
    const resetsAt = timestamp(row.resetsAt);
    const used = percent(row.usedPercent);
    const remaining = percent(row.remainingPercent) ?? (used === null ? null : 100 - used);
    const stale = !current || !measuredAt || now - Date.parse(measuredAt) > STALE_AFTER_MS ||
      Date.parse(measuredAt) > now + 60_000 || (resetsAt !== null && Date.parse(resetsAt) <= now);
    return {
      key: /^[a-zA-Z0-9_-]{1,64}$/.test(row.key) ? row.key : `window-${index + 1}`,
      label: cleanLabel(row.label),
      windowMinutes: typeof row.windowMinutes === "number" && Number.isFinite(row.windowMinutes) && row.windowMinutes > 0 ? row.windowMinutes : null,
      remainingPercent: remaining,
      resetsAt, measuredAt,
      status: remaining === null ? "unavailable" : stale ? "stale" : "current",
      quality: remaining === null ? "unavailable" : ["measured", "calculated_from_logs", "estimated"].includes(quality) ? quality : "unavailable"
    };
  });
}

// Project only normalized, account-scoped data. Never pass through the provider
// object, account identity, source path, error message, or authentication payload.
function buildDesktopWidgetSnapshot(usage = {}, now = Date.now()) {
  const accounts = new Map();
  const connected = mergeClaudeLocalAccounts(Array.isArray(usage.connectedAccounts) ? usage.connectedAccounts : [], usage.claudeCode, null, now);
  const add = (provider, identity, label, windows, sources = []) => {
    const id = opaqueId(provider, identity);
    accounts.set(id, { id, provider, label: cleanLabel(label, PROVIDERS[provider]), sources, windows });
  };
  for (const account of usage.gptAccounts?.accounts || []) {
    if (!account.id) continue;
    const sources = Array.isArray(account.sources) ? account.sources : [];
    const current = (source) => source.active && source.quotaStatus === "ready";
    const source = sources.filter((item) => item.limits?.rows?.length).sort((a, b) =>
      Number(current(b)) - Number(current(a)) || (Date.parse(b.limitsUpdatedAt) || 0) - (Date.parse(a.limitsUpdatedAt) || 0))[0];
    const profile = connected.find((item) => item.provider === "gpt" && item.accountId === account.id && item.managed);
    add("gpt", account.id, profile?.label || account.label,
      quotaWindows(source?.limits, source?.limitsUpdatedAt, Boolean(source && current(source)), now),
      [...new Set(sources.map((item) => item.id).filter((id) => ["codex", "openCode"].includes(id)))]);
  }
  for (const account of connected) {
    if (!Object.hasOwn(PROVIDERS, account.provider) || !account.id) continue;
    const identity = account.accountId || account.id;
    const id = opaqueId(account.provider, identity);
    if (accounts.has(id)) continue;
    add(account.provider, identity, account.label,
      quotaWindows(account.limits, account.updatedAt, account.quotaStatus === "current" ||
        (account.status === "connected" && account.quotaStatus !== "stale"), now, account.quotaQuality),
      account.localSource ? ["local"] : []);
  }
  // These collectors expose a single local source, rather than managed profiles.
  // Never use a provider-wide Codex/Claude limit to fill an account's missing quota.
  for (const provider of ["copilot", "gemini"]) {
    const value = usage[provider];
    if (!value?.limits?.rows?.length || [...accounts.values()].some((account) => account.provider === provider)) continue;
    add(provider, "local-source", PROVIDERS[provider], quotaWindows(value.limits,
      value.limitsUpdatedAt || value.quotaStatus?.updatedAt,
      !value.setup?.staleLimits && ["live", "ready"].includes(value.status), now));
  }
  // Labels do not establish identity. A visible provider-local ordinal also
  // distinguishes long labels with identical truncated prefixes.
  const values = [...accounts.values()];
  for (const account of values) {
    const peers = values.filter((item) => item.provider === account.provider)
      .sort((a, b) => a.id.localeCompare(b.id));
    account.labelIndex = peers.length > 1 ? peers.indexOf(account) + 1 : null;
  }
  return { generatedAt: timestamp(usage.generatedAt), staleAfterMs: STALE_AFTER_MS, accounts: values };
}

module.exports = { buildDesktopWidgetSnapshot, STALE_AFTER_MS, PROVIDERS };
