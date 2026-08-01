"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const GPT_ACCOUNT_REGISTRY_VERSION = 1;
const GPT_ACCOUNT_REGISTRY_FILE = "gpt-account-registry.json";
const GPT_SOURCE_IDS = new Set(["codex", "openCode"]);

function gptAccountRegistryPath(dataDir) {
  return path.join(dataDir, GPT_ACCOUNT_REGISTRY_FILE);
}

async function readGptAccountRegistry(dataDir) {
  try {
    return normalizeGptAccountRegistry(JSON.parse(await fsp.readFile(gptAccountRegistryPath(dataDir), "utf8")));
  } catch {
    return emptyGptAccountRegistry();
  }
}

async function writeGptAccountRegistry(dataDir, registry) {
  const normalized = normalizeGptAccountRegistry(registry);
  const target = gptAccountRegistryPath(dataDir);
  const temporary = `${target}.${process.pid}.tmp`;
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await fsp.chmod(temporary, 0o600);
  await fsp.rename(temporary, target);
  if (process.platform !== "win32") await fsp.chmod(target, 0o600);
  return normalized;
}

function emptyGptAccountRegistry() {
  return {
    version: GPT_ACCOUNT_REGISTRY_VERSION,
    lastScannedAt: null,
    scan: null,
    accounts: []
  };
}

function normalizeGptAccountRegistry(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const accounts = Array.isArray(value.accounts)
    ? value.accounts.map(normalizeStoredAccount).filter(Boolean)
    : [];
  return {
    version: GPT_ACCOUNT_REGISTRY_VERSION,
    lastScannedAt: normalizeIso(value.lastScannedAt),
    scan: normalizeScan(value.scan),
    accounts: accounts.sort(compareAccounts)
  };
}

function createGptAccountObservation({
  sourceId,
  sourceRef,
  email,
  accountId,
  planType,
  seenAt,
  usage,
  limits,
  limitsUpdatedAt,
  quotaStatus,
  quotaCheckedAt,
  dataQuality
} = {}) {
  if (!GPT_SOURCE_IDS.has(sourceId)) return null;
  const identity = accountIdentity({ email, accountId });
  if (!identity) return null;
  const observedAt = normalizeIso(seenAt) || new Date().toISOString();
  return {
    id: accountPublicId(identity.key),
    label: identity.label,
    identityQuality: identity.quality,
    sourceId,
    sourceRef: sourceRef ? opaqueSourceRef(sourceRef) : null,
    planType: shortString(planType),
    seenAt: observedAt,
    usage: normalizeAccountUsage(usage),
    limits: normalizeAccountLimits(limits),
    limitsUpdatedAt: normalizeIso(limitsUpdatedAt),
    quotaStatus: normalizeQuotaStatus(quotaStatus, limits ? "ready" : "unknown"),
    quotaCheckedAt: normalizeIso(quotaCheckedAt),
    dataQuality: shortString(dataQuality, "identity_only")
  };
}

function openCodeAccountObservationsFromAuth(auth, options = {}) {
  const value = auth && typeof auth === "object" && !Array.isArray(auth) ? auth : {};
  const observations = [];
  for (const [providerId, entry] of Object.entries(value)) {
    if (normalizeProviderId(providerId) !== "openai") continue;
    if (!entry || typeof entry !== "object" || String(entry.type || "").toLowerCase() !== "oauth") continue;
    const claims = parseJwtClaims(entry.access);
    const nestedAuth = claims?.["https://api.openai.com/auth"] || {};
    const nestedProfile = claims?.["https://api.openai.com/profile"] || {};
    const observation = createGptAccountObservation({
      sourceId: "openCode",
      sourceRef: options.profileRef || "default",
      email: claims?.email || nestedProfile.email,
      accountId:
        entry.accountId ||
        claims?.chatgpt_account_id ||
        nestedAuth.chatgpt_account_id ||
        claims?.organizations?.[0]?.id,
      planType: claims?.chatgpt_plan_type || nestedAuth.chatgpt_plan_type,
      seenAt: options.seenAt,
      dataQuality: "identity_only"
    });
    if (observation) observations.push(observation);
  }
  return observations;
}

function codexAccountObservationsFromAuth(auth, options = {}) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return [];
  const tokens = auth.tokens && typeof auth.tokens === "object" ? auth.tokens : {};
  const claims = parseJwtClaims(tokens.id_token) || parseJwtClaims(tokens.access_token);
  const nestedAuth = claims?.["https://api.openai.com/auth"] || {};
  const nestedProfile = claims?.["https://api.openai.com/profile"] || {};
  const observation = createGptAccountObservation({
    sourceId: "codex",
    sourceRef: options.profileRef || "default",
    email: claims?.email || nestedProfile.email,
    accountId:
      tokens.account_id ||
      claims?.chatgpt_account_id ||
      nestedAuth.chatgpt_account_id ||
      claims?.organizations?.[0]?.id,
    planType: claims?.chatgpt_plan_type || nestedAuth.chatgpt_plan_type,
    seenAt: options.seenAt,
    dataQuality: "identity_only"
  });
  return observation ? [observation] : [];
}

function parseJwtClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mergeGptAccountRegistry(current, observations, options = {}) {
  const scannedAt = normalizeIso(options.scannedAt) || new Date().toISOString();
  const normalized = normalizeGptAccountRegistry(current);
  const byId = new Map(normalized.accounts.map((account) => [account.id, deactivateStoredAccount(account)]));

  for (const rawObservation of observations || []) {
    const observation = normalizeObservation(rawObservation);
    if (!observation) continue;
    const existing = byId.get(observation.id);
    const account = existing || {
      id: observation.id,
      label: observation.label,
      identityQuality: observation.identityQuality,
      planType: null,
      firstSeenAt: observation.seenAt,
      lastSeenAt: observation.seenAt,
      active: false,
      sources: []
    };
    account.label = preferIdentityLabel(account, observation);
    account.identityQuality = preferIdentityQuality(account.identityQuality, observation.identityQuality);
    account.planType = observation.planType || account.planType || null;
    account.firstSeenAt = earliestIso(account.firstSeenAt, observation.seenAt);
    account.lastSeenAt = latestIso(account.lastSeenAt, observation.seenAt);
    account.active = true;
    account.sources = mergeAccountSource(account.sources, observation);
    byId.set(account.id, account);
  }

  const accounts = Array.from(byId.values())
    .map((account) => ({
      ...account,
      active: account.sources.some((source) => source.active)
    }))
    .sort(compareAccounts);
  return normalizeGptAccountRegistry({
    version: GPT_ACCOUNT_REGISTRY_VERSION,
    lastScannedAt: scannedAt,
    scan: options.scan || null,
    accounts
  });
}

function publicGptAccountRegistry(registry) {
  const normalized = normalizeGptAccountRegistry(registry);
  const activeSources = new Set();
  for (const account of normalized.accounts) {
    for (const source of account.sources) {
      if (source.active) activeSources.add(source.id);
    }
  }
  const activeAccounts = normalized.accounts.filter((account) => account.active);
  const quotaAccountCount = activeAccounts.filter(accountHasQuota).length;
  return {
    ...normalized,
    status: normalized.accounts.length ? "ready" : normalized.scan?.status === "error" ? "error" : "empty",
    accountCount: normalized.accounts.length,
    activeAccountCount: activeAccounts.length,
    quotaAccountCount,
    quotaMissingAccountCount: Math.max(0, activeAccounts.length - quotaAccountCount),
    activeSourceCount: activeSources.size,
    activeSources: Array.from(activeSources).sort()
  };
}

function accountHasQuota(account) {
  return (account?.sources || []).some((source) => (
    source?.active && source?.quotaStatus === "ready" && (source?.limits?.rows || []).length > 0
  ));
}

function normalizeStoredAccount(account) {
  if (!account || typeof account !== "object") return null;
  const id = String(account.id || "").trim();
  if (!/^gpt-[a-f0-9]{16}$/u.test(id)) return null;
  const sources = Array.isArray(account.sources)
    ? account.sources.map(normalizeStoredSource).filter(Boolean)
    : [];
  return {
    id,
    label: shortString(account.label, `GPT · ${id.slice(-6)}`),
    identityQuality: normalizeIdentityQuality(account.identityQuality),
    planType: shortString(account.planType),
    firstSeenAt: normalizeIso(account.firstSeenAt),
    lastSeenAt: normalizeIso(account.lastSeenAt),
    active: Boolean(account.active) && sources.some((source) => source.active),
    sources
  };
}

function normalizeStoredSource(source) {
  if (!source || typeof source !== "object") return null;
  const id = String(source.id || "").trim();
  if (!GPT_SOURCE_IDS.has(id)) return null;
  return {
    id,
    active: Boolean(source.active),
    firstSeenAt: normalizeIso(source.firstSeenAt),
    lastSeenAt: normalizeIso(source.lastSeenAt),
    profileRefs: Array.isArray(source.profileRefs)
      ? Array.from(new Set(source.profileRefs.map(opaqueSourceRef).filter(Boolean))).slice(0, 24)
      : [],
    usage: normalizeAccountUsage(source.usage),
    limits: normalizeAccountLimits(source.limits),
    limitsUpdatedAt: normalizeIso(source.limitsUpdatedAt),
    quotaStatus: normalizeQuotaStatus(source.quotaStatus, source.limits ? "ready" : "unknown"),
    quotaCheckedAt: normalizeIso(source.quotaCheckedAt),
    dataQuality: shortString(source.dataQuality, "identity_only")
  };
}

