import { readDashboardSource } from "./fixtures/dashboard-source.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeSnapshot, buildAccountHistories } = require('../lib/codex-reset-history');
const { codexNotificationSample, createQuotaNotifications, notificationSettings } = require('../lib/quota-notifications');
const { notificationMessage } = require('../lib/mobile-notifications');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reset-accounts-'));
process.env.LLM_USAGE_DATA_DIR = dir;
process.env.CODEX_LIVE_RATE_LIMITS = 'false';
const { _test } = require('../server');
const now = Date.parse('2026-10-17T20:44:00Z');
const raw = (id, used, reset) => ({ accountId: id, rateLimitsByLimitId: { codex: { planType: 'pro',
  secondary: { windowDurationMins: 10080, usedPercent: used, resetsAt: Date.parse(reset) / 1000 } } } });
const records = [];
const observation = (id, label, used, at, reset) => {
  const response = raw(id, used, reset), sample = normalizeSnapshot(response, at);
  sample.accountRef = 'ref-' + id; sample.accountLabel = label; records.push(sample);
  return { snapshot: sample, notification: { ...codexNotificationSample(response, at), accountLabel: label } };
};
try {
  const previousReset = '2026-10-22T06:18:00Z', nextReset = '2026-10-24T20:41:00Z';
  const a = observation('one', 'First account', 100, '2026-10-17T20:40:00Z', previousReset);
  const b = observation('two', 'Second account', 18, '2026-10-17T20:40:30Z', previousReset);
  const aNext = observation('one', 'First account', 1, '2026-10-17T20:41:00Z', nextReset);
  const bNext = observation('two', 'Second account', 0, '2026-10-17T20:41:30Z', nextReset);
  const bStable = observation('two', 'Second account', 0, '2026-10-17T20:43:30Z', nextReset);
  const history = buildAccountHistories(records, [], { now });
  assert.equal(history.accounts.length, 2);
  assert.deepEqual(history.accounts.map(a => a.history.windows[0].previousUsedPercent), [100, 18]);
  assert.deepEqual(history.accounts.map(a => a.history.current.lastUsedPercent), [1, 0]);
  assert.equal(history.unassigned, null);
  const legacy = [{ timestamp: '2026-09-01T12:00:00Z', rateLimits: { primary: { used_percent: 87, window_minutes: 10080, resets_at: Date.parse('2026-09-08T12:00:00Z') / 1000 } } },
    { timestamp: '2026-09-03T12:00:00Z', rateLimits: { primary: { used_percent: 1, window_minutes: 10080, resets_at: Date.parse('2026-09-10T12:00:00Z') / 1000 } } }];
  const withLegacy = buildAccountHistories(records, legacy, { now });
  assert.equal(withLegacy.unassigned.windows[0].maxUsedPercent, 87);
  assert.equal(withLegacy.accounts[0].history.windows.length, 1, 'unassigned history never joins an identified account');
  const unknown = buildAccountHistories([], [], { now, accounts: [{ id: 'new', label: 'Not yet observed', active: true, sources: [{ id: 'codex' }] }] });
  assert.equal(unknown.accounts.length, 1); assert.equal(unknown.accounts[0].history.current, null);

  const file = path.join(dir, 'notification-feed.json');
  let feed = createQuotaNotifications(file, () => now);
  await feed.observe('codex', a.notification); await feed.observe('codex', b.notification);
  assert.equal((await feed.observe('codex', aNext.notification))[0].previousUsedPercent, 100);
  feed = createQuotaNotifications(file, () => now);
  assert.equal((await feed.observe('codex', bNext.notification))[0].previousUsedPercent, 18);
  const events = await feed.events(notificationSettings());
  assert.equal(new Set(events.map(e => e.accountKey)).size, 2);
  const de = JSON.parse(await fs.readFile(new URL('../public/i18n/de.json', import.meta.url), 'utf8'));
  assert.match(notificationMessage(events[0], de.mobilePrototype, 'de').body, /First account/);
  assert.match(notificationMessage(events[0], de.mobilePrototype, 'de').body, /100%/);
  assert.match(notificationMessage(events[1], de.mobilePrototype, 'de').body, /18%/);
  const isolatedGap = createQuotaNotifications(path.join(dir, 'gap-feed.json'), () => now);
  await isolatedGap.observe('codex', a.notification); await isolatedGap.observe('codex', b.notification);
  await isolatedGap.observe('codex', null, a.snapshot.accountKey);
  assert.deepEqual(await isolatedGap.observe('codex', aNext.notification), [], 'an interrupted account has no reset evidence');
  assert.equal((await isolatedGap.observe('codex', bNext.notification))[0].previousUsedPercent, 18, 'one unavailable account does not erase another baseline');
  const migrationFile = path.join(dir, 'migration.json');
  await fs.writeFile(migrationFile, JSON.stringify({ version: 1, samples: { codex: a.notification }, events: [] }));
  const migrated = createQuotaNotifications(migrationFile, () => now);
  await migrated.observe('codex', b.notification);
  assert.equal((await migrated.observe('codex', aNext.notification))[0].previousUsedPercent, 100);

  // Interleaved account writes can have older timestamps than the other account.
  await _test.recordCodexResetSnapshot(a.snapshot);
  await _test.recordCodexResetSnapshot(aNext.snapshot);
  await _test.recordCodexResetSnapshot(b.snapshot);
  await _test.recordCodexResetSnapshot(bNext.snapshot);
  await _test.recordCodexResetSnapshot(bStable.snapshot);
  const persisted = await _test.readCodexResetHistory();
  assert.equal(persisted.accounts.length, 2);
  assert.deepEqual(persisted.accounts.map(a => a.history.windows[0].previousUsedPercent), [100, 18]);
  const source = (await readDashboardSource()).replace('\ninit();', '\n// no bootstrap');
  const context = { document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] }, window: {}, navigator: {}, localStorage: { getItem: () => null }, Intl, Date, console, URLSearchParams, setTimeout, clearTimeout };
  const html = vm.runInNewContext(source + `\nstate.translations = ${JSON.stringify(de)}; renderCodexResetHistoryContent(${JSON.stringify(withLegacy)});`, context);
  assert.match(html, /First account/); assert.match(html, /Second account/); assert.match(html, /Keinem Konto zugeordnet/);
  assert.match(html, /Zuletzt vor Reset/); assert.match(html, /100 %/); assert.match(html, /18 %/);
  assert.match(html, /Zuletzt gemessen/);
  const home = path.join(dir, 'additional-profile'); await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'profile-only' } }));
  const profileReset = new Date(Date.now() + 7 * 86400000).toISOString();
  const scanned = await _test.readCodexGptAccountObservation({ codexHomes: [home], clientFactory: async () => ({
    client: { request: async method => method === 'account/read' ? { account: { type: 'chatgpt', planType: 'pro' } }
      : method === 'account/usage/read' ? null : raw('profile-only', 12, profileReset) }
  }) });
  assert.equal(scanned.quotaAvailable, 1, 'a signed-in profile without email still has an account identity');
  const profileHistory = await _test.readCodexResetHistory();
  assert.ok(profileHistory.accounts.some(a => a.accountRef && a.history.current?.lastUsedPercent === 12), 'additional profile probes persist their own reset observations');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
console.log('Reset account attribution: two accounts, previous percentages, persistence, legacy isolation, notification migration and shared UI passed.');
