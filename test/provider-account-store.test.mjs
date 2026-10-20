import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createProviderAccountStore } = require("../lib/provider-account-store");
const { readAdminAccountUsage } = require("../lib/admin-account-usage");
const { readMoonshotBalance } = require("../lib/kimi-accounts");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "llm-account-store-"));
const secret = "test-only-secret-never-returned";
let instant = Date.now(), unavailable = false;
const reader = async () => unavailable ? { authenticated: false, error: "invalid_key" } : {
  authenticated: true, updatedAt: new Date(instant).toISOString(), balance: 0, currency: "USD", tokenTotal: 123,
  limits: { rows: [{ key: "weekly", usedPercent: 0, remainingPercent: 100, windowMinutes: 10080 }] },
  apiKey: secret, raw: { password: secret }, prompt: "private prompt"
};
const readers = { kimi: reader, glm: reader, moonshot: async () => {
  const result = await readMoonshotBalance(secret, { fetch: async () => new Response(JSON.stringify({ code: 0, data: { available_balance: 12.5, cash_balance: 10, voucher_balance: 2.5 } })) });
  return { ...result, balance: result.balance?.available, currency: result.balance?.currency };
} };
const make = () => createProviderAccountStore({ dataDir: temporary, readers, now: () => instant });
try {
  const store = make();
  const first = await store.add({ provider: "kimi", apiKey: secret, label: "Personal" });
  assert.equal(first.balance, 0); assert.equal(first.limits.rows[0].usedPercent, 0);
  assert(!JSON.stringify(first).includes(secret)); assert(!JSON.stringify(first).includes("private prompt"));
  const same = await store.add({ provider: "kimi", apiKey: secret, label: "Renamed" });
  assert.equal(first.id, same.id); assert.equal((await store.list()).length, 1);
  const other = await store.add({ provider: "glm", apiKey: secret, label: "Other provider" });
  assert.notEqual(first.accountId, other.accountId);
  const moonshot = await store.add({ provider: "moonshot", apiKey: secret });
  assert.equal(moonshot.balance, 12.5); assert.equal(moonshot.currency, "USD");
  const file = path.join(temporary, "provider-accounts", "accounts.enc");
  const ciphertext = await fs.readFile(file);
  assert(!ciphertext.includes(Buffer.from(secret))); assert(!ciphertext.includes(Buffer.from("Renamed")));
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await make().list(), await store.list());
  unavailable = true; instant += 120000;
  const stale = (await store.refresh()).find(item => item.id === first.id);
  assert.equal(stale.status, "unavailable"); assert.equal(stale.balance, 0);
  assert.equal(stale.updatedAt, first.updatedAt, "a failed refresh retains the actual measurement timestamp");
  unavailable = false;
  const rename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error("test disk full"), { code: "ENOSPC" }); };
  try {
    const before = await store.list();
    await assert.rejects(store.add({ provider: "kimi", apiKey: "another-test-only-secret" }));
    assert.deepEqual(await store.list(), before, "a failed save must not invent a live account");
    await assert.rejects(store.remove(first.id));
    assert.deepEqual(await store.list(), before, "a failed removal must remain visible");
  } finally { fs.rename = rename; }
  await store.remove(first.id);
  assert(!(await make().list()).some(item => item.id === first.id));
  await assert.rejects(store.remove("../../unrelated"), /invalid_account/);
  await assert.rejects(store.add({ provider: "__proto__", apiKey: secret }), /invalid_account/);
  const damaged = await fs.readFile(file); damaged[damaged.length - 1] ^= 1; await fs.writeFile(file, damaged);
  await assert.rejects(make().list(), /account_storage_unavailable/);
  assert.deepEqual(await fs.readFile(file), damaged, "corruption is not overwritten as an empty store");

  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    assert(!String(url).includes(secret));
    if (url.pathname.includes("cost")) return new Response(JSON.stringify({ data: [{ results: [{ amount: "125", currency: "USD" }] }], has_more: false }));
    return new Response(JSON.stringify({ data: [{ results: [{ uncached_input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 50 } }] }], has_more: !url.searchParams.has("page"), next_page: "second-page" }));
  };
  const usage = await readAdminAccountUsage("anthropic", secret, { fetchImpl, now: instant });
  assert.equal(usage.authenticated, true); assert.equal(usage.tokenTotal, 480); assert.equal(usage.costTotal, 1.25);
  assert.equal(requests.length, 3); assert.equal(usage.periodDays, 7);
  const denied = await readAdminAccountUsage("openai", secret, { fetchImpl: async () => new Response("denied", { status: 403 }) });
  assert.deepEqual(denied, { authenticated: false, error: "permission_denied" });
  const zero = await readAdminAccountUsage("openai", secret, { fetchImpl: async () => new Response(JSON.stringify({ data: [], has_more: false })) });
  assert.equal(zero.tokenTotal, 0); assert.equal(zero.costTotal, 0);
  const invalid = await readAdminAccountUsage("openai", secret, { fetchImpl: async () => new Response(JSON.stringify({ message: "unexpected" })) });
  assert.equal(invalid.authenticated, false);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
console.log("Provider accounts: encrypted persistence, atomic failures, private public fields, real zero, pagination and API units passed.");
