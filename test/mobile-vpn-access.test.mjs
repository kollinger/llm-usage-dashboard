import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { privateAddress, sameSubnet, parseVpnNetworks, networkAllowed } = require("../lib/mobile-access-policy");
const { signToken } = require("../lib/mobile-lan-prototype");

const iface = { address: "192.168.74.5", netmask: "255.255.255.0" };
const networks = parseVpnNetworks("10.73.9.0/24\n172.23.6.5\n192.168.90.128/25");
assert.deepEqual(networks, ["10.73.9.0/24", "172.23.6.5/32", "192.168.90.128/25"]);
assert.deepEqual(parseVpnNetworks(""), []);
assert.deepEqual(parseVpnNetworks("10.73.9.1/32,10.73.9.1"), ["10.73.9.1/32"]);
for (const invalid of [null, [], "0.0.0.0/0", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "10.73.9.1/24", "10.73.9.0/23", "10.73.9.1/033", "10.073.9.1", "10..9.1", "10.73.9.256", "127.0.0.1", "169.254.1.1", "100.64.1.1", "198.51.100.1", "fd00::/64", "::ffff:10.73.9.1", "10.73.9.1/32/path", "10.73.9.1;10.73.9.2", "1".repeat(513), Array(9).fill("10.73.9.1").join("\n")]) {
  assert.throws(() => parseVpnNetworks(invalid), /invalid_vpn_networks/);
}
for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.0.1"]) assert.equal(privateAddress(ip), true);
for (const ip of [undefined, "172.15.0.1", "172.32.0.1", "10.00.0.1", "10.0..1", "192.168.1.999", "::1"]) assert.equal(privateAddress(ip), false);
assert.equal(sameSubnet("192.168.74.6", iface.address, iface.netmask), true);
assert.equal(sameSubnet("garbage", iface.address, iface.netmask), false);
assert.equal(networkAllowed("192.168.74.6", iface, []), true, "LAN needs no VPN allowance");
assert.equal(networkAllowed("10.73.9.5", iface, []), false, "routed private sources are denied by default");
for (const ip of ["10.73.9.0", "10.73.9.255", "172.23.6.5", "192.168.90.128", "192.168.90.255"]) assert.equal(networkAllowed(ip, iface, networks), true);
for (const ip of ["10.73.8.255", "10.73.10.0", "172.23.6.4", "172.23.6.6", "192.168.90.127", "198.51.100.1", "127.0.0.1", "fd00::1"]) assert.equal(networkAllowed(ip, iface, networks), false);

const localeDirectory = new URL("../public/i18n/", import.meta.url);
const locales = new Map(await Promise.all((await fs.readdir(localeDirectory)).filter((file) => file.endsWith(".json")).map(async (file) =>
  [file.slice(0, -5), JSON.parse(await fs.readFile(new URL(file, localeDirectory), "utf8")).mobilePrototype])));
