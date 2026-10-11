import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resetNotifications, subscriptionValue, createMobilePush, notificationMessage } = require('../lib/mobile-notifications');
const { startMobilePrototype, signToken } = require('../lib/mobile-lan-prototype');
const root = new URL('..', import.meta.url);
let now = Date.parse('2026-10-11T12:00:00Z');
const eventWindow = { resetType: 'early', source: 'live', accountScope: 'current_account', confidence: 'observed', gap: false, overlap: false,
  scheduledResetAt: '2026-10-13T12:00:00Z', resetObservedBetween: { from: '2026-10-11T11:57:00Z', to: '2026-10-11T11:59:00Z' } };
const history = { liveStatus: 'live', windows: [eventWindow] };
const events = resetNotifications(history, now);
assert.equal(events.length, 1);
assert.equal(events[0].type, 'unexpected_reset');
assert.equal(events[0].previousResetAt, eventWindow.scheduledResetAt);
for (const change of [{ gap: true }, { overlap: true }, { confidence: 'uncertain' }, { source: 'historical' }, { accountScope: 'historical_unscoped' }, { resetType: 'regular' }, { resetObservedBetween: { to: '2026-10-10T12:00:00Z' } }]) {
  assert.equal(resetNotifications({ ...history, windows: [{ ...eventWindow, ...change }] }, now).length, 0);
}
assert.equal(resetNotifications({ ...history, liveStatus: 'stale' }, now).length, 0);

