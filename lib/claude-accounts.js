"use strict";

const crypto = require("node:crypto");

const quotaAccountId = (value) => typeof value === "string" && /^claude-[a-f0-9]{24}$/.test(value) ? value : null;

// Managed and detected CLI sessions use the same account + organization boundary.
// Display labels never establish identity.
function claudeAccountIdentity(raw = {}) {
  const identity = typeof raw.accountId === "string" && raw.accountId.trim() ? raw.accountId.trim() :
    typeof raw.email === "string" && raw.email.trim() ? raw.email.trim().toLowerCase() : null;
  if (!identity) return null;
  const org = [raw.orgId, raw.org_id, raw.organizationUuid, raw.organization_uuid]
    .find((value) => typeof value === "string" && value.trim())?.trim() || null;
  return `claude-${crypto.createHash("sha256").update(JSON.stringify([identity, org])).digest("hex").slice(0, 24)}`;
}

function mergeClaudeLocalAccounts(accounts = [], usage = null, auth = null, now = Date.now()) {
  const hasLimits = Boolean(usage?.limits?.rows?.length);
  const entries = accounts.filter((account) => !(hasLimits && account.provider === "claude" && account.id === "detected:claude" && !account.managed));
  if (hasLimits) {
    entries.push({ id: "detected:claude", accountId: quotaAccountId(usage.quotaAccountId), provider: "claude", label: "Claude Code",
      kind: "subscription", managed: false, localSource: true, status: usage.status === "live" ? "connected" : "unavailable",
      quotaStatus: usage.setup?.staleLimits ? "stale" : null,
      limits: usage.limits, updatedAt: usage.limitsUpdatedAt || null, planType: usage.planType || null });
  } else if (auth?.loggedIn && auth.authMethod === "claude.ai") {
    entries.push({ id: "detected:claude", accountId: auth.accountId || null, provider: "claude", label: "Claude Code",
      kind: "subscription", managed: false, localSource: true, status: "connected", limits: null, updatedAt: null, planType: auth.planType || null });
  }
  const groups = new Map();
  for (const entry of entries) {
    if (entry.provider !== "claude") continue;
    const key = entry.accountId || entry.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const current = (entry) => {
    const at = Date.parse(entry.updatedAt);
    return entry.quotaStatus !== "stale" && entry.status === "connected" && Number.isFinite(at) &&
      now - at <= 15 * 60_000 && at <= now + 60_000;
  };
  const merged = new Map();
  for (const [key, group] of groups) {
    const preferred = group.find((entry) => entry.managed) || group[0];
    const measurement = group.filter((entry) => entry.limits?.rows?.length).sort((a, b) =>
      Number(current(b)) - Number(current(a)) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0];
    merged.set(key, measurement ? { ...preferred, limits: measurement.limits, updatedAt: measurement.updatedAt,
      quotaStatus: current(measurement) ? "current" : "stale", quotaQuality: measurement.quotaQuality } : preferred);
  }
  const seen = new Set();
  return entries.flatMap((entry) => {
    if (entry.provider !== "claude") return [entry];
    const key = entry.accountId || entry.id;
    if (seen.has(key)) return [];
    seen.add(key);
    return [merged.get(key)];
  });
}

module.exports = { claudeAccountIdentity, quotaAccountId, mergeClaudeLocalAccounts };
