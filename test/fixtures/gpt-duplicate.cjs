"use strict";

const { createGptAccountObservation } = require("../../lib/gpt-account-registry");

function gptDuplicateUsageFixture(now = Date.now()) {
  const at = (minutes) => new Date(now + minutes * 60_000).toISOString();
  const identity = (accountId) => createGptAccountObservation({ sourceId: "codex", accountId, email: "same@example.test" }).id;
  const accountId = identity("synthetic-shared-workspace");
  const otherId = identity("synthetic-separate-workspace");
  const row = (key, minutes, remainingPercent, age) => ({ key, windowMinutes: minutes, remainingPercent,
    updatedAt: at(age), resetsAt: at(120) });
  return {
    generatedAt: at(0),
    gptAccounts: { accounts: [
      { id: accountId, label: "Shared synthetic label", active: true, sources: [
        { id: "codex", active: true, quotaStatus: "ready", limitsUpdatedAt: at(-2), limits: { rows: [
          row("fiveHour", 300, 87, -30), row("weekly", 10080, 40, -2)
        ] } },
        { id: "openCode", active: true, quotaStatus: "ready", limitsUpdatedAt: at(-1), limits: { rows: [
          row("fiveHour", 300, 0, -1), row("weekly", 10080, 90, -20), row("codexWindow1440m", 1440, null, -1)
        ] } }
      ] },
      { id: otherId, label: "Shared synthetic label", active: true, sources: [
        { id: "codex", active: true, quotaStatus: "ready", limitsUpdatedAt: at(-1),
          limits: { rows: [row("fiveHour", 300, 65, -1)] } }
      ] }
    ] },
    connectedAccounts: [
      { id: "synthetic-managed-profile", provider: "gpt", accountId, managed: true, label: "Shared synthetic label" },
      { id: "synthetic-mirrored-profile", provider: "gpt", accountId: "synthetic-shared-workspace", label: "Shared synthetic label",
        status: "connected", updatedAt: at(0), limits: { rows: [row("fiveHour", 300, 99, -30)] } }
    ]
  };
}

module.exports = { gptDuplicateUsageFixture };
