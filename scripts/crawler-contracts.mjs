export const EXIT_CODES = Object.freeze({
  ok: 0,
  needsCrawlerUpdate: 1,
  authMissing: 2,
  notTestable: 3,
  toolError: 4,
  invalidArgs: 5
});

export const EXIT_CODE_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(EXIT_CODES).map(([label, code]) => [code, label]))
);

const FUTURE_RESET_LABEL = "2099-12-31T00:00:00.000Z";

export const PROVIDER_CONTRACTS = Object.freeze({
  codex: {
    id: "codex",
    component: "readCodexUsage",
    fixtureSubdir: "codex-home",
    sourceContracts: [
      {
        scope: "session_event",
        path: "payload.info.last_token_usage.input_tokens",
        expectedType: "number",
        renameCandidates: ["payload.info.lastTokenUsage.input_tokens", "payload.info.token_usage_last.input_tokens"]
      },
      {
        scope: "session_event",
        path: "payload.info.total_token_usage.total_tokens",
        expectedType: "number",
        renameCandidates: ["payload.info.totalTokenUsage.total_tokens", "payload.info.token_usage_total.total_tokens"]
      },
      {
        scope: "session_event",
        path: "payload.rate_limits.primary.used_percent",
        expectedType: "number",
        renameCandidates: ["payload.rate_limits.primary.usedPercent"]
      },
      {
        scope: "session_event",
        path: "payload.rate_limits.secondary.used_percent",
        expectedType: "number",
        renameCandidates: ["payload.rate_limits.secondary.usedPercent"]
      }
    ],
    normalizedContracts: [
      { path: "id", expectedType: "string" },
      { path: "status", expectedType: "string" },
      { path: "source.filesScanned", expectedType: "number" },
      { path: "latest.last.totalTokens", expectedType: "number" },
      { path: "totals.allTime.totalTokens", expectedType: "number" },
      { path: "limits.fiveHour.usedPercent", expectedType: "number" },
      { path: "limits.weekly.usedPercent", expectedType: "number" }
    ],
    unexpectedContainers: []
  },
  claudeCode: {
    id: "claudeCode",
    component: "readClaudeCodeUsage",
    fixtureSubdir: "claude-home",
    sourceContracts: [
      {
        scope: "assistant_usage",
        path: "message.usage.input_tokens",
        expectedType: "number",
        renameCandidates: ["message.usage.inputTokens"]
      },
      {
        scope: "assistant_usage",
        path: "message.usage.output_tokens",
        expectedType: "number",
        renameCandidates: ["message.usage.outputTokens"]
      },
      {
        scope: "statusline",
        path: "rate_limits.five_hour.used_percentage",
        expectedType: "number",
        renameCandidates: ["rate_limits.fiveHour.used_percentage", "rate_limits.current_session.used_percentage"]
      },
      {
        scope: "statusline",
        path: "rate_limits.seven_day.used_percentage",
        expectedType: "number",
        renameCandidates: ["rate_limits.sevenDay.used_percentage", "rate_limits.weekly.used_percentage"]
      }
    ],
    normalizedContracts: [
      { path: "id", expectedType: "string" },
      { path: "status", expectedType: "string" },
      { path: "setup.claudeAvailable", expectedType: "boolean" },
      { path: "source.filesScanned", expectedType: "number" },
      { path: "latest.last.total_tokens", expectedType: "number" },
      { path: "limits.rows", expectedType: "array" }
    ],
    unexpectedContainers: [
      {
        scope: "statusline",
        path: "rate_limits",
        allowedKeys: ["five_hour", "seven_day", "claude_design", "sonnet_only"]
      }
    ]
  }
});

export function canonicalProviderName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "claude") return "claudeCode";
  if (normalized === "claudecode") return "claudeCode";
  return normalized;
}

export function statusForExitCode(exitCode) {
  return EXIT_CODE_LABELS[exitCode] || "invalidArgs";
}

export function nextActionForStatus(status) {
  switch (status) {
    case "needsCrawlerUpdate":
      return "Update the affected crawler parser or normalizer before trusting this provider.";
    case "authMissing":
      return "Restore the local provider login or session before re-running the watchdog.";
    case "notTestable":
      return "Provide fixture data or a readable local source for this provider before re-running.";
    case "toolError":
      return "Inspect the watchdog stderr and provider tooling, then retry.";
    case "ok":
      return "No crawler update is needed for this provider.";
    default:
      return "Fix the watchdog invocation and try again.";
  }
}

export function buildTriggerPayload(providerReports, detectedAt) {
  const drifted = providerReports.filter((report) => report.drifts.length > 0);
  if (!drifted.length) {
    return {
      shouldCreateTicket: false,
      dedupeKey: null,
      reason: "no_drift",
      detectedAt
    };
  }

  const parts = drifted.map((report) => {
    const driftTypes = [...new Set(report.drifts.map((drift) => drift.driftType))].sort().join(",");
    return `${report.provider}|${report.component}|${driftTypes}`;
  });

  return {
    shouldCreateTicket: true,
    dedupeKey: `${parts.sort().join("|")}|${String(detectedAt).slice(0, 10)}`,
    detectedAt,
    providers: drifted.map((report) => ({
      provider: report.provider,
      component: report.component,
      driftTypes: [...new Set(report.drifts.map((drift) => drift.driftType))].sort()
    }))
  };
}
