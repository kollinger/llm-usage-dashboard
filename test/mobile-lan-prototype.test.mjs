import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startMobilePrototype, loadGroup, signToken, verifyToken, sanitize, elect } = require('../lib/mobile-lan-prototype');

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
  const code = signToken(group, 'pair', 60_000);
  assert.equal(verifyToken(group, code, 'phone'), false);
  assert.equal(verifyToken(group, signToken(group, 'pair', 100, Date.now() - 200), 'pair'), false);
  const response = await get(a, '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal((await get(a, '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).status, 401);
  const usage = await (await get(a, '/api/usage', { headers: { Cookie: cookie } })).json();
  assert.equal(usage.local.totalTokens, 123); assert.equal(usage.nested.outputTokens, 42);
  assert.equal(usage.email, undefined); assert.equal(usage.accessToken, undefined); assert.equal(usage.nested.file, undefined);
  assert.equal((await get(a, '/api/updates/check', { method: 'POST', headers: { Cookie: cookie } })).status, 405);
  assert.equal((await get(a, '/api/support/report', { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await get(a, '/api/group-code', { headers: { Cookie: cookie } })).status, 403);
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
  console.log('mobile LAN prototype: pairing, expiry, replay, read-only API, origin checks, sanitization, survivor session and restart passed');
} finally {
  await a?.stop(); await b?.stop();
  await new Promise((resolve) => upstream.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
