import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createKimiAccountLogin, normalizeKimiQuota, readKimiKeyUsage, readMoonshotBalance } = require("../lib/kimi-accounts.js");
const tmp = await mkdtemp(path.join(os.tmpdir(), "llm-kimi-"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
const until = async (predicate) => {
  for (let index = 0; index < 100; index += 1) { if (await predicate()) return; await delay(10); }
  throw new Error("Timed out waiting for fixture state");
};
const controllers = [];
function fixture(options = {}) {
  const processes = [], requests = [], homes = [], servers = new Map();
  const secret = "PRIVATE_LOCAL_BEARER_NEVER_FRONTEND";
  let completed = 0, polling = 0;
  const login = createKimiAccountLogin({
    profilesDir: path.join(tmp, crypto.randomUUID()), resolveCli: options.resolveCli || (async () => options.missing ? null : "kimi-fixture"), pollIntervalMs: 10, startupTimeoutMs: 500, requestTimeoutMs: 200,
    onComplete: async () => { completed += 1; },
    spawnImpl(command, args, settings) {
      assert.equal(command, "kimi-fixture");
      assert.equal(settings.env.KIMI_DISABLE_TELEMETRY, "1");
      assert.equal(settings.env.KIMI_CODE_NO_AUTO_UPDATE, "1");
      if (!settings.env.KIMI_CODE_HOME.includes("llm-kimi-probe-")) assert.equal(settings.cwd, settings.env.KIMI_CODE_HOME);
      assert.equal(settings.stdio[0], "ignore");
      assert.equal(settings.windowsHide, true);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
      child.on("exit", () => { child.exited = true; });
      child.kill = () => { if (!child.killed) { child.killed = true; child.emit("exit", 0); } return true; };
      processes.push(child); homes.push(settings.env.KIMI_CODE_HOME);
      if (args.includes("--help")) {
        if (options.helpPending) return child;
        queueMicrotask(() => {
          child.stdout.write(options.legacy ? "--dangerously-omit-auth --no-open" : "--no-open --dangerous-bypass-auth");
          child.emit("exit", 0);
        });
      } else {
        assert.deepEqual(args.slice(0, 3), ["web", "--host", "127.0.0.1"]);
        assert.equal(args.at(-1), "--no-open");
        const port = args[args.indexOf("--port") + 1];
        servers.set(port, settings.env.KIMI_CODE_HOME);
        writeFile(path.join(settings.env.KIMI_CODE_HOME, "server.token"), secret, { mode: 0o600 }).catch(() => {});
        child.stdout.write(`Secret startup banner: ${secret}`);
      }
      return child;
    },
    async fetchImpl(input, request) {
      const url = new URL(input); requests.push({ url, request });
      assert.equal(url.hostname, "127.0.0.1");
      assert(servers.has(url.port));
      assert.equal(request.headers.Authorization, `Bearer ${secret}`);
      assert.equal(request.redirect, "error");
      let data;
      if (url.pathname.endsWith("/meta")) data = { server_version: "0.40.0" };
      else if (url.pathname.endsWith("/usage") && options.usageUnavailable) return response({ code: 1 }, 503);
      else if (url.pathname.endsWith("/login") && request.method === "POST") {
        assert.deepEqual(JSON.parse(request.body), { region: "global" });
        data = { status: "pending", verification_uri_complete: options.authUrl || "https://auth.kimi.com/authorize?user_code=TEST", user_code: "TEST-CODE", expires_in: 600, interval: 1 };
      } else if (url.pathname.endsWith("/login") && request.method === "DELETE") data = { cancelled: true, status: "cancelled" };
      else if (url.pathname.endsWith("/login")) {
        polling += 1;
        if (options.pollFailures && polling <= options.pollFailures) throw new Error("private provider diagnostic");
        if (options.pollDelay) await delay(options.pollDelay);
        data = { status: options.pending ? "pending" : "authenticated" };
      } else if (url.pathname.endsWith("/usage")) data = { kind: "ok", quota: { usages: { limit5h: { usedRatio: 0, resetAt: "2026-10-05T12:00:00Z" }, monthTotal: { usedRatio: 0.3 } }, extraUsage: { private: secret } } };
      else if (url.pathname.endsWith("/userinfo")) data = { kind: "ok", userInfo: { userId: "private-provider-account", email: "private@example.invalid", userLevelName: "Plus", access_token: secret } };
      else throw new Error("Unexpected fixture request");
      return response({ code: 0, data });
    }
  });
  controllers.push(login);
  return { login, processes, requests, homes, get completed() { return completed; }, get polling() { return polling; }, secret };
}
try {
  const catalog = fixture();
  const initialFiles = await readdir(tmp);
  const [available, concurrentAvailability] = await Promise.all([catalog.login.availability(), catalog.login.availability()]);
  assert.deepEqual(available, { available: true }); assert.deepEqual(concurrentAvailability, available);
  assert.deepEqual(await catalog.login.availability(), available);
  assert.equal(catalog.processes.length, 1, "availability is cached and concurrent probes share one process");
  assert.deepEqual(await readdir(tmp), initialFiles, "availability creates no profiles or files");
  assert.equal(catalog.requests.length, 0, "availability performs no login or API call");
  const unavailableCatalog = fixture({ legacy: true });
  assert.deepEqual(await unavailableCatalog.login.availability(), { available: false, error: "kimi_cli_unsupported" });
  const missingCatalog = fixture({ missing: true });
  assert.deepEqual(await missingCatalog.login.availability(), { available: false, error: "kimi_cli_missing" });
  const old = path.join(tmp, "original-user-home", "credentials.json");
  await mkdir(path.dirname(old)); await writeFile(old, "NEVER_REPLACE");
  const ready = fixture({ pollFailures: 1 });
  const [first, same] = await Promise.all([ready.login.start({ label: "Work Kimi" }), ready.login.start({ label: "Ignored duplicate" })]);
  assert.equal(first.id, same.id);
  assert.equal(first.status, "waiting"); assert.equal(first.userCode, null, "preparation returns promptly before the helper starts");
  await until(() => ready.login.status().userCode === "TEST-CODE");
  assert.equal((await ready.login.start()).id, first.id);
  assert.equal((await ready.login.profiles()).length, 0, "pending login is not a connected account");
  await until(() => ready.login.status().status === "complete");
  assert.equal(ready.completed, 1); assert(ready.polling >= 2, "transient polling failure retries");
  assert.equal(ready.login.status().authUrl, null); assert.equal(ready.login.status().userCode, null);
  const [account] = await ready.login.profiles();
  assert.equal(account.label, "Work Kimi"); assert.equal(account.status, "connected");
  assert.equal(account.accountId, `kimi-${crypto.createHash("sha256").update("kimi:private-provider-account").digest("hex").slice(0, 16)}`);
  assert.equal(account.measurement.limits.rows[0].usedPercent, 0);
  assert.equal(account.measurement.authenticated, true);
  const exposed = JSON.stringify({ state: ready.login.status(), account });
  for (const privateValue of [ready.secret, tmp, "private-provider-account", "private@example.invalid", "access_token"]) assert(!exposed.includes(privateValue));
  assert(ready.processes.every((entry) => entry.killed || entry.exited), "login helper stops after completion");
  if (process.platform !== "win32") assert.equal((await stat(ready.login.profileDir(first.id))).mode & 0o777, 0o700);
  await ready.login.refresh(first.id);
  assert(ready.processes.every((entry) => entry.killed || entry.exited), "refresh helper stops after quota fetch");
  const second = await ready.login.start({ label: "Personal Kimi" }); assert.notEqual(second.id, first.id);
  await until(() => ready.login.status().status === "complete");
  assert.equal((await ready.login.profiles()).length, 2);
  assert.notEqual(ready.login.profileDir(first.id), ready.login.profileDir(second.id));
  await assert.rejects(ready.login.remove("../../original-user-home"), /profile_not_found/);
  await ready.login.remove(first.id);
  assert.equal((await ready.login.profiles()).length, 1);
  assert.equal(await readFile(old, "utf8"), "NEVER_REPLACE");

  const cancelled = fixture({ pending: true });
  const pending = await cancelled.login.start(); await until(() => cancelled.login.status().userCode); await cancelled.login.cancel();
  assert.equal(cancelled.login.status().status, "idle");
  assert.equal(cancelled.completed, 0); assert.equal((await cancelled.login.profiles()).length, 0);
  await assert.rejects(stat(cancelled.login.profileDir(pending.id)), { code: "ENOENT" });
  assert(cancelled.requests.some(({ request }) => request.method === "DELETE"));
  assert(cancelled.processes.every((entry) => entry.killed || entry.exited));

  const race = fixture({ pollDelay: 40 });
  await race.login.start(); await until(() => race.polling > 0); await race.login.cancel(); await delay(60);
  assert.equal(race.completed, 0, "late successful poll cannot recreate cancelled account");
  assert.equal((await race.login.profiles()).length, 0);
  const missing = fixture({ missing: true }); await missing.login.start(); await until(() => missing.login.status().status === "failed"); assert.equal(missing.login.status().error, "kimi_cli_missing");
  const legacy = fixture({ legacy: true }); await legacy.login.start(); await until(() => legacy.login.status().status === "failed"); assert.equal(legacy.login.status().error, "kimi_cli_unsupported");
  assert.equal(legacy.processes.length, 1, "legacy CLI never starts a server with the user's real home");
  const hostile = fixture({ authUrl: "https://auth.kimi.com.attacker.invalid/login" }); await hostile.login.start(); await until(() => hostile.login.status().status === "failed"); assert.equal(hostile.login.status().error, "invalid_auth_url");
  assert(!JSON.stringify(hostile.login.status()).includes("attacker"));
  const failures = fixture({ pollFailures: 9 }); await failures.login.start(); await until(() => failures.login.status().status === "failed");
  assert.equal(failures.polling, 3); assert.equal(failures.completed, 0);
  const shuttingDown = fixture({ pending: true }); await shuttingDown.login.start(); await shuttingDown.login.close();
  assert(shuttingDown.processes.every((entry) => entry.killed || entry.exited));
  assert.equal((await shuttingDown.login.profiles()).length, 0);

  let releaseResolver, resolverEntered = false;
  const deferred = new Promise((resolve) => { releaseResolver = resolve; });
  const closingResolver = fixture({ resolveCli: async () => { resolverEntered = true; await deferred; return "kimi-fixture"; } });
  const preparing = await closingResolver.login.start();
  assert.equal(preparing.status, "waiting");
  await until(() => resolverEntered);
  const closing = closingResolver.login.close(); releaseResolver(); await closing;
  assert.equal(closingResolver.processes.length, 0, "resolver completing after close must never spawn a child");
  assert.equal((await closingResolver.login.profiles()).length, 0);
  assert.equal((await closingResolver.login.start()).status, "failed");

  const preflightCancel = fixture({ helpPending: true });
  const preflightState = await preflightCancel.login.start();
  await until(() => preflightCancel.processes.length === 1);
  await preflightCancel.login.cancel();
  assert.equal(preflightCancel.login.status().status, "idle");
  assert(preflightCancel.processes.every((entry) => entry.killed));
  await assert.rejects(stat(preflightCancel.login.profileDir(preflightState.id)), { code: "ENOENT" });

  const preflightClose = fixture({ helpPending: true });
  await preflightClose.login.start(); await until(() => preflightClose.processes.length === 1); await preflightClose.login.close();
  assert(preflightClose.processes.every((entry) => entry.killed));
  assert.equal((await preflightClose.login.profiles()).length, 0);

  const failedDownload = fixture({ resolveCli: async () => { throw new Error("kimi_runtime_integrity_failed"); } });
  await failedDownload.login.start(); await until(() => failedDownload.login.status().status === "failed");
  assert.equal(failedDownload.login.status().error, "kimi_runtime_integrity_failed");
  assert.equal(failedDownload.processes.length, 0);

  const staleOptions = {};
  const stale = fixture(staleOptions);
  const staleLogin = await stale.login.start(); await until(() => stale.login.status().status === "complete");
  const previousMeasurement = (await stale.login.profiles())[0].measurement;
  staleOptions.usageUnavailable = true;
  const staleProfile = await stale.login.refresh(staleLogin.id);
  assert.equal(staleProfile.measurement.status, "unavailable");
  assert.equal(staleProfile.measurement.updatedAt, previousMeasurement.updatedAt, "a failed refresh does not advance the actual measurement timestamp");
  assert.deepEqual(staleProfile.measurement.limits, previousMeasurement.limits, "last-known quotas survive a temporary provider failure");
  assert(!staleProfile.measurement.authenticated, "a failed refresh must not claim new authentication proof");

  assert.equal(normalizeKimiQuota({ usages: { limit5h: { usedRatio: "0.2" }, limit7d: { usedRatio: NaN }, monthCode: { usedRatio: -1 } } }), null);
  assert.equal(normalizeKimiQuota({ usage: { limit: 0, used: 0 } }), null, "unknown or zero denominator does not become zero consumption");
  assert.equal(normalizeKimiQuota({ usage: { limit: 10, remaining: 10 } }).rows[0].usedPercent, 0);
  const direct = await readKimiKeyUsage("fixture-key", { fetch: async (url, options) => {
    assert.equal(url, "https://api.kimi.com/coding/v1/usages"); assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer fixture-key"); assert.equal(options.body, undefined);
    return response({ usage: { limit: 100, remaining: 80, resetTime: "2026-10-06T00:00:00Z" }, limits: [{ window: { duration: 5, timeUnit: "HOUR" }, detail: { limit: 100, used: 0 } }] });
  } });
  assert.equal(direct.status, "available"); assert.equal(direct.authenticated, true);
  assert.equal(direct.limits.rows[0].usedPercent, 20); assert.equal(direct.limits.rows[1].windowMinutes, 300);
  const rawUsage = await readKimiKeyUsage("fixture-key", { fetch: async () => response({ usages: {
    limit_5h: { used_ratio: 0, reset_time: "2026-10-05T12:00:00Z" },
    limit_7d: { used_ratio: "0.25" }, limit_month_total: { used_ratio: 1 }, limit_month_code: { used_ratio: 0.5 }
  } }) });
  assert.equal(rawUsage.authenticated, true);
  assert.deepEqual(rawUsage.limits.rows.map(({ key, usedPercent }) => ({ key, usedPercent })), [
    { key: "limit5h", usedPercent: 0 }, { key: "limit7d", usedPercent: 25 }, { key: "monthTotal", usedPercent: 100 }, { key: "monthCode", usedPercent: 50 }
  ]);
  assert.equal(rawUsage.limits.rows[0].resetsAt, "2026-10-05T12:00:00.000Z");
  const rejected = await readKimiKeyUsage("fixture-key", { fetch: async () => response({ message: "secret diagnostic" }, 401) });
  assert.equal(rejected.error, "auth_failed"); assert(!rejected.authenticated); assert(!JSON.stringify(rejected).includes("secret"));
  const malformed = await readKimiKeyUsage("fixture-key", { fetch: async () => response({ usages: { limit5h: { usedRatio: "bad" } } }) });
  assert.equal(malformed.status, "unavailable"); assert.equal(malformed.limits, null);
  const balance = await readMoonshotBalance("fixture-key", { fetch: async (url, options) => {
    assert.equal(url, "https://api.moonshot.ai/v1/users/me/balance"); assert.equal(options.method, "GET");
    return response({ code: 0, status: true, data: { available_balance: 0, cash_balance: -2, voucher_balance: 0 } });
  } });
  assert.equal(balance.balance.available, 0); assert.equal(balance.balance.cash, -2); assert.equal(balance.authenticated, true);
  const invalidBalance = await readMoonshotBalance("fixture-key", { fetch: async () => response({ code: 401, data: { available_balance: 1 } }) });
  assert.equal(invalidBalance.status, "unavailable");
  console.log("Kimi accounts: isolated browser login, private bearer, safe URLs, cancellation races, retry, lifecycle, quota and balance passed.");
} finally {
  await Promise.allSettled(controllers.map((controller) => controller.close()));
  await rm(tmp, { recursive: true, force: true });
}
