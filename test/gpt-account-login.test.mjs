import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createGptAccountLogin } = require("../lib/gpt-account-login");
const tmp = await mkdtemp(path.join(os.tmpdir(), "llm-login-"));
let clientOptions, completed = 0;
try {
  const existing = path.join(tmp, "existing", "auth.json");
  await mkdir(path.dirname(existing)); await writeFile(existing, "DO_NOT_REPLACE");
  const login = createGptAccountLogin({ profilesDir: path.join(tmp, "profiles"), clientFactory: async (options) => {
    clientOptions = options;
    return { request: async (method) => method === "account/login/start" ? { loginId: "test", authUrl: "https://auth.openai.com/authorize?state=test" } : {}, close() {} };
  }, onComplete: async () => { completed += 1; } });
  const [first, concurrent] = await Promise.all([login.start(), login.start()]);
  assert.equal(first.id, concurrent.id, "concurrent starts own one profile");
  assert.equal(first.status, "waiting");
  assert(!JSON.stringify(first).includes(tmp));
  assert.equal((await login.start()).id, first.id, "duplicate clicks cannot create concurrent login profiles");
  assert((await readFile(path.join(clientOptions.codexHome, "config.toml"), "utf8")).includes('cli_auth_credentials_store = "file"'));
  await clientOptions.onNotification({ method: "account/login/completed", params: { success: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(login.status().status, "complete"); assert.equal(completed, 1);
  assert.equal(login.status().authUrl, null);
  const second = await login.start(); assert.notEqual(second.id, first.id);
  await login.cancel(); assert.equal(login.status().status, "idle");
  assert.equal(await readFile(existing, "utf8"), "DO_NOT_REPLACE");
  login.close();
  const missing = createGptAccountLogin({ profilesDir: path.join(tmp, "missing"), clientFactory: async () => { throw new Error("secret diagnostic"); } });
  assert.equal((await missing.start()).error, "codex_login_unavailable");
  assert(!JSON.stringify(missing.status()).includes("secret"));
} finally { await rm(tmp, { recursive: true, force: true }); }
console.log("GPT login: isolated profiles, completion, cancellation, missing CLI and credential privacy passed.");
