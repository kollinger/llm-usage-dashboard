import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, utimes, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import vm from "node:vm";
import { readDashboardSource } from "./fixtures/dashboard-source.mjs";
process.env.CODEX_LIVE_RATE_LIMITS = "false";
process.env.TZ = "Europe/Vienna";
const require = createRequire(import.meta.url);
const { normalizeManualResets, claudeManualResets, readClaudeDesktopResets, decodeCacheEntry } = require("../lib/manual-resets");
const { _test } = require("../server");
const now = Date.parse("2026-10-22T09:00:00Z"), at = new Date(now).toISOString();
const org = "11111111-2222-4333-8444-555555555555";
const block = { eligible: true, secret: "must-not-survive", grants: [{ id: "private-grant", resets_left: 1,
  starts_at: "2026-09-22T16:00:00Z", ends_at: "2026-10-22T16:00:00Z", usable_now: true, paused: false,
  clears: ["five_hour", "seven_day"], accessToken: "must-not-survive" }] };
const resets = claudeManualResets(block, at);
assert.equal(resets.offers[0].expiresAt, "2026-10-22T16:00:00.000Z");
assert.equal(resets.offers[0].scope, "full");
assert.equal(resets.offers[0].remaining, 1);
assert(!JSON.stringify(resets).includes("private-grant"));
assert(!JSON.stringify(resets).includes("must-not-survive"));
assert.equal(claudeManualResets(null, at), null);
assert.equal(claudeManualResets({}, at), null);
assert.equal(claudeManualResets({ eligible: true, grants: [] }, at).offers.length, 0);
assert.equal(normalizeManualResets({ status: "available", offers: [{ remaining: "1" }] }).offers.length, 0);
assert.equal(claudeManualResets({ ...block, grants: [{ ...block.grants[0], clears: ["unknown"] }] }, at).offers.length, 0);

function cacheEntry(organization, compression = "plain") {
  const key = Buffer.from(`1/0/https://claude.ai/api/organizations/${organization}/usage?cedar_ember=1&skip_spend=1`);
  const header = Buffer.alloc(24); header.writeBigUInt64LE(0xfcfb6d1ba7725c30n); header.writeUInt32LE(5, 8); header.writeUInt32LE(key.length, 12);
  let body = Buffer.from(JSON.stringify({ cedar_ember: block, sessionKey: "never-export-this" }));
  if (compression === "zstd") body = zlib.zstdCompressSync(body);
  if (compression === "gzip") body = zlib.gzipSync(body);
  return Buffer.concat([header, key, body, Buffer.from("d8410d97456ffaf4", "hex"), Buffer.alloc(16)]);
}
for (const compression of ["plain", "gzip", ...(zlib.zstdCompressSync ? ["zstd"] : [])]) {
  const entry = cacheEntry(org, compression);
  assert.equal(decodeCacheEntry(entry, org).cedar_ember.grants[0].resets_left, 1);
  assert.equal(decodeCacheEntry(entry, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), null);
}
assert.equal(decodeCacheEntry(Buffer.from("not a cache"), org), null);
const directory = await mkdtemp(path.join(os.tmpdir(), "manual-resets-"));
try {
  const file = path.join(directory, "123456789abcdef0_0");
  await writeFile(file, cacheEntry(org, zlib.zstdCompressSync ? "zstd" : "gzip"));
  await utimes(file, now / 1000, now / 1000);
  const cached = readClaudeDesktopResets({ orgId: org, cacheDir: directory, now });
  assert.equal(cached.source, "claude_desktop_cache");
  assert.equal(cached.updatedAt, at);
  assert.equal(cached.offers[0].remaining, 1);
  assert.equal(readClaudeDesktopResets({ orgId: "wrong-account", cacheDir: directory, now }), null);
  assert.equal(readClaudeDesktopResets({ orgId: org, cacheDir: directory, now: now + 25 * 3600_000 }), null);
  assert.equal(readClaudeDesktopResets({ orgId: org, platform: "unsupported", home: directory, now }), null);
  const usage = _test.normalizeClaudeApiUsagePayload({ seven_day: { utilization: 20, resets_at: "2026-10-25T00:00:00Z" }, cedar_ember: block });
  assert.equal(usage.manualResets.offers[0].remaining, 1);
  assert.equal(usage.cedar_ember, undefined);
  usage.updatedAt = at; usage.manualResets.updatedAt = at;
  const probe = { status: "available", source: "claude_app_cookie", updatedAt: at, usage, manualResets: resets };
  const snapshotFile = path.join(directory, "snapshot.json");
  await _test.saveClaudeUsageSnapshot(probe, snapshotFile);
  const restored = await _test.readClaudeUsageSnapshot(snapshotFile, now);
  assert.equal(restored.manualResets.updatedAt, at, "normalization must preserve reset observation time");
  assert.equal(restored.manualResets.offers[0].expiresAt, resets.offers[0].expiresAt);
  const incoming = { status: "unavailable", usage: null, manualResets: claudeManualResets({ eligible: true, grants: [] }, at) };
  assert.equal(_test.retainLastKnownClaudeUsageProbe(probe, incoming, now).manualResets.offers.length, 0, "a newer empty reset response must clear a redeemed offer");
  let requestedOrg;
  const oauth = await _test.fetchClaudeUsageProbe({ oauthSession: { status: "available", accessToken: "test-token", orgId: org },
    fetchWithAuth: async () => ({ status: "available", usage: { seven_day: { utilization: 20 } } }),
    readDesktopResets: (options) => { requestedOrg = options.orgId; return resets; } });
  assert.equal(requestedOrg, org);
  assert.equal(oauth.manualResets.offers[0].remaining, 1);
} finally { await rm(directory, { recursive: true, force: true }); }

