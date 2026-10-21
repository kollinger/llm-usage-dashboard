import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { createGptAccountLifecycle } from "./fixtures/gpt-account-lifecycle.mjs";
const require = createRequire(import.meta.url);
const { buildDesktopWidgetSnapshot } = require("../lib/desktop-widget");
const { createGptAccountObservation, mergeGptAccountRegistry, publicGptAccountRegistry } = require("../lib/gpt-account-registry");
const { combinedUsage } = require("../lib/device-sync-data");
const { createIdentity, signedSnapshot, verifySnapshot } = require("../lib/device-sync");

const lifecycle = await createGptAccountLifecycle();
let bridge;
try {
  const registry = await lifecycle.scan();
  assert.equal(registry.accounts.length, 2, "upgrading an email-keyed registry must show only the two verified workspace accounts");
  assert.equal(registry.historicalAccounts.length, 1);
  assert.equal(publicGptAccountRegistry(registry).historicalAccounts.length, 1, "projected registries retain their historical records on normalization");
  const snapshot = await lifecycle.snapshot();
  assert.equal(snapshot.accounts.length, 2, "persisted legacy history must not render as a duplicate quota account");
  const handles = snapshot.accounts.map((account) => account.id).sort();
  const shared = snapshot.accounts.find((account) => account.windows.some((row) => row.remainingPercent === 0));
  assert.deepEqual(shared.windows.map((row) => row.remainingPercent), [0, 40]);
  assert.equal(shared.aliases, undefined, "an email-only historical handle cannot claim a workspace favorite");
  const originalAuthPath = path.join(lifecycle.profiles, "11111111-2222-4333-8444-555555555555", "auth.json");
  const originalAuth = await fs.readFile(originalAuthPath, "utf8");
  const model = vm.createContext({});
  vm.runInContext((await fs.readFile(new URL("../plasma/contents/code/ViewModel.js", import.meta.url), "utf8")).replace(/^\.pragma library\s*/, ""), model);
  for (let cycle = 0; cycle < 3; cycle++) {
    assert.equal((await lifecycle.login()).status, "complete", "production login completion refreshes the account pipeline");
    assert.equal((await lifecycle.connections()).filter((account) => account.provider === "gpt").length, 2,
      "multiple managed profiles for the same identity produce one connection row");
    await lifecycle.scan();
    assert.equal((await lifecycle.cached()).accounts.length, 2);
    await lifecycle.reload();
    const restored = await lifecycle.snapshot();
    assert.deepEqual(restored.accounts.map((account) => account.id).sort(), handles);
    assert.equal(model.accounts(restored, "gpt", "all", [shared.id]).length, 2, "favorites do not determine identity/count");
    assert.equal(model.accounts(restored, "gpt", "favorites", [shared.id]).length, 1);
    assert.equal(restored.accounts.find((account) => account.id === shared.id).windows[0].remainingPercent, 0);
  }
  assert.equal(await fs.readFile(originalAuthPath, "utf8"), originalAuth, "re-login cannot overwrite the existing credentials");
  assert.equal((await fs.readdir(lifecycle.profiles)).length, 4, "all previous profiles remain recoverable");
  const stored = await lifecycle.stored();
  const historical = stored.accounts.find((account) => account.id === lifecycle.legacyId);
  const expectedHistory = JSON.parse(lifecycle.legacyBytes);
  expectedHistory.active = false;
  expectedHistory.sources.forEach((source) => { source.active = false; });
  assert.deepEqual(historical, expectedHistory, "the old unscoped history remains intact and is never attributed to either workspace");
  const cachedUsage = await lifecycle.usage();
  cachedUsage.gptAccounts = stored;
  cachedUsage.connectedAccounts.push({ id: `detected:${lifecycle.legacyId}`, accountId: lifecycle.legacyId, provider: "gpt", label: historical.label,
    limits: historical.sources[0].limits, updatedAt: new Date().toISOString(), status: "connected" });
  assert.equal(buildDesktopWidgetSnapshot(cachedUsage).accounts.length, 2, "a cached connection mirror cannot revive historical quota as a fresh account");
  const saved = JSON.stringify(stored);
  for (const secret of [lifecycle.workspace, lifecycle.otherWorkspace, "same@example.test", "synthetic-access", lifecycle.directory]) {
    assert(!saved.includes(secret), "registry persists only opaque identity metadata and masked labels");
  }
  const collision = createGptAccountObservation({ sourceId: "codex", email: "saxxe@example.test" });
  assert.equal(collision.label, historical.label, "synthetic distinct emails deliberately share the same masked label");
  const withCollision = publicGptAccountRegistry(mergeGptAccountRegistry(stored, [collision]));
  assert.equal(withCollision.accounts.length, 3, "masked label equality cannot archive an unrelated identity");
  assert.equal(withCollision.historicalAccounts.length, 1);

  const identity = createIdentity();
  const oldSnapshot = signedSnapshot(identity, "Synthetic peer", { accounts: stored.accounts, events: [], excludedEvents: 0 });
  const signedBytes = JSON.stringify(oldSnapshot);
  for (const selected of ["all", identity.id]) {
    const combined = combinedUsage(await lifecycle.usage(), [oldSnapshot], selected);
    assert.equal(buildDesktopWidgetSnapshot(combined).accounts.length, 2, "an older peer cannot restore a recognized email-first duplicate");
    assert.equal(combined.gptAccounts.historicalAccounts.length, 1);
  }
  assert.equal(JSON.stringify(oldSnapshot), signedBytes);
  assert.equal(verifySnapshot(JSON.parse(signedBytes)).revision, oldSnapshot.revision, "legacy signed account payloads remain readable without a schema change");
  const currentSnapshot = signedSnapshot(identity, "Synthetic peer", { accounts: (await lifecycle.usage()).gptAccounts.accounts, events: [], excludedEvents: 0 });
  assert.equal(currentSnapshot.accounts.length, 2, "new captures export only the verified account list");

  lifecycle.setFailed(true);
  await lifecycle.scan();
  const stale = await lifecycle.snapshot();
  assert.equal(stale.accounts.length, 2);
  assert(stale.accounts.flatMap((account) => account.windows).every((row) => row.status === "stale"));
  assert.deepEqual(stale.accounts.find((account) => account.id === shared.id).windows.map((row) => row.remainingPercent), [0, 40]);
  lifecycle.setFailed(false);
  await lifecycle.scan();
  if (process.platform === "linux") {
    bridge = await lifecycle.serve();
    for (let cycle = 0; cycle < 2; cycle++) {
      const envelope = await bridge.read();
      assert.equal(envelope.status, "ready");
      assert.equal(envelope.snapshot.accounts.length, 2, "production endpoint -> bridge -> packaged Python helper contains two accounts");
      bridge.setAuthenticated(false);
      const locked = await bridge.read();
      assert.equal(locked.status, "locked"); assert.equal(locked.snapshot, undefined);
      bridge.setAuthenticated(true);
      await lifecycle.reload();
    }
  }
  lifecycle.setFailed(true);
  await lifecycle.login("synthetic-unavailable-new-workspace");
  const unknown = (await lifecycle.snapshot()).accounts.find((account) => account.windows.length === 0);
  assert(unknown, "a new verified identity with missing raw provider measurements stays unknown");
  assert.equal(model.remaining({}), null, "missing quota cannot become zero");
} finally { await bridge?.close(); await lifecycle.close(); }
console.log("GPT lifecycle: failing upgrade regression fixed; raw collectors, repeated login/scans, cache/restart, connections, preserved history/credentials/favorites, signed peer snapshots and authenticated native bridge passed.");
