import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTimedCache, readThroughCache } = require("../server");
const registryApi = require("../lib/gpt-account-registry");
const { mergeGptQuotaLimits } = require("../lib/gpt-account-quota");
const { assessQuotaPace, gptAccountQuotaPaceEvents, mergeQuotaPaceSamples } = require("../lib/quota-pace");
const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
const code = (name) => {
  const definition = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"))?.[0];
  assert(definition, name);
  return definition;
};
const within = async (promise, message, delay = 3000) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), delay);
    })]);
  } finally { clearTimeout(timer); }
};

const now = Date.now();
const iso = (offset) => new Date(now + offset).toISOString();
const workspace = "synthetic-codex-account";
const other = "synthetic-other-account";
const home = "synthetic-codex-profile";
const measure = (accountId, minutes, usedPercent, sourceRef = home) => registryApi.createGptAccountObservation({
  sourceId: "codex", sourceRef, accountId, email: "same@example.test", quotaStatus: "ready",
  seenAt: iso(minutes * 60_000), limitsUpdatedAt: iso(minutes * 60_000), quotaCheckedAt: iso(minutes * 60_000),
  limits: { rows: [
    { key: "weekly", windowMinutes: 10080, usedPercent, resetsAt: iso(3 * 86400_000) },
    ...(minutes === -360 ? [{ key: "fiveHour", windowMinutes: 300, usedPercent: 7, resetsAt: iso(3_600_000) }] : [])
  ] }
});
const old = measure(workspace, -360, 18);
const fresh = measure(workspace, 0, 28);
const registry = registryApi.publicGptAccountRegistry(registryApi.mergeGptAccountRegistry(null,
  [old, measure(other, -360, 42, "another-codex-profile")], { scannedAt: old.seenAt }));
