import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildDesktopWidgetSnapshot } = require("../lib/desktop-widget");
const { createGptAccountObservation, mergeGptAccountRegistry, normalizeGptAccountRegistry,
  readGptAccountRegistry, writeGptAccountRegistry, codexAccountObservationsFromAuth, openCodeAccountObservationsFromAuth } = require("../lib/gpt-account-registry");
const { mergeGptQuotaLimits } = require("../lib/gpt-account-quota");
const { gptDuplicateUsageFixture } = require("./fixtures/gpt-duplicate.cjs");
const { sanitizeAccounts, combinedUsage } = require("../lib/device-sync-data");
const now = Date.now();
const at = (minutes) => new Date(now + minutes * 60_000).toISOString();
const fixture = gptDuplicateUsageFixture(now);
const snapshot = buildDesktopWidgetSnapshot(fixture, now);
assert.equal(snapshot.accounts.length, 2, "provider ID and opaque registry ID identify one account across profiles");
const shared = snapshot.accounts.find((account) => account.sources.length === 2);
assert.deepEqual(shared.windows.map((row) => row.remainingPercent), [0, 40, null], "select the newest valid reading independently for each window");
assert.deepEqual(shared.windows.map((row) => row.status), ["current", "current", "unavailable"]);
assert.equal(shared.aliases.length, 1, "a former raw-ID widget handle remains a safe favorite alias");
assert(snapshot.accounts.every((account) => account.labelIndex), "different IDs retain separate same-name workspace rows");
assert(!JSON.stringify(snapshot).includes("synthetic-shared-workspace"));
assert(!JSON.stringify(snapshot).includes("same@example.test"));
const alternate = structuredClone(fixture);
alternate.gptAccounts.accounts.push({ ...alternate.gptAccounts.accounts[0], id: `gpt-${"c".repeat(16)}`, accountId: "synthetic-shared-workspace" });
assert.equal(buildDesktopWidgetSnapshot(alternate, now).accounts.length, 2, "a second registry handle with the same explicit provider identity coalesces too");
const unresolved = structuredClone(fixture);
unresolved.connectedAccounts.push({ id: "synthetic-unverified-profile", provider: "gpt", label: "Shared synthetic label" });
assert.equal(buildDesktopWidgetSnapshot(unresolved, now).accounts.length, 3, "a label cannot join an unresolved profile to a verified account");
const conflict = structuredClone(fixture);
conflict.gptAccounts.accounts[1] = { ...conflict.gptAccounts.accounts[1], id: conflict.gptAccounts.accounts[0].id, accountId: "synthetic-separate-workspace" };
const conflicted = buildDesktopWidgetSnapshot(conflict, now);
assert.equal(conflicted.accounts.length, 2);
assert.equal(conflicted.accounts.find((account) => account.windows[0].remainingPercent === 65).aliases, undefined, "an ambiguous former handle cannot claim another workspace's favorite");
for (let cycle = 0; cycle < 3; cycle++) {
  fixture.gptAccounts.accounts[0].sources.reverse();
  fixture.connectedAccounts.reverse();
  assert.deepEqual(buildDesktopWidgetSnapshot(fixture, now), snapshot, "source/profile order cannot change selection, identity or favorites");
}

const model = vm.createContext({});
vm.runInContext((await fs.readFile(new URL("../plasma/contents/code/ViewModel.js", import.meta.url), "utf8")).replace(/^\.pragma library\s*/, ""), model);
assert.equal(model.accounts(snapshot, "gpt", "all", []).length, 2);
for (const handle of [shared.id, shared.aliases[0]]) {
  assert.equal(model.accounts(snapshot, "gpt", "favorites", [handle]).length, 1);
  assert.equal(model.favorite(shared, [handle]), true);
  assert.equal(model.toggleFavorite(shared, [handle]).length, 0, "unfavorite removes the mapped alias too");
  const mapped = model.canonicalFavorites(snapshot, [handle]);
  assert.equal(mapped[0], shared.id);
  assert.equal(model.accounts({ accounts: [{ ...shared, aliases: [] }] }, "all", "favorites", mapped).length, 1, "persisted canonical favorites survive disappearance of the former representation");
}
assert.equal(model.remaining(shared.windows[0]), 0);
assert.equal(model.remaining(shared.windows[2]), null);
assert.equal(model.stale(shared.windows[0], snapshot, false, now), false);

