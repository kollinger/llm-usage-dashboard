import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";

const tmp = await mkdtemp(path.join(os.tmpdir(), "llm-connections-api-"));
process.env.LLM_USAGE_DATA_DIR = tmp;
const require = createRequire(import.meta.url);
const { app } = require("../server");
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  const status = await fetch(`${url}/api/device-sync`).then((response) => response.json());
  assert.equal(status.enabled, false);
  assert.equal(status.deviceId, null, "disabled installs create neither keys nor listeners");
  for (const headers of [{ Origin: "https://attacker.example" }, { Host: "attacker.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request(`${url}/api/device-sync/settings`, { method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ enabled: true, name: "test" }));
    });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.body.error, "local_control_only");
  }
  assert.equal((await fetch(`${url}/api/device-sync/invite`, { method: "POST" })).status, 400);
  const own = "11111111-2222-3333-4444-555555555555";
  await mkdir(path.join(tmp, "codex-profiles", own), { recursive: true });
  await writeFile(path.join(tmp, "codex-profiles", own, "auth.json"), "test-only");
  await writeFile(path.join(tmp, "keep.txt"), "keep");
  assert.equal((await fetch(`${url}/api/gpt-accounts/profiles/keep.txt`, { method: "DELETE" })).status, 400);
  assert.equal((await fetch(`${url}/api/gpt-accounts/profiles/${own}`, { method: "DELETE" })).status, 200);
  assert.equal(await readFile(path.join(tmp, "keep.txt"), "utf8"), "keep");
  await assert.rejects(readFile(path.join(tmp, "codex-profiles", own, "auth.json")));
  const icons = await fetch(`${url}/vendor/lucide/lucide.js`);
  assert.equal(icons.status, 200);
  assert((await icons.text()).includes("createIcons"));
  const source = await readFile(new URL("../electron/main.js", import.meta.url), "utf8");
  assert(source.includes('host: "127.0.0.1"'), "desktop dashboard and Ollama proxy must bind to loopback");
} finally {
  await fetch(`${url}/api/device-sync/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false, name: "test" }) }).catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(tmp, { recursive: true, force: true });
}
console.log("Connection APIs: local controls, CSRF/rebinding rejection, scoped removal and local icons passed.");
