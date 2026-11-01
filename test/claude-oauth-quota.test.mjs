import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

process.env.CODEX_LIVE_RATE_LIMITS = "false";

const require = createRequire(import.meta.url);
const { _test } = require("../server.js");
const { claudeAccountIdentity } = require("../lib/claude-accounts");
const { buildDesktopWidgetSnapshot } = require("../lib/desktop-widget");

await assertClaudeOauthSessionReadsTokenAndOrg();
await assertClaudeOauthExpiredTokenIsUnavailable();
await assertClaudeOauthOrgIsOptional();
await assertClaudeOauthCredentialsTryNextCandidate();
await assertClaudeOauthEndpointUsesTokenScopedUsagePath();
assertClaudeApiPayloadIsSanitized();
assertClaudeOauthApiLimitsOverrideStaleStatusline();
assertClaudeFableScopedLimitsSupportMultipleBuckets();
assertClaudeLastKnownUsageSurvivesTemporaryRefreshFailure();
await assertClaudeUsageSnapshotSurvivesRestart();
await assertClaudeHistoryDoesNotImplyLogin();
await assertClaudeQuotaRefreshesWhileHistoryIsCached();
await assertIndependentClaudePaceSamples();
assertClaudePacePreservesObservationTime();
assertClaudeQuotaOverlaysRestoredConsumption();
assertPartialClaudeRefreshPreservesWindowAge();

function assertPartialClaudeRefreshPreservesWindowAge() {
  const now = Date.now(), old = new Date(now - 3_600_000).toISOString(), fresh = new Date(now).toISOString();
  const statusline = { updatedAt: old, limits: {
    fiveHour: { remainingPercent: 0, usedPercent: 100, windowMinutes: 300 },
    weekly: { remainingPercent: 10, usedPercent: 90, windowMinutes: 10080 }
  } };
  const resolved = _test.resolveClaudeUsageLimits({ statusline, apiUsage: { seven_day: { utilization: 20 } }, apiUsageUpdatedAt: fresh });
  let projected = buildDesktopWidgetSnapshot({ claudeCode: { status: "live", limits: resolved.resolvedLimits, limitsUpdatedAt: resolved.resolvedLimitsUpdatedAt } }, now);
  assert.equal(projected.accounts[0].windows[0].measuredAt, old);
  assert.equal(projected.accounts[0].windows[0].status, "stale", "a weekly refresh cannot freshen a stale five-hour quota");
  assert.equal(projected.accounts[0].windows[1].status, "current");
  statusline.updatedAt = null;
  const unknown = _test.resolveClaudeUsageLimits({ statusline, apiUsage: { seven_day: { utilization: 20 } }, apiUsageUpdatedAt: fresh });
  projected = buildDesktopWidgetSnapshot({ claudeCode: { status: "live", limits: unknown.resolvedLimits, limitsUpdatedAt: unknown.resolvedLimitsUpdatedAt } }, now);
  assert.equal(projected.accounts[0].windows[0].measuredAt, null);
  assert.equal(projected.accounts[0].windows[0].status, "stale");
}

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
    assert.equal(session.accountId, null, "quota without matching account evidence stays unscoped");
    const email = "fixture@example.invalid", orgId = "11111111-2222-4333-8444-555555555555";
    await writeFile(configFile, JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: orgId } }));
    const identity = claudeAccountIdentity({ email, orgId });
    const scoped = await _test.readClaudeCliOauthSession({ credentialsFiles: [credentialsFile], configFile,
      authStatus: { loggedIn: true, authMethod: "claude.ai", accountId: identity, orgId } });
    assert.equal(scoped.accountId, identity);
    const mismatch = await _test.readClaudeCliOauthSession({ credentialsFiles: [credentialsFile], configFile,
      authStatus: { loggedIn: true, authMethod: "claude.ai", accountId: identity, orgId: "synthetic-other-org" } });
    assert.equal(mismatch.accountId, null, "config and active session organization must agree");
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
    assert.equal(observedOptions.agent, false, "quota polls must not reuse an authenticated HTTPS connection");
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

function assertClaudeLastKnownUsageSurvivesTemporaryRefreshFailure() {
  const now = Date.now();
  const reset = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString();
  const previous = _test.normalizeClaudeApiUsageProbe({
    status: "available",
    source: "claude_app_cookie",
    usage: {
      seven_day: { utilization: 76, resets_at: reset },
      limits: [{
        kind: "weekly_scoped",
        percent: 100,
        resets_at: reset,
        scope: { model: { display_name: "Fable" } }
      }]
    }
  });
  const unavailable = _test.normalizeClaudeApiUsageProbe({
    status: "unavailable",
    reason: "claude_api_network_error",
    source: "claude_app_cookie"
  });
  const retained = _test.retainLastKnownClaudeUsageProbe(previous, unavailable, now);

  assert.equal(retained.status, "available");
  assert.equal(retained.usage.seven_day.utilization, 76);
  assert.equal(retained.usage.limits[0].percent, 100);
  assert.equal(retained.fallback.reason, "claude_api_network_error");

  const expired = _test.retainLastKnownClaudeUsageProbe(previous, unavailable, now + 9 * 24 * 60 * 60 * 1000);
  assert.equal(expired.status, "unavailable");
  assert.equal(expired.usage, null);
}

