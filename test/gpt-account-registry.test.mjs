import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

process.env.CODEX_LIVE_RATE_LIMITS = "false";
process.env.OPENCODE_AUTH_CONTENT = "";
const tmp = await mkdtemp(path.join(os.tmpdir(), "gpt-account-registry-"));
process.env.LLM_USAGE_DATA_DIR = tmp;

const require = createRequire(import.meta.url);
const {
  codexAccountObservationsFromAuth,
  createGptAccountObservation,
  mergeGptAccountRegistry,
  openCodeAccountObservationsFromAuth,
  publicGptAccountRegistry,
  readGptAccountRegistry,
  writeGptAccountRegistry
} = require("../lib/gpt-account-registry.js");
const { _test } = require("../server.js");
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

try {
  await assertPrivateAccountRegistry(tmp);
  await assertWorkspaceIdentityIsolation();
  await assertOpenCodeCredentialVariants();
  await assertCodexAccountProfileDiscovery(tmp);
  await assertPerAccountQuotaProbes(tmp);
  await assertCodexIdentityGuard(tmp);
  await assertCodexCredentialRefresh(tmp);
  await assertOpenCodeGptUsage(tmp);
  await assertFrontendContract();
} finally {
  await rm(tmp, { recursive: true, force: true });
}

async function assertCodexAccountProfileDiscovery(tmpDir) {
  const profilesRoot = path.join(tmpDir, "codex-accounts");
  const profileA = path.join(profilesRoot, "account-a");
  const profileB = path.join(profilesRoot, "account-b");
  await mkdir(profileA, { recursive: true });
  await mkdir(profileB, { recursive: true });
  await writeFile(path.join(profilesRoot, "README.txt"), "not a profile");
  assert.deepEqual(_test.defaultCodexAccountHomes(profilesRoot), [profileA, profileB]);

  const authFile = path.join(profileA, "auth.json");
  const missingSignature = await _test.gptAccountAuthFileSignature([authFile]);
  await writeFile(authFile, "{}");
  const presentSignature = await _test.gptAccountAuthFileSignature([authFile]);
  assert.notEqual(presentSignature, missingSignature, "the background watcher must notice a new or replaced login file");

  const openCodeProjectsDir = path.join(tmpDir, ".opencode", "projects", "project-a");
  await mkdir(openCodeProjectsDir, { recursive: true });
  const multiAuthFiles = _test.defaultOpenCodeMultiAuthFiles(tmpDir);
  assert(multiAuthFiles.includes(path.join(tmpDir, ".opencode", "oc-codex-multi-auth-accounts.json")));
  assert(multiAuthFiles.includes(path.join(openCodeProjectsDir, "oc-codex-multi-auth-accounts.json")));
  assert(multiAuthFiles.includes(path.join(openCodeProjectsDir, "openai-codex-accounts.json")));
}

