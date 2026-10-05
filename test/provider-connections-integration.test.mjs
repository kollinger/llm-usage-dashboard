import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { safeMeasurement, providerAccountIdentity } = require("../lib/provider-account-store");
const { sanitizeConnections } = require("../lib/device-sync-data");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = await fsp.readFile(path.join(root, "server.js"), "utf8");
// Execute the integration functions with synthetic dependencies. Loading the
// whole server would make unrelated collectors and the real CLI available.
function serverFunction(name, context) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert(match, `missing server function ${name}`);
  const rest = source.slice(match.index + match[0].length);
  const next = /\n(?:async )?function /.exec(rest);
  assert(next, `missing function boundary after ${name}`);
  const code = source.slice(match.index, match.index + match[0].length + next.index);
  return vm.runInNewContext(`${code}\n${name};`, context);
}

let authMethod = "api_key";
const probe = serverFunction("probeClaudeAuthStatus", {
  resolveClaudeBinary: () => "fixture-cli",
  execFileAsync: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod, email: "fixture@example.invalid", orgId: "fixture-org" }) }),
  CLAUDE_AUTH_STATUS_TIMEOUT_MS: 100, extractClaudePlanType: () => null,
  parseBoolean: Boolean, firstNonEmptyString: (...values) => values.find((value) => typeof value === "string" && value) || null, crypto
});
let localClaude = await probe();
assert.equal(localClaude.authMethod, "api_key");
let claudeProfiles = [], kimiProfiles = [];
const usageCache = { value: {} };
const fixtureKey = "test-only-glm-key";
const readConnections = serverFunction("readBrowserConnections", {
  readManagedGptProfiles: async () => [], gptAccountsCache: { value: { accounts: [] } },
  claudeLogin: { profiles: async () => claudeProfiles },
  kimiLogin: { profiles: async () => kimiProfiles }, readClaudeAuthStatus: async () => localClaude,
  readClaudeProfileMeasurement: async () => ({}), usageCache, safeMeasurement, DATA_DIR: "/unused", path,
  readGlmCodingPlanAuth: async () => ({ status: "available", provider: "zai", accessToken: fixtureKey }), providerAccountIdentity
});
assert.equal((await readConnections()).length, 0, "API-key auth must not create a Claude subscription connection");
authMethod = "claude.ai"; localClaude = await probe();
const detected = (await readConnections())[0];
assert.equal(detected.provider, "claude"); assert.equal(detected.kind, "subscription");
assert(!JSON.stringify(detected).includes("fixture@example.invalid"));
assert(!JSON.stringify(detected).includes("fixture-org"));
authMethod = "unexpected-secret";
assert.equal((await probe()).authMethod, null, "unknown auth method diagnostics are not exposed");

const measuredAt = new Date().toISOString();
const limits = { rows: [{ key: "weekly", usedPercent: 15, remainingPercent: 85 }] };
claudeProfiles = [{ id: "fixture-profile", accountId: localClaude.accountId, authenticated: true }];
usageCache.value.claudeCode = { limits, limitsUpdatedAt: measuredAt };
const linked = await readConnections();
assert.equal(linked.length, 1, "the same detected and managed Claude account is shown once");
assert.equal(linked[0].limits.rows[0].usedPercent, 15, "verified matching account identity reuses available local quota");
localClaude = { ...localClaude, accountId: `claude-${"b".repeat(24)}` };
assert.equal((await readConnections()).find((account) => account.managed).limits, null, "another account's quota must not be attributed to the managed profile");
claudeProfiles = []; localClaude = { loggedIn: false };
kimiProfiles = [{ id: "fixture-kimi", status: "connected", measurement: { status: "unavailable", error: "auth_failed" } }];
let kimi = (await readConnections())[0];
assert.equal(kimi.status, "auth_required"); assert.equal(kimi.detailCode, "invalid_key");
kimiProfiles[0].measurement.error = "usage_unavailable";
kimi = (await readConnections())[0];
assert.equal(kimi.status, "connected"); assert.equal(kimi.detailCode, "limits_unavailable");
kimiProfiles = [];
usageCache.value.glm = { limits, limitsUpdatedAt: measuredAt, connectedAccountCount: 1 };
assert.equal((await readConnections()).length, 0, "a managed GLM quota cache does not become a duplicate detected account");
delete usageCache.value.glm.connectedAccountCount;
const glm = (await readConnections())[0];
assert.equal(glm.accountId, providerAccountIdentity("glm", "global", fixtureKey));
assert.equal(sanitizeConnections([glm]).length, 1, "detected GLM quota has a stable sync identity");
assert(!JSON.stringify(glm).includes(fixtureKey));