async function assertClaudeUsageSnapshotSurvivesRestart() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-snapshot-"));
  const snapshotFile = path.join(root, "claude-usage-snapshot.json");
  const now = Date.now();
  try {
    const confirmed = _test.normalizeClaudeApiUsageProbe({
      status: "available",
      source: "claude_app_cookie",
      accountId: `claude-${"a".repeat(24)}`,
      usage: {
        updatedAt: new Date(now - 3_600_000).toISOString(),
        seven_day: { utilization: 76, resets_at: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString() }
      }
    });
    await _test.saveClaudeUsageSnapshot(confirmed, snapshotFile);

    const restored = await _test.readClaudeUsageSnapshot(snapshotFile, now);
    assert.equal(restored.status, "available");
    assert.equal(restored.usage.seven_day.utilization, 76);
    assert.equal(restored.auth, null);
    assert.equal(restored.accountId, confirmed.accountId);
    assert.equal(restored.usage.updatedAt, new Date(now - 3_600_000).toISOString(), "disk restore never restamps an old measurement");
    const overlay = _test.overlayRestoredClaudeQuota({ cache: { restored: true }, claudeCode: { status: "live" } }, restored, now);
    const projected = buildDesktopWidgetSnapshot(overlay, now);
    assert.equal(projected.accounts.length, 1);
    assert.equal(projected.accounts[0].windows[0].status, "stale", "restored quota stays visibly old in widgets");
    assert.equal(projected.accounts[0].windows[0].remainingPercent, 24);

    const unavailable = _test.normalizeClaudeApiUsageProbe({
      status: "missing",
      reason: "claude_app_cookie_missing",
      source: "claude_app_cookie"
    });
    const retained = _test.retainLastKnownClaudeUsageProbe(restored, unavailable, now);
    assert.equal(retained.usage.seven_day.utilization, 76);
    await writeFile(snapshotFile, JSON.stringify({ status: "available", usage: { seven_day: confirmed.usage.seven_day } }));
    assert.equal(await _test.readClaudeUsageSnapshot(snapshotFile, now), null, "saved quota without an observation time cannot appear fresh");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertClaudeHistoryDoesNotImplyLogin() {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("function renderClaudeCreditHint("), source.indexOf("function renderCreditRows("));
  const ui = vm.createContext({ t: () => "Sign in to Claude.ai", escapeHtml: (value) => value });
  vm.runInContext(code, ui);
  assert.equal(ui.renderClaudeCreditHint({ id: "claudeCode", todayTokens: 8604278 }), "",
    "a consumption-only restored view has no login evidence");
  assert.equal(ui.renderClaudeCreditHint({ id: "claudeCode", claudeBrowserCredits: { status: "available" } }), "");
  assert.match(ui.renderClaudeCreditHint({ id: "claudeCode", claudeBrowserCredits: { status: "expired" } }), /Sign in/);
}

