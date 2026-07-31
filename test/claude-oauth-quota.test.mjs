import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.env.CODEX_LIVE_RATE_LIMITS = "false";

const require = createRequire(import.meta.url);
const { _test } = require("../server.js");

await assertClaudeOauthSessionReadsTokenAndOrg();
await assertClaudeOauthExpiredTokenIsUnavailable();
await assertClaudeOauthOrgIsOptional();
await assertClaudeOauthCredentialsTryNextCandidate();
await assertClaudeOauthEndpointUsesTokenScopedUsagePath();
assertClaudeApiPayloadIsSanitized();
assertClaudeOauthApiLimitsOverrideStaleStatusline();
assertClaudeFableScopedLimitsSupportMultipleBuckets();

async function assertClaudeOauthSessionReadsTokenAndOrg() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-oauth-"));
  try {
    const credentialsFile = path.join(root, ".credentials.json");
    const configFile = path.join(root, ".claude.json");
    await writeFile(credentialsFile, `${JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        subscriptionType: "max",
        rateLimitTier: "claude_pro_max"
      }
    })}\n`);
    await writeFile(configFile, `${JSON.stringify({
      oauthAccount: {
        organizationUuid: "11111111-2222-4333-8444-555555555555",
        subscriptionType: "Claude Max 20x"
      }
    })}\n`);

    const session = await _test.readClaudeCliOauthSession({
      credentialsFiles: [credentialsFile],
      configFile,
      authStatus: {},
      nowMs: Date.now()
    });

    assert.equal(session.status, "available");
    assert.equal(session.accessToken, "test-access-token");
    assert.equal(session.orgId, "11111111-2222-4333-8444-555555555555");
    assert.equal(session.source, "claude_oauth");
    assert.equal(session.credentialsFileFound, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertClaudeOauthExpiredTokenIsUnavailable() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-oauth-expired-"));
  try {
    const credentialsFile = path.join(root, ".credentials.json");
    const configFile = path.join(root, ".claude.json");
    await writeFile(credentialsFile, `${JSON.stringify({
      claudeAiOauth: {
        accessToken: "expired-access-token",
        refreshToken: "refresh-token-not-used",
        expiresAt: Date.now() - 60 * 1000
      }
    })}\n`);
    await writeFile(configFile, `${JSON.stringify({
      oauthAccount: {
        organizationUuid: "11111111-2222-4333-8444-555555555555"
      }
    })}\n`);

    const session = await _test.readClaudeCliOauthSession({
      credentialsFiles: [credentialsFile],
      configFile,
      authStatus: {},
      nowMs: Date.now()
    });

    assert.equal(session.status, "expired");
    assert.equal(session.reason, "claude_oauth_token_expired");
    assert.equal(session.accessToken, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertClaudeOauthOrgIsOptional() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-oauth-org-"));
  try {
    const credentialsFile = path.join(root, ".credentials.json");
    const configFile = path.join(root, ".claude.json");
    await writeFile(credentialsFile, `${JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-access-token",
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    })}\n`);
    await writeFile(configFile, "{}\n");

    const session = await _test.readClaudeCliOauthSession({
      credentialsFiles: [credentialsFile],
      configFile,
      authStatus: {},
      nowMs: Date.now()
    });

    assert.equal(session.status, "available");
    assert.equal(session.reason, null);
    assert.equal(session.accessToken, "test-access-token");
    assert.equal(session.orgId, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertClaudeOauthCredentialsTryNextCandidate() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-oauth-candidates-"));
  try {
    const invalidCredentialsFile = path.join(root, "invalid-credentials.json");
    const validCredentialsFile = path.join(root, "valid-credentials.json");
    const configFile = path.join(root, ".claude.json");
    await writeFile(invalidCredentialsFile, "{not json}\n");
    await writeFile(validCredentialsFile, `${JSON.stringify({
      claudeAiOauth: {
        accessToken: "second-candidate-token",
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    })}\n`);
    await writeFile(configFile, "{}\n");

    const session = await _test.readClaudeCliOauthSession({
      credentialsFiles: [invalidCredentialsFile, validCredentialsFile],
      configFile,
      authStatus: {},
      nowMs: Date.now()
    });

    assert.equal(session.status, "available");
    assert.equal(session.accessToken, "second-candidate-token");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertClaudeOauthEndpointUsesTokenScopedUsagePath() {
  const originalRequest = https.request;
  const reset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  let observedPrimaryRequest = null;
  let observedOptions = null;
  try {
    const primaryProbe = await _test.fetchClaudeUsageProbe({
      oauthSession: {
        status: "available",
        source: "claude_oauth",
        accessToken: "test-access-token",
        expiresAt: reset,
        credentialsFileFound: true,
        configStatus: "missing"
      },
      fetchWithAuth: async (request) => {
        observedPrimaryRequest = request;
        return _test.normalizeClaudeApiUsageProbe({
          status: "available",
          source: request.source,
          usage: {
            five_hour: { utilization: 11, resets_at: reset },
            seven_day: { utilization: 23, resets_at: reset },
            source: request.source
          }
        });
      },
      fetchWithCookies: async () => _test.normalizeClaudeApiUsageProbe({
        status: "missing",
        reason: "claude_app_cookie_missing",
        source: "claude_app_cookie"
      })
    });

    assert.equal(observedPrimaryRequest.hostname, "api.anthropic.com");
    assert.equal(observedPrimaryRequest.path, "/api/oauth/usage");
    assert.equal(observedPrimaryRequest.orgId, undefined);
    assert.equal(observedPrimaryRequest.headers.Authorization, "Bearer test-access-token");
    assert.equal(observedPrimaryRequest.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(primaryProbe.status, "available");
    assert.equal(primaryProbe.usage.five_hour.utilization, 11);

    https.request = (options, callback) => {
      observedOptions = options;
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        queueMicrotask(() => {
          res.emit("data", Buffer.from(JSON.stringify({
            five_hour: { utilization: 17, resets_at: reset },
            seven_day: { utilization: 31, resets_at: reset },
            accessToken: "must-not-survive"
          })));
          res.emit("end");
        });
      };
      return req;
    };

    const probe = await _test.fetchClaudeUsageWithAuth({
      source: "claude_oauth",
      hostname: "api.anthropic.com",
      path: "/api/oauth/usage",
      headers: {
        Authorization: "Bearer test-access-token",
        "anthropic-beta": "oauth-2025-04-20"
      }
    });

    assert.equal(observedOptions.hostname, "api.anthropic.com");
    assert.equal(observedOptions.path, "/api/oauth/usage");
    assert.equal(observedOptions.headers.Authorization, "Bearer test-access-token");
    assert.equal(observedOptions.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(probe.status, "available");
    assert.equal(probe.source, "claude_oauth");
    assert.equal(probe.usage.five_hour.utilization, 17);
    assert.equal(probe.usage.seven_day.utilization, 31);
    assert.equal(probe.usage.accessToken, undefined);
  } finally {
    https.request = originalRequest;
  }
}

function assertClaudeApiPayloadIsSanitized() {
  const usage = _test.normalizeClaudeApiUsagePayload({
    accessToken: "must-not-survive",
    five_hour: { utilization: 37, resets_at: Math.floor((Date.now() + 60 * 60 * 1000) / 1000) },
    seven_day: { utilization: 61, resets_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() },
    limits: [
      { kind: "weekly_all", percent: 61, resets_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() },
      {
        kind: "weekly_scoped",
        percent: 29,
        resets_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        scope: { model: { display_name: "Fable" } },
        accessToken: "must-not-survive"
      }
    ],
    unexpected: { raw: "payload" }
  }, "claude_oauth");

  assert.equal(usage.source, "claude_oauth");
  assert.equal(usage.five_hour.utilization, 37);
  assert.equal(usage.seven_day.utilization, 61);
  assert.deepEqual(usage.limits.map((limit) => limit.label), ["Fable"]);
  assert.equal(usage.limits[0].percent, 29);
  assert.equal(usage.limits[0].scope, undefined);
  assert.equal(usage.limits[0].accessToken, undefined);
  assert.equal(usage.accessToken, undefined);
  assert.equal(usage.unexpected, undefined);

  const nested = _test.normalizeClaudeApiUsagePayload({
    usage: {
      fiveHour: { utilization: 9, resets_at: Math.floor((Date.now() + 60 * 60 * 1000) / 1000) }
    },
    refreshToken: "must-not-survive"
  }, "claude_oauth");
  assert.equal(nested.five_hour.utilization, 9);
  assert.equal(nested.refreshToken, undefined);

  const summary = _test.summarizeClaudeApiUsageProbe({
    status: "unavailable",
    reason: "claude_api_auth_failed",
    source: "claude_oauth",
    accessToken: "must-not-survive"
  });
  assert.deepEqual(summary, {
    status: "unavailable",
    reason: "claude_api_auth_failed",
    source: "claude_oauth",
    updatedAt: null,
    hasUsage: false
  });
}

function assertClaudeOauthApiLimitsOverrideStaleStatusline() {
  const reset = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const usage = _test.normalizeClaudeApiUsagePayload({
    five_hour: { utilization: 12, resets_at: reset },
    seven_day: { utilization: 44, resets_at: reset },
    limits: [{
      kind: "weekly_scoped",
      group: "weekly",
      percent: 100,
      resets_at: reset,
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: true
    }]
  }, "claude_oauth");

  const resolved = _test.resolveClaudeUsageLimits({
    statusline: {
      staleLimits: true,
      limits: null,
      updatedAt: "2026-06-18T00:00:00.000Z"
    },
    apiUsage: usage,
    apiUsageSource: usage.source,
    apiUsageUpdatedAt: usage.updatedAt
  });

  assert.equal(resolved.limitSource, "claude_oauth");
  assert.equal(resolved.resolvedLimits.fiveHour.usedPercent, 12);
  assert.equal(resolved.resolvedLimits.weekly.usedPercent, 44);
  assert.equal(resolved.resolvedLimits.fable.usedPercent, 100);
  assert.equal(resolved.resolvedLimits.rows.length, 3);
  assert.equal(resolved.resolvedLimits.rows[2].key, "fable");
  assert.equal(resolved.resolvedLimits.rows[2].label, "Fable");
  assert.equal(resolved.resolvedLimitsUpdatedAt, usage.updatedAt);
}

function assertClaudeFableScopedLimitsSupportMultipleBuckets() {
  const reset = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const usage = _test.normalizeClaudeApiUsagePayload({
    limits: [
      {
        kind: "weekly_scoped",
        percent: 35,
        resets_at: reset,
        scope: { model: { display_name: "Fable" }, surface: null }
      },
      {
        kind: "weekly_scoped",
        percent: 72,
        resets_at: reset,
        scope: { model: { display_name: "Fable" }, surface: { display_name: "Claude Code" } }
      },
      {
        kind: "weekly_all",
        percent: 90,
        resets_at: reset,
        scope: null
      }
    ]
  }, "claude_browser_sync");

  assert.deepEqual(usage.limits.map((limit) => limit.label), ["Fable", "Fable · Claude Code"]);
  const resolved = _test.resolveClaudeUsageLimits({
    apiUsage: usage,
    apiUsageSource: usage.source,
    apiUsageUpdatedAt: usage.updatedAt
  });

  assert.deepEqual(resolved.resolvedLimits.rows.map((row) => row.key), ["fable", "fable-2"]);
  assert.deepEqual(resolved.resolvedLimits.rows.map((row) => row.usedPercent), [35, 72]);
  assert.deepEqual(resolved.resolvedLimits.rows.map((row) => row.windowMinutes), [10080, 10080]);

  const alerts = _test.buildNotificationAlerts(
    { hardLimitPercent: 70, pacingPercent: 200 },
    { claudeCode: { limits: resolved.resolvedLimits } }
  );
  assert(alerts.some((alert) => alert.windowKey === "fable_2" && alert.usedPercent === 72));
}
