import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createKimiRuntime, KIMI_RUNTIME_VERSION } = require("../lib/kimi-runtime.js");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-runtime-test-"));
const binary = Buffer.from("fixture-only Kimi binary; never executed\n");
const checksum = crypto.createHash("sha256").update(binary).digest("hex");
const releases = Object.fromEntries(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"].map((key) => [key, checksum]));
const controllers = [];
let sequence = 0;
const runtime = (options = {}) => {
  const toolsDir = path.join(root, String(++sequence), "tools", "kimi");
  const result = createKimiRuntime({ toolsDir, platform: "darwin", arch: "arm64", releases, ...options });
  controllers.push(result);
  return { app: result, toolsDir };
};
const response = (body = binary, options = {}) => new Response(body, { status: 200, headers: { "content-length": String(body.length) }, ...options });
const until = async (predicate) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } assert.fail("condition did not become true"); };
const listFiles = async (dir) => fs.readdir(dir, { recursive: true }).catch(() => []);

try {
  {
    const { app, toolsDir } = runtime({ fetchImpl: () => assert.fail("catalog must not download") });
    assert.deepEqual(app.availability(), { available: true, managed: true, version: "2.1.1" });
    assert.equal(await app.resolve(), null);
    assert.deepEqual(await listFiles(toolsDir), []);
    assert.equal(app.status().status, "missing");
    assert.equal(KIMI_RUNTIME_VERSION, "2.1.1");
    const unsupported = runtime({ platform: "freebsd" });
    assert.deepEqual(unsupported.app.availability(), { available: false, error: "kimi_runtime_unsupported" });
    await assert.rejects(unsupported.app.ensure(), /kimi_runtime_unsupported/);
    assert.deepEqual(await listFiles(unsupported.toolsDir), []);
  }
  {
    const calls = [];
    const { app, toolsDir } = runtime({ fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith("https://code.kimi.com/")) return new Response(null, { status: 302, headers: { location: url.replace("code.kimi.com", "cdn.kimi.com") } });
      return response();
    } });
    const executable = await app.ensure();
    assert.equal(executable, path.join(toolsDir, "2.1.1", "darwin-arm64", "kimi-code-darwin-arm64"));
    assert.deepEqual(await fs.readFile(executable), binary);
    if (process.platform !== "win32") assert.equal((await fs.stat(executable)).mode & 0o777, 0o700);
    assert.match(await fs.readFile(path.join(path.dirname(executable), "LICENSE"), "utf8"), /Copyright \(c\) 2026 Moonshot AI/);
    assert.equal(await app.resolve(), executable);
    assert.equal(await app.ensure(), executable);
    assert.equal(calls.length, 2, "cached helper must not be re-downloaded");
    assert.equal(app.status().status, "ready");
    assert.equal(app.status().downloadedBytes, binary.length);
    assert(!JSON.stringify(app.status()).includes(toolsDir), "public status must not leak filesystem paths");
    for (const { url, init } of calls) {
      assert.match(url, /^https:\/\/(?:code|cdn)\.kimi\.com\/kimi-code\/binaries\/2\.1\.1\/kimi-code-darwin-arm64$/);
      assert.equal(init.method, "GET"); assert.equal(init.redirect, "manual");
      assert.equal(init.headers.Authorization, undefined);
    }
    await fs.writeFile(executable, "corruption");
    assert.equal(await app.resolve(), null, "changed helper must be rehashed before use");
    assert.equal(await app.ensure(), executable);
    assert.deepEqual(await fs.readFile(executable), binary);
    assert.equal(calls.length, 4);
    const reopened = runtime({ toolsDir, fetchImpl: () => assert.fail("existing verified helper should remain usable offline") }).app;
    assert.equal(await reopened.resolve(), executable);
  }
  {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let downloads = 0;
    const { app } = runtime({ fetchImpl: async () => { downloads++; await gate; return response(); } });
    const first = app.ensure(), second = app.ensure();
    assert.equal(first, second, "concurrent logins must share one download");
    await until(() => downloads === 1); release();
    assert.equal(await first, await second);
    assert.equal(downloads, 1);
  }
  for (const location of ["https://evil.example/file", "https://code.kimi.com.evil.example/file", "http://cdn.kimi.com/file", "https://user@cdn.kimi.com/kimi-code/binaries/2.1.1/kimi-code-darwin-arm64", "https://cdn.kimi.com/other", "https://cdn.kimi.com/kimi-code/binaries/2.1.1/kimi-code-darwin-arm64?token=private"]) {
    let calls = 0;
    const { app, toolsDir } = runtime({ fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location } }); } });
    await assert.rejects(app.ensure(), /kimi_runtime_download_failed/);
    assert.equal(calls, 1, "untrusted redirect must be rejected without requesting it");
    assert(!(await listFiles(toolsDir)).some((item) => item.endsWith(".download")));
  }
  {
    let calls = 0;
    const { app } = runtime({ fetchImpl: async (url) => { calls++; return new Response(null, { status: 302, headers: { location: url } }); } });
    await assert.rejects(app.ensure(), /kimi_runtime_download_failed/);
    assert.equal(calls, 4, "redirect loop must be bounded");
  }
  for (const [fetchImpl, maxBytes, expected] of [
    [async () => response(Buffer.from("wrong hash")), 100, "integrity_failed"],
    [async () => response(binary, { headers: { "content-length": "301" } }), 100, "download_too_large"],
    [async () => response(binary, { headers: {} }), 5, "download_too_large"],
    [async () => response(binary, { headers: { "content-length": "99" } }), 100, "integrity_failed"],
    [async () => new Response("secret response", { status: 403 }), 100, "download_failed"],
    [async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("private transport error")); } })), 100, "download_failed"]
  ]) {
    const { app, toolsDir } = runtime({ fetchImpl, maxBytes });
    await assert.rejects(app.ensure(), new RegExp(`^Error: kimi_runtime_${expected}$`));
    assert.equal(await app.resolve(), null);
    assert(!(await listFiles(toolsDir)).some((item) => item.includes(".download") || item.endsWith("kimi-code-darwin-arm64")));
    assert(!JSON.stringify(app.status()).includes("secret"));
    assert(!JSON.stringify(app.status()).includes("private"));
  }
  {
    const stalled = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("internal abort detail")), { once: true }));
    const { app, toolsDir } = runtime({ fetchImpl: stalled, timeoutMs: 25 });
    // Keep the process alive while testing an intentionally unref'd timeout.
    const keepAlive = setInterval(() => {}, 50);
    try { await assert.rejects(app.ensure(), /kimi_runtime_download_timeout/); } finally { clearInterval(keepAlive); }
    assert.equal(app.status().error, "kimi_runtime_download_timeout");
    assert(!(await listFiles(toolsDir)).some((item) => item.includes(".download")));
  }
  {
    let streaming = false, cancellations = 0, shouldStall = true;
    const { app, toolsDir } = runtime({ fetchImpl: async (_url, { signal }) => {
      if (!shouldStall) return response();
      return new Response(new ReadableStream({
        start(stream) { streaming = true; stream.enqueue(binary.subarray(0, 4)); signal.addEventListener("abort", () => stream.error(new Error("aborted")), { once: true }); },
        cancel() { cancellations++; }
      }));
    } });
    const download = app.ensure();
    const rejection = assert.rejects(download, /kimi_runtime_cancelled/);
    await until(() => streaming && app.status().downloadedBytes > 0);
    await app.cancel(); await rejection;
    assert.equal(await app.resolve(), null);
    assert(!(await listFiles(toolsDir)).some((item) => item.includes(".download")));
    shouldStall = false;
    assert(await app.ensure(), "cancelled download can be retried");
    await app.close();
    assert.equal(await app.resolve(), null);
    await assert.rejects(app.ensure(), /kimi_runtime_cancelled/);
    assert(cancellations >= 0);
  }
  {
    const outside = path.join(root, "outside"); await fs.mkdir(outside);
    const { app, toolsDir } = runtime({ fetchImpl: () => assert.fail("unsafe storage must fail before network") });
    await fs.mkdir(path.dirname(toolsDir), { recursive: true });
    await fs.symlink(outside, toolsDir, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(app.ensure(), /kimi_runtime_storage_unsafe/);
    assert.deepEqual(await fs.readdir(outside), []);
  }
  for (const target of Object.keys(releases)) {
    const [platform, arch] = target.split("-");
    const { app } = runtime({ platform, arch, fetchImpl: async () => response() });
    assert.equal(app.availability().available, true);
    const executable = await app.ensure();
    assert.equal(path.basename(executable), `kimi-code-${target}${platform === "win32" ? ".exe" : ""}`);
    assert.equal(await app.resolve(), executable);
  }
  console.log("Kimi runtime: pinned integrity, private storage, redirects, cancellation, retries, and all platform paths passed.");
} finally {
  await Promise.allSettled(controllers.map((controller) => controller.close()));
  await fs.rm(root, { recursive: true, force: true });
}