async function assertWorkspaceIdentityIsolation() {
  const observedAt = new Date().toISOString();
  const observe = (accountId, sourceId = "codex", email = "same@example.test", remaining = 40) => createGptAccountObservation({
    sourceId, sourceRef: "synthetic-profile", email, accountId, planType: accountId === "synthetic-private" ? "plus" : "team",
    seenAt: observedAt, limits: { rows: [{ key: "weekly", remainingPercent: remaining, resetsAt: "2099-01-01T00:00:00.000Z" }] },
    limitsUpdatedAt: observedAt, quotaStatus: "ready"
  });
  const personal = observe("synthetic-private");
  const business = observe("synthetic-business");
  assert.notEqual(personal.id, business.id, "same email cannot collapse private and business workspaces");
  assert.equal(observe("synthetic-private", "openCode", null).id, personal.id, "missing email cannot duplicate a verified identity");
  assert.equal(observe("synthetic-private", "openCode", "changed@example.test").id, personal.id, "labels never determine identity");
  const legacy = createGptAccountObservation({ sourceId: "codex", email: "same@example.test", seenAt: observedAt,
    limits: { rows: [{ key: "weekly", remainingPercent: 99 }] }, quotaStatus: "ready" });
  assert.equal(legacy.id, `gpt-${crypto.createHash("sha256").update("llm-usage-dashboard:email:same@example.test").digest("hex").slice(0, 16)}`);
  const old = mergeGptAccountRegistry(null, [legacy]);
  const registry = mergeGptAccountRegistry(old, [personal, business, observe("synthetic-private", "openCode", null, 70)]);
  assert.equal(registry.accounts.filter(account => account.active).length, 2);
  assert.equal(registry.accounts.find(account => account.id === legacy.id).active, false, "unverified legacy history is retained separately");
  assert.equal(registry.accounts.find(account => account.id === legacy.id).sources[0].limits.rows[0].remainingPercent, 99);
  assert.deepEqual(registry.accounts.find(account => account.id === personal.id).sources.map(source => source.id), ["codex", "openCode"]);
  assert.equal(registry.accounts.find(account => account.id === business.id).sources[0].limits.rows[0].remainingPercent, 40);
  const switched = mergeGptAccountRegistry(registry, [observe("synthetic-business", "openCode", null, 20)]);
  assert.equal(switched.accounts.find(account => account.id === personal.id).active, false);
  assert.equal(switched.accounts.find(account => account.id === personal.id).sources.find(source => source.id === "openCode").limits.rows[0].remainingPercent, 70);
  assert.equal(switched.accounts.find(account => account.id === business.id).sources.find(source => source.id === "openCode").limits.rows[0].remainingPercent, 20);
  const duplicateFailure = { ...personal, limits: null, quotaStatus: "unavailable", quotaReason: "request_failed" };
  assert.equal(mergeGptAccountRegistry(null, [personal, duplicateFailure]).accounts[0].sources[0].quotaStatus, "ready", "one failed duplicate profile cannot mask a successful probe in the same scan");
  assert.equal(mergeGptAccountRegistry(mergeGptAccountRegistry(null, [personal]), [duplicateFailure]).accounts[0].sources[0].quotaStatus, "unavailable", "a subsequent failed scan must mark its saved quota stale");
}

async function assertCodexIdentityGuard(tmpDir) {
  const codexHome = path.join(tmpDir, "identity-guard");
  await mkdir(codexHome, { recursive: true });
  const auth = account_id => ({ tokens: { account_id, id_token: fakeJwt({ email: "same@example.test", "https://api.openai.com/auth": { chatgpt_account_id: account_id, chatgpt_plan_type: "plus" } }) } });
  for (const variant of ["mismatch", "changed", "missing", "invalid"]) {
    await writeFile(path.join(codexHome, "auth.json"), JSON.stringify(auth("synthetic-original")));
    const result = await _test.readCodexGptAccountObservation({ codexHomes: [codexHome], clientFactory: async () => ({
      async request(method) {
        if (method === "account/read") return { account: { type: "chatgpt", email: "same@example.test", planType: "plus" } };
        if (method === "account/usage/read") return { summary: { lifetimeTokens: 999 } };
        if (method === "account/rateLimits/read") {
          if (variant === "changed") await writeFile(path.join(codexHome, "auth.json"), JSON.stringify(auth("synthetic-switched-workspace")));
          if (variant === "missing") await rm(path.join(codexHome, "auth.json"));
          if (variant === "invalid") await writeFile(path.join(codexHome, "auth.json"), "invalid-json");
          return { accountId: variant === "mismatch" ? "synthetic-wrong-default" : undefined,
            rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: "2099-01-01T00:00:00.000Z" } } };
        }
        assert.fail(method);
      }
    }) });
    assert.equal(result.quotaAvailable, 0, variant);
    assert.equal(result.quotaUnavailable, 1, variant);
    assert.equal(result.observations.length, 1, variant);
    assert.equal(result.observations[0].limits, null, "a wrong or switching profile must not supply another account's limits");
    assert.equal(result.observations[0].usage, null, "the rejected live identity cannot supply another account's historical usage");
  }
}

