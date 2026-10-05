"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const METADATA_FILE = "dashboard-profile.json";
const MAX_OUTPUT_BYTES = 64 * 1024;

// The unmodified CLI owns authentication and its credential store. Never read
// its OAuth files or Keychain entries here. Separate CLAUDE_CONFIG_DIR values
// isolate subscription logins: https://code.claude.com/docs/en/authentication
// Native CLI sign-in is distinct from a third-party OAuth implementation:
// https://code.claude.com/docs/en/legal-and-compliance
function createClaudeAccountLogin({
  profilesDir, resolveCli, onComplete = async () => {}, spawnProcess = spawn,
  environment = process.env, loginTimeoutMs = 10 * 60_000, commandTimeoutMs = 15_000
}) {
  let pending = null;
  let starting = null;
  let closed = false;
  let closing = null;
  const statusCache = new Map();
  const removals = new Map();
  const activeTasks = new Set();
  const profilePath = (id) => {
    if (typeof id !== "string" || !PROFILE_ID.test(id)) throw new Error("invalid_profile");
    return path.join(profilesDir, id);
  };
  const publicState = () => pending ? {
    id: pending.id, status: pending.status, authUrl: pending.authUrl,
    expiresAt: pending.expiresAt, error: pending.error
  } : { status: "idle" };
  const cliEnvironment = (configDir) => {
    const env = { ...environment };
    for (const key of Object.keys(env)) {
      if (/^(ANTHROPIC_|CLAUDE_)/i.test(key) || /^(CLAUDECODE|NODE_OPTIONS)$/i.test(key)) delete env[key];
    }
    env.CLAUDE_CONFIG_DIR = configDir;
    return env;
  };
  const cliPath = async () => {
    if (closed) throw new Error("login_cancelled");
    const executable = await resolveCli();
    if (closed) throw new Error("login_cancelled");
    if (typeof executable !== "string" || !executable.trim()) throw new Error("claude_cli_unavailable");
    return executable;
  };
  function run(executable, args, configDir, { timeout = commandTimeoutMs, onOutput, owner, cleanup = false } = {}) {
    if (closed && !cleanup) throw new Error("login_cancelled");
    let child, timeoutTimer, killTimer, fallbackTimer, stopReason, settled = false;
    let stdout = "";
    let outputBytes = 0;
    let finish;
    const task = {
      cleanup,
      stop(reason = "login_cancelled") {
        if (settled || stopReason) return;
        stopReason = reason;
        killTimer = setTimeout(() => child?.kill("SIGKILL"), 1000);
        fallbackTimer = setTimeout(() => finish(new Error(reason)), 2000);
        killTimer.unref?.(); fallbackTimer.unref?.();
        child?.kill();
      },
      done: null
    };
    task.done = new Promise((resolve, reject) => {
      finish = (error, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer); clearTimeout(killTimer); clearTimeout(fallbackTimer);
        activeTasks.delete(task); owner?.tasks.delete(task);
        if (error || stopReason) reject(error || new Error(stopReason));
        else resolve({ code, stdout });
      };
      try {
        child = spawnProcess(executable, args, {
          cwd: configDir, env: cliEnvironment(configDir), shell: false,
          stdio: ["ignore", "pipe", "pipe"], windowsHide: true
        });
        child.stdout?.on("data", (chunk) => {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > MAX_OUTPUT_BYTES) return task.stop("claude_output_limit");
          stdout += chunk.toString();
          onOutput?.(stdout);
        });
        // Drain diagnostics, but never return or retain them: CLI errors may
        // include credential paths, account identifiers or authorization URLs.
        child.stderr?.on("data", () => {});
        child.once("error", () => finish(new Error("claude_cli_unavailable")));
        child.once("close", (code) => finish(null, code));
        activeTasks.add(task); owner?.tasks.add(task);
        timeoutTimer = setTimeout(() => task.stop("claude_command_timeout"), timeout);
        timeoutTimer.unref?.();
      } catch { finish(new Error("claude_cli_unavailable")); }
    });
    return task;
  }
  async function readMetadata(id) {
    const configDir = profilePath(id);
    const info = await fsp.lstat(configDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid_profile");
    const file = path.join(configDir, METADATA_FILE);
    const metadataInfo = await fsp.lstat(file);
    if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.size > 4096) throw new Error("invalid_profile");
    const metadata = JSON.parse(await fsp.readFile(file, "utf8"));
    if (metadata.version !== 1 || metadata.id !== id) throw new Error("invalid_profile");
    return { id, label: cleanLabel(metadata.label), completed: metadata.completed === true, createdAt: metadata.createdAt };
  }
  const cleanLabel = (label) => typeof label === "string" ? label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
  async function saveMetadata(metadata) {
    const file = path.join(profilePath(metadata.id), METADATA_FILE);
    await fsp.writeFile(file, `${JSON.stringify({ version: 1, ...metadata })}\n`, { mode: 0o600 });
    await fsp.chmod(file, 0o600);
  }
  async function ownedProfiles() {
    const entries = await fsp.readdir(profilesDir, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const profiles = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROFILE_ID.test(entry.name)) continue;
      try { profiles.push(await readMetadata(entry.name)); } catch { /* Not an owned profile. */ }
    }
    return profiles;
  }
  async function authStatus(metadata, executable, owner) {
    const result = await run(executable, ["auth", "status", "--json"], profilePath(metadata.id), { owner }).done;
    let raw;
    try { raw = JSON.parse(result.stdout); } catch { throw new Error("claude_status_unavailable"); }
    const authenticated = result.code === 0 && raw.loggedIn === true && raw.authMethod === "claude.ai";
    const value = { id: metadata.id, label: metadata.label, authenticated };
    if (authenticated) {
      const identity = typeof raw.accountId === "string" ? raw.accountId :
        (typeof raw.email === "string" ? raw.email.trim().toLowerCase() : null);
      if (identity) value.accountId = `claude-${crypto.createHash("sha256").update(JSON.stringify([identity, raw.orgId || null])).digest("hex").slice(0, 24)}`;
      const plan = typeof raw.subscriptionType === "string" ? raw.subscriptionType.toLowerCase() : "";
      if (["free", "pro", "max", "team", "enterprise"].includes(plan)) value.planType = plan;
    }
    return value;
  }
  function acceptAuthUrl(text, entry) {
    if (entry.cancelled || pending !== entry) return;
    for (const candidate of text.match(/https:\/\/[^\s<>"\u001b]+/g) || []) {
      try {
        const url = new URL(candidate);
        if (url.username || url.password || url.port) continue;
        if (!["claude.ai", "console.anthropic.com", "platform.claude.com"].includes(url.hostname)) continue;
        if (url.pathname !== "/oauth/authorize") continue;
        if (url.searchParams.has("access_token") || url.searchParams.has("refresh_token")) continue;
        entry.authUrl = url.href;
        return;
      } catch { /* Partial stdout chunks and unrelated URLs are not login links. */ }
    }
  }
  async function discard(entry, { cleanup = false } = {}) {
    // Logout also removes this profile's Keychain entry on macOS. Never delete
    // the directory first: its exact path identifies that credential entry.
    if (entry.executable) {
      const result = await run(entry.executable, ["auth", "logout"], entry.configDir, { cleanup }).done;
      if (result.code !== 0) throw new Error("claude_logout_failed");
    }
    await fsp.rm(entry.configDir, { recursive: true, force: true });
    statusCache.delete(entry.id);
  }
  async function startLogin({ label } = {}) {
    const entry = {
      id: crypto.randomUUID(), status: "waiting", authUrl: null, error: null,
      expiresAt: new Date(Date.now() + loginTimeoutMs).toISOString(), tasks: new Set(), cancelled: false
    };
    entry.configDir = profilePath(entry.id);
    pending = entry;
    try {
      entry.executable = await cliPath();
      if (closed) throw new Error("login_cancelled");
      await fsp.mkdir(entry.configDir, { recursive: true, mode: 0o700 });
      await fsp.chmod(entry.configDir, 0o700);
      entry.metadata = { id: entry.id, label: cleanLabel(label), completed: false, createdAt: new Date().toISOString() };
      await saveMetadata(entry.metadata);
      const loginTask = run(entry.executable, ["auth", "login", "--claudeai"], entry.configDir, {
        timeout: loginTimeoutMs, owner: entry, onOutput: (text) => acceptAuthUrl(text, entry)
      });
      entry.finished = loginTask.done.then(async (result) => {
        if (entry.cancelled) throw new Error("login_cancelled");
        if (result.code !== 0) throw new Error("claude_login_failed");
        const profile = await authStatus(entry.metadata, entry.executable, entry);
        if (entry.cancelled) throw new Error("login_cancelled");
        if (!profile.authenticated) throw new Error("claude_login_failed");
        entry.metadata.completed = true;
        await saveMetadata(entry.metadata);
        if (entry.cancelled) throw new Error("login_cancelled");
        statusCache.set(entry.id, { value: profile, expiresAt: Date.now() + 60_000 });
        entry.status = "complete";
        entry.authUrl = null;
        try { await onComplete(profile); } catch { entry.error = "refresh_failed"; }
      }).catch(async (error) => {
        entry.status = "failed";
        entry.authUrl = null;
        entry.error = ["claude_command_timeout", "claude_cli_unavailable", "login_cancelled"].includes(error.message)
          ? error.message : "claude_login_failed";
        await discard(entry, { cleanup: true }).catch(() => { entry.error = "claude_cleanup_failed"; });
      });
    } catch {
      entry.status = "failed";
      entry.error = closed ? "login_cancelled" : "claude_cli_unavailable";
      if (entry.metadata) await discard(entry, { cleanup: true }).catch(() => { entry.error = "claude_cleanup_failed"; });
    }
    return publicState();
  }
  async function cancel() {
    if (starting) await starting;
    const entry = pending;
    if (entry?.status === "waiting") {
      entry.cancelled = true;
      for (const task of entry.tasks) task.stop();
    }
    // A failed attempt may still be removing its isolated Keychain login.
    // Wait for that cleanup before allowing a new attempt or shutting down.
    if (entry?.finished) await entry.finished;
    if (pending === entry) pending = null;
    return publicState();
  }
  return {
    status: publicState,
    async start(options) {
      if (closed) return { status: "failed", error: "claude_login_unavailable" };
      if (starting) return starting;
      if (pending?.status === "waiting") return publicState();
      // Completion includes the collector refresh callback; don't let it race
      // a new profile's login or cancellation.
      starting = (async () => {
        if (pending?.finished) await pending.finished;
        return startLogin(options);
      })();
      try { return await starting; } finally { starting = null; }
    },
    cancel,
    async profiles({ refresh = false } = {}) {
      if (closed) return [];
      const result = [];
      const metadata = await ownedProfiles();
      if (closed) return [];
      let executable;
      try { executable = await cliPath(); } catch { /* Surface a safe status below. */ }
      for (const profile of metadata) {
        if (closed) return [];
        if (pending?.id === profile.id && pending.status === "waiting") continue;
        const cached = statusCache.get(profile.id);
        if (!refresh && cached?.expiresAt > Date.now()) { result.push(cached.value); continue; }
        let value;
        try {
          if (!executable) throw new Error("claude_cli_unavailable");
          value = await authStatus(profile, executable);
          if (closed) return [];
          // Recover a login completed by the CLI just before an app restart.
          if (value.authenticated && !profile.completed) {
            profile.completed = true;
            await saveMetadata(profile);
          }
        } catch { value = { id: profile.id, label: profile.label, authenticated: false, error: "claude_status_unavailable" }; }
        if (closed) return [];
        statusCache.set(profile.id, { value, expiresAt: Date.now() + 60_000 });
        result.push(value);
      }
      return result;
    },
    async profileSources() {
      return (await ownedProfiles()).filter((profile) => profile.completed).map(({ id, label }) => ({ id, label, configDir: profilePath(id) }));
    },
    async remove(id) {
      profilePath(id);
      if (closed) throw new Error("login_cancelled");
      if (removals.has(id)) return removals.get(id);
      const removal = (async () => {
        if (pending?.id === id && pending.status === "waiting") { await cancel(); return; }
        await readMetadata(id);
        const executable = await cliPath();
        await discard({ id, executable, configDir: profilePath(id) });
        if (pending?.id === id) pending = null;
      })();
      removals.set(id, removal);
      try { await removal; } finally { removals.delete(id); }
    },
    async close() {
      if (!closing) {
        closed = true;
        closing = (async () => {
          const tasks = [...activeTasks];
          for (const task of tasks) if (!task.cleanup) task.stop();
          // Cancellation may start the profile's required logout. Its command
          // timeout remains bounded, and cancel waits for that cleanup too.
          await cancel();
          for (const task of activeTasks) {
            if (!task.cleanup) task.stop();
            tasks.push(task);
          }
          await Promise.allSettled(tasks.map((task) => task.done));
        })();
      }
      return closing;
    }
  };
}

module.exports = { createClaudeAccountLogin };