function assertClaudeQuotaOverlaysRestoredConsumption() {
  const now = Date.now();
  const history = { cache: { restored: true, refreshing: true }, claudeCode: {
    status: "live", limits: null, totals: { last24h: { totalTokens: 8604278 } }
  } };
  const probe = _test.normalizeClaudeApiUsageProbe({ status: "available", source: "claude_app_cookie", usage: {
    five_hour: { utilization: 0, resets_at: new Date(now - 60000).toISOString() },
    seven_day: { utilization: 2, resets_at: new Date(now + 5 * 86400000).toISOString() }
  } });
  const restored = _test.overlayRestoredClaudeQuota(history, probe, now);
  assert.equal(restored.claudeCode.limits.weekly.usedPercent, 2);
  assert.equal(restored.claudeCode.limits.fiveHour, null, "an expired window cannot reappear");
  assert.equal(restored.claudeCode.status, history.claudeCode.status, "quota restoration preserves the card's existing status");
  assert.equal(restored.claudeCode.limitsUpdatedAt, probe.usage.updatedAt);
  assert.equal(restored.claudeCode.totals, history.claudeCode.totals, "log totals stay independent of quotas");
  assert.equal(_test.overlayRestoredClaudeQuota(history, null, now), history);
  assert.equal(_test.overlayRestoredClaudeQuota(history, probe, now + 9 * 86400000), history);
  const current = { ...history, cache: {} };
  assert.equal(_test.overlayRestoredClaudeQuota(current, probe, now), current, "a current reader remains authoritative");
  const noWeekly = _test.normalizeClaudeApiUsageProbe({ status: "available", source: "claude_oauth", usage: {
    five_hour: { utilization: 0, resets_at: null }, seven_day: null
  } });
  const partial = _test.overlayRestoredClaudeQuota(history, noWeekly, now);
  assert.equal(partial.claudeCode.limits.fiveHour.usedPercent, 0);
  assert.equal(partial.claudeCode.limits.weekly, null, "an unreported weekly window must remain unavailable");
  const localStatusline = { updatedAt: new Date(now).toISOString(), limits: { rows: [
    { key: "fiveHour", remainingPercent: 0, windowMinutes: 300, resetsAt: new Date(now + 3_600_000).toISOString() }
  ] } };
  const cold = _test.overlayRestoredClaudeQuota({ ...history, claudeCode: { ...history.claudeCode, status: "empty" } }, null, now, localStatusline);
  assert.equal(cold.claudeCode.status, "live");
  assert.equal(cold.claudeCode.quotaAccountId, null);
  assert.equal(buildDesktopWidgetSnapshot(cold, now).accounts[0].windows[0].remainingPercent, 0, "cold restored history immediately overlays local quota without auth");
}

async function assertClaudeQuotaRefreshesWhileHistoryIsCached() {
  const now = Date.now(), reset = new Date(now + 6 * 86400000).toISOString();
  const old = new Date(now - 50 * 60000).toISOString(), fresh = new Date(now).toISOString();
  const usage = { generatedAt: old, cache: { stale: true, refreshing: true }, claudeCode: {
    id: "claudeCode", status: "live", totals: { last24h: { totalTokens: 1234 } },
    limitsUpdatedAt: old, limits: { weekly: { usedPercent: 23 }, fable: { usedPercent: 46 } }
  } };
  const resolved = _test.resolveClaudeUsageLimits({ apiUsage: { seven_day: { utilization: 28, resets_at: reset },
    limits: [{ label: "Fable", percent: 55, resets_at: reset, window_minutes: 10080 }] },
    apiUsageSource: "claude_app_cookie", apiUsageUpdatedAt: fresh });
  const current = { id: "claudeCode", status: "live", limits: resolved.resolvedLimits,
    limitsUpdatedAt: fresh, limitSource: resolved.limitSource, setup: { staleLimits: false } };
  let quotaReads = 0;
  const context = vm.createContext({ usageCache: { value: usage }, gptAccountsCache: {}, USAGE_CACHE_MS: 1,
    readThroughCache: async () => usage, claudeApiUsageCache: {}, readClaudeUsageSnapshot: async () => null,
    readClaudeStatusline: async () => null, codexLiveRateLimitsCache: {},
    readCurrentClaudeQuota: async () => { quotaReads += 1; return current; },
    overlayCurrentClaudeQuota: _test.overlayCurrentClaudeQuota,
    overlayRestoredClaudeQuota: _test.overlayRestoredClaudeQuota,
    overlayCurrentCodexQuota: value => value, applyCodexCreditExpiry: async value => value });
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  vm.runInContext(source.slice(source.indexOf("async function readUsageDashboard("), source.indexOf("\nasync function currentCodexCreditScope")), context);
  const result = await context.readUsageDashboard({ staleWhileRefresh: true });
  assert.equal(quotaReads, 1, "a cached history response must still refresh current Claude quota");
  assert.equal(result.claudeCode.limits.weekly.usedPercent, 28);
  assert.equal(result.claudeCode.limits.fable.usedPercent, 55);
  assert.equal(result.claudeCode.limitsUpdatedAt, fresh);
  assert.equal(result.claudeCode.totals, usage.claudeCode.totals);
  assert.equal(result.generatedAt, old, "quota freshness must not freshen token history");
  assert.equal(usage.claudeCode.limits.weekly.usedPercent, 23, "do not mutate the consumption cache");
}