// Exercise the real renderer and all locale placeholders without starting a server.
const source = (await readDashboardSource()).replace("\ninit();", "\n// bootstrap disabled");
const fixture = await readFile(new URL("./provider-recency.test.mjs", import.meta.url), "utf8");
const contextFactory = fixture.slice(fixture.indexOf("function createAppContext()"));
const context = vm.runInNewContext(`(${contextFactory})()`, { console, setTimeout, clearTimeout, URLSearchParams, Intl, Date });
const en = JSON.parse(await readFile(new URL("../public/i18n/en.json", import.meta.url)));
const de = JSON.parse(await readFile(new URL("../public/i18n/de.json", import.meta.url)));
vm.createContext(context);
vm.runInContext(source, context);
const render = (provider, time = now) => {
  context.input = provider; context.testNow = time;
  return vm.runInContext(`state.translations = ${JSON.stringify(de)}; state.fallbackTranslations = ${JSON.stringify(en)}; state.language = "de"; renderManualResets(input, testNow)`, context);
};
let html = render({ id: "claudeCode", manualResets: resets });
assert.match(html, /Vollständiger Reset/);
assert.match(html, /18:00/, "expiry must include the local time");
assert.match(html, /22.10.2026/);
assert.match(html, /claude.ai\/settings\/usage/);
assert(!html.includes("private-grant"));
assert.match(render({ id: "codex", manualResets: resets }), /18:00/, "the card supports other providers with reported reset offers");
assert.match(render({ id: "claudeCode" }), /keine verfügbaren Reset-Angebote/);
assert.match(render({ id: "claudeCode", manualResets: { ...resets, offers: [] } }), /Keine gespeicherten Resets/);
html = render({ id: "claudeCode", manualResets: resets }, Date.parse("2026-10-22T16:00:00Z"));
assert.match(html, /Abgelaufen/);
assert(!html.includes("Noch "));
assert.match(render({ id: "claudeCode", manualResets: { ...resets, source: "claude_desktop_cache" } }), /Gespeicherter Stand/);
const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join(",");
for (const file of await readdir(new URL("../public/i18n/", import.meta.url))) {
  if (!file.endsWith(".json")) continue;
  const locale = JSON.parse(await readFile(new URL(`../public/i18n/${file}`, import.meta.url)));
  assert.deepEqual(Object.keys(locale.manualResets).sort(), Object.keys(en.manualResets).sort(), file);
  for (const key of Object.keys(en.manualResets)) assert.equal(placeholders(locale.manualResets[key]), placeholders(en.manualResets[key]), `${file}:${key}`);
}
console.log("Manual resets: account scope, private fields, compressed desktop caches, expiry, persistence, generic cards and locale placeholders passed.");