const rawId = "synthetic-measurement-workspace";
const observe = ({ sourceId = "codex", profile = "profile-a", checked = 0, measured = -1, remaining = 0, rows } = {}) => createGptAccountObservation({
  sourceId, sourceRef: profile, accountId: rawId, email: "same@example.test", seenAt: at(checked), quotaCheckedAt: at(checked),
  limitsUpdatedAt: at(measured), quotaStatus: "ready", limits: { rows: rows || [
    { key: "fiveHour", windowMinutes: 300, remainingPercent: remaining, resetsAt: at(120) }
  ] }
});
const fresh = observe({ checked: -2 });
const old = observe({ profile: "profile-b", measured: -30, remaining: 88 });
for (const observations of [[old, fresh], [fresh, old]]) {
  const registry = mergeGptAccountRegistry(null, observations, { scannedAt: at(0) });
  assert.equal(registry.accounts.length, 1);
  assert.equal(registry.accounts[0].sources[0].limits.rows[0].remainingPercent, 0, "probe completion order cannot replace a newer measurement");
  assert.equal(registry.accounts[0].sources[0].profileRefs.length, 2);
}
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-dedupe-"));
try {
  let registry = mergeGptAccountRegistry(null, [fresh, observe({ profile: "weekly-profile", measured: -30, rows: [
    { key: "weekly", windowMinutes: 10080, remainingPercent: 25, resetsAt: at(120) }
  ] })], { scannedAt: at(0) });
  const id = buildDesktopWidgetSnapshot({ gptAccounts: registry }, now).accounts[0].id;
  for (let scan = 0; scan < 3; scan++) {
    await writeGptAccountRegistry(temporary, registry);
    registry = mergeGptAccountRegistry(await readGptAccountRegistry(temporary), [old], { scannedAt: at(scan) });
    const account = buildDesktopWidgetSnapshot({ gptAccounts: registry }, now).accounts[0];
    assert.equal(account.id, id, "opaque favorite handles survive persisted registry reloads and repeat scans");
    assert.deepEqual(account.windows.map((row) => row.remainingPercent), [0, 25]);
    assert.deepEqual(account.windows.map((row) => row.status), ["current", "stale"], "a partial scan cannot relabel an old window as newly measured");
    assert.equal(account.windows[1].measuredAt, at(-30));
  }
  const failed = { ...fresh, limits: null, quotaStatus: "unavailable", quotaReason: "request_failed", seenAt: at(1), quotaCheckedAt: at(1) };
  registry = mergeGptAccountRegistry(registry, [failed], { scannedAt: at(1) });
  const saved = buildDesktopWidgetSnapshot({ gptAccounts: registry }, now).accounts[0];
  assert.equal(saved.id, id);
  assert.deepEqual(saved.windows.map((row) => row.remainingPercent), [0, 25]);
  assert(saved.windows.every((row) => row.status === "stale"));
  const duplicated = normalizeGptAccountRegistry({ accounts: [...registry.accounts, ...mergeGptAccountRegistry(null, [old]).accounts] });
  assert.equal(duplicated.accounts.length, 1, "duplicate persisted account records are coalesced by exact ID");
  assert.equal(duplicated.accounts[0].sources.length, 1);
  assert.equal(duplicated.accounts[0].sources[0].limits.rows[0].remainingPercent, 0);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }

for (const invalid of [null, undefined, false, "0", -1, 101, NaN, Infinity]) {
  const observation = observe({ rows: [{ key: "fiveHour", windowMinutes: 300, remainingPercent: invalid, resetsAt: at(120) }] });
  const account = buildDesktopWidgetSnapshot({ gptAccounts: mergeGptAccountRegistry(null, [observation]) }, now).accounts[0];
  assert.equal(account.windows[0].remainingPercent, null);
  assert.equal(account.windows[0].status, "unavailable");
}
for (const invalidRow of [
  { remainingPercent: 99, updatedAt: at(2) },
  { remainingPercent: 99, updatedAt: null },
  { remainingPercent: 99, updatedAt: at(0), resetsAt: at(-1) },
  { remainingPercent: null, updatedAt: at(0) }
]) {
  const newerInvalid = observe({ rows: [{ key: "fiveHour", windowMinutes: 300, resetsAt: at(120), ...invalidRow }] });
  const registry = mergeGptAccountRegistry(null, [fresh, newerInvalid]);
  assert.equal(buildDesktopWidgetSnapshot({ gptAccounts: registry }, now).accounts[0].windows[0].remainingPercent, 0, "future, expired, undated or missing values cannot replace a valid quota");
}

