"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

// Pinned official release, verified 2026-10-05. Checksums are for the raw binary,
// not its archive. Never trust a downloaded mutable manifest as the authority.
// https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.1.1
// https://code.kimi.com/kimi-code/binaries/2.1.1/manifest.json
const VERSION = "2.1.1";
const RELEASES = Object.freeze({
  "darwin-arm64": "4bab6f96c2c289368b7f05a04f66737c53a59ce740f932d8f149240584758efb",
  "darwin-x64": "ed3215af6eeb8979c99dbe0761484ed8f08198ef0f6ca1785637f60b1463ca95",
  "linux-arm64": "8bcc0a2267a0ecb1ff48cad284f7e364528a01598f38d696ec1baa6b069a88c8",
  "linux-x64": "66f47536e40b02bb1d577cdd324768f73d39b8b9472e0ca140e73d8e225cd7de",
  "win32-arm64": "4e70de861344c5f20fdcdede0a3afa08493608479cdd313f7bf0b09313b47007",
  "win32-x64": "28096756410623f0413607b10872dc16fe8c037c87b005821030daba569a32d4"
});
const ORIGINS = new Set(["https://code.kimi.com", "https://cdn.kimi.com"]);
const MAX_BYTES = 300 * 1024 * 1024;

// Verbatim license at the pinned tag, retained beside each downloaded helper:
// https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai/kimi-code%402.1.1/LICENSE
const LICENSE = `MIT License

Copyright (c) 2026 Moonshot AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const errorCode = (error) => /^kimi_runtime_[a-z_]+$/.test(error?.message || "") ? error.message : "kimi_runtime_download_failed";
const fingerprint = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;

function createKimiRuntime({ toolsDir, fetchImpl = fetch, platform = process.platform, arch = process.arch,
  timeoutMs = 120_000, maxBytes = MAX_BYTES, releases = RELEASES } = {}) {
  if (typeof toolsDir !== "string" || !toolsDir) throw new TypeError("toolsDir is required");
  const target = `${platform}-${arch}`;
  const checksum = releases[target];
  const supported = /^[a-f0-9]{64}$/.test(checksum || "") && Object.hasOwn(RELEASES, target);
  const filename = `kimi-code-${target}${platform === "win32" ? ".exe" : ""}`;
  const directories = [path.resolve(toolsDir), path.resolve(toolsDir, VERSION), path.resolve(toolsDir, VERSION, target)];
  const executable = path.join(directories[2], filename);
  const downloadPath = `/kimi-code/binaries/${VERSION}/${filename}`;
  let state = { status: "missing", version: VERSION, downloadedBytes: 0, totalBytes: null, error: null };
  let verified = null, pending = null, controller = null, closed = false;

  const availability = () => supported ? { available: true, managed: true, version: VERSION } : { available: false, error: "kimi_runtime_unsupported" };
  const checkAbort = (signal) => { if (closed || signal?.aborted) throw new Error("kimi_runtime_cancelled"); };

  async function safeDirectories(create = false) {
    for (const directory of directories) {
      if (create) await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fsp.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("kimi_runtime_storage_unsafe");
      if (create) await fsp.chmod(directory, 0o700);
    }
  }

  async function resolve() {
    if (!supported || closed) return null;
    try {
      await safeDirectories();
      const stat = await fsp.lstat(executable);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) return null;
      if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) return null;
      if (verified !== fingerprint(stat)) {
        const file = await fsp.open(executable, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const before = await file.stat();
          if (!before.isFile() || fingerprint(before) !== fingerprint(stat)) return null;
          const hash = crypto.createHash("sha256");
          for await (const chunk of file.createReadStream({ autoClose: false })) { checkAbort(); hash.update(chunk); }
          if (hash.digest("hex") !== checksum || fingerprint(await file.stat()) !== fingerprint(before)) return null;
          verified = fingerprint(before);
        } finally { await file.close(); }
      }
      if (closed) return null;
      state = { status: "ready", version: VERSION, downloadedBytes: stat.size, totalBytes: stat.size, error: null };
      return executable;
    } catch { return null; }
  }

  function checkedUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error("kimi_runtime_download_failed"); }
    if (!ORIGINS.has(url.origin) || url.username || url.password || url.pathname !== downloadPath || url.search || url.hash) {
      throw new Error("kimi_runtime_download_failed");
    }
    return url.href;
  }

  async function responseFor(signal) {
    let url = `https://code.kimi.com${downloadPath}`;
    for (let redirects = 0; redirects <= 3; redirects++) {
      checkAbort(signal);
      const response = await fetchImpl(checkedUrl(url), { method: "GET", redirect: "manual", signal,
        headers: { Accept: "application/octet-stream" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel?.().catch(() => {});
        const location = response.headers?.get("location");
        if (!location) throw new Error("kimi_runtime_download_failed");
        url = checkedUrl(new URL(location, url).href);
        continue;
      }
      if (response.status !== 200 || !response.body?.getReader) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error("kimi_runtime_download_failed");
      }
      return response;
    }
    throw new Error("kimi_runtime_download_failed");
  }

  async function install(signal) {
    const existing = await resolve();
    checkAbort(signal);
    if (existing) return existing;
    if (!supported) throw new Error("kimi_runtime_unsupported");
    await safeDirectories(true);
    checkAbort(signal);
    const temporary = path.join(directories[2], `.${filename}.${crypto.randomUUID()}.download`);
    const licenseTemporary = `${temporary}.license`;
    let file, reader;
    state = { status: "downloading", version: VERSION, downloadedBytes: 0, totalBytes: null, error: null };
    try {
      const response = await responseFor(signal);
      const rawLength = response.headers?.get("content-length");
      const expectedLength = rawLength === null || rawLength === undefined ? null : Number(rawLength);
      if (expectedLength !== null && (!Number.isSafeInteger(expectedLength) || expectedLength <= 0 || expectedLength > maxBytes)) {
        await response.body.cancel().catch(() => {});
        throw new Error("kimi_runtime_download_too_large");
      }
      state.totalBytes = expectedLength;
      file = await fsp.open(temporary, "wx", 0o600);
      reader = response.body.getReader();
      const hash = crypto.createHash("sha256");
      for (;;) {
        checkAbort(signal);
        const { value, done } = await reader.read();
        checkAbort(signal);
        if (done) break;
        const chunk = Buffer.from(value);
        state.downloadedBytes += chunk.length;
        if (state.downloadedBytes > maxBytes) throw new Error("kimi_runtime_download_too_large");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new Error("kimi_runtime_download_failed");
          offset += bytesWritten;
        }
      }
      if (!state.downloadedBytes || (expectedLength !== null && expectedLength !== state.downloadedBytes) || hash.digest("hex") !== checksum) {
        throw new Error("kimi_runtime_integrity_failed");
      }
      await file.sync(); await file.close(); file = null;
      await fsp.writeFile(licenseTemporary, LICENSE, { mode: 0o600, flag: "wx" });
      checkAbort(signal);
      // The only executable file is a fully downloaded and verified pinned binary.
      await fsp.chmod(temporary, 0o700);
      await fsp.rename(licenseTemporary, path.join(directories[2], "LICENSE"));
      await fsp.rename(temporary, executable);
      verified = fingerprint(await fsp.lstat(executable));
      state = { status: "ready", version: VERSION, downloadedBytes: state.downloadedBytes, totalBytes: state.downloadedBytes, error: null };
      checkAbort(signal);
      return executable;
    } finally {
      await reader?.cancel().catch(() => {});
      await file?.close().catch(() => {});
      await Promise.allSettled([fsp.rm(temporary, { force: true }), fsp.rm(licenseTemporary, { force: true })]);
    }
  }

  return {
    availability, status: () => ({ ...state }), resolve,
    ensure() {
      if (closed) return Promise.reject(new Error("kimi_runtime_cancelled"));
      if (pending) return pending;
      controller = new AbortController();
      const active = controller;
      let expired = false;
      const timer = setTimeout(() => { expired = true; active.abort(); }, timeoutMs);
      timer.unref?.();
      pending = install(active.signal).catch((error) => {
        const code = expired ? "kimi_runtime_download_timeout" : active.signal.aborted ? "kimi_runtime_cancelled" : errorCode(error);
        state = { ...state, status: "failed", error: code };
        throw new Error(code);
      }).finally(() => { clearTimeout(timer); pending = null; if (controller === active) controller = null; });
      return pending;
    },
    async cancel() { controller?.abort(); await pending?.catch(() => {}); },
    async close() { closed = true; controller?.abort(); await pending?.catch(() => {}); }
  };
}

module.exports = { createKimiRuntime, KIMI_RUNTIME_VERSION: VERSION };