async function assertCodexCredentialRefresh(tmpDir) {
  const codexHome = path.join(tmpDir, "credential-refresh");
  await mkdir(codexHome, { recursive: true });
  const authFile = path.join(codexHome, "auth.json");
  const auth = (accountId, token) => ({ tokens: { account_id: accountId, access_token: token,
    id_token: fakeJwt({ email: "same@example.test", "https://api.openai.com/auth": {
      chatgpt_account_id: accountId, chatgpt_plan_type: "pro"
    } }) } });
  for (const explicitAccountId of [true, false]) {
    await writeFile(authFile, JSON.stringify(auth("synthetic-refresh-account", "old-token")));
    const result = await _test.readCodexGptAccountObservation({ codexHomes: [codexHome], refreshToken: true,
      clientFactory: async () => ({ async request(method, params) {
        if (method === "account/read") {
          assert.equal(params.refreshToken, true);
          await writeFile(authFile, JSON.stringify(auth("synthetic-refresh-account", "renewed-token-with-a-different-size")));
          return { account: { type: "chatgpt", email: "same@example.test", planType: "pro" } };
        }
        if (method === "account/usage/read") return { summary: { lifetimeTokens: 999 } };
        if (method === "account/rateLimits/read") return {
          accountId: explicitAccountId ? "synthetic-refresh-account" : undefined,
          rateLimits: { planType: "pro", primary: { usedPercent: 56, windowDurationMins: 10080,
            resetsAt: "2099-01-01T00:00:00.000Z" } }
        };
        assert.fail(method);
      } }) });
    assert.equal(result.quotaAvailable, 1, "renewing credentials for the same verified account must retain live quota");
    assert.equal(result.quotaUnavailable, 0);
    const registry = mergeGptAccountRegistry(null, result.observations);
    assert.equal(registry.accounts.length, 1);
    assert.equal(registry.accounts[0].sources[0].quotaStatus, "ready");
    assert.equal(registry.accounts[0].sources[0].limits.rows[0].usedPercent, 56);
  }
}