const accessKeys = Object.keys(locales.get("en")).filter((key) => key.startsWith("access")).sort();
const placeholders = (value) => [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
for (const [language, copy] of locales) {
  assert.deepEqual(Object.keys(copy).filter((key) => key.startsWith("access")).sort(), accessKeys, `${language}: access translation keys`);
  for (const key of accessKeys) {
    assert.equal(typeof copy[key], "string", `${language}: ${key}`);
    assert.ok(copy[key].trim(), `${language}: nonempty ${key}`);
    assert.deepEqual(placeholders(copy[key]), placeholders(locales.get("en")[key]), `${language}: ${key} placeholders`);
  }
}
const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const assertDenialPage = (response, { language = "en", key = "accessNetwork", source } = {}) => {
  const copy = locales.get(language);
  assert.equal(response.status, 403);
  assert.equal(response.headers["content-language"], language);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers.vary, "Accept, Accept-Language");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers.location, undefined);
  assert.match(response.headers["content-type"], /^text\/html/);
  assert.ok(response.data.includes(`<html lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}">`));
  assert.ok(response.data.includes(escapeHtml(copy[key])));
  assert.doesNotMatch(response.data, /<(?:script|style|link|img|iframe|form)\b|\s(?:src|href|onclick)=/i, "the denial stays self-contained with the unchanged CSP");
  if (source) {
    assert.ok(response.data.includes(`<code dir="ltr">${source}</code>`));
    assert.ok(response.data.includes('<label for="vpn-source-entry">' + escapeHtml(copy.accessEntry) + '</label>'));
    assert.ok(response.data.includes(`<input id="vpn-source-entry" type="text" dir="ltr" readonly value="${source}/32">`));
    assert.deepEqual([...response.data.matchAll(/value="([^"]*)"/g)].map((match) => match[1]), [`${source}/32`], "suggest exactly the observed address, never a subnet");
    assert.ok(response.data.includes(escapeHtml(copy.accessSource)));
    assert.ok(response.data.includes(escapeHtml(copy.accessNat)));
    assert.ok(!response.data.includes(escapeHtml(copy.accessUnavailable)));
  } else {
    assert.doesNotMatch(response.data, /<input|vpn-source-entry|\/32/);
    assert.ok(!response.data.includes(escapeHtml(copy.accessSource)));
    assert.ok(response.data.includes(escapeHtml(copy.accessUnavailable)) === (key === "accessNetwork"));
  }
};

