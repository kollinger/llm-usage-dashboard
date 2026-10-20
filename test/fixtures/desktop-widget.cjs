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
function claudeQuotaLabelsFixture(now = Date.now()) {
  const time = new Date(now).toISOString();
  const rows = [
    { key: "fiveHour", label: "5h", windowMinutes: 300, remainingPercent: 0 },
    { key: "weekly", label: "Alle Modelle", windowMinutes: 10080, usedPercent: 55 },
    { key: "sonnetOnly", label: "Nur Sonnet", windowMinutes: 10080, usedPercent: 0 },
    { key: "fable", label: "Fable", windowMinutes: 10080, remainingPercent: 80 },
    { key: "fable-2", label: "Fable Extended", windowMinutes: 10080, remainingPercent: 61,
      updatedAt: new Date(now - 3_600_000).toISOString() },
    { key: "claudeDesign", label: "Claude Design", windowMinutes: 10080, remainingPercent: 15 },
    { key: "futureModel", label: "Future model with a very long scope name for wrapping and RTL checks", windowMinutes: 10080,
      remainingPercent: null },
    { key: "unknownWeekly", windowMinutes: 10080 },
    { key: "fable-3", label: "Fable Zero", windowMinutes: 10080, remainingPercent: 0 }
  ].map((row, index) => ({ ...row, resetsAt: new Date(now + (index === 8 ? -1 : index + 1) * 3_600_000).toISOString() }));
  return { generatedAt: time, connectedAccounts: [{ id: "synthetic-claude-quota-labels", provider: "claude",
    label: "Claude · Synthetic quota scopes", status: "connected", updatedAt: time, limits: { rows } }] };
}
function providerColorsUsageFixture(now = Date.now()) {
  return { generatedAt: new Date(now).toISOString(), connectedAccounts:
    ["gpt", "claude", "kimi", "glm", "openai", "anthropic", "moonshot", "copilot", "gemini"].map((provider, index) => ({
      id: `synthetic-color-${provider}`, provider, label: "Claude / Codex · Same synthetic label",
      localSource: true, status: "connected", updatedAt: new Date(now).toISOString(),
      quotaQuality: ["measured", "calculated_from_logs", "estimated"][index % 3],
      limits: { rows: [
        { key: "fiveHour", windowMinutes: 300, remainingPercent: 65 },
        { key: "weekly", windowMinutes: 10080, remainingPercent: 40, updatedAt: new Date(now - 3_600_000).toISOString() },
        { key: "zero", windowMinutes: 60, remainingPercent: 0 },
        { key: "missing", windowMinutes: 120, remainingPercent: null }
      ] }
    })) };
}
module.exports = { widgetUsageFixture, claudeUsageFixture, claudeQuotaLabelsFixture, providerColorsUsageFixture };
