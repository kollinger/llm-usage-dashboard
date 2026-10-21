// Production collectors and account-list functions, supplied only synthetic
// provider responses. No prepared widget snapshot or real provider is used.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const require = createRequire(import.meta.url);
const registryApi = require("../../lib/gpt-account-registry");
const { buildDesktopWidgetSnapshot } = require("../../lib/desktop-widget");
const { createGptAccountLogin } = require("../../lib/gpt-account-login");
const { safeMeasurement } = require("../../lib/provider-account-store");
const { startPlasmaBridge, readPlasmaSnapshot } = require("../../lib/plasma-bridge");
const run = promisify(execFile);

export async function createGptAccountLifecycle() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-lifecycle-"));
  process.env.LLM_USAGE_DATA_DIR = directory;
  process.env.CODEX_LIVE_RATE_LIMITS = "false";
  process.env.OPENCODE_AUTH_CONTENT = "";
  const { _test, createTimedCache, readThroughCache } = require("../../server");
  const source = await fs.readFile(new URL("../../server.js", import.meta.url), "utf8");
  const productionFunction = (name, context) => {
    const code = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"))?.[0];
    if (!code) throw new Error(`Missing production function ${name}`);
    return vm.runInNewContext(`${code}\n${name}`, context);
  };
  const email = "same@example.test";
  const workspace = "synthetic-lifecycle-personal";
  const otherWorkspace = "synthetic-lifecycle-business";
  const profiles = path.join(directory, "codex-profiles");
  const jwt = (claims) => `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const authFor = (accountId) => ({ tokens: { account_id: accountId, access_token: "synthetic-access",
    id_token: jwt({ email, "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" } }) } });
  const saveAuth = async (home, id) => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(authFor(id)), { mode: 0o600 });
  };
  const firstHome = path.join(profiles, "11111111-2222-4333-8444-555555555555");
  await saveAuth(firstHome, workspace);
  const openCodeFile = path.join(directory, "opencode-auth.json");
  await fs.writeFile(openCodeFile, JSON.stringify({ accounts: [workspace, otherWorkspace].map((id) => ({
    type: "oauth", accessToken: authFor(id).tokens.id_token, accountId: id, expiresAt: Date.now() + 3600_000
  })) }));
  const oldAt = new Date(Date.now() - 3600_000).toISOString();
  // This is the pre-69099d0 collector's persisted email-first output for the
  // same raw auth. Retain it exactly, without inventing a verified workspace.
  const legacyObservation = registryApi.createGptAccountObservation({ sourceId: "codex", sourceRef: firstHome,
    email, seenAt: oldAt, limitsUpdatedAt: oldAt, quotaStatus: "ready",
    usage: { summary: { lifetimeTokens: 123456 } },
    limits: { rows: [{ key: "fiveHour", windowMinutes: 300, remainingPercent: 99 }] } });
  await registryApi.writeGptAccountRegistry(directory, registryApi.mergeGptAccountRegistry(null, [legacyObservation], { scannedAt: oldAt }));
  const legacyBytes = JSON.stringify((await registryApi.readGptAccountRegistry(directory)).accounts[0]);
  let registry;
  let failed = false;
  const clientFor = async (home) => {
    const auth = JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8"));
    const id = auth.tokens.account_id;
    return { request: async (method) => {
      if (method === "account/read") return { account: { type: "chatgpt", email, planType: "plus" } };
      if (method === "account/usage/read") return { summary: { lifetimeTokens: 234567 } };
      if (method === "account/rateLimits/read") {
        if (failed) throw new Error("synthetic-unavailable");
        return { rateLimits: { primary: { usedPercent: id === workspace ? 100 : 35, windowDurationMins: 300,
          resetsAt: new Date(Date.now() + 7200_000).toISOString() } } };
      }
      throw new Error("Unexpected synthetic method");
    }, close() {} };
  };
  const cache = createTimedCache();
  const readAccounts = productionFunction("readGptAccounts", { ...registryApi, DATA_DIR: directory, Date,
    readThroughCache, gptAccountsCache: cache, GPT_ACCOUNT_SCAN_CACHE_MS: 60_000, isInteractiveUsageRecent: () => false,
    readCodexGptAccountObservation: (options) => _test.readCodexGptAccountObservation({ ...options, clientFactory: clientFor }),
    readOpenCodeGptAccountObservations: () => _test.readOpenCodeGptAccountObservations([], { authFiles: [openCodeFile], fetchImpl: async () => ({
      ok: !failed, status: failed ? 401 : 200, json: async () => ({ rate_limit: { secondary_window: {
        used_percent: 60, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 86400
      } } })
    }) })
  });
  const scan = async () => {
    const result = await readAccounts({ force: true, refreshToken: true, codexHomes: _test.defaultCodexAccountHomes(profiles) });
    registry = await registryApi.readGptAccountRegistry(directory);
    return result;
  };
  const readManaged = productionFunction("readManagedGptProfiles", { DATA_DIR: directory, path, fsp: fs,
    defaultCodexAccountHomes: _test.defaultCodexAccountHomes, ...registryApi });
  const connections = productionFunction("readBrowserConnections", { DATA_DIR: directory, path, Date,
    ...registryApi, readManagedGptProfiles: readManaged, usageCache: { value: {} },
    gptAccountsCache: cache,
    claudeLogin: { profiles: async () => [] }, kimiLogin: { profiles: async () => [] },
    readClaudeAuthStatus: async () => ({}), readGlmCodingPlanAuth: async () => ({}),
    mergeClaudeLocalAccounts: (accounts) => accounts, safeMeasurement });
  const usage = async () => ({ generatedAt: new Date().toISOString(),
    gptAccounts: registryApi.publicGptAccountRegistry(registry), connectedAccounts: await connections() });
  const snapshot = async () => buildDesktopWidgetSnapshot(await usage());
  const login = async (id = workspace) => {
    let notification;
    const login = createGptAccountLogin({ profilesDir: profiles,
      clientFactory: async (options) => {
        notification = options.onNotification;
        return { request: async () => {
          await saveAuth(options.codexHome, id);
          return { loginId: "synthetic-login", authUrl: "https://auth.openai.com/authorize?state=synthetic" };
        }, close() {} };
      }, onComplete: scan });
    try {
      await login.start({ label: "Synthetic shared label" });
      await notification({ method: "account/login/completed", params: { success: true } });
      return login.status();
    } finally { login.close(); }
  };
  const serve = async ({ runtimeDirectory = path.join(directory, "runtime") } = {}) => {
    const app = require("express")();
    let authenticated = true;
    const context = { app, URL, buildDesktopWidgetSnapshot, readUsageDashboard: usage,
      markInteractiveUsageRequest() {}, isAuthed: () => authenticated };
    context.authMiddleware = productionFunction("authMiddleware", context);
    context.localControlMiddleware = productionFunction("localControlMiddleware", context);
    vm.runInNewContext(source.slice(source.indexOf('app.get("/api/desktop-widget"'),
      source.indexOf('app.get("/api/chat-usage"')), context);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await fs.mkdir(runtimeDirectory, { mode: 0o700, recursive: true });
    const bridge = await startPlasmaBridge({ runtimeDirectory,
      readSnapshot: () => readPlasmaSnapshot({ fetch: (...args) => fetch(...args) }, origin) });
    return { origin, runtimeDirectory, setAuthenticated: (value) => { authenticated = value; },
      read: async () => JSON.parse((await run("/usr/bin/python3", ["-I",
        new URL("../../plasma/contents/code/read_snapshot.py", import.meta.url).pathname],
      { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory } })).stdout),
      close: async () => { await bridge.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
  };
  return { directory, profiles, workspace, otherWorkspace, legacyId: legacyObservation.id, legacyBytes,
    scan, usage, snapshot, login, connections, serve, setFailed: (value) => { failed = value; },
    cached: () => readAccounts(),
    reload: async () => { Object.assign(cache, createTimedCache()); await readAccounts(); registry = await registryApi.readGptAccountRegistry(directory); },
    stored: () => registryApi.readGptAccountRegistry(directory),
    close: () => fs.rm(directory, { recursive: true, force: true }) };
}