async function assertOpenCodeCredentialVariants() {
  const idToken = fakeJwt({ email: "same@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-private", chatgpt_plan_type: "plus" } });
  const access = fakeJwt({ "https://api.openai.com/auth": {} });
  const candidates = openCodeAccountObservationsFromAuth({ openai: { type: "oauth", access, idToken } });
  assert.equal(candidates.length, 1, "empty access claims must not hide ID-token account claims");
  assert.equal(openCodeAccountObservationsFromAuth({ "synthetic-plugin": { access, idToken } }).length, 1);
  const calls = [];
  const result = await _test.openCodeAccountObservationsWithQuota({ accounts: [
    { accessToken: access, idToken },
    { access: "synthetic-opaque-access", accountId: "synthetic-business", email: "same@example.test" }
  ], activeIndex: 0 }, { fetchImpl: async (_url, options) => {
    const account = options.headers["chatgpt-account-id"];
    calls.push(account);
    return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: account === "synthetic-private" ? 0 : 100, limit_window_seconds: 18000, reset_at: 4070908800 } } }) };
  } });
  assert.deepEqual(calls.sort(), ["synthetic-business", "synthetic-private"]);
  assert.equal(new Set(result.observations.map(row => row.id)).size, 2);
  assert.deepEqual(result.observations.map(row => row.limits.rows[0].remainingPercent).sort((a, b) => a - b), [0, 100]);
  for (const row of result.observations) assert.equal(Object.hasOwn(row, "currentlyUsed"), false, "saved profiles and activeIndex cannot prove current execution");

  const entry = { access: "synthetic-access", idToken };
  const expired = await _test.readChatGptQuotaFromOauthEntry({ ...entry, expires: Date.now() - 1000 }, { fetchImpl() { assert.fail("expired credentials must not be sent"); } });
  assert.equal(expired.reason, "auth_required");
  const missing = await _test.readChatGptQuotaFromOauthEntry({ idToken }, { fetchImpl() { assert.fail("missing credentials must not be sent"); } });
  assert.equal(missing.reason, "credentials_missing");
  for (const status of [401, 403, 429, 500]) {
    const quota = await _test.readChatGptQuotaFromOauthEntry(entry, { fetchImpl: async () => ({ ok: false, status }) });
    assert.equal(quota.reason, [401, 403].includes(status) ? "auth_required" : "request_failed");
    assert.equal(quota.limits, null);
  }
  for (const name of ["AbortError", "Error"]) {
    const quota = await _test.readChatGptQuotaFromOauthEntry(entry, { fetchImpl: async () => { const error = new Error("synthetic-private-provider-payload"); error.name = name; throw error; } });
    assert.equal(quota.reason, name === "AbortError" ? "timeout" : "request_failed");
    assert(!JSON.stringify(quota).includes("synthetic-private-provider-payload"));
  }
  const mismatch = await _test.readChatGptQuotaFromOauthEntry(entry, { fetchImpl: async () => ({ ok: true, json: async () => ({ account_id: "synthetic-other-workspace", rate_limit: { primary_window: { used_percent: 1 } } }) }) });
  assert.equal(mismatch.reason, "identity_unverified");
  const empty = await _test.readChatGptQuotaFromOauthEntry(entry, { fetchImpl: async () => ({ ok: true, json: async () => ({ rate_limit: {} }) }) });
  assert.equal(empty.reason, "limits_missing");
  assert.equal(openCodeAccountObservationsFromAuth({ openai: { type: "api", access: "synthetic-key", accountId: "synthetic-id" } }).length, 0);
}

