"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const os = require("node:os");
const { spawn } = require("node:child_process");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KIMI_AUTH_HOSTS = new Set(["auth.kimi.com", "auth.kimi.ai", "www.kimi.com", "www.kimi.ai", "kimi.com", "kimi.ai"]);
const HTTP_TIMEOUT = 10_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeLabel = (value) => String(value || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80);
const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const failedMeasurement = (error = "usage_unavailable") => ({ status: "unavailable", updatedAt: new Date().toISOString(), limits: null, error });

function safeError(error) {
  if (/^kimi_runtime_(?:unsupported|cancelled|storage_unsafe|download_failed|download_timeout|download_too_large|integrity_failed)$/.test(error?.message || "")) return error.message;
  return ["kimi_cli_missing", "kimi_cli_unsupported", "kimi_login_unavailable", "kimi_login_expired", "kimi_login_denied", "kimi_login_cancelled", "invalid_auth_url", "request_timeout", "invalid_response", "auth_failed", "rate_limited", "usage_unavailable", "profile_not_found"].includes(error?.message)
    ? error.message : "kimi_login_unavailable";
}

async function requestJson(url, { fetchImpl = fetch, method = "GET", token, body, timeoutMs = HTTP_TIMEOUT } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("request_timeout")); }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(url, {
        method, headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, redirect: "error"
      });
      if (!response?.ok) {
        await response?.body?.cancel?.().catch(() => {});
        throw new Error([401, 403].includes(response?.status) ? "auth_failed" : response?.status === 429 ? "rate_limited" : "usage_unavailable");
      }
      let text;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = []; let length = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_RESPONSE_BYTES) throw new Error("invalid_response");
            chunks.push(Buffer.from(value));
          }
          text = Buffer.concat(chunks).toString("utf8");
        } finally { await reader.cancel().catch(() => {}); }
      } else {
        text = await response.text();
        if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("invalid_response");
      }
      try { return JSON.parse(text); } catch { throw new Error("invalid_response"); }
    })()]);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("request_timeout");
    throw error;
  } finally { clearTimeout(timer); }
}

