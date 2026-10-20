import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const express = require("express");
const { buildDesktopWidgetSnapshot } = require("../lib/desktop-widget");
const { widgetUsageFixture, claudeUsageFixture } = require("./fixtures/desktop-widget.cjs");
const source = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
const app = express();
let reads = 0, fail = false;
const fixture = widgetUsageFixture(5);
fixture.rawProviderPayload = "PRIVATE_FIXTURE_SENTINEL";
const context = vm.createContext({ app, URL, buildDesktopWidgetSnapshot,
  isAuthed: (req) => req.get("X-Fixture-Authenticated") === "yes",
  markInteractiveUsageRequest() {},
  async readUsageDashboard(options) {
    assert.equal(options.force, undefined, "widget cannot force a second collector scan");
    assert.equal(options.staleWhileRefresh, true);
    reads++;
    if (fail) throw new Error("PRIVATE_FIXTURE_SENTINEL");
    return fixture;
  }
});
for (const name of ["authMiddleware", "localControlMiddleware"]) {
  const fn = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert(fn, `production ${name} must be tested`); vm.runInContext(fn, context);
}
const route = source.slice(source.indexOf('app.get("/api/desktop-widget"'), source.indexOf('app.get("/api/chat-usage"'));
assert(route.trim()); vm.runInContext(route, context);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const request = (headers) => new Promise((resolve, reject) => {
  const req = http.get(`${origin}/api/desktop-widget`, { headers, agent: false }, (res) => {
    let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on("error", reject);
});
try {
  assert.equal((await request({})).status, 401);
  assert.equal(reads, 0);
  const authenticated = { "X-Fixture-Authenticated": "yes" };
  for (const headers of [{ Origin: "https://attacker.invalid" }, { Origin: "garbage" }, { Host: "attacker.invalid" }, { "Sec-Fetch-Site": "cross-site" }]) {
    const response = await request({ ...authenticated, ...headers });
    assert.equal(response.status, 403); assert.equal(JSON.parse(response.body).error, "local_control_only");
  }
  assert.equal(reads, 0, "rejected requests never collect data");
  const response = await request({ ...authenticated, Origin: origin });
  assert.equal(response.status, 200); assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(JSON.parse(response.body).accounts.length, 5);
  assert(!response.body.includes("PRIVATE_FIXTURE_SENTINEL"));
  assert.equal(reads, 1);
  fixture.gptAccounts.accounts = [];
  fixture.connectedAccounts = [];
  fixture.claudeCode = claudeUsageFixture().claudeCode;
  const local = JSON.parse((await request(authenticated)).body).accounts;
  assert.equal(local.length, 1, "actual route exposes local Claude without a managed connection");
  assert.equal(local[0].provider, "claude");
  assert.deepEqual(local[0].sources, ["local"]);
  assert.equal(local[0].windows[0].remainingPercent, 0);
  assert.equal(local[0].windows[1].remainingPercent, null);
  fail = true;
  const unavailable = await request(authenticated);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(JSON.parse(unavailable.body), { error: "widget_unavailable" });
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
console.log("Desktop widget API: production route/middleware, shared reader, authentication, local origin/host checks, no-store and sanitized failures passed.");