async function assertPrivateAccountRegistry(dataDir) {
  const accessToken = fakeJwt({
    email: "reinhard@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-secret-123",
      chatgpt_plan_type: "pro"
    }
  });
  const refreshToken = "refresh-secret-456";
  const openCode = openCodeAccountObservationsFromAuth({
    openai: {
      type: "oauth",
      access: accessToken,
      refresh: refreshToken,
      expires: Date.now() + 60_000,
      accountId: "account-secret-123"
    }
  }, {
    profileRef: "/private/opencode/profile-a",
    seenAt: "2026-07-31T08:00:00.000Z"
  });
  assert.equal(openCode.length, 1);
  assert.equal(openCode[0].label, "re•••••d@e••••••.com");
  const codexAuth = codexAccountObservationsFromAuth({
    auth_mode: "chatgpt",
    tokens: {
      id_token: accessToken,
      access_token: "access-secret-789",
      refresh_token: refreshToken,
      account_id: "account-secret-123"
    }
  }, { profileRef: "/private/codex/profile-b", seenAt: "2026-07-31T08:00:30.000Z" });
  assert.equal(codexAuth.length, 1);
  assert.equal(codexAuth[0].label, openCode[0].label);

  const codex = createGptAccountObservation({
    sourceId: "codex",
    sourceRef: "/private/codex/home",
    email: "Reinhard@example.com",
    accountId: "account-secret-123",
    planType: "pro",
    seenAt: "2026-07-31T08:01:00.000Z",
    usage: { summary: { lifetimeTokens: 123456 } },
    limits: { rows: [{ key: "fiveHour", label: "5h Codex limit", usedPercent: 25, remainingPercent: 75 }] },
    limitsUpdatedAt: "2026-07-31T08:01:00.000Z",
    quotaStatus: "ready",
    quotaCheckedAt: "2026-07-31T08:01:00.000Z",
    dataQuality: "account_api"
  });
  let registry = mergeGptAccountRegistry(null, [...openCode, ...codexAuth, codex], {
    scannedAt: "2026-07-31T08:01:00.000Z",
    scan: {
      status: "ready",
      checkedAt: "2026-07-31T08:01:00.000Z",
      sources: {
        codex: { status: "ready", observations: 1, profilesScanned: 1 },
        openCode: { status: "ready", observations: 1, profilesScanned: 1 }
      }
    }
  });
  assert.equal(registry.accounts.length, 1, "the same account ID must merge across Codex and OpenCode");
  assert.deepEqual(registry.accounts[0].sources.map((source) => source.id), ["codex", "openCode"]);
  assert.equal(registry.accounts[0].sources.find((source) => source.id === "codex")?.usage?.summary?.lifetimeTokens, 123456);

  await writeGptAccountRegistry(dataDir, registry);
  const stored = await readFile(path.join(dataDir, "gpt-account-registry.json"), "utf8");
  for (const secret of [accessToken, refreshToken, "access-secret-789", "account-secret-123", "reinhard@example.com", "/private/opencode/profile-a", "/private/codex/profile-b", "/private/codex/home"]) {
    assert(!stored.includes(secret), `registry must not persist secret or raw identity material: ${secret}`);
  }
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(dataDir, "gpt-account-registry.json"))).mode & 0o777, 0o600);
  }

  const failedRefresh = createGptAccountObservation({
    sourceId: "codex",
    sourceRef: "/private/codex/home",
    email: "Reinhard@example.com",
    accountId: "account-secret-123",
    planType: "pro",
    seenAt: "2026-07-31T08:30:00.000Z",
    quotaStatus: "unavailable",
    quotaReason: "auth_required",
    quotaCheckedAt: "2026-07-31T08:30:00.000Z",
    dataQuality: "identity_only"
  });
  registry = mergeGptAccountRegistry(await readGptAccountRegistry(dataDir), [failedRefresh], {
    scannedAt: "2026-07-31T08:30:00.000Z",
    scan: { status: "partial", checkedAt: "2026-07-31T08:30:00.000Z", sources: {} }
  });
  const failedSource = registry.accounts[0].sources.find((source) => source.id === "codex");
  assert.equal(failedSource.quotaStatus, "unavailable");
  assert.equal(failedSource.quotaReason, "auth_required");
  assert.equal(failedSource.limits?.rows?.[0]?.remainingPercent, 75, "a failed refresh must keep the last known limit snapshot");
  assert.equal(failedSource.limitsUpdatedAt, "2026-07-31T08:01:00.000Z");
  assert.equal(publicGptAccountRegistry(registry).quotaAccountCount, 0, "saved snapshots must not be counted as live quota");

  const secondAccount = createGptAccountObservation({
    sourceId: "codex",
    sourceRef: "/private/codex/home",
    email: "second@example.net",
    seenAt: "2026-07-31T09:00:00.000Z"
  });
  registry = mergeGptAccountRegistry(await readGptAccountRegistry(dataDir), [secondAccount], {
    scannedAt: "2026-07-31T09:00:00.000Z",
    scan: { status: "ready", checkedAt: "2026-07-31T09:00:00.000Z", sources: {} }
  });
  const publicRegistry = publicGptAccountRegistry(registry);
  assert.equal(publicRegistry.accountCount, 2);
  assert.equal(publicRegistry.activeAccountCount, 1);
  assert.equal(publicRegistry.quotaAccountCount, 0);
  assert.equal(publicRegistry.quotaMissingAccountCount, 1);
  assert.equal(publicRegistry.accounts.find((account) => account.label.endsWith(".com"))?.active, false);
  assert.equal(publicRegistry.accounts.find((account) => account.label.endsWith(".net"))?.active, true);
}