// Trace both collectors from the same synthetic provider claims. Same email is
// deliberately shared by a second workspace, so it cannot become a join key.
const jwt = (claims) => `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const auth = (id) => jwt({ email: "same@example.test", "https://api.openai.com/auth": { chatgpt_account_id: id } });
const codex = codexAccountObservationsFromAuth({ tokens: { account_id: rawId, id_token: auth(rawId) } });
const openCode = openCodeAccountObservationsFromAuth({ accounts: [
  { type: "oauth", access: auth(rawId) }, { type: "oauth", access: auth("synthetic-another-workspace") }
] });
assert.equal(codex[0].id, openCode[0].id);
assert.equal(mergeGptAccountRegistry(null, [...codex, ...openCode]).accounts.length, 2);

const registryId = fresh.id;
const remoteSource = (rows, updatedAt) => ({ id: "codex", active: true, quotaStatus: "ready", limitsUpdatedAt: updatedAt, limits: { rows } });
const remoteSnapshots = [
  { device: { id: "a".repeat(32), name: "Synthetic A" }, capturedAt: at(0), events: [], accounts: [
    { id: registryId, sources: [remoteSource([
      { key: "fiveHour", windowMinutes: 300, remainingPercent: 0, updatedAt: at(-1) },
      { key: "weekly", windowMinutes: 10080, remainingPercent: 90, updatedAt: at(-30) }
    ], at(-1))] }
  ] },
  { device: { id: "b".repeat(32), name: "Synthetic B" }, capturedAt: at(0), events: [], accounts: [
    { id: registryId, sources: [remoteSource([
      { key: "fiveHour", windowMinutes: 300, remainingPercent: 88, updatedAt: at(-30) },
      { key: "weekly", windowMinutes: 10080, remainingPercent: 40, updatedAt: at(-2) }
    ], at(-2))] }
  ] }
];
const remoteBefore = JSON.stringify(remoteSnapshots);
assert.equal(sanitizeAccounts({ accounts: remoteSnapshots[0].accounts })[0].sources[0].limits.rows[1].updatedAt, at(-30), "sync sanitization preserves window measurement times");
const legacy = sanitizeAccounts({ accounts: [{ id: registryId, sources: [remoteSource([{ key: "fiveHour", remainingPercent: 0 }], at(-1))] }] });
assert.equal(Object.hasOwn(legacy[0].sources[0].limits.rows[0], "updatedAt"), false, "legacy signed snapshots keep their original field shape");
for (const ordered of [remoteSnapshots, [...remoteSnapshots].reverse()]) {
  const usage = combinedUsage({ gptAccounts: { accounts: [] }, connectedAccounts: [] }, ordered, "all");
  const result = buildDesktopWidgetSnapshot(usage, now);
  assert.equal(result.accounts.length, 1);
  assert.deepEqual(result.accounts[0].windows.map((row) => row.remainingPercent), [0, 40]);
  assert(result.accounts[0].windows.every((row) => row.status === "stale"), "remote saved measurements never become live");
}
assert.equal(JSON.stringify(remoteSnapshots), remoteBefore, "composition must not mutate signed snapshots");

// Exercise the production OpenCode collection stage that runs before the
// registry; dropping a profile here would make later per-window merging moot.
const serverSource = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
const collection = vm.createContext({ mergeGptQuotaLimits });
vm.runInContext(serverSource.match(/function dedupeOpenCodeAccountObservations\([^]*?\n\}/)[0], collection);
const a = { ...fresh, sourceId: "openCode" }, b = { ...old, sourceId: "openCode" };
for (const observations of [[a, b], [b, a]]) {
  const results = collection.dedupeOpenCodeAccountObservations(observations);
  assert.equal(results.length, 1);
  assert.equal(results[0].limits.rows[0].remainingPercent, 0);
}
console.log("GPT account dedupe: verified identities, per-window freshness, reordered/partial/failed scans, persistence, workspace isolation and Plasma favorites passed.");
