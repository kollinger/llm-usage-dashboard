"use strict";

const crypto = require("node:crypto");
const { mergeClaudeLocalAccounts } = require("./claude-accounts");
const { normalizedGptAccountId } = require("./gpt-account-registry");
const { selectGptQuotaRows } = require("./gpt-account-quota");

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
  const gptGroups = new Map();
  const registryIdentities = new Map();
  const registryAccounts = usage.gptAccounts?.accounts || [];
  const groupGpt = (identity, account, originalIdentity) => {
    if (!gptGroups.has(identity)) gptGroups.set(identity, { labels: [], candidates: [], sources: new Set(), aliases: new Set() });
    const group = gptGroups.get(identity);
    group.labels.push({ label: account.label, managed: Boolean(account.managed), id: String(account.id) });
    group.aliases.add(opaqueId("gpt", originalIdentity));
    return group;
  };
  for (const account of registryAccounts) {
    if (!account.id) continue;
    const identity = account.identityQuality !== "email" && normalizedGptAccountId(account.accountId) || account.id;
    const mapped = registryIdentities.get(account.id);
    registryIdentities.set(account.id, mapped === undefined || mapped === identity ? identity : null);
    const group = groupGpt(identity, account, account.id);
    group.registry = true;
    for (const source of Array.isArray(account.sources) ? account.sources : []) {
      group.candidates.push({ ...source, current: Boolean(source.active && source.quotaStatus === "ready") });
      if (["codex", "openCode"].includes(source.id)) group.sources.add(source.id);
    }
  }
  for (const account of connected.filter((item) => item.provider === "gpt" && item.id)) {
    const originalIdentity = account.accountId || account.id;
    const identity = registryIdentities.get(account.accountId) ||
      normalizedGptAccountId(account.accountId) || account.id;
    const group = groupGpt(identity, account, originalIdentity);
    // Browser connections mirror a single registry source. They are useful for
    // labels, but their coarser timestamp must not refresh or add quota rows.
    if (!group.registry) group.candidates.push({ limits: account.limits, limitsUpdatedAt: account.updatedAt, quality: account.quotaQuality,
      current: account.quotaStatus === "current" || (account.status === "connected" && !["stale", "unavailable"].includes(account.quotaStatus)) });
    if (account.localSource) group.sources.add("local");
  }
  const aliasOwners = new Map();
  for (const [identity, group] of gptGroups) {
    const id = opaqueId("gpt", identity);
    for (const alias of new Set([id, ...group.aliases])) aliasOwners.set(alias, (aliasOwners.get(alias) || 0) + 1);
  }
  for (const [identity, group] of gptGroups) {
    const label = group.labels.sort((a, b) => Number(b.managed) - Number(a.managed) || a.id.localeCompare(b.id) ||
      cleanLabel(a.label).localeCompare(cleanLabel(b.label)))[0]?.label;
    const windows = selectGptQuotaRows(group.candidates, now, true).flatMap((candidate) => quotaWindows(
      { rows: [{ ...candidate.row, updatedAt: candidate.updatedAt }] }, null, candidate.current, now, candidate.quality));
    add("gpt", identity, label, windows, [...group.sources].sort());
    const id = opaqueId("gpt", identity);
    const aliases = [...group.aliases].filter((alias) => alias !== id && aliasOwners.get(alias) === 1).sort();
    if (aliases.length) accounts.get(id).aliases = aliases;
  }
  for (const account of connected) {
    if (account.provider === "gpt" || !Object.hasOwn(PROVIDERS, account.provider) || !account.id) continue;
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