// Exercise the actual gateway middleware, routes, and pairing ledger, with
// synthetic TCP peer addresses. Only listening/discovery are adapted to make
// this portable: the production network predicate is never bypassed.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "mobile-vpn-"));
const originalInterfaces = os.networkInterfaces;
const originalListen = http.Server.prototype.listen;
const mdns = require("multicast-dns");
const dgram = require("node:dgram");
const originalSocket = dgram.createSocket;
const { EventEmitter } = require("node:events");
let gateway, remote = "192.168.74.6", proxiedRemote = "127.0.0.1";
let upstreamReads = 0;
const upstream = http.createServer((_req, res) => { upstreamReads++; res.setHeader("Content-Type", "application/json"); res.end('{"local":{"totalTokens":42}}'); });
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
try {
  os.networkInterfaces = () => ({ fixture: [{ ...iface, family: "IPv4", internal: false }] });
  // Bind the chosen synthetic interface to loopback without changing the
  // selected interface passed to the production guard.
  http.Server.prototype.listen = function(port, address, callback) { return originalListen.call(this, port, address === iface.address ? "127.0.0.1" : address, callback); };
  // Discovery stays entirely in memory, separate from the HTTP guard.
  const dnsPath = require.resolve("multicast-dns");
  require.cache[dnsPath].exports = () => Object.assign(new EventEmitter(), { respond() {}, destroy(callback) { callback(); } });
  dgram.createSocket = () => Object.assign(new EventEmitter(), { bind(_port, callback) { callback(); }, addMembership() {}, setMulticastInterface() {}, setMulticastTTL() {}, send(...args) { if (typeof args.at(-1) === "function") args.at(-1)(); }, close(callback) { callback(); } });
  // Reload so only transport dependencies are stubbed; no testing flag is set.
  const gatewayPath = require.resolve("../lib/mobile-lan-prototype");
  delete require.cache[gatewayPath];
  const start = require(gatewayPath).startMobilePrototype;
  gateway = await start({ address: iface.address, port: 0, httpsOrigin: "https://phone.example.invalid", httpsProxyPort: 0,
    upstream: `http://127.0.0.1:${upstream.address().port}`, groupFile: path.join(temporary, "group.json"), label: "Synthetic fixture",
    vpnNetworks: networks.join("\n") });
  gateway.server.prependListener("request", (req) => Object.defineProperty(req.socket, "remoteAddress", { value: remote, configurable: true }));
  gateway.proxyServer.prependListener("request", (req) => Object.defineProperty(req.socket, "remoteAddress", { value: proxiedRemote, configurable: true }));
  const send = (route, { method = "GET", headers = {}, body, proxy = false } = {}) => new Promise((resolve, reject) => {
    const server = proxy ? gateway.proxyServer : gateway.server;
    const baseHeaders = proxy ? { Host: "phone.example.invalid", "X-Forwarded-Proto": "https" } : { Host: `${iface.address}:${server.address().port}` };
    const request = http.request({ host: "127.0.0.1", port: server.address().port, path: route, method, agent: false,
      headers: { ...baseHeaders, ...headers } }, (response) => {
      let data = ""; response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, data, json: () => JSON.parse(data) }));
    });
    request.on("error", reject); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await send("/api/usage")).status, 401, "same LAN reaches pairing boundary");
  const code = signToken(gateway.group, "pair", 60_000);
  remote = "10.73.10.7";
  assert.equal((await send(`/pair/${code}`)).status, 403, "a valid code does not grant network access");
  assert.equal((await send("/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: { code } })).status, 403, "unallowed sources cannot redeem a valid code");
  remote = "10.73.9.7";
  assert.equal((await send("/api/usage")).status, 401, "allowed VPN still requires pairing");
  assert.equal((await send(`/pair/${code}`)).status, 200, "VPN GET only displays the pairing page");
  assert.equal((await send("/api/usage")).status, 401);
  const invalidPair = await send("/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: { code: "invalid" } });
  assert.equal(invalidPair.status, 401);
  const paired = await send("/pair", { method: "POST", headers: { "Content-Type": "application/json", Origin: `http://${iface.address}:${gateway.server.address().port}` }, body: { code } });
  assert.equal(paired.status, 200, "valid pairing works from a routed private VPN");
  const cookie = paired.headers["set-cookie"][0].split(";")[0];
  assert.match(paired.headers["set-cookie"][0], /HttpOnly/); assert.match(paired.headers["set-cookie"][0], /SameSite=Strict/);
  assert.equal((await send("/api/usage", { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await send("/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: { code } })).status, 401, "pairing token stays single-use");
  assert.equal((await send("/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: { code: signToken(gateway.group, "pair", -1) } })).status, 401);
  assert.equal((await send("/api/settings", { method: "POST", headers: { Cookie: cookie } })).status, 405);
  assert.equal((await send("/api/accounts", { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await send("/api/mobile-prototype/status", { headers: { Cookie: cookie } })).data.includes("vpnNetworks"), false);
  for (const headers of [{ Host: "attacker.invalid" }, { Host: "attacker.invalid", "X-Forwarded-Host": iface.address }, { Origin: "https://attacker.invalid" }, { "Sec-Fetch-Site": "cross-site" }, { Host: "phone.example.invalid", "X-Forwarded-Proto": "https" }]) {
    assert.equal((await send("/api/usage", { headers: { Cookie: cookie, ...headers } })).status, 403, "VPN allowance never bypasses Host/Origin/cross-site restrictions");
    const html = await send(`/pair/${code}`, { headers: { Accept: "text/html", Cookie: cookie, ...headers } });
    assertDenialPage(html, { key: headers.Origin || headers["Sec-Fetch-Site"] ? "accessOrigin" : "accessHost" });
    for (const secret of [remote, iface.address, code, cookie, "attacker.invalid", "phone.example.invalid"]) assert.ok(!html.data.includes(secret), "other denial reasons never expose addresses or request secrets");
  }
  const nameHost = new URL(gateway.url).host;
  assert.equal((await send("/api/usage", { headers: { Cookie: cookie, Host: nameHost } })).status, 200);
  for (const source of ["10.73.10.7", "172.23.6.6", "198.51.100.4", "127.0.0.1", "fd00::7"]) {
    remote = source;
    const before = upstreamReads;
    for (const headers of [{}, { "X-Forwarded-For": "192.168.74.6", "X-Forwarded-Host": iface.address, "X-Forwarded-Proto": "https", Forwarded: 'for=10.73.9.7;host=phone.example.invalid;proto=https' }]) {
      const denied = await send("/api/usage", { headers: { Cookie: cookie, ...headers } });
      assert.equal(denied.status, 403); assert.deepEqual(denied.json(), { error: "lan_only", reason: "network_not_allowed" }, "JSON denials remain free of diagnostics");
    }
    assert.equal(upstreamReads, before, "unallowed sources never read data, even with a valid cookie");
    assert.equal((await send("/api/code", { method: "POST" })).status, 403);
  }
  const spoofedHeaders = [{}, { "X-Forwarded-For": "10.73.9.44" }, { Forwarded: 'for=10.73.9.44;host=spoofed.example.invalid;proto=https' },
    { "X-Forwarded-For": "10.73.9.44, 203.0.113.87", "X-Forwarded-Host": "spoofed.example.invalid", "X-Forwarded-Proto": "https", Forwarded: 'for=10.73.9.44;host=spoofed.example.invalid;proto=https' }];
  for (const source of ["10.73.10.7", "172.23.6.6", "192.168.91.17", "::ffff:10.73.10.7", "::FFFF:172.23.6.6"]) {
    remote = source;
    const normalized = source.replace(/^::ffff:/i, "");
    const before = upstreamReads;
    for (const headers of spoofedHeaders) {
      const denied = await send(`/pair/${code}?return=https://request.example.invalid`, { headers: { Accept: "text/html", Cookie: cookie, ...headers } });
      assertDenialPage(denied, { source: normalized });
      for (const secret of [code, cookie, iface.address, nameHost, ...networks, "10.73.9.44", "203.0.113.87", "spoofed.example.invalid", "request.example.invalid"]) assert.ok(!denied.data.includes(secret), `must not disclose ${secret}`);
      if (source !== normalized) assert.ok(!denied.data.includes(source), "mapped addresses are displayed as IPv4");
    }
    for (const route of ["/", "/api/usage", "/api/chat-usage", "/api/accounts", "/api/mobile-prototype/status", "/mobile-prototype/client.js", "/i18n/en.json"]) {
      assertDenialPage(await send(route, { headers: { Accept: "text/html", Cookie: cookie } }), { source: normalized });
    }
    assert.equal((await send("/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: { code } })).status, 403, "seeing a /32 entry never grants pairing");
    assert.equal(upstreamReads, before, "diagnostics never fetch protected data, including with an existing phone cookie");
  }
  for (const source of ["198.51.100.4", "8.8.8.8", "172.15.0.1", "172.32.0.1", "127.0.0.1", "169.254.1.1", "100.64.1.1", "0.0.0.0", "::ffff:198.51.100.4", "::1", "fd00::7", "2001:db8::7", "::ffff:a49:a07", "garbage", "10.073.10.7", "10.73.10.256", "10.73.10.7/32", '10.73.10.7\"><script>alert(1)</script>', "", undefined, null]) {
    remote = source;
    const before = upstreamReads;
    for (const headers of spoofedHeaders) {
      const denied = await send(`/pair/${code}`, { headers: { Accept: "text/html", Cookie: cookie, ...headers } });
      assertDenialPage(denied);
      for (const secret of [code, cookie, iface.address, "10.73.9.44", "203.0.113.87", "spoofed.example.invalid"]) assert.ok(!denied.data.includes(secret));
      if (source) assert.ok(!denied.data.includes(source), "unsupported sources are not echoed");
    }
    assert.equal(upstreamReads, before);
  }
  remote = "10.73.10.7";
  for (const [language, copy] of locales) {
    const denied = await send("/", { headers: { Accept: "text/html", "Accept-Language": language } });
    assertDenialPage(denied, { language, source: remote });
    assert.ok(denied.data.includes(escapeHtml(copy.accessNat)));
  }
  const denied = await send(`/pair/${code}`, { headers: { Accept: "text/html", "Accept-Language": "de-DE,de;q=0.9,en;q=0.5" } });
  assertDenialPage(denied, { language: "de", source: remote });
  assert.match(denied.data, /Quellnetz/); assert.match(denied.data, /Namensauflösung/);
  assert.ok(!denied.data.includes(code) && !denied.data.includes(iface.address));
  const arabic = await send("/", { headers: { Accept: "text/html", "Accept-Language": "ar" } });
  assert.match(arabic.data, /dir="rtl"/);
  assert.match((await send("/", { headers: { Accept: "text/html" } })).data, /lang="en"/);
  assertDenialPage(await send("/", { headers: { Accept: "text/html", "Accept-Language": "xx" } }), { source: remote });
  remote = "::ffff:10.73.9.7";
  assert.equal((await send("/api/usage", { headers: { Cookie: cookie } })).status, 200, "IPv4-mapped socket addresses use the same VPN rule");
  remote = "192.168.74.6";
  assert.equal((await send("/api/usage", { headers: { Cookie: cookie } })).status, 200, "LAN pairing remains valid");
  const secureCode = signToken(gateway.group, "pair", 60_000);
  const securePair = await send("/pair", { proxy: true, method: "POST", headers: { Origin: "https://phone.example.invalid", "Content-Type": "application/json" }, body: { code: secureCode } });
  assert.equal(securePair.status, 200); assert.match(securePair.headers["set-cookie"][0], /Secure/);
  const secureCookie = securePair.headers["set-cookie"][0].split(";")[0];
  assert.equal((await send("/api/usage", { proxy: true, headers: { Cookie: secureCookie, "X-Forwarded-For": "198.51.100.4" } })).status, 200, "the dedicated loopback HTTPS route retains its contract");
  for (const headers of [{ Host: "attacker.invalid" }, { "X-Forwarded-Proto": "http" }, { Origin: "http://phone.example.invalid" }, { "Sec-Fetch-Site": "cross-site" }]) {
    assert.equal((await send("/api/usage", { proxy: true, headers: { Cookie: secureCookie, ...headers } })).status, 403);
    assertDenialPage(await send("/", { proxy: true, headers: { Accept: "text/html", Cookie: secureCookie, ...headers } }), { key: headers.Origin || headers["Sec-Fetch-Site"] ? "accessOrigin" : "accessHost" });
  }
  proxiedRemote = "10.73.9.7";
  assert.equal((await send("/api/usage", { proxy: true, headers: { Cookie: secureCookie } })).status, 403, "VPN allowances do not widen the HTTPS proxy's loopback trust");
  const proxyDenial = await send("/", { proxy: true, headers: { Accept: "text/html", Cookie: secureCookie } });
  assertDenialPage(proxyDenial, { key: "accessHost" });
  assert.ok(!proxyDenial.data.includes(proxiedRemote), "proxy denials never receive source diagnostics");
  await gateway.stop();
  gateway = await start({ address: iface.address, port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`,
    groupFile: path.join(temporary, "group.json"), label: "Synthetic fixture" });
  gateway.server.prependListener("request", (req) => Object.defineProperty(req.socket, "remoteAddress", { value: remote, configurable: true }));
  remote = "10.73.9.7";
  assert.equal((await send("/api/usage", { headers: { Cookie: cookie } })).status, 403, "removing VPN allowances blocks an already paired source");
  remote = "192.168.74.6";
  assert.equal((await send("/api/usage", { headers: { Cookie: cookie } })).status, 200, "default LAN access survives gateway restart without VPN allowances");
} finally {
  await gateway?.stop();
  os.networkInterfaces = originalInterfaces; http.Server.prototype.listen = originalListen; dgram.createSocket = originalSocket;
  require.cache[require.resolve("multicast-dns")].exports = mdns;
  await new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); });
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log("VPN access: production LAN/VPN source guard, CIDR bounds, pairing, read-only routes, hostile headers, localized denials and HTTPS passed.");