function assertClaudePacePreservesObservationTime() {
  const now = Date.now(), old = new Date(now - 50 * 60000).toISOString(), fresh = new Date(now).toISOString();
  const reset = new Date(now + 6 * 86400000).toISOString();
  const resolved = _test.resolveClaudeUsageLimits({ statusline: { updatedAt: old, limits: {
    weekly: { usedPercent: 23, windowMinutes: 10080, resetsAt: reset },
    fable: { key: "fable", label: "Fable", usedPercent: 46, windowMinutes: 10080, resetsAt: reset }
  } }, apiUsage: { seven_day: { utilization: 28, resets_at: reset } }, apiUsageUpdatedAt: fresh });
  const events = _test.buildProviderQuotaEvents({ id: "claudeCode", status: "live",
    limits: resolved.resolvedLimits, limitsUpdatedAt: fresh });
  assert.equal(events.find(row => row.windowKey === "weekly").capturedAt, fresh);
  assert.equal(events.find(row => row.windowKey === "fable").capturedAt, old,
    "a total-quota refresh cannot manufacture a fresh Fable measurement");
  resolved.resolvedLimits.rows.find(row => row.key === "fable").updatedAt = null;
  assert(!_test.buildProviderQuotaEvents({ id: "claudeCode", limits: resolved.resolvedLimits,
    limitsUpdatedAt: fresh }).some(row => row.windowKey === "fable"), "missing measurement time stays unavailable");
  const history = { claudeCode: { limits: {}, limitsUpdatedAt: fresh } };
  assert.equal(_test.overlayCurrentClaudeQuota(history, { limits: {}, limitsUpdatedAt: old }), history);
  assert.equal(_test.overlayCurrentClaudeQuota(history, { limits: {}, limitsUpdatedAt: null }), history);
}

async function assertIndependentClaudePaceSamples() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-live-pace-"));
  try {
    const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
    const pace = require("../lib/quota-pace");
    const now = Date.now(), reset = new Date(now + 6 * 86400000).toISOString();
    const old = new Date(now - 120 * 60000).toISOString();
    const baseline = ["weekly", "fable"].map((windowKey, index) => ({ provider: "claudeCode", windowKey,
      capturedAt: old, resetsAt: reset, usedPercent: index ? 40 : 20 }));
    const file = path.join(directory, "pace.json"); await writeFile(file, JSON.stringify(baseline));
    const current = new Date(now).toISOString();
    const probe = _test.normalizeClaudeApiUsageProbe({ status: "available", source: "claude_app_cookie",
      updatedAt: current, usage: { seven_day: { utilization: 28, resets_at: reset },
        limits: [{ label: "Fable", percent: 55, resets_at: reset, window_minutes: 10080 }] } });
    const context = vm.createContext({ path, Date, process: { pid: process.pid }, DATA_DIR: directory, QUOTA_PACE_SAMPLES_FILE: file,
      QUOTA_EVENTS_FILE: path.join(directory, "events.jsonl"), usageCache: {}, gptAccountsCache: {},
      readClaudeUsageProbe: async () => probe, readClaudeStatusline: async () => null,
      resolveClaudeUsageLimits: _test.resolveClaudeUsageLimits,
      normalizeManualResets: require("../lib/manual-resets").normalizeManualResets,
      quotaAccountId: require("../lib/claude-accounts").quotaAccountId,
      summarizeClaudeApiUsageProbe: _test.summarizeClaudeApiUsageProbe,
      recordProviderQuotaSnapshots: async providers => providers.flatMap(_test.buildProviderQuotaEvents),
      ...pace });
    context.fsp = require("node:fs/promises");
    vm.runInContext(source.slice(source.indexOf("let quotaPaceUpdatePending ="), source.indexOf("\nfunction buildProviderQuotaEvents(")), context);
    vm.runInContext(source.slice(source.indexOf("async function readCurrentClaudeQuota("), source.indexOf("\nasync function readClaudeUsageSnapshot(")), context);
    const live = await context.readCurrentClaudeQuota();
    assert.equal(live.limits.weekly.usedPercent, 28);
    assert.equal(live.limits.fable.usedPercent, 55);
    let samples = JSON.parse(await readFile(file, "utf8"));
    const assessment = pace.assessQuotaPace(samples, now).claudeCode;
    assert.equal(assessment.weekly[120].deltaPercent, 8);
    assert.equal(assessment.fable[120].deltaPercent, 15);
    const event = (windowKey, usedPercent, offset) => ({ type: "quota_window", provider: "claudeCode", windowKey,
      usedPercent, windowMinutes: 10080, capturedAt: new Date(now + offset).toISOString(), resetsAt: reset });
    await Promise.all([context.updateQuotaPace([event("weekly", 29, 1000)]),
      context.updateQuotaPace([event("fable", 56, 2000)])]);
    samples = JSON.parse(await readFile(file, "utf8"));
    assert(samples.some(row => row.windowKey === "weekly" && row.usedPercent === 29));
    assert(samples.some(row => row.windowKey === "fable" && row.usedPercent === 56));
    console.log("Claude live pace: cached-history refresh, both windows, real observation times and concurrent persistence passed.");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