function resetAt(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function quotaRow(key, detail, windowMinutes = null) {
  if (!detail || typeof detail !== "object") return null;
  const rawRatio = detail.used_ratio;
  const ratio = finite(detail.usedRatio) ?? (typeof rawRatio === "string" && rawRatio.trim() ? finite(Number(rawRatio)) : finite(rawRatio));
  let percent = ratio !== null && ratio >= 0 && ratio <= 1 ? ratio * 100 : null;
  const limit = finite(detail.limit);
  const used = finite(detail.used);
  const remaining = finite(detail.remaining);
  if (percent === null && limit !== null && limit > 0) {
    const consumed = used ?? (remaining !== null ? limit - remaining : null);
    if (consumed !== null && consumed >= 0) percent = Math.min(100, consumed / limit * 100);
  }
  if (percent === null) return null;
  return { key, usedPercent: percent, remainingPercent: 100 - percent, windowMinutes,
    resetsAt: resetAt(detail.resetAt || detail.resetTime || detail.reset_at || detail.reset_time) };
}

function normalizeKimiQuota(payload) {
  const rows = [];
  const windows = { limit5h: 300, limit7d: 10080, monthTotal: null, monthCode: null };
  const rawWindows = { limit5h: "limit_5h", limit7d: "limit_7d", monthTotal: "limit_month_total", monthCode: "limit_month_code" };
  if (payload?.usages && typeof payload.usages === "object") {
    for (const [key, minutes] of Object.entries(windows)) {
      const row = quotaRow(key, payload.usages[key] ?? payload.usages[rawWindows[key]], minutes);
      if (row) rows.push(row);
    }
  } else if (payload && typeof payload === "object") {
    const summary = quotaRow("summary", payload.usage);
    if (summary) rows.push(summary);
    for (const [index, item] of (Array.isArray(payload.limits) ? payload.limits.slice(0, 12) : []).entries()) {
      const detail = item?.detail || item;
      const window = item?.window || item;
      const duration = finite(window?.duration);
      const unit = String(window?.timeUnit || "").toUpperCase();
      const multiplier = { SECOND: 1 / 60, MINUTE: 1, HOUR: 60, DAY: 1440 }[unit.replace(/S$/, "")];
      const minutes = duration !== null && duration > 0 && multiplier ? duration * multiplier : null;
      const row = quotaRow(`limit${index + 1}`, detail, minutes);
      if (row) rows.push(row);
    }
  }
  return rows.length ? { rows } : null;
}

async function readKimiKeyUsage(apiKey, options = {}) {
  if (!apiKey || typeof apiKey !== "string") return failedMeasurement("auth_failed");
  try {
    const payload = await requestJson("https://api.kimi.com/coding/v1/usages", { token: apiKey, fetchImpl: options.fetch || options.fetchImpl || fetch, timeoutMs: options.timeoutMs });
    const limits = normalizeKimiQuota(payload);
    return limits ? { status: "available", authenticated: true, updatedAt: new Date().toISOString(), limits } : failedMeasurement("invalid_response");
  } catch (error) { return failedMeasurement(safeError(error) === "kimi_login_unavailable" ? "usage_unavailable" : safeError(error)); }
}

async function readMoonshotBalance(apiKey, options = {}) {
  if (!apiKey || typeof apiKey !== "string") return failedMeasurement("auth_failed");
  try {
    const payload = await requestJson("https://api.moonshot.ai/v1/users/me/balance", { token: apiKey, fetchImpl: options.fetch || options.fetchImpl || fetch, timeoutMs: options.timeoutMs });
    const data = payload?.data;
    if (payload?.code !== 0 || payload?.status === false || finite(data?.available_balance) === null) return failedMeasurement("invalid_response");
    return { status: "available", authenticated: true, updatedAt: new Date().toISOString(), limits: null,
      balance: { available: data.available_balance, cash: finite(data.cash_balance), voucher: finite(data.voucher_balance), currency: "USD" } };
  } catch (error) { return failedMeasurement(safeError(error) === "kimi_login_unavailable" ? "usage_unavailable" : safeError(error)); }
}

function createKimiAccountLogin({ profilesDir, resolveCli, onComplete = async () => {}, fetchImpl = fetch, spawnImpl = spawn, startupTimeoutMs = 12_000, requestTimeoutMs = HTTP_TIMEOUT, pollIntervalMs, maxLoginMs = 10 * 60_000 } = {}) {
  if (!profilesDir || typeof resolveCli !== "function") throw new Error("Kimi profiles directory and CLI resolver are required");
  let pending = null, starting = null, closed = false;
  let availabilityCache = null, checkingAvailability = null;
  const services = new Set();
  const refreshing = new Map();
  const assertActive = (entry) => { if (closed || entry?.cancelled) throw new Error("kimi_login_cancelled"); };
  function trackChild(child) {
    let resolveDone, killTimer, stopTimer;
    const service = { child, exited: false, stopped: false };
    service.done = new Promise((resolve) => { resolveDone = resolve; });
    const finished = () => {
      service.exited = true; clearTimeout(killTimer); clearTimeout(stopTimer);
      services.delete(service); resolveDone();
    };
    child.once("error", finished); child.once("exit", finished);
    service.stop = () => {
      if (!service.exited && !service.stopped) {
        service.stopped = true;
        killTimer = setTimeout(() => { if (!service.exited) child.kill("SIGKILL"); }, 2000);
        stopTimer = setTimeout(finished, 2500);
        killTimer.unref?.(); stopTimer.unref?.();
        child.kill("SIGTERM");
      }
      return service.done;
    };
    services.add(service);
    return service;
  }
  const profileDir = (id) => {
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("profile_not_found");
    return path.join(profilesDir, id);
  };
  const metadataPath = (id) => path.join(profileDir(id), "dashboard-account.json");
  const publicProfile = (entry) => ({ id: entry.id, label: safeLabel(entry.label) || "Kimi Code", status: entry.status || "connected", accountId: entry.accountId || null, planType: entry.planType || null, measurement: entry.measurement || null });
  const publicState = () => pending ? { id: pending.id, status: ["starting", "finishing"].includes(pending.status) ? "waiting" : pending.status, authUrl: pending.authUrl || null, userCode: pending.userCode || null, expiresAt: pending.expiresAt || null, error: pending.error || null } : { status: "idle" };
  const save = async (entry) => {
    const target = metadataPath(entry.id);
    const temporary = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify({ ...publicProfile(entry), createdAt: entry.createdAt || new Date().toISOString() }), { mode: 0o600, flag: "wx" });
    await fsp.rename(temporary, target);
    await fsp.chmod(target, 0o600);
  };
  const read = async (id) => {
    try {
      const stat = await fsp.lstat(profileDir(id));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      const value = JSON.parse(await fsp.readFile(metadataPath(id), "utf8"));
      if (value.id !== id) throw new Error();
      return value;
    } catch { throw new Error("profile_not_found"); }
  };
  const environment = (home) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^KIMI_(?:MODEL_|CODE_OAUTH_HOST$|OAUTH_HOST$|CODE_BASE_URL$|CODE_PASSWORD$)/.test(key)) delete env[key];
    }
    return { ...env, KIMI_CODE_HOME: home, KIMI_DISABLE_TELEMETRY: "1", KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_CLI_NO_AUTO_UPDATE: "1", KIMI_DISABLE_CRON: "1", KIMI_LOG_LEVEL: "off", NO_COLOR: "1" };
  };
  async function currentCli(home, cwd = home, entry) {
    assertActive(entry);
    let resolved;
    try { resolved = await resolveCli(); } catch (error) { throw new Error(safeError(error).startsWith("kimi_runtime_") ? safeError(error) : "kimi_cli_missing"); }
    assertActive(entry);
    if (!resolved) throw new Error("kimi_cli_missing");
    const cli = typeof resolved === "string" ? { command: resolved, args: [] } : resolved;
    if (typeof cli.command !== "string" || !cli.command || !Array.isArray(cli.args || [])) throw new Error("kimi_cli_missing");
    return new Promise((resolve, reject) => {
      let child, service, output = "", settled = false;
      const finish = async (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        await service?.stop();
        error ? reject(error) : resolve({ command: cli.command, args: cli.args || [] });
      };
      const timer = setTimeout(() => finish(new Error("kimi_cli_unsupported")), startupTimeoutMs);
      timer.unref?.();
      try {
        child = spawnImpl(cli.command, [...(cli.args || []), "web", "--help"], { env: environment(home), cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        service = trackChild(child);
        service.entry = entry;
        for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => {
          if (output.length < 32_768) output += String(chunk).slice(0, 32_768 - output.length);
        });
        child.on("error", () => finish(new Error("kimi_cli_missing")));
        child.on("exit", (code) => finish(code === 0 && output.includes("--no-open") && output.includes("--dangerous-bypass-auth") ? null : new Error("kimi_cli_unsupported")));
      } catch { finish(new Error("kimi_cli_missing")); }
    });
  }
  async function availablePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer(); server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
    });
  }
  async function launch(home, entry) {
    const cli = await currentCli(home, home, entry);
    assertActive(entry);
    const port = await availablePort();
    assertActive(entry);
    const child = spawnImpl(cli.command, [...cli.args, "web", "--host", "127.0.0.1", "--port", String(port), "--no-open"], { env: environment(home), cwd: home, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    // The startup banner contains its private bearer token. Drain, never log it.
    child.stdout?.resume(); child.stderr?.resume();
    const service = trackChild(child);
    service.entry = entry;
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + startupTimeoutMs;
    try {
      while (Date.now() < deadline && !closed && !entry?.cancelled && !service.exited) {
        try {
          const tokenFile = path.join(home, "server.token");
          const stat = await fsp.lstat(tokenFile);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("invalid_response");
          const token = (await fsp.readFile(tokenFile, "utf8")).trim();
          if (token.length < 16 || /[\s\x00-\x1f]/.test(token)) throw new Error("invalid_response");
          const meta = await requestJson(`${endpoint}/api/v1/meta`, { token, fetchImpl, timeoutMs: Math.min(1000, requestTimeoutMs) });
          if (meta?.code !== 0 || typeof meta?.data?.server_version !== "string") throw new Error("invalid_response");
          assertActive(entry);
          service.token = token;
          service.request = async (route, options = {}) => {
            if (service.stopped || service.exited) throw new Error("kimi_login_unavailable");
            const response = await requestJson(`${endpoint}${route}`, { token, fetchImpl, timeoutMs: requestTimeoutMs, ...options });
            if (response?.code !== 0) throw new Error("invalid_response");
            return response.data;
          };
          return service;
        } catch { await wait(100); }
      }
      throw new Error("kimi_login_unavailable");
    } catch (error) { await service.stop(); throw error; }
  }
  async function measurement(service) {
    try {
      const result = await service.request("/api/v1/oauth/usage");
      const limits = result?.kind === "ok" ? normalizeKimiQuota(result.quota) : null;
      return limits ? { status: "available", authenticated: true, updatedAt: new Date().toISOString(), limits } : failedMeasurement("usage_unavailable");
    } catch (error) { return failedMeasurement(safeError(error)); }
  }
  async function finish(entry, success, error) {
    if (pending !== entry || !["starting", "waiting"].includes(entry.status)) return;
    clearTimeout(entry.timer);
    entry.status = "finishing";
    entry.authUrl = null; entry.userCode = null;
    try {
      if (success && !closed && !entry.cancelled) {
        entry.measurement = await measurement(entry.service);
        try {
          const info = await entry.service.request("/api/v1/oauth/userinfo");
          if (info?.kind === "ok") {
            const id = info.userInfo?.globalId || info.userInfo?.userId;
            if (typeof id === "string" && id) entry.accountId = `kimi-${crypto.createHash("sha256").update(`kimi:${id}`).digest("hex").slice(0, 16)}`;
            entry.planType = safeLabel(info.userInfo?.userLevelName) || null;
          }
        } catch { /* Quota remains useful when optional account metadata fails. */ }
        if (entry.cancelled || closed) throw new Error("kimi_login_cancelled");
        await save({ ...entry, status: "connected" });
        if (entry.cancelled || closed) throw new Error("kimi_login_cancelled");
        entry.status = "complete";
        try { await onComplete(entry.id); } catch { /* A later dashboard refresh can retry. */ }
      } else {
        entry.status = "failed"; entry.error = error || (entry.cancelled || closed ? "kimi_login_cancelled" : "kimi_login_unavailable");
        await fsp.rm(entry.home, { recursive: true, force: true });
      }
    } catch (caught) {
      entry.status = "failed"; entry.error = safeError(caught);
      await fsp.rm(entry.home, { recursive: true, force: true }).catch(() => {});
    } finally { await entry.service?.stop(); }
  }
  async function poll(entry) {
    if (pending !== entry || entry.status !== "waiting") return;
    if (Date.now() >= entry.deadline) return finish(entry, false, "kimi_login_expired");
    try {
      const state = await entry.service.request("/api/v1/oauth/login");
      if (state?.status === "authenticated") return finish(entry, true);
      if (["expired", "denied", "cancelled"].includes(state?.status)) return finish(entry, false, `kimi_login_${state.status}`);
      if (state?.status !== "pending") return finish(entry, false, "invalid_response");
      entry.failures = 0;
    } catch {
      entry.failures = (entry.failures || 0) + 1;
      if (entry.failures >= 3) return finish(entry, false, "kimi_login_unavailable");
    }
    if (pending === entry && entry.status === "waiting") {
      entry.timer = setTimeout(() => poll(entry).catch(() => finish(entry, false)), entry.interval);
      entry.timer.unref?.();
    }
  }
  async function start({ label } = {}) {
    if (closed) return { status: "failed", error: "kimi_login_unavailable" };
    const id = crypto.randomUUID();
    const home = profileDir(id);
    const entry = { id, home, label: safeLabel(label), status: "starting", createdAt: new Date().toISOString(), authUrl: null, error: null };
    pending = entry;
    try {
      await fsp.mkdir(home, { recursive: true, mode: 0o700 }); await fsp.chmod(home, 0o700);
      assertActive(entry);
      entry.service = await launch(home, entry);
      assertActive(entry);
      const flow = await entry.service.request("/api/v1/oauth/login", { method: "POST", body: { region: "global" } });
      assertActive(entry);
      if (flow?.status === "authenticated") { await finish(entry, true); return publicState(); }
      if (flow?.status !== "pending") throw new Error("invalid_response");
      let url;
      try { url = new URL(flow.verification_uri_complete || flow.verification_uri); } catch { throw new Error("invalid_auth_url"); }
      if (url.protocol !== "https:" || !KIMI_AUTH_HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== "443")) throw new Error("invalid_auth_url");
      if (typeof flow.user_code !== "string" || flow.user_code.length > 64 || /[\x00-\x1f]/.test(flow.user_code)) throw new Error("invalid_response");
      const expires = finite(flow.expires_in);
      const interval = finite(flow.interval);
      if (expires === null || expires <= 0 || interval === null || interval < 1) throw new Error("invalid_response");
      entry.authUrl = url.href; entry.userCode = flow.user_code;
      entry.deadline = Date.now() + Math.min(maxLoginMs, expires * 1000);
      entry.expiresAt = new Date(entry.deadline).toISOString();
      entry.interval = pollIntervalMs ?? Math.max(1000, interval * 1000);
      entry.status = "waiting";
      entry.timer = setTimeout(() => poll(entry).catch(() => finish(entry, false)), entry.interval);
      entry.timer.unref?.();
    } catch (error) { await finish(entry, false, safeError(error)); }
    return publicState();
  }
  async function refreshOne(id) {
    const entry = await read(id);
    const previous = entry.measurement;
    let service;
    try { service = await launch(profileDir(id)); entry.measurement = await measurement(service); }
    catch (error) { entry.measurement = failedMeasurement(safeError(error)); }
    finally { await service?.stop(); }
    if (entry.measurement.status !== "available" && previous?.limits && previous?.updatedAt) {
      entry.measurement = { ...entry.measurement, limits: previous.limits, updatedAt: previous.updatedAt };
    }
    await save(entry);
    return publicProfile(entry);
  }
  async function profiles() {
    const entries = await fsp.readdir(profilesDir, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    const result = [];
    for (const entry of entries.filter((entry) => entry.isDirectory() && UUID.test(entry.name)).slice(0, 50)) {
      try { result.push(publicProfile(await read(entry.name))); } catch { /* Pending or invalid profiles are not connected accounts. */ }
    }
    return result;
  }
  return {
    status: publicState, profileDir, profiles,
    async availability() {
      if (closed) return { available: false, error: "kimi_cli_missing" };
      if (availabilityCache?.expiresAt > Date.now()) return { ...availabilityCache.value };
      if (checkingAvailability) return checkingAvailability;
      checkingAvailability = (async () => {
        let value;
        try {
          // --help only: no account, local server, or profile directory is created.
          // A nonexistent private home prevents reading the user's CLI configuration.
          await currentCli(path.join(os.tmpdir(), `llm-kimi-probe-${crypto.randomUUID()}`), os.tmpdir());
          value = { available: true };
        } catch (error) {
          value = { available: false, error: safeError(error) === "kimi_cli_missing" ? "kimi_cli_missing" : "kimi_cli_unsupported" };
        }
        availabilityCache = { value, expiresAt: Date.now() + 60_000 };
        return { ...value };
      })();
      try { return await checkingAvailability; } finally { checkingAvailability = null; }
    },
    async start(options) {
      if (closed) return { status: "failed", error: "kimi_login_unavailable" };
      if (starting) return publicState();
      if (["waiting", "finishing"].includes(pending?.status)) return publicState();
      starting = start(options).finally(() => { starting = null; });
      // Preparation may download the private helper. Poll status while it runs.
      starting.catch(() => {});
      return publicState();
    },
    async cancel() {
      const entry = pending;
      if (entry) entry.cancelled = true;
      if (entry?.status === "starting") await Promise.allSettled([...services].filter((service) => service.entry === entry).map((service) => service.stop()));
      if (starting) await starting;
      if (entry?.status === "waiting") {
        clearTimeout(entry.timer);
        entry.status = "starting"; // An in-flight poll cannot publish after cancellation.
        await entry.service?.request("/api/v1/oauth/login", { method: "DELETE" }).catch(() => {});
        await finish(entry, false, "kimi_login_cancelled");
      }
      if (entry?.status !== "finishing") pending = null;
      return publicState();
    },
    async refresh(id) {
      const ids = id ? [id] : (await profiles()).map((entry) => entry.id);
      const results = [];
      for (const current of ids) {
        if (!refreshing.has(current)) refreshing.set(current, refreshOne(current).finally(() => refreshing.delete(current)));
        results.push(await refreshing.get(current));
      }
      return id ? results[0] : results;
    },
    async remove(id) {
      await read(id);
      if (refreshing.has(id)) await refreshing.get(id);
      await fsp.rm(profileDir(id), { recursive: true, force: true });
      return profiles();
    },
    async close() {
      closed = true; clearTimeout(pending?.timer);
      if (pending) pending.cancelled = true;
      await Promise.allSettled([...services].map((service) => service.stop()));
      if (starting) await starting;
      if (["starting", "waiting"].includes(pending?.status)) await finish(pending, false, "kimi_login_cancelled");
      await Promise.allSettled(refreshing.values());
      if (checkingAvailability) await checkingAvailability;
    }
  };
}

module.exports = { createKimiAccountLogin, readKimiKeyUsage, readMoonshotBalance, normalizeKimiQuota };
