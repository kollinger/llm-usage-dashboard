import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClaudeAccountLogin } = require("../lib/claude-account-login");
const tmp = await mkdtemp(path.join(os.tmpdir(), "llm-claude-login-"));
const controllers = [];
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for test operation");
}

function fixture(name, overrides = {}) {
  const calls = [];
  const children = [];
  let logoutCode = 0;
  let rawStatus = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "fixture@example.invalid", orgId: "fixture-org" };
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.kill = (signal = "SIGTERM") => {
      child.signals.push(signal);
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    calls.push({ executable, args, options }); children.push(child);
    if (args[1] === "status") queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify(rawStatus)));
      child.emit("close", 0);
    });
    if (args[1] === "logout") queueMicrotask(() => child.emit("close", logoutCode));
    return child;
  };
  const profilesDir = path.join(tmp, name);
  const login = createClaudeAccountLogin({ profilesDir, resolveCli: async () => "claude-fixture", spawnProcess, ...overrides });
  controllers.push(login);
  return { login, calls, children, profilesDir, setStatus(value) { rawStatus = value; }, setLogoutCode(value) { logoutCode = value; } };
}

try {
  const existing = path.join(tmp, "existing-profile");
  await mkdir(existing);
  await writeFile(path.join(existing, ".credentials.json"), "existing credentials must remain untouched");
  const sourceEnvironment = {
    PATH: "fixture-path", HOME: existing, CLAUDE_CONFIG_DIR: existing,
    ANTHROPIC_API_KEY: "must-not-inherit", ANTHROPIC_AUTH_TOKEN: "must-not-inherit",
    ANTHROPIC_PROFILE: "another-account", ANTHROPIC_BASE_URL: "https://example.invalid",
    CLAUDE_CODE_OAUTH_TOKEN: "must-not-inherit", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "must-not-inherit",
    CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_PROCESS_WRAPPER: "untrusted-wrapper",
    CLAUDECODE: "1", NODE_OPTIONS: "untrusted-loader"
  };
  let completed = 0;
  const f = fixture("profiles", { environment: sourceEnvironment, onComplete: async () => { completed += 1; } });
  const [first, duplicate] = await Promise.all([f.login.start({ label: "  Work\n account  " }), f.login.start()]);
  assert.equal(first.status, "waiting");
  assert.equal(first.id, duplicate.id);
  assert.equal(f.calls.length, 1, "double-click starts one official login process");
  assert.deepEqual(f.calls[0].args, ["auth", "login", "--claudeai"]);
  assert.equal(f.calls[0].options.shell, false);
  assert.equal(f.calls[0].options.cwd, path.join(f.profilesDir, first.id));
  assert.deepEqual(f.calls[0].options.env, { PATH: "fixture-path", HOME: existing, CLAUDE_CONFIG_DIR: path.join(f.profilesDir, first.id) });
  assert.equal(sourceEnvironment.ANTHROPIC_API_KEY, "must-not-inherit", "parent environment is unchanged");
  assert.equal(sourceEnvironment.CLAUDE_CONFIG_DIR, existing);
  f.children[0].stdout.emit("data", Buffer.from("Ignore https://claude.ai.evil.invalid/oauth/authorize?state=bad\n"));
  f.children[0].stdout.emit("data", Buffer.from("Ignore https://claude.ai/oauth/authorize?access_token=secret\n"));
  f.children[0].stderr.emit("data", Buffer.from("raw diagnostic: secret credential"));
  assert.equal(f.login.status().authUrl, null);
  f.children[0].stdout.emit("data", Buffer.from("Open https://claude.ai/oauth/authorize?client_id=fixture&state=state-fixture\n"));
  assert.equal(f.login.status().authUrl, "https://claude.ai/oauth/authorize?client_id=fixture&state=state-fixture");
  f.children[0].emit("close", 0);
  await until(() => f.login.status().status === "complete");
  assert.equal(completed, 1);
  assert.equal(f.login.status().authUrl, null);
  const profiles = await f.login.profiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].label, "Work account");
  assert.equal(profiles[0].authenticated, true);
  assert.match(profiles[0].accountId, /^claude-[a-f0-9]{24}$/);
  assert.equal(profiles[0].planType, "max");
  assert(!JSON.stringify(profiles).includes("fixture@example.invalid"));
  assert(!JSON.stringify(profiles).includes("fixture-org"));
  assert(!JSON.stringify(profiles).includes(tmp));
  assert(!JSON.stringify(f.login.status()).includes("secret"));
  const metadata = await readFile(path.join(f.profilesDir, first.id, "dashboard-profile.json"), "utf8");
  assert(!metadata.includes("credentials"));
  assert(!metadata.includes("fixture@example.invalid"));
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(f.profilesDir, first.id))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(f.profilesDir, first.id, "dashboard-profile.json"))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await f.login.profileSources(), [{ id: first.id, label: "Work account", configDir: path.join(f.profilesDir, first.id) }]);
  const afterRestart = fixture("profiles");
  assert.equal((await afterRestart.login.profiles())[0].authenticated, true, "completed metadata survives restart without reading credentials");
  const interruptedMetadata = JSON.parse(metadata);
  interruptedMetadata.completed = false;
  await writeFile(path.join(f.profilesDir, first.id, "dashboard-profile.json"), JSON.stringify(interruptedMetadata));
  const interrupted = fixture("profiles");
  assert.equal((await interrupted.login.profiles())[0].authenticated, true);
  assert.equal((await interrupted.login.profileSources()).length, 1, "CLI-completed login is recovered after interrupted metadata persistence");
  f.setStatus({ loggedIn: true, authMethod: "api_key", email: "wrong-account@example.invalid" });
  assert.equal((await f.login.profiles({ refresh: true }))[0].authenticated, false, "an API key is not a Claude subscription login");
  f.setStatus({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" });
  const [second, secondDuplicate] = await Promise.all([f.login.start(), f.login.start()]);
  assert.equal(second.id, secondDuplicate.id, "concurrent starts after completion remain serialized");
  assert.notEqual(second.id, first.id);
  const loginChild = f.children.at(-1);
  await f.login.cancel();
  assert.equal(f.login.status().status, "idle");
  assert.deepEqual(loginChild.signals, ["SIGTERM"]);
  assert(!(await readdir(f.profilesDir)).includes(second.id));
  loginChild.emit("close", 0);
  await turn();
  assert.equal(completed, 1, "a cancelled process cannot report late completion");
  assert.equal(await readFile(path.join(existing, ".credentials.json"), "utf8"), "existing credentials must remain untouched");
  await assert.rejects(f.login.remove("../existing-profile"), /invalid_profile/);
  const fakeId = "11111111-2222-4333-8444-555555555555";
  if (process.platform !== "win32") {
    await symlink(existing, path.join(f.profilesDir, fakeId));
    await assert.rejects(f.login.remove(fakeId), /invalid_profile/);
  }
  f.setLogoutCode(1);
  await assert.rejects(f.login.remove(first.id), /claude_logout_failed/);
  assert((await stat(path.join(f.profilesDir, first.id))).isDirectory(), "failed Keychain logout preserves the profile for retry");
  f.setLogoutCode(0);
  await f.login.remove(first.id);
  const logout = f.calls.at(-1);
  assert.deepEqual(logout.args, ["auth", "logout"]);
  assert.equal(logout.options.env.CLAUDE_CONFIG_DIR, path.join(f.profilesDir, first.id));
  assert.equal((await f.login.profiles()).length, 0);

  const missing = fixture("missing", { resolveCli: async () => { throw new Error("private diagnostic"); } });
  assert.equal((await missing.login.start()).error, "claude_cli_unavailable");
  assert(!JSON.stringify(missing.login.status()).includes("private"));
  assert.equal(missing.calls.length, 0);

  const rejected = fixture("rejected");
  await rejected.login.start();
  rejected.setStatus({ loggedIn: false, authMethod: "none", accessToken: "never-expose" });
  rejected.children[0].emit("close", 0);
  await until(() => rejected.login.status().status === "failed");
  await until(async () => (await readdir(rejected.profilesDir)).length === 0);
  assert.equal(rejected.login.status().error, "claude_login_failed", "process exit zero alone does not confirm authentication");
  assert(!JSON.stringify(rejected.login.status()).includes("never-expose"));

  const timed = fixture("timeout", { loginTimeoutMs: 10 });
  await timed.login.start();
  await until(() => timed.login.status().status === "failed");
  assert.equal(timed.login.status().error, "claude_command_timeout");
  await until(async () => (await readdir(timed.profilesDir)).length === 0);
  assert.deepEqual(timed.children[0].signals, ["SIGTERM"]);

  const excessive = fixture("excessive-output");
  await excessive.login.start();
  excessive.children[0].stdout.emit("data", Buffer.from("x".repeat(70 * 1024)));
  await until(() => excessive.login.status().status === "failed");
  await excessive.login.cancel();
  assert.equal(excessive.login.status().status, "idle");
  assert.equal((await readdir(excessive.profilesDir)).length, 0, "cancel waits for failure cleanup");

  const unavailable = fixture("spawn-error");
  await unavailable.login.start();
  unavailable.children[0].emit("error", new Error("credential-path-and-secret-must-not-escape"));
  await until(() => unavailable.login.status().status === "failed");
  assert.equal(unavailable.login.status().error, "claude_cli_unavailable");
  assert(!JSON.stringify(unavailable.login.status()).includes("secret"));

  let releaseResolver;
  const blocked = fixture("closing", { resolveCli: () => new Promise((resolve) => { releaseResolver = resolve; }) });
  const starting = blocked.login.start();
  const closing = blocked.login.close();
  releaseResolver("claude-fixture");
  await Promise.all([starting, closing]);
  assert.equal(blocked.calls.length, 0, "shutdown while locating the CLI must not launch a process");
  assert.equal((await blocked.login.start()).status, "failed");

  let releaseProfileResolver;
  const closingProfiles = fixture("closing-profiles", {
    resolveCli: () => new Promise((resolve) => { releaseProfileResolver = resolve; })
  });
  const storedProfile = { version: 1, id: fakeId, label: "Stored profile", completed: true };
  await mkdir(path.join(closingProfiles.profilesDir, fakeId), { recursive: true });
  await writeFile(path.join(closingProfiles.profilesDir, fakeId, "dashboard-profile.json"), JSON.stringify(storedProfile));
  const profilesDuringClose = closingProfiles.login.profiles({ refresh: true });
  await until(() => releaseProfileResolver);
  await closingProfiles.login.close();
  releaseProfileResolver("claude-fixture");
  await profilesDuringClose;
  assert.equal(closingProfiles.calls.length, 0, "a deferred profile resolver must not spawn after shutdown");
  assert.deepEqual(await closingProfiles.login.profiles(), []);
  await assert.rejects(closingProfiles.login.remove(fakeId), /login_cancelled/);

  const shutdownSignals = [];
  let statusSpawned = false;
  const hangingStatus = fixture("closing-status", {
    spawnProcess() {
      statusSpawned = true;
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = (signal = "SIGTERM") => { shutdownSignals.push(signal); return true; };
      return child;
    }
  });
  await mkdir(path.join(hangingStatus.profilesDir, fakeId), { recursive: true });
  await writeFile(path.join(hangingStatus.profilesDir, fakeId, "dashboard-profile.json"), JSON.stringify(storedProfile));
  const hangingProfiles = hangingStatus.login.profiles({ refresh: true });
  await until(() => statusSpawned);
  let shutdownComplete = false;
  const statusShutdown = hangingStatus.login.close().then(() => { shutdownComplete = true; });
  await turn();
  assert.equal(shutdownComplete, false, "shutdown waits for tracked status commands to settle");
  assert.deepEqual(shutdownSignals, ["SIGTERM"]);
  let shutdownDeadline;
  try {
    await Promise.race([
      Promise.all([statusShutdown, hangingProfiles]),
      new Promise((_, reject) => { shutdownDeadline = setTimeout(() => reject(new Error("shutdown exceeded its bound")), 3000); })
    ]);
  } finally { clearTimeout(shutdownDeadline); }
  assert.deepEqual(shutdownSignals, ["SIGTERM", "SIGKILL"], "an unresponsive CLI has bounded termination");

  const closingLogin = fixture("closing-login");
  await closingLogin.login.start();
  await closingLogin.login.close();
  assert.deepEqual(closingLogin.calls.map(({ args }) => args), [["auth", "login", "--claudeai"], ["auth", "logout"]]);
  assert.equal((await readdir(closingLogin.profilesDir)).length, 0, "shutdown still completes isolated login cleanup");
} finally {
  for (const controller of controllers) await controller.close();
  await rm(tmp, { recursive: true, force: true });
}
console.log("Claude login: native CLI profile isolation, credential privacy, completion verification, cancellation, timeout and scoped logout passed.");
