"use strict";

// Synthetic labels and local handles only. No provider payloads or credentials.
function widgetUsageFixture(count = 5, now = Date.now()) {
  const time = new Date(now).toISOString();
  const windows = (index) => ({ rows: [
    { key: "fiveHour", windowMinutes: 300, remainingPercent: index === 0 ? 0 : 83 - index, resetsAt: new Date(now + 3_600_000).toISOString() },
    { key: "weekly", windowMinutes: 10080, remainingPercent: index === 1 ? null : 68 - index, resetsAt: new Date(now + 172_800_000).toISOString() }
  ] });
  return {
    generatedAt: time,
    gptAccounts: { accounts: Array.from({ length: Math.min(2, count) }, (_unused, index) => ({
      id: `synthetic-gpt-${index}`, label: index === 0 ? "Personal · Example" : "Business · Example Workspace with a very long display name",
      active: true, sources: [{ id: "codex", active: true, quotaStatus: "ready", limitsUpdatedAt: time, limits: windows(index) },
        { id: "openCode", active: true, quotaStatus: "unavailable", limits: null }]
    })) },
    connectedAccounts: Array.from({ length: Math.max(0, count - 2) }, (_unused, index) => ({
      id: `synthetic-connection-${index}`, provider: index % 3 === 0 ? "claude" : index % 3 === 1 ? "kimi" : "glm",
      label: index < 3 ? ["Studio · Example", "Research · Example", "Team · Example"][index] : "Example duplicate display name",
      status: "connected", updatedAt: time, limits: windows(index + 2)
    }))
  };
}
function claudeUsageFixture(now = Date.now()) {
  const time = new Date(now).toISOString();
  const limits = (remainingPercent) => ({ rows: [
    { key: "fiveHour", windowMinutes: 300, remainingPercent, resetsAt: new Date(now + 3_600_000).toISOString() },
    { key: "weekly", windowMinutes: 10080, remainingPercent: null, resetsAt: null }
  ] });
  return { generatedAt: time, connectedAccounts: [
    { id: "synthetic-claude-personal", accountId: `claude-${"a".repeat(24)}`, provider: "claude", label: "Claude · Personal",
      managed: true, status: "connected", updatedAt: new Date(now - 3_600_000).toISOString(), limits: limits(73) },
    { id: "synthetic-claude-team", accountId: `claude-${"b".repeat(24)}`, provider: "claude", label: "Claude · Team",
      managed: true, status: "connected", updatedAt: time, limits: limits(41) }
  ], claudeCode: { status: "live", limitsUpdatedAt: time, limits: limits(0), quotaAccountId: null } };
}
module.exports = { widgetUsageFixture, claudeUsageFixture };
