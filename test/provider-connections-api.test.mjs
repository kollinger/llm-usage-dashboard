import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const express = require("express");
const { installConnectionsApi } = require("../lib/connections-api");
const app = express(); app.use(express.json());
const calls = [];
const login = {
  start: async ({ label }) => { calls.push(label); return { status: "starting", authUrl: "https://auth.kimi.com/test" }; },
  status: () => ({ status: "waiting", authUrl: "https://auth.kimi.com/test" }), cancel: async () => ({ status: "idle" })
};
installConnectionsApi(app, { middleware: [], available: async (id) => ({ available: id !== "claude", unavailableReason: "cli_missing" }),
  logins: { gpt: login, kimi: login, claude: login },
  keyStore: { refresh: async () => [{ id: "key-test", provider: "glm" }], add: async (body) => {
    calls.push(body); if (body.apiKey === "bad") throw new Error("invalid_key"); return { id: "key-test", provider: body.provider };
  }, remove: async (id) => calls.push(id) },
  listBrowserAccounts: async () => [{ id: "detected:test", provider: "gpt" }],
  removeBrowserAccount: async () => { throw new Error("profile_remove_failed"); }, invalidate: () => calls.push("invalidate")
});
const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const request = async (route, body, method = "POST") => {
  const response = await fetch(`${url}${route}`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
};
try {
  const catalog = await request("/api/connections", null, "GET");
  assert.equal(catalog.data.accounts.length, 2);
  assert.equal(catalog.data.providers.find((p) => p.id === "claude").methods[0].available, false);
  assert.equal(catalog.data.providers.find((p) => p.id === "kimi").methods[0].available, true);
  const start = await request("/api/connections", { provider: "kimi", method: "browser", label: "Personal" });
  assert.equal(start.data.login.id, "kimi"); assert.equal(start.data.login.status, "waiting"); assert(calls.includes("Personal"));
  const unavailable = await request("/api/connections", { provider: "claude", method: "browser" });
  assert.equal(unavailable.status, 400); assert.equal(unavailable.data.error, "cli_missing");
  assert.equal((await request("/api/connections", { provider: "__proto__", method: "browser" })).status, 400);
  assert.equal((await request("/api/connections/login/toString", null, "GET")).status, 404);
  assert.equal((await request("/api/connections/login/kimi", null, "DELETE")).data.status, "idle");
  assert.equal((await request("/api/connections", { provider: "glm", method: "key", apiKey: "bad" })).data.error, "invalid_key");
  const connected = await request("/api/connections", { provider: "glm", method: "key", apiKey: "test-secret" });
  assert.equal(connected.status, 200); assert(!JSON.stringify(connected).includes("test-secret"));
  assert.equal((await request("/api/connections/claude:fixture", null, "DELETE")).data.error, "profile_remove_failed");
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
console.log("Provider connections API: async availability, routing, safe errors and login lifecycle passed.");
