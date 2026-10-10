import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startMobilePrototype, loadGroup, signToken, verifyToken, sanitize, elect } = require('../lib/mobile-lan-prototype');

const clientSource = await fs.readFile(new URL('../public/mobile-prototype/client.js', import.meta.url), 'utf8');
const clientStorage = new Map();
const client = async (url, result = { status: 200, ok: true }, { supplied = '', state = 'missing', storageBlocked = false } = {}) => {
  const location = new URL(url);
  let destination, submitted;
  location.replace = (value) => { destination = value; };
  const button = { disabled: false, addEventListener: (_event, handler) => { button.click = handler; } };
  const message = {};
  const context = {
    location, navigator: { language: 'de' },
    sessionStorage: { setItem: (key, value) => { if (storageBlocked) throw Error('blocked'); clientStorage.set(key, value); }, getItem: (key) => clientStorage.get(key), removeItem: (key) => clientStorage.delete(key) },
    history: { replaceState: (_state, _title, value) => { location.href = new URL(value, location).href; } },
    document: { body: { dataset: { prototype: 'pair' } }, documentElement: {}, querySelectorAll: () => [], querySelector: () => ({ content: state }), getElementById: (id) => id === 'prototypePair' ? button : id === 'prototypeCode' ? { value: supplied } : message },
    fetch: async (value, options) => {
      if (!options) return { json: async () => ({ mobilePrototype: { scanAgain: 'new-link', networkError: 'retry', missingCode: 'missing', expiredCode: 'expired', usedCode: 'used', invalidCode: 'invalid' } }) };
      submitted = JSON.parse(options.body).code;
      if (result instanceof Error) throw result;
      return result;
    }
  };
  await vm.runInNewContext(clientSource, context);
  return { button, message, submitted: () => submitted, destination: () => destination, url: () => location.href };
};
// A second browser receives the current URL, without the first browser's storage.
for (const url of ['http://127.0.0.1/pair/handoff-token', 'http://127.0.0.1/pair#handoff-token']) {
  const embedded = await client(url);
  assert.equal(embedded.button.disabled, false);
  clientStorage.clear();
  const external = await client(embedded.url());
  assert.equal(external.button.disabled, false, 'Open in another browser retains the pairing code');
  await external.button.click();
  assert.equal(external.submitted(), 'handoff-token');
  assert.equal(external.destination(), '/');
}
// Support a cleaned URL restored from the same browser's storage.
await client('http://127.0.0.1/pair#fragment-token');
let phone = await client('http://127.0.0.1/pair');
assert.equal(phone.button.disabled, false);
await phone.button.click();
assert.equal(phone.submitted(), 'fragment-token');
assert.equal(phone.destination(), '/');
assert.equal(clientStorage.size, 0);
phone = await client('http://127.0.0.1/pair/path-token');
assert.equal(phone.button.disabled, false);
phone = await client('http://127.0.0.1/pair', new Error('offline'));
await phone.button.click();
assert.equal(phone.button.disabled, false);
assert.equal(phone.message.textContent, 'retry');
phone = await client('http://127.0.0.1/pair', { status: 401, ok: false, json: async () => ({ error: 'pair_expired' }) });
await phone.button.click();
assert.equal(phone.submitted(), 'path-token');
assert.equal(phone.message.textContent, 'expired');
assert.equal(clientStorage.size, 0);
phone = await client('http://127.0.0.1/pair');
assert.equal(phone.button.disabled, true);
assert.equal(phone.message.textContent, 'missing');
phone = await client('http://127.0.0.1/pair/path-token/');
assert.equal(phone.button.disabled, false);
await phone.button.click();
assert.equal(phone.submitted(), 'path-token');
phone = await client('http://127.0.0.1/pair', undefined, { supplied: 'server-token', state: 'valid', storageBlocked: true });
assert.equal(phone.button.disabled, false);
await phone.button.click();
assert.equal(phone.submitted(), 'server-token');

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mobile-prototype-'));
const upstream = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ generatedAt: '2026-01-01T00:00:00Z', local: { totalTokens: 123 }, email: 'private@example.invalid', accessToken: 'private', nested: { file: '/private/source', outputTokens: 42 } })); });
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
let a, b;
const get = (node, url, options = {}) => fetch(`http://127.0.0.1:${node.server.address().port}${url}`, { ...options, redirect: 'manual' });
try {
  const groupA = path.join(temporary, 'a', 'group.json');
  const group = await loadGroup(groupA);
  const groupB = path.join(temporary, 'b', 'group.json');
  await loadGroup(groupB);
  const common = { address: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`, testing: true };
  a = await startMobilePrototype({ ...common, groupFile: groupA, nodeId: 'a', label: 'A' });
  let joined = false;
  b = await startMobilePrototype({ ...common, groupFile: groupB, nodeId: 'b', label: 'B', onJoin: async () => {
    await b.stop();
    b = await startMobilePrototype({ ...common, groupFile: groupB, nodeId: 'b', label: 'B' });
    joined = true;
  } });
  assert.equal((await fs.stat(groupA)).mode & 0o777, 0o600);
  assert.equal((await get(a, '/api/usage')).status, 401);
  assert.equal((await get(a, '/')).status, 302);
  const badHost = await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: a.server.address().port, path: '/api/usage', headers: { Host: 'attacker.invalid' } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await get(a, '/pair', { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await fetch(`${a.controlUrl}/api/code`, { method: 'POST', headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  const direct = await (await fetch(`${a.controlUrl}/api/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direct: true }) })).json();
  assert.equal(new URL(direct.url).hostname, '127.0.0.1');
  assert.equal(Number(new URL(direct.url).port), a.server.address().port);
  assert.match(direct.svg, /<svg/);
  const linkCode = new URL(direct.linkUrl).pathname.slice('/pair/'.length);
  assert.equal(linkCode, new URL(direct.url).hash.slice(1));
  const link = await get(a, `/pair/${linkCode}`);
  assert.equal(link.status, 200);
  assert.equal(link.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(link.headers.get('cache-control'), 'no-store');
  const bootstrap = link.headers.get('set-cookie').split(';')[0];
  assert.match(bootstrap, /^llm_mobile_bootstrap=/);
  assert.equal((await get(a, '/api/usage', { headers: { Cookie: bootstrap } })).status, 401, 'bootstrap cookie never grants dashboard access');
  assert.ok((await link.text()).includes(`id="prototypeCode" value="${linkCode}"`));
  const reload = await get(a, '/pair', { headers: { Cookie: bootstrap } });
  assert.ok((await reload.text()).includes(`id="prototypeCode" value="${linkCode}"`), 'server restores code even without session storage');
  assert.ok((await (await get(a, `/pair/${linkCode}/`)).text()).includes(`id="prototypeCode" value="${linkCode}"`));
  assert.equal((await get(a, '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: linkCode }) })).status, 200);
  assert.equal((await (await get(a, '/pair', { method: 'POST', headers: { Cookie: bootstrap, 'Content-Type': 'application/json' }, body: '{}' })).json()).error, 'pair_used');
  const expired = signToken(group, 'pair', 100, Date.now() - 200);
  assert.equal((await (await get(a, '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: expired }) })).json()).error, 'pair_expired');
  assert.equal((await (await get(a, '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).error, 'pair_missing');
  const code = signToken(group, 'pair', 60_000);
  assert.equal(verifyToken(group, code, 'phone'), false);
  assert.equal(verifyToken(group, signToken(group, 'pair', 100, Date.now() - 200), 'pair'), false);
  const response = await get(a, '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.match(response.headers.get('set-cookie'), /llm_mobile_bootstrap=;/);
  assert.equal((await get(a, '/pair', { headers: { Cookie: cookie } })).headers.get('location'), '/');
  assert.equal((await get(a, '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).status, 401);
  const usage = await (await get(a, '/api/usage', { headers: { Cookie: cookie } })).json();
  assert.equal(usage.local.totalTokens, 123); assert.equal(usage.nested.outputTokens, 42);
  assert.equal(usage.email, undefined); assert.equal(usage.accessToken, undefined); assert.equal(usage.nested.file, undefined);
  assert.equal((await get(a, '/api/updates/check', { method: 'POST', headers: { Cookie: cookie } })).status, 405);
  assert.equal((await get(a, '/api/support/report', { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await get(a, '/api/group-code', { headers: { Cookie: cookie } })).status, 403);
  const events = (await (await fetch(`${a.controlUrl}/api/status`)).json()).pairing;
  assert.ok(events.some(event => event.action === 'link' && event.state === 'valid'));
  assert.ok(events.some(event => event.action === 'connect' && event.state === 'used'));
  assert.ok(!JSON.stringify(events).includes(linkCode), 'local diagnostics contain no codes');
  assert.equal((await (await get(a, '/api/mobile-prototype/status', { headers: { Cookie: cookie } })).json()).pairing, undefined);
  assert.equal((await get(a, '/api/usage', { headers: { Cookie: cookie.slice(0, -1) + 'X' } })).status, 401);
  const html = await (await get(a, '/', { headers: { Cookie: cookie } })).text();
  assert.match(html, /mobile-prototype\/client.js/); assert.match(html, /dashboardLayout/);
  assert.equal((await get(b, '/api/usage', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(`${b.controlUrl}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'invalid' }) })).status, 400);
  const invitation = await (await fetch(`${a.controlUrl}/api/group-code`, { method: 'POST' })).json();
  assert.equal((await fetch(`${b.controlUrl}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invitation.code }) })).status, 200);
  const joinDeadline = Date.now() + 3000;
  while (!joined && Date.now() < joinDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(joined, true);
  assert.equal((await loadGroup(groupB)).id, group.id);
  // One phone session still works on another group member after its original
  // server stops, and after that survivor restarts. No re-pairing occurs.
  await a.stop(); a = null;
  assert.equal((await get(b, '/api/usage', { headers: { Cookie: cookie } })).status, 200);
  await b.stop();
  b = await startMobilePrototype({ ...common, groupFile: groupB, nodeId: 'b', label: 'B' });
  assert.equal((await get(b, '/api/usage', { headers: { Cookie: cookie } })).status, 200);
  const now = Date.now();
  const peers = new Map([['a', { id: 'a', seen: now - 6001 }], ['b', { id: 'b', seen: now }], ['c', { id: 'c', seen: now }]]);
  assert.equal(elect(peers, now).id, 'b');
  assert.deepEqual(sanitize({ inputTokens: 2, outputTokens: 3, secret: 'hidden', path: 'hidden' }), { inputTokens: 2, outputTokens: 3 });
  const locales = await fs.readdir(new URL('../public/i18n', import.meta.url));
  let keys;
  for (const locale of locales.filter((file) => file.endsWith('.json'))) {
    const data = JSON.parse(await fs.readFile(new URL(`../public/i18n/${locale}`, import.meta.url)));
    const current = Object.keys(data.mobilePrototype).sort(); keys ||= current; assert.deepEqual(current, keys, locale);
  }
  console.log('mobile LAN prototype: fragment/path links, reload, retry, pairing, expiry, replay, read-only API, origin checks, sanitization, survivor session and restart passed');
} finally {
  await a?.stop(); await b?.stop();
  await new Promise((resolve) => upstream.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