async function assertPerAccountQuotaProbes(tmpDir) {
  const codexHomes = [path.join(tmpDir, "codex-a"), path.join(tmpDir, "codex-b")];
  const codexAccounts = new Map();
  for (const [index, codexHome] of codexHomes.entries()) {
    const account = {
      email: "same@example.test",
      accountId: `account-secret-${index + 1}`,
      planType: index ? "team" : "pro",
      usedPercent: index ? 62 : 18
    };
    codexAccounts.set(codexHome, account);
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: fakeJwt({
          email: account.email,
          "https://api.openai.com/auth": {
            chatgpt_account_id: account.accountId,
            chatgpt_plan_type: account.planType
          }
        }),
        access_token: "not-used-by-the-mock",
        account_id: account.accountId
      }
    }));
  }

  const closedHomes = [];
  const codexResult = await _test.readCodexGptAccountObservation({
    codexHomes,
    refreshToken: true,
    clientFactory: async (codexHome) => {
      const account = codexAccounts.get(codexHome);
      return {
        closeWhenDone: true,
        client: {
          async request(method) {
            if (method === "account/read") {
              return { account: { type: "chatgpt", email: account.email, planType: account.planType } };
            }
            if (method === "account/usage/read") {
              return { summary: { lifetimeTokens: account.usedPercent * 1_000 } };
            }
            if (method === "account/rateLimits/read") {
              return {
                rateLimitsByLimitId: {
                  codex: {
                    limitId: "codex",
                    planType: account.planType,
                    primary: {
                      usedPercent: account.usedPercent,
                      windowDurationMins: 300,
                      resetsAt: "2026-08-01T20:00:00.000Z"
                    },
                    secondary: {
                      usedPercent: account.usedPercent + 10,
                      windowDurationMins: 10080,
                      resetsAt: "2026-08-08T20:00:00.000Z"
                    }
                  }
                }
              };
            }
            throw new Error(`Unexpected Codex request: ${method}`);
          },
          close() {
            closedHomes.push(codexHome);
          }
        }
      };
    }
  });
  assert.equal(codexResult.status, "ready");
  assert.equal(codexResult.profilesScanned, 2);
  assert.equal(codexResult.quotaAvailable, 2);
  assert.equal(codexResult.quotaUnavailable, 0);
  assert.equal(new Set(codexResult.observations.filter((entry) => entry.limits?.rows?.length).map((entry) => entry.id)).size, 2);
  assert.equal(mergeGptAccountRegistry(null, codexResult.observations).accounts.length, 2, "email-only live CLI responses must bind only to their own unchanged auth profile");
  assert.equal(closedHomes.length, 2);

  const openCodeDir = path.join(tmpDir, "opencode-quota");
  const openCodeToken = fakeJwt({
    email: "opencode@example.test",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "opencode-account-secret",
      chatgpt_plan_type: "pro"
    }
  });
  await mkdir(openCodeDir, { recursive: true });
  await writeFile(path.join(openCodeDir, "auth.json"), JSON.stringify({
    openai: {
      type: "oauth",
      access: openCodeToken,
      refresh: "must-never-be-sent",
      accountId: "opencode-account-secret"
    }
  }));
  const openCodeSources = [{
    id: "opencode-quota-test",
    providerId: "openCode",
    paths: [{ role: "opencode_data_dir", path: openCodeDir, kind: "directory" }]
  }];
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://quota.test/usage");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.authorization, `Bearer ${openCodeToken}`);
    assert.equal(options.headers["chatgpt-account-id"], "opencode-account-secret");
    assert.equal(JSON.stringify(options).includes("must-never-be-sent"), false);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 22,
              limit_window_seconds: 18_000,
              reset_at: 1_775_252_800
            },
            secondary_window: {
              used_percent: 47,
              limit_window_seconds: 604_800,
              reset_at: 1_775_857_600
            }
          }
        };
      }
    };
  };
  const openCodeResult = await _test.readOpenCodeGptAccountObservations(openCodeSources, {
    authFiles: [path.join(openCodeDir, "auth.json")],
    fetchImpl,
    usageUrl: "https://quota.test/usage"
  });
  assert.equal(openCodeResult.status, "ready");
  assert.equal(openCodeResult.quotaAvailable, 1);
  assert.equal(openCodeResult.quotaUnavailable, 0);
  assert.equal(openCodeResult.observations[0]?.limits?.rows?.length, 2);
  assert.equal(openCodeResult.observations[0]?.limits?.rows?.[0]?.remainingPercent, 78);
  assert.equal(openCodeResult.observations[0]?.limits?.rows?.[1]?.remainingPercent, 53);
  assert.equal(openCodeResult.observations[0]?.dataQuality, "account_quota_api");

  const unavailableResult = await _test.readOpenCodeGptAccountObservations(openCodeSources, {
    authFiles: [path.join(openCodeDir, "auth.json")],
    fetchImpl: async () => ({ ok: false, status: 401 }),
    usageUrl: "https://quota.test/usage"
  });
  assert.equal(unavailableResult.status, "partial");
  assert.equal(unavailableResult.quotaAvailable, 0);
  assert.equal(unavailableResult.quotaUnavailable, 1);
  assert.equal(unavailableResult.observations[0]?.limits, null);

  const multiAuthFile = path.join(tmpDir, "oc-codex-multi-auth-accounts.json");
  const multiAuthTokens = [
    fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "opencode-multi-account-a",
        chatgpt_plan_type: "plus"
      },
      "https://api.openai.com/profile": { email: "multi-a@example.test" }
    }),
    fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "opencode-multi-account-b",
        chatgpt_plan_type: "pro"
      },
      "https://api.openai.com/profile": { email: "multi-b@example.test" }
    })
  ];
  await writeFile(multiAuthFile, JSON.stringify({
    version: 3,
    accounts: multiAuthTokens.map((accessToken, index) => ({
      accountId: `stored-organization-${index}`,
      accessToken,
      refreshToken: `refresh-token-${index}`,
      expiresAt: Date.now() + ((index + 1) * 60_000),
      addedAt: Date.now(),
      lastUsed: Date.now()
    })),
    activeIndex: 0
  }));
  const multiAuthResult = await _test.readOpenCodeGptAccountObservations([], {
    authFiles: [multiAuthFile],
    usageUrl: "https://quota.test/usage",
    fetchImpl: async (_url, options) => {
      const accountId = options.headers["chatgpt-account-id"];
      assert.match(accountId, /^opencode-multi-account-[ab]$/u, "quota must use the ChatGPT account ID from each token");
      const usedPercent = accountId.endsWith("a") ? 31 : 64;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            rate_limit: {
              primary_window: {
                used_percent: usedPercent,
                limit_window_seconds: 18_000,
                reset_at: 1_775_252_800
              }
            }
          };
        }
      };
    }
  });
  assert.equal(multiAuthResult.status, "ready");
  assert.equal(multiAuthResult.quotaAvailable, 2);
  assert.equal(multiAuthResult.quotaUnavailable, 0);
  assert.equal(multiAuthResult.observations.length, 2, "both OpenCode accounts must be visible separately");
  assert.equal(new Set(multiAuthResult.observations.map((entry) => entry.id)).size, 2);
  assert.deepEqual(
    multiAuthResult.observations.map((entry) => entry.limits.rows[0].usedPercent).sort((a, b) => a - b),
    [31, 64]
  );
}