const encryption = crypto.createECDH('prime256v1'); encryption.generateKeys();
const subscription = { endpoint: 'https://web.push.apple.com/example-test', keys: { p256dh: encryption.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
assert.equal(subscriptionValue(subscription).endpoint, subscription.endpoint);
for (const endpoint of ['http://web.push.apple.com/a', 'https://127.0.0.1/a', 'https://web.push.apple.com.attacker.invalid/a', 'https://user:pass@web.push.apple.com/a', 'https://web.push.apple.com:4177/a']) {
  assert.throws(() => subscriptionValue({ ...subscription, endpoint }));
}
assert.throws(() => subscriptionValue({ ...subscription, keys: { ...subscription.keys, p256dh: Buffer.alloc(65).toString('base64url') } }));

const creditCopy = JSON.parse(await fs.readFile(new URL('public/i18n/de.json', root), 'utf8')).mobilePrototype;
const creditMessage = notificationMessage({ type: 'credit_expiry', provider: 'codex', balance: 63000, expiresOn: '2026-12-31' }, creditCopy, 'de');
assert.match(creditMessage.body, /63.000.*31.12.2026.*eigene Angabe/);

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-notifications-'));
let gateway, lan, upstream;
try {
  const file = path.join(directory, 'push.json'), sent = [];
  const send = async (sub, payload, options) => {
    // Exercise the real encryption and VAPID request builder without sending.
    const request = require('web-push').generateRequestDetails(sub, payload, options);
    assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
    assert.ok(request.body.length > Buffer.byteLength(payload));
    assert.match(request.headers.Authorization, /^vapid /);
    sent.push(JSON.parse(payload));
  };
  let push = await createMobilePush({ file, origin: 'https://dashboard.example.invalid', send, now: () => now });
  await push.subscribe('phone', now + 3600000, subscription, 'de');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const publicKey = push.publicKey;
  const alert = { provider: 'claudeCode', type: 'hard_limit', windowKey: 'weekly', usedPercent: 96, resetsAt: '2026-10-13T12:00:00Z' };
  await push.publish({ enabled: true, alerts: [alert, alert], events });
  assert.equal(sent.length, 1, 'enrollment does not replay past resets; duplicate window representations send once');
  assert.match(sent[0].body, /Claude.*96/);
  push = await createMobilePush({ file, origin: 'https://dashboard.example.invalid', send, now: () => now });
  assert.equal(push.publicKey, publicKey);
  await push.subscribe('phone', now + 3600000, subscription, 'de');
  await push.publish({ enabled: true, alerts: [alert] });
  assert.equal(sent.length, 1, 'restart and reopening do not repeat warnings');
  const beforeRenew = JSON.parse(await fs.readFile(file, 'utf8')).phones.phone;
  await push.renew('phone', now + 365 * 24 * 3600000);
  const afterRenew = JSON.parse(await fs.readFile(file, 'utf8')).phones.phone;
  assert.equal(afterRenew.expires, now + 365 * 24 * 3600000);
  assert.deepEqual(afterRenew.sent, beforeRenew.sent, 'session renewal does not replay warnings');
  assert.deepEqual(afterRenew.subscription, beforeRenew.subscription);
  now += 60000;
  const recent = { ...events[0], at: new Date(now).toISOString(), id: 'new-observation' };
  await push.publish({ enabled: true, events: [recent] });
  assert.equal(sent.length, 2, 'push delivery runs without a browser page');
  await push.publish({ enabled: true, events: [recent] });
  await push.publish({ enabled: false, alerts: [{ ...alert, windowKey: 'five_hour' }] });
  assert.equal(sent.length, 2);
  assert.equal((await push.test('phone')).accepted, true);
  await assert.rejects(push.test('phone'), /rate_limited/);
  await push.unsubscribe('phone');
  assert.equal(push.status('phone').subscribed, false);
  await push.publish({ enabled: true, alerts: [alert] });
  assert.equal(sent.length, 3);
  await assert.rejects(createMobilePush({ file, origin: 'https://other.example.invalid' }), /origin_changed/);
  const gone = await createMobilePush({ file: path.join(directory, 'gone.json'), origin: 'https://dashboard.example.invalid', now: () => now,
    send: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); } });
  await gone.subscribe('phone', now + 1000, subscription, 'en');
  await gone.publish({ enabled: true, alerts: [alert] });
  assert.equal(gone.status('phone').subscribed, false);

  let creditNow = now; const creditSent = [];
  const creditFile = path.join(directory, 'credit-push.json');
  let creditPush = await createMobilePush({ file: creditFile, origin: 'https://credits.example.invalid', now: () => creditNow, send: async (_, payload) => creditSent.push(JSON.parse(payload)) });
  await creditPush.subscribe('credit-phone', creditNow + 365 * 86400000, subscription, 'de');
  const creditAlert = { type: 'credit_expiry', provider: 'codex', balance: 63000, expiresOn: '2026-12-31', id: 'credit-expiry:2026-12-31:30' };
  await creditPush.publish({ enabled: true, alerts: [creditAlert] });
  creditNow += 2 * 86400000;
  creditPush = await createMobilePush({ file: creditFile, origin: 'https://credits.example.invalid', now: () => creditNow, send: async (_, payload) => creditSent.push(JSON.parse(payload)) });
  await creditPush.publish({ enabled: true, alerts: [creditAlert] });
  assert.equal(creditSent.length, 1, 'credit expiry stage stays deduplicated across days and restart');
  await creditPush.publish({ enabled: true, alerts: [{ ...creditAlert, id: 'credit-expiry:2026-12-31:7' }] });
  assert.equal(creditSent.length, 2, 'the next expiry stage produces a new warning');

  upstream = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ enabled: true, alerts: [alert], events: [] })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const common = { testing: true, address: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstream.address().port}` };
  gateway = await startMobilePrototype({ ...common, groupFile: path.join(directory, 'https', 'group.json'), httpsOrigin: 'https://dashboard.example.invalid', pushSend: send });
  const proxy = (url, options = {}) => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: gateway.proxyServer.address().port, path: url, method: options.method || 'GET',
      headers: { Host: 'dashboard.example.invalid', 'X-Forwarded-Proto': 'https', ...options.headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.on('error', reject); request.end(options.body);
  });
  assert.equal((await proxy('/api/mobile-prototype/notifications')).status, 401);
  const pair = await proxy('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://dashboard.example.invalid' }, body: JSON.stringify({ code: signToken(gateway.group, 'pair', 60000) }) });
  assert.equal(pair.status, 200); assert.match(pair.headers.get('set-cookie'), /Secure/);
  const cookie = pair.headers.get('set-cookie').split(';')[0];
  const feed = await (await proxy('/api/mobile-prototype/notifications', { headers: { Cookie: cookie } })).json();
  assert.equal(feed.pushAvailable, true); assert.ok(feed.publicKey);
  const post = (action, body, extra = {}) => proxy(`/api/mobile-prototype/push/${action}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://dashboard.example.invalid', ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('subscribe', { subscription, language: 'de' }, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await post('subscribe', { subscription, language: 'de' }, { Origin: '' })).status, 403);
  assert.equal((await post('subscribe', { subscription, language: 'de' })).status, 200);
  const backgroundDeadline = Date.now() + 2000;
  while (sent.length < 4 && Date.now() < backgroundDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.length, 4, 'the gateway checks and sends after enrollment without a browser polling');
  const pushFile = path.join(directory, 'https', `mobile-push-${gateway.group.id}.json`);
  const originalToken = cookie.split('=')[1];
  const owner = crypto.createHash('sha256').update(originalToken).digest('hex');
  // The send callback returns before the queued durable write completes.
  let beforeGatewayRenew;
  const persistenceDeadline = Date.now() + 2000;
  do {
    beforeGatewayRenew = JSON.parse(await fs.readFile(pushFile, 'utf8')).phones[owner];
    if (Object.keys(beforeGatewayRenew.sent).length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < persistenceDeadline);
  assert.ok(Object.keys(beforeGatewayRenew.sent).length, 'background warning is durable before renewal');
  const oldValue = JSON.parse(Buffer.from(originalToken.split('.')[0], 'base64url').toString());
  const renewedBody = Buffer.from(JSON.stringify({ ...oldValue, owner, expires: Date.now() + 3600000 })).toString('base64url');
  const renewedMac = crypto.createHmac('sha256', Buffer.from(gateway.group.key, 'base64url')).update(renewedBody).digest('base64url');
  const renewal = await proxy('/api/mobile-prototype/notifications', { headers: { Cookie: `llm_mobile_prototype=${renewedBody}.${renewedMac}` } });
  assert.equal((await renewal.json()).subscribed, true, 'cookie rotation keeps its existing push subscription');
  const afterGatewayRenew = JSON.parse(await fs.readFile(pushFile, 'utf8')).phones[owner];
  assert.deepEqual(afterGatewayRenew.sent, beforeGatewayRenew.sent);
  assert.ok(afterGatewayRenew.expires > Date.now() + 364 * 24 * 3600000);
  assert.equal((await post('test', {})).status, 200);
  assert.equal((await proxy('/api/updates/check', { method: 'POST', headers: { Cookie: cookie } })).status, 405);
  assert.equal((await proxy('/mobile-prototype/sw.js', { headers: { Cookie: cookie } })).headers.get('service-worker-allowed'), '/');
  assert.equal((await proxy('/mobile-prototype/manifest.webmanifest', { headers: { Cookie: cookie } })).status, 200);
  // Forged proxy headers on the LAN socket cannot unlock the HTTPS feature.
  const forged = await fetch(`http://127.0.0.1:${gateway.server.address().port}/api/mobile-prototype/notifications`, { headers: { Cookie: cookie, Host: 'dashboard.example.invalid', 'X-Forwarded-Proto': 'https' } });
  assert.equal((await forged.json()).pushAvailable, false);
  lan = await startMobilePrototype({ ...common, groupFile: path.join(directory, 'lan', 'group.json') });
  const lanCookie = `llm_mobile_prototype=${signToken(lan.group, 'phone', 60000)}`;
  const lanFeed = await (await fetch(`http://127.0.0.1:${lan.server.address().port}/api/mobile-prototype/notifications`, { headers: { Cookie: lanCookie } })).json();
  assert.equal(lanFeed.pushAvailable, false); assert.equal(lanFeed.publicKey, null);
  assert.equal((await fetch(`http://127.0.0.1:${lan.server.address().port}/api/mobile-prototype/push/subscribe`, { method: 'POST', headers: { Cookie: lanCookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 409);

  // A worker push event displays a notification independently of open pages.
  const handlers = {}, displayed = [];
  let waiting;
  const source = await fs.readFile(new URL('../public/mobile-prototype/sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { self: { addEventListener: (name, callback) => { handlers[name] = callback; }, registration: { showNotification: async (title, value) => { displayed.push({ title, value }); } } } });
  handlers.push({ data: { json: () => sent[0] }, waitUntil: value => { waiting = value; } });
  await waiting; assert.equal(displayed.length, 1); assert.equal(displayed[0].value.data.url, '/');

  const en = JSON.parse(await fs.readFile(new URL('public/i18n/en.json', root), 'utf8')).mobilePrototype;
  for (const name of await fs.readdir(new URL('public/i18n', root))) {
    if (!name.endsWith('.json')) continue;
    const copy = JSON.parse(await fs.readFile(new URL(`public/i18n/${name}`, root), 'utf8')).mobilePrototype;
    for (const [key, value] of Object.entries(en)) {
      assert.equal(typeof copy[key], 'string', `${name}: ${key}`);
      assert.deepEqual((copy[key].match(/\{\w+\}/g) || []).sort(), (value.match(/\{\w+\}/g) || []).sort());
    }
  }
} finally {
  await gateway?.stop(); await lan?.stop();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
console.log('mobile notifications: reset evidence, encryption, persistence, deduplication, LAN/HTTPS isolation, pairing, worker and translations passed');