function normalizeObservation(observation) {
  if (!observation || typeof observation !== "object") return null;
  if (!/^gpt-[a-f0-9]{16}$/u.test(String(observation.id || ""))) return null;
  if (!GPT_SOURCE_IDS.has(observation.sourceId)) return null;
  const seenAt = normalizeIso(observation.seenAt) || new Date().toISOString();
  return {
    id: observation.id,
    label: shortString(observation.label, `GPT · ${observation.id.slice(-6)}`),
    identityQuality: normalizeIdentityQuality(observation.identityQuality),
    sourceId: observation.sourceId,
    sourceRef: observation.sourceRef ? opaqueSourceRef(observation.sourceRef) : null,
    planType: shortString(observation.planType),
    seenAt,
    usage: normalizeAccountUsage(observation.usage),
    limits: normalizeAccountLimits(observation.limits),
    limitsUpdatedAt: normalizeIso(observation.limitsUpdatedAt),
    quotaStatus: normalizeQuotaStatus(observation.quotaStatus, observation.limits ? "ready" : "unknown"),
    quotaCheckedAt: normalizeIso(observation.quotaCheckedAt),
    dataQuality: shortString(observation.dataQuality, "identity_only")
  };
}

function deactivateStoredAccount(account) {
  return {
    ...account,
    active: false,
    sources: account.sources.map((source) => ({ ...source, active: false }))
  };
}

function mergeAccountSource(sources, observation) {
  const next = (sources || []).map((source) => ({ ...source }));
  const index = next.findIndex((source) => source.id === observation.sourceId);
  const existing = index >= 0 ? next[index] : null;
  const profileRefs = Array.from(new Set([
    ...(existing?.profileRefs || []),
    ...(observation.sourceRef ? [observation.sourceRef] : [])
  ])).slice(0, 24);
  const source = normalizeStoredSource({
    id: observation.sourceId,
    active: true,
    firstSeenAt: earliestIso(existing?.firstSeenAt, observation.seenAt),
    lastSeenAt: latestIso(existing?.lastSeenAt, observation.seenAt),
    profileRefs,
    usage: observation.usage || existing?.usage,
    limits: observation.limits || existing?.limits,
    limitsUpdatedAt: observation.limitsUpdatedAt || existing?.limitsUpdatedAt,
    quotaStatus: observation.quotaStatus || existing?.quotaStatus,
    quotaCheckedAt: observation.quotaCheckedAt || existing?.quotaCheckedAt,
    dataQuality: observation.dataQuality || existing?.dataQuality
  });
  if (index >= 0) next[index] = source;
  else next.push(source);
  return next.sort((a, b) => a.id.localeCompare(b.id));
}

function accountIdentity({ email, accountId }) {
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    return {
      key: `email:${normalizedEmail}`,
      label: maskEmail(normalizedEmail),
      quality: "email"
    };
  }
  const normalizedAccountId = String(accountId || "").trim();
  if (!normalizedAccountId || normalizedAccountId.length > 320) return null;
  const id = accountPublicId(`account:${normalizedAccountId}`);
  return {
    key: `account:${normalizedAccountId}`,
    label: `GPT · ${id.slice(-6)}`,
    quality: "account_id"
  };
}

function accountPublicId(identityKey) {
  return `gpt-${crypto.createHash("sha256").update(`llm-usage-dashboard:${identityKey}`).digest("hex").slice(0, 16)}`;
}

function opaqueSourceRef(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^src-[a-f0-9]{12}$/u.test(text)) return text;
  return `src-${crypto.createHash("sha256").update(`llm-usage-dashboard-source:${text}`).digest("hex").slice(0, 12)}`;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/u.test(email) || email.length > 254) return null;
  return email;
}

function maskEmail(email) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "GPT account";
  const domainParts = domain.split(".");
  const domainName = domainParts.shift() || domain;
  const domainSuffix = domainParts.length ? `.${domainParts.join(".")}` : "";
  const visibleStart = local.slice(0, Math.min(2, local.length));
  const visibleEnd = local.length > 3 ? local.slice(-1) : "";
  const maskedDomain = `${domainName.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(6, domainName.length - 1)))}${domainSuffix}`;
  return `${visibleStart}${"•".repeat(Math.max(2, Math.min(6, local.length - visibleStart.length - visibleEnd.length)))}${visibleEnd}@${maskedDomain}`;
}

function normalizeAccountUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const summaryValue = usage.summary && typeof usage.summary === "object" ? usage.summary : usage;
  const summary = {
    lifetimeTokens: optionalNumber(summaryValue.lifetimeTokens),
    peakDailyTokens: optionalNumber(summaryValue.peakDailyTokens),
    longestRunningTurnSec: optionalNumber(summaryValue.longestRunningTurnSec),
    currentStreakDays: optionalNumber(summaryValue.currentStreakDays),
    longestStreakDays: optionalNumber(summaryValue.longestStreakDays)
  };
  const dailyUsageBuckets = (Array.isArray(usage.dailyUsageBuckets) ? usage.dailyUsageBuckets : [])
    .map((bucket) => ({
      startDate: normalizeDateOnly(bucket?.startDate),
      tokens: optionalNumber(bucket?.tokens)
    }))
    .filter((bucket) => bucket.startDate && bucket.tokens !== null)
    .slice(-400);
  if (!Object.values(summary).some((value) => value !== null) && !dailyUsageBuckets.length) return null;
  return { summary, dailyUsageBuckets };
}

function normalizeAccountLimits(limits) {
  if (!limits || typeof limits !== "object") return null;
  const rows = (Array.isArray(limits.rows) ? limits.rows : [limits.fiveHour, limits.weekly])
    .map(normalizeLimitRow)
    .filter(Boolean)
    .slice(0, 12);
  return rows.length ? { rows } : null;
}

function normalizeLimitRow(row) {
  if (!row || typeof row !== "object") return null;
  const usedPercent = optionalNumber(row.usedPercent);
  const remainingPercent = optionalNumber(row.remainingPercent);
  if (usedPercent === null && remainingPercent === null && !row.valueLabel) return null;
  return {
    key: shortString(row.key, "limit"),
    label: shortString(row.label, "Limit"),
    usedPercent,
    remainingPercent,
    windowMinutes: optionalNumber(row.windowMinutes),
    resetsAt: normalizeIso(row.resetsAt),
    valueLabel: shortString(row.valueLabel)
  };
}

function normalizeScan(scan) {
  if (!scan || typeof scan !== "object") return null;
  const sources = {};
  for (const sourceId of GPT_SOURCE_IDS) {
    const source = scan.sources?.[sourceId];
    if (!source || typeof source !== "object") continue;
    sources[sourceId] = {
      status: normalizeScanStatus(source.status),
      observations: Math.max(0, Math.round(Number(source.observations) || 0)),
      profilesScanned: Math.max(0, Math.round(Number(source.profilesScanned) || 0)),
      quotaAvailable: Math.max(0, Math.round(Number(source.quotaAvailable) || 0)),
      quotaUnavailable: Math.max(0, Math.round(Number(source.quotaUnavailable) || 0))
    };
  }
  return {
    status: normalizeScanStatus(scan.status),
    checkedAt: normalizeIso(scan.checkedAt),
    sources
  };
}

function normalizeScanStatus(value) {
  const status = String(value || "").trim();
  return ["ready", "empty", "partial", "error", "unavailable"].includes(status) ? status : "empty";
}

function normalizeQuotaStatus(value, fallback = "unknown") {
  const status = String(value || "").trim().toLowerCase();
  return ["ready", "unavailable", "unknown"].includes(status) ? status : fallback;
}

function normalizeProviderId(value) {
  return String(value || "").trim().toLowerCase().replace(/\/+$/u, "");
}

function normalizeIdentityQuality(value) {
  return value === "email" ? "email" : "account_id";
}

function preferIdentityQuality(current, candidate) {
  return current === "email" || candidate !== "email" ? current || candidate : "email";
}

function preferIdentityLabel(account, observation) {
  if (observation.identityQuality === "email") return observation.label;
  return account.label || observation.label;
}

function compareAccounts(a, b) {
  const activeDelta = Number(Boolean(b.active)) - Number(Boolean(a.active));
  if (activeDelta) return activeDelta;
  const seenDelta = Date.parse(b.lastSeenAt || "") - Date.parse(a.lastSeenAt || "");
  if (Number.isFinite(seenDelta) && seenDelta) return seenDelta;
  return String(a.label || a.id).localeCompare(String(b.label || b.id));
}

function earliestIso(a, b) {
  const left = normalizeIso(a);
  const right = normalizeIso(b);
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function latestIso(a, b) {
  const left = normalizeIso(a);
  const right = normalizeIso(b);
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function normalizeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeDateOnly(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : text;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function shortString(value, fallback = null) {
  const text = String(value || "").replace(/[\r\n\t]+/gu, " ").trim();
  return text ? text.slice(0, 160) : fallback;
}

module.exports = {
  GPT_ACCOUNT_REGISTRY_FILE,
  GPT_ACCOUNT_REGISTRY_VERSION,
  codexAccountObservationsFromAuth,
  createGptAccountObservation,
  emptyGptAccountRegistry,
  gptAccountRegistryPath,
  mergeGptAccountRegistry,
  normalizeGptAccountRegistry,
  openCodeAccountObservationsFromAuth,
  parseJwtClaims,
  publicGptAccountRegistry,
  readGptAccountRegistry,
  writeGptAccountRegistry
};