async function assertOpenCodeGptUsage(tmpDir) {
  if (spawnSync("sqlite3", ["-version"], { encoding: "utf8" }).status !== 0) return;
  const profileDir = path.join(tmpDir, "opencode-profile");
  const database = path.join(profileDir, "opencode.db");
  await mkdir(profileDir, { recursive: true });
  const rows = [
    {
      id: "message-gpt",
      session: "session-a",
      created: Date.parse("2026-07-31T08:00:00.000Z"),
      data: { role: "assistant", providerID: "openai", modelID: "gpt-5.2-codex", tokens: { input: 100, output: 30, reasoning: 5, cache: { read: 20, write: 0 } } }
    },
    {
      id: "message-other",
      session: "session-b",
      created: Date.parse("2026-07-31T08:05:00.000Z"),
      data: { role: "assistant", providerID: "deepseek", modelID: "deepseek-chat", tokens: { input: 900, output: 100 } }
    }
  ];
  const sql = [
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);",
    ...rows.map((row) => `INSERT INTO message VALUES ('${row.id}', '${row.session}', ${row.created}, ${row.created}, '${sqlString(JSON.stringify(row.data))}');`)
  ].join("\n");
  const created = spawnSync("sqlite3", [database], { input: sql, encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);

  const usage = await _test.readOpenCodeGptUsage({
    sources: [{
      id: "open-code-test",
      providerId: "openCode",
      paths: [{ role: "opencode_database", path: database, kind: "file" }]
    }]
  });
  assert.equal(usage.status, "live");
  assert.equal(usage.totals.allTime.totalTokens, 155, "only the OpenAI/GPT row should be counted");
  assert.equal(usage.byModel[0]?.model, "gpt-5.2-codex");
  assert.equal(usage.source.accountAttribution, "unavailable");
  assert.equal(usage._usageEvents[0]?.metadata?.accountAttribution, "unavailable");
  const combined = _test.buildLocalAggregate([usage, usage], { accounts: [createGptAccountObservation({ sourceId: "openCode", accountId: "synthetic-current-login" })] });
  assert.equal(combined.totals.allTime.totalTokens, 155, "copied OpenCode events count once independently of account discovery");
  assert.equal(combined.attribution.coverage.knownAccountTokens, 0, "a current login cannot identify historical OpenCode tokens");
  assert.equal(combined.attribution.coverage.unknownAccountTokens, 155);
}

