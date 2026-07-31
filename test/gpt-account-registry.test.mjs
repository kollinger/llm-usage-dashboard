import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.env.CODEX_LIVE_RATE_LIMITS = "false";

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
const tmp = await mkdtemp(path.join(os.tmpdir(), "gpt-account-registry-"));

try {
  await assertPrivateAccountRegistry(tmp);
  await assertOpenCodeGptUsage(tmp);
  await assertFrontendContract();
} finally {
  await rm(tmp, { recursive: true, force: true });
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
    planType: "pro",
    seenAt: "2026-07-31T08:01:00.000Z",
    usage: { summary: { lifetimeTokens: 123456 } },
    limits: { rows: [{ key: "fiveHour", label: "5h Codex limit", usedPercent: 25, remainingPercent: 75 }] },
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
  assert.equal(registry.accounts.length, 1, "the same email must merge across Codex and OpenCode");
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
  assert.equal(publicRegistry.accounts.find((account) => account.label.endsWith(".com"))?.active, false);
  assert.equal(publicRegistry.accounts.find((account) => account.label.endsWith(".net"))?.active, true);
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
}

async function assertFrontendContract() {
  const html = await readFile(path.join(rootDir, "public", "index.html"), "utf8");
  const app = await readFile(path.join(rootDir, "public", "app.js"), "utf8");
  assert.match(html, /id="gptAccountsRecheckBtn"/);
  assert.match(html, /data-dashboard-panel-id="gpt-accounts"/);
  assert.match(app, /\/api\/gpt-accounts\/recheck/);
  assert.match(app, /normalizeLocalProvider\("openCode", usage\.openCode\)/);

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
