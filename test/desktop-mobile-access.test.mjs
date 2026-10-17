import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createDesktopMobileAccess } = require("../lib/desktop-mobile-access");
const { startMobilePrototype, loadGroup } = require("../lib/mobile-lan-prototype");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-mobile-"));
const upstream = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ codex: { status: "live" } })); });
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
let address = "127.0.0.1", starts = 0, fail = false;
const gateways = [];
const options = { dataDir: path.join(temporary, "first"), upstream: `http://127.0.0.1:${upstream.address().port}`,
  interfaces: () => address ? [{ address }] : [], start: async (config) => {
    if (fail) throw Object.assign(new Error("busy"), { code: "EADDRINUSE" });
    starts++;
    const gateway = await startMobilePrototype({ ...config, port: 0, testing: true });
    gateways.push(gateway); return gateway;
  } };
const managers = [];
const create = (extra = {}) => { const manager = createDesktopMobileAccess({ ...options, ...extra }); managers.push(manager); return manager; };
try {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const candidatePort = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  await assert.rejects(startMobilePrototype({ address: "127.0.0.1", port: candidatePort, testing: true,
    groupFile: path.join(temporary, "conflict/group.json"), upstream: options.upstream, controlPort: upstream.address().port }), { code: "EADDRINUSE" });
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(candidatePort, "127.0.0.1", resolve); });
  await new Promise((resolve) => probe.close(resolve));
  const first = create();
  assert.equal((await first.init()).enabled, false, "fresh installation never exposes LAN before activation");
  assert.equal(starts, 0);
  await Promise.all([first.setEnabled(true), first.refresh(), first.refresh()]);
  assert.equal(starts, 1, "concurrent actions start one gateway");
  let status = first.status(), gateway = gateways.at(-1);
  const root = path.join(options.dataDir, "mobile-access");
  const group = await loadGroup(path.join(root, "group.json"));
  // Use the actual gateway's cookie name, not an assumed authentication bypass.
  const response = await fetch(`${status.controlUrl}/api/code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ direct: true }) });
  const pairing = await response.json();
  assert.equal(typeof pairing.svg, "string");
  const origin = `http://127.0.0.1:${gateway.server.address().port}`;
  assert.equal((await fetch(`${origin}/api/usage`)).status, 401);
  const paired = await fetch(`${origin}/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: new URL(pairing.url).hash.slice(1) }) });
  assert.equal(paired.status, 200);
  const phoneCookie = paired.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${origin}/api/usage`, { headers: { Cookie: phoneCookie } })).status, 200);
  await first.stop();
  const restarted = create();
  await restarted.init(); gateway = gateways.at(-1);
  const nextOrigin = `http://127.0.0.1:${gateway.server.address().port}`;
  assert.equal(restarted.status().enabled, true, "activation persists across app restarts");
  assert.equal((await loadGroup(path.join(root, "group.json"))).key, group.key);
  assert.equal((await fetch(`${nextOrigin}/api/usage`, { headers: { Cookie: phoneCookie } })).status, 200, "existing phone stays paired after restart");
  const replay = await fetch(`${nextOrigin}/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: new URL(pairing.url).hash.slice(1) }) });
  assert.equal(replay.status, 401, "used pairing link stays consumed after restart");
  await assert.rejects(restarted.setHttpsOrigin("http://private.example.invalid"), /invalid_https_origin/);
  await assert.rejects(restarted.setHttpsOrigin("https://private.example.invalid/path"), /invalid_https_origin/);
  await restarted.setHttpsOrigin("https://private.example.invalid/");
  gateway = gateways.at(-1);
  assert.equal(gateway.proxyServer.address().address, "127.0.0.1");
  assert.equal(gateway.proxyServer.address().port, 41781);
  const secureCode = await (await fetch(`${restarted.status().controlUrl}/api/code`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ https: true }) })).json();
  assert.equal(new URL(secureCode.linkUrl).origin, "https://private.example.invalid");
  const proxy = "http://127.0.0.1:41781";
  assert.equal((await fetch(`${proxy}/api/usage`)).status, 403, "untrusted loopback host is rejected");
  const securePair = await new Promise((resolve, reject) => {
    const request = http.request(`${proxy}/pair`, { method: "POST", headers: {
      Host: "private.example.invalid", "X-Forwarded-Proto": "https", Origin: "https://private.example.invalid",
      "Content-Type": "application/json" } }, (response) => {
      response.resume(); response.on("end", () => resolve({ status: response.statusCode,
        headers: new Headers(response.headers) }));
    });
    request.on("error", reject); request.end(JSON.stringify({ code: new URL(secureCode.url).hash.slice(1) }));
  });
  assert.equal(securePair.status, 200);
  assert.match(securePair.headers.get("set-cookie"), /Secure/);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "settings.json"))).httpsOrigin, "https://private.example.invalid");
  await restarted.setHttpsOrigin("https://other.example.invalid");
  assert.equal(restarted.status().running, true, "changing the private HTTPS host keeps LAN available");
  await restarted.setHttpsOrigin("");
  assert.equal(gateways.at(-1).proxyServer, null, "clearing the origin closes the optional proxy");
  address = null; await restarted.refresh(); assert.equal(restarted.status().reason, "noLan");
  address = "127.0.0.1"; await restarted.refresh(); assert.equal(restarted.status().running, true, "recovers after Wi-Fi returns");
  await restarted.setEnabled(false); assert.equal(restarted.status().running, false);
  const disabled = create(); await disabled.init(); assert.equal(disabled.status().enabled, false, "explicit opt-out persists");
  await assert.rejects(disabled.setEnabled("true"), /invalid_mobile_setting/);
  fail = true; await disabled.setEnabled(true); assert.equal(disabled.status().reason, "portBusy");
  fail = false; await disabled.refresh(); assert.equal(disabled.status().running, true); await disabled.stop();
  const independent = create({ dataDir: path.join(temporary, "second") }); await independent.init(); await independent.setEnabled(true);
  const secondGroup = await loadGroup(path.join(temporary, "second/mobile-access/group.json"));
  assert.notEqual(secondGroup.key, group.key, "another user's installation gets an independent key"); await independent.stop();
  const migrated = create({ dataDir: path.join(temporary, "migrated"), legacyDirectory: root });
  await migrated.init(); await migrated.setEnabled(true);
  assert.equal((await loadGroup(path.join(temporary, "migrated/mobile-access/group.json"))).key, group.key);
  assert.equal(await fs.readFile(path.join(temporary, "migrated/mobile-access/mobile-prototype-spent.json"), "utf8"), await fs.readFile(path.join(root, "mobile-prototype-spent.json"), "utf8"));
  assert.equal((await fs.stat(path.join(temporary, "migrated/mobile-access/group.json"))).mode & 0o777, 0o600);

  const native = await fs.readFile(new URL("../electron/main.js", import.meta.url), "utf8");
  const trusted = native.match(/function trustedMobileRequest\(event\) \{[\s\S]*?\n\}/)[0];
  const sender = {};
  const context = vm.createContext({ URL, mainWindow: { webContents: sender }, dashboardPort: 1234 });
  vm.runInContext(`${trusted}; this.validate = trustedMobileRequest;`, context);
  assert.doesNotThrow(() => context.validate({ sender, senderFrame: { url: "http://127.0.0.1:1234/" } }));
  assert.doesNotThrow(() => context.validate({ sender, senderFrame: { url: "http://localhost:1234/" } }), "the installed dashboard uses localhost");
  assert.throws(() => context.validate({ sender, senderFrame: { url: "http://localhost:9876/" } }), /untrusted/);
  assert.throws(() => context.validate({ sender: {}, senderFrame: { url: "http://127.0.0.1:1234/" } }), /untrusted/);
  assert.throws(() => context.validate({ sender, senderFrame: { url: "https://example.com/" } }), /untrusted/);
  const english = JSON.parse(await fs.readFile(new URL("../public/i18n/en.json", import.meta.url), "utf8"));
  for (const file of await fs.readdir(new URL("../public/i18n/", import.meta.url))) {
    if (!file.endsWith(".json")) continue;
    const locale = JSON.parse(await fs.readFile(new URL(`../public/i18n/${file}`, import.meta.url), "utf8"));
    assert.deepEqual(Object.keys(locale.settings.mobile).sort(), Object.keys(english.settings.mobile).sort(), file);
    for (const value of Object.values(locale.settings.mobile)) assert.ok(typeof value === "string" && value.trim(), file);
    for (const key of ["copyLink", "copied", "copyError", "desktopTitle"]) assert.ok(locale.mobilePrototype[key]?.trim(), `${file}:${key}`);
  }
} finally {
  await Promise.all(managers.map((manager) => manager.stop()));
  await new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); });
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log("Desktop phone access: independent users, pairing/replay persistence, opt-out, network recovery, native boundary and translations passed.");
