import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { notificationSettings, quotaTransitions, codexNotificationSample, createQuotaNotifications, EVENT_TYPES } = require('../lib/quota-notifications');
const { notificationMessage } = require('../lib/mobile-notifications');

assert.equal(notificationSettings().enabled, true);
assert.equal(notificationSettings().resetsEnabled, true);
assert.equal(notificationSettings({ enabled: false, resetsEnabled: false }).resetsEnabled, false);
const at = Date.parse('2026-10-12T12:00:00Z');
const sample = (usedPercent, resetsAt, offset = 0, accountKey = 'test-account') => ({ accountKey, planType: 'test-plan',
  at: new Date(at + offset).toISOString(), windows: [{ key: 'weekly', windowMinutes: 10080, usedPercent, resetsAt }] });
const before = sample(99, '2026-10-13T12:00:00Z');
const reached = sample(100, before.windows[0].resetsAt, 60000);
assert.deepEqual(quotaTransitions(before, reached).map(e => e.type), ['limit_reached']);
const available = sample(90, before.windows[0].resetsAt, 120000);
assert.deepEqual(quotaTransitions(reached, available).map(e => e.type), ['availability_restored']);
const early = sample(0, '2026-10-19T12:02:00Z', 120000);
assert.deepEqual(quotaTransitions(reached, early).map(e => e.type), ['unexpected_reset']);
const scheduledBefore = sample(99, '2026-10-12T12:01:00Z');
assert.deepEqual(quotaTransitions(scheduledBefore, early).map(e => e.type), ['scheduled_reset']);
assert.deepEqual(quotaTransitions(before, sample(50, before.windows[0].resetsAt, 60000)).map(e => e.type), ['quota_changed']);
assert.deepEqual(quotaTransitions(before, sample(99, '2026-10-12T18:00:00Z', 60000)).map(e => e.type), ['quota_changed']);
assert.deepEqual(quotaTransitions(before, sample(0, early.windows[0].resetsAt, 60000, 'another-account')), []);
assert.deepEqual(quotaTransitions(before, { ...early, planType: 'another-plan' }), []);
assert.deepEqual(quotaTransitions(before, sample(0, early.windows[0].resetsAt, 11 * 60000)), []);
assert.deepEqual(quotaTransitions(sample(0, before.windows[0].resetsAt), early), [], 'moving zero-use deadline is not a reset');
assert.deepEqual(quotaTransitions(null, reached), [], 'first observation is a baseline');
assert.deepEqual(quotaTransitions(before, { ...early, windows: [] }), [], 'unreported quota is not a reset');
const codex = codexNotificationSample({ accountId: 'test-source-account', ordinaryUsageAllowed: false,
  rateLimitsByLimitId: { codex: { planType: 'test-plan', primary: { windowDurationMins: 300, usedPercent: 2, resetsAt: (at + 3600000) / 1000 },
    secondary: { windowDurationMins: 10080, usedPercent: 50, resetsAt: (at + 86400000) / 1000 } } } }, before.at);
assert.equal(codex.windows.find(w => w.key === 'weekly').limited, true);
assert.equal(codex.windows.find(w => w.key === 'five_hour').limited, undefined);
assert.notEqual(codex.accountKey, 'test-source-account');

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-notices-'));
try {
  let now = at;
  const file = path.join(dir, 'events.json');
  let feed = createQuotaNotifications(file, () => now);
  assert.deepEqual(await feed.observe('codex', before), []);
  now += 60000;
  const events = await feed.observe('codex', reached);
  assert.equal(events[0].provider, 'codex');
  assert.deepEqual(await feed.events(notificationSettings()), events);
  assert.deepEqual(await feed.events(notificationSettings({ resetsEnabled: false })), []);
  assert.deepEqual(await feed.events(notificationSettings({ enabled: false })), []);
  feed = createQuotaNotifications(file, () => now);
  assert.deepEqual(await feed.observe('codex', reached), [], 'restart does not replay transitions');
  assert.deepEqual(await feed.events(notificationSettings()), events, 'event IDs survive restart');
  await feed.observe('codex', null);
  now += 60000;
  assert.deepEqual(await feed.observe('codex', early), [], 'failed poll interrupts reset evidence');
  assert.deepEqual(await feed.observe('claudeCode', reached), []);
  now += 60000;
  assert.equal((await feed.observe('claudeCode', { ...early, at: new Date(now).toISOString() }))[0].provider, 'claudeCode');
  now += 11 * 60000;
  assert.deepEqual(await feed.events(notificationSettings()), [], 'old events stop being alerts');
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  const copy = JSON.parse(await fs.readFile(new URL('../public/i18n/de.json', import.meta.url), 'utf8'));
  const source = await fs.readFile(new URL('../electron/main.js', import.meta.url), 'utf8');
  const start = source.indexOf('function buildNotificationBody('), end = source.indexOf('\nfunction getNotificationStatusFile', start);
  const context = vm.createContext({ EVENT_TYPES, notificationMessage, readNotificationTranslations: () => copy });
  vm.runInContext(source.slice(start, end), context);
  for (const type of EVENT_TYPES) {
    const event = { ...events[0], type };
    const mobile = notificationMessage(event, copy.mobilePrototype, 'de').body;
    assert.equal(context.buildNotificationBody(event, 'de'), mobile, 'desktop and phone use identical event wording');
    assert.ok(!mobile.includes('{'));
    assert.match(mobile, /Codex/);
  }
  let status = {}, deliveries = 0;
  const nativeContext = vm.createContext({ EVENT_TYPES, Date, Notification: { isSupported: () => true },
    fetchLocalJson: async () => ({ alerts: events }), fs: { readFile: async () => JSON.stringify(status) },
    getNotificationStatusFile: () => 'test-status', notificationCooldowns: new Map(), NOTIFICATION_COOLDOWN_MS: 1800000,
    alertKey: event => event.id, getNotificationLanguage: async () => 'de', buildNotificationTitle: () => 'test',
    buildNotificationBody: () => 'test', showNativeNotification: async () => { deliveries++; return { result: 'accepted' }; },
    setAppBadgeCount: () => {}, requestNotificationAttention: () => {}, dashboardPort: null,
    writeNotificationStatus: async update => { status = { ...status, ...update }; } });
  const checkStart = source.indexOf('async function checkNotifications('), checkEnd = source.indexOf('\nfunction setAppBadgeCount', checkStart);
  assert.ok(checkEnd > checkStart);
  vm.runInContext(source.slice(checkStart, checkEnd), nativeContext);
  await nativeContext.checkNotifications(4177);
  nativeContext.notificationCooldowns.clear();
  await nativeContext.checkNotifications(4177);
  assert.equal(deliveries, 1, 'persistent native event IDs prevent replay after restart');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
console.log('quota notifications: default-on, account scope, Matrix-equivalent transitions, gaps, moving zeros, persistence, controls and shared desktop/phone copy passed');