async function assertFrontendContract() {
  const html = await readFile(path.join(rootDir, "public", "index.html"), "utf8");
  const app = await readFile(path.join(rootDir, "public", "app.js"), "utf8");
  const settingsStart = html.indexOf('<dialog id="settingsDialog"');
  const settingsEnd = html.indexOf("</dialog>", settingsStart);
  const accountsStart = html.indexOf('id="gptAccountsSection"');
  assert.match(html, /id="gptAccountsRecheckBtn"/);
  assert.ok(
    settingsStart >= 0 && accountsStart > settingsStart && accountsStart < settingsEnd,
    "GPT accounts must be rendered inside Settings"
  );
  assert.doesNotMatch(html, /data-dashboard-panel-id="gpt-accounts"/);
  assert.match(app, /\/api\/gpt-accounts\/recheck/);
  assert.match(app, /normalizeLocalProvider\("openCode", usage\.openCode\)/);
  assert.match(app, /gptAccountLimitSource/);
  assert.match(app, /quotaAccountCount/);
  assert.match(app, /account\.active && limits\.length && !hasCurrentLimits/);
  assert.match(app, /liveMetrics\.unavailable/);

  const i18nDir = path.join(rootDir, "public", "i18n");
  const files = (await import("node:fs/promises")).readdir(i18nDir);
  for (const name of await files) {
    if (!name.endsWith(".json")) continue;
    const json = JSON.parse(await readFile(path.join(i18nDir, name), "utf8"));
    assert.equal(typeof json.gptAccounts?.recheck, "string", `${name} must include GPT account UI copy`);
    assert.equal(typeof json.providers?.openCode?.kicker, "string", `${name} must include OpenCode provider copy`);
    assert.equal(typeof json.providers?.messages?.noOpenCodeGptEvents, "string", `${name} must localize the OpenCode empty state`);
  }
}

function fakeJwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
}

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}