const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "llm-connections-integration-"));
try {
  const profileId = "11111111-2222-4333-8444-555555555555";
  const profileDir = path.join(temporary, "claude-profiles", profileId);
  const otherHome = path.join(temporary, "existing-claude");
  await fsp.mkdir(profileDir, { recursive: true }); await fsp.mkdir(otherHome);
  const settingsFile = path.join(profileDir, "settings.json");
  await fsp.writeFile(settingsFile, JSON.stringify({ theme: "dark", permissions: { allow: [] } }));
  const otherSettings = path.join(otherHome, "settings.json");
  await fsp.writeFile(otherSettings, "existing settings remain unchanged");
  const shellQuote = serverFunction("shellQuote", {});
  const install = serverFunction("installManagedClaudeStatusline", { DATA_DIR: temporary, ROOT: root, fsp, path, process, Buffer, shellQuote });
  await install(profileId);
  const settings = JSON.parse(await fsp.readFile(settingsFile, "utf8"));
  assert.equal(settings.theme, "dark"); assert.deepEqual(settings.permissions, { allow: [] });
  assert.equal(settings.statusLine.type, "command");
  const capture = path.join(profileDir, "llm-usage-statusline-capture.js");
  assert(process.platform === "win32" ? Buffer.from(settings.statusLine.command.split(" ").at(-1), "base64").toString("utf16le").includes(capture) : settings.statusLine.command.includes(capture));
  const result = spawnSync(process.execPath, [capture], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: profileDir, CLAUDE_HOME: otherHome }, encoding: "utf8",
    input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: Math.floor(Date.now() / 1000) + 3600 } }, transcript_path: "private transcript", session_id: "private session" })
  });
  assert.equal(result.status, 0);
  const captured = await fsp.readFile(path.join(profileDir, "usage-dashboard-statusline.json"), "utf8");
  assert.equal(JSON.parse(captured).rate_limits.five_hour.used_percentage, 12);
  assert(!captured.includes("private"));
  await assert.rejects(fsp.readFile(path.join(otherHome, "usage-dashboard-statusline.json")), { code: "ENOENT" });
  assert.equal(await fsp.readFile(otherSettings, "utf8"), "existing settings remain unchanged");
  if (process.platform !== "win32") assert.equal((await fsp.stat(settingsFile)).mode & 0o777, 0o600);
  await fsp.writeFile(settingsFile, "{}");
  const installWindows = serverFunction("installManagedClaudeStatusline", { DATA_DIR: temporary, ROOT: root, fsp, path, Buffer, shellQuote,
    process: { platform: "win32", execPath: "C:\\Program Files\\Dashboard\\Dashboard.exe", versions: { electron: "test" } } });
  await installWindows(profileId);
  const windowsCommand = JSON.parse(await fsp.readFile(settingsFile, "utf8")).statusLine.command;
  assert(windowsCommand.startsWith("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand "));
  const decoded = Buffer.from(windowsCommand.split(" ").at(-1), "base64").toString("utf16le");
  assert(decoded.includes("$env:ELECTRON_RUN_AS_NODE='1'; $input | & "));
  assert(decoded.includes("Program Files")); assert(decoded.includes(capture));
  const customSettings = JSON.stringify({ theme: "light", statusLine: { type: "command", command: "existing-user-hook" } });
  await fsp.writeFile(settingsFile, customSettings);
  await install(profileId);
  assert.equal(await fsp.readFile(settingsFile, "utf8"), customSettings, "existing profile statusline hooks are preserved");
} finally { await fsp.rm(temporary, { recursive: true, force: true }); }
console.log("Provider integration: auth classifications, quota identity, GLM sync and isolated Claude capture passed.");