const cache = {
  ...createTimedCache(), value: { generatedAt: old.seenAt, gptAccounts: registry },
  pending: new Promise(() => {}), pendingGeneration: 0,
  quotaPaceSamples: mergeQuotaPaceSamples([], gptAccountQuotaPaceEvents(registryApi.mergeGptAccountRegistry(null,
    [measure(workspace, -120, 22)]), now - 120 * 60_000), now)
};
let profileObservation = fresh;
let tick;
const history = [];
const context = vm.createContext({
  ...registryApi, mergeGptQuotaLimits, DATA_DIR: "synthetic-data", CODEX_HOMES: [home], CODEX_ACCOUNT_PROFILES_DIR: "synthetic-profiles",
  CODEX_LIVE_RATE_LIMITS_ENABLED: true, CODEX_LIVE_RATE_LIMITS_CACHE_MS: 15_000, USAGE_CACHE_MS: 60_000,
  codexLiveRateLimitsCache: createTimedCache(), gptAccountsCache: createTimedCache(),
  usageCache: cache, path: { join: (...parts) => parts.join("/") },
  getCodexAppServer: async () => ({}), readScopedCodexLiveRateLimits: async () => ({
    notificationSnapshot: { windows: [{}] }, historySnapshot: { at: fresh.seenAt }
  }),
  recordCodexResetSnapshot: async (sample) => { history.push(sample); },
  readCodexProfileGptAccountObservation: async () => profileObservation,
  readGptAccountRegistry: async () => registry, uniquePaths: (paths) => paths, defaultCodexAccountHomes: () => [],
  codexResetProfileAccounts: new Map(), primaryCodexResetAccountKey: null,
  updateQuotaPace: async (_, accounts) => {
    cache.quotaPaceSamples = mergeQuotaPaceSamples(cache.quotaPaceSamples, gptAccountQuotaPaceEvents(accounts, now), now);
  },
  assessQuotaPace, readThroughCache,
  readCurrentClaudeQuota: async () => null, applyCodexCreditExpiry: (value) => value,
  overlayRestoredClaudeQuota: (value) => value, overlayCurrentClaudeQuota: (value) => value,
  overlayCurrentCodexQuota: (value) => value,
  setTimeout(fn) { tick = fn; return {}; }, setInterval() { return {}; }, clearTimeout() {}, clearInterval() {}
});
const functions = ["readUsageDashboard", "startCodexResetCollector", "overlayCurrentCodexAccounts", "readCurrentCodexAccounts"];
vm.runInContext(`const codexProfileQuotas = new Map();\n${functions.filter((name) => source.includes(`function ${name}(`)).map(code).join("\n")}`, context);
const stop = context.startCodexResetCollector();
const readUsage = () => within(context.readUsageDashboard({ staleWhileRefresh: true }), "quota waited behind history");
const rowsFor = (usage, id) => usage.gptAccounts.accounts.find((account) => account.id === id).sources[0].limits.rows;
const rowFor = (usage, id) => rowsFor(usage, id).find((row) => row.key === "weekly");
assert.equal(rowFor(await readUsage(), old.id).usedPercent, 18, "before a new measurement, keep the saved value");
await tick();
const usage = await readUsage();
assert.equal(history.length, 1);
assert.equal(usage.cache.refreshing, true);
assert.equal(rowFor(usage, old.id).usedPercent, 28, "minute collector must update the card while history is blocked");
assert.equal(usage.gptAccounts.accounts.find((account) => account.id === old.id).sources[0].limitsUpdatedAt,
  fresh.limitsUpdatedAt, "the actual provider observation time is preserved");
assert.equal(rowFor(usage, old.id).updatedAt, fresh.limitsUpdatedAt);
assert.equal(rowsFor(usage, old.id).find((row) => row.key === "fiveHour").updatedAt, old.limitsUpdatedAt,
  "an omitted quota window must retain its old measurement time");
assert.equal(rowFor(usage, measure(other, 0, 0).id).usedPercent, 42, "no other workspace inherits quota");
assert.equal(usage.quotaPace[old.id]?.weekly?.[120]?.deltaPercent, 6, "recent pace uses the same confirmed account sample");
profileObservation = measure(workspace, 0, 99, "unregistered-profile");
await tick();
assert.equal(rowFor(await readUsage(), old.id).usedPercent, 18, "unregistered profile cannot update the active account");
profileObservation = measure(workspace, -16, 99);
await tick();
assert.equal(rowFor(await readUsage(), old.id).usedPercent, 18, "an old poll cannot masquerade as a current measurement");
stop();

const children = [];
const clientContext = vm.createContext({
  CODEX_APP_SERVER_TIMEOUT_MS: 1500,
  CODEX_APP_SERVER_IDLE_SHUTDOWN_MS: 30 * 60_000,
  CODEX_HOME: home, codexLiveRateLimitsCache: createTimedCache(),
  process, path: { resolve: (p) => p }, resolveCodexBinary: () => process.execPath,
  setTimeout, clearTimeout, setInterval, clearInterval,
  spawn(binary, _args, options) {
    const proc = spawn(binary, ["-e", `
      const readline = require("node:readline");
      process.on("SIGTERM", () => {});
      const input = readline.createInterface({ input: process.stdin });
      input.on("line", (line) => {
        const m = JSON.parse(line);
        if (m.method === "initialize") console.log(JSON.stringify({ id: m.id, result: {} }));
      });
      input.on("close", () => process.exit(0));
    `], options);
    children.push({ proc, exit: new Promise((resolve) => proc.once("exit", resolve)) });
    return proc;
  }
});
vm.runInContext(`let codexAppServer = null, codexAppServerPending = null, codexAppServerLastUseAt = 0;\n${[
  "createCodexAppServer", "getCodexAppServer", "openResidentCodexAppServer"
].filter((name) => source.includes(`function ${name}(`)).map(code).join("\n")}`, clientContext);
try {
  const [one, two] = await Promise.all([clientContext.getCodexAppServer(), clientContext.getCodexAppServer()]);
  assert.equal(children.length, 1, "concurrent consumers must share the same starting app-server");
  assert.equal(one, two);
  const pending = assert.rejects(one.request("pending"), /closing/);
  one.close();
  await pending;
  assert.equal(await within(children[0].exit, "child did not close on EOF"), 0);
  const next = await clientContext.getCodexAppServer();
  assert.notEqual(next, one, "a subsequent probe can start a fresh app-server");
  next.close();
  assert.equal(await within(children[1].exit, "second child did not close on EOF"), 0);
} finally {
  for (const { proc, exit } of children) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await exit;
  }
}
console.log("Codex quota collector: fresh account and pace during blocked history, identity and age guards, and child lifecycle passed");
