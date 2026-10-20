import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const semver = require("semver");
const { HttpError } = require("builder-util-runtime");
const { AppImageUpdater } = require("electron-updater/out/AppImageUpdater");
const { PublishedGitHubProvider, configurePublishedUpdates, safeUpdateError } = require("../electron/published-update-provider");
const { publicRelease, publicResponses } = require("./fixtures/public-updates.cjs");

function harness(fixtures, { current = "1.10.0-preview.1", allowPrerelease = true, platform = "linux", arch = "x64", rows, overrides = new Map() } = {}) {
  const calls = [], responses = publicResponses(fixtures);
  const updater = { currentVersion: semver.parse(current), allowPrerelease, allowDowngrade: true };
  const releases = rows || fixtures.map(fixture => fixture.release);
  const provider = new PublishedGitHubProvider({ owner: "kollinger", repo: "llm-usage-dashboard" }, updater, {
    platform, executor: { async request(options) {
      calls.push(structuredClone(options));
      if (overrides.has(options.path)) {
        const response = overrides.get(options.path);
        if (response instanceof Error) throw response;
        return response;
      }
      if (options.path.startsWith("/repos/")) {
        const page = Number(new URL(`https://api.github.com${options.path}`).searchParams.get("page"));
        return JSON.stringify(releases.slice((page - 1) * 100, page * 100));
      }
      if (!responses.has(options.path)) throw new HttpError(404);
      return options.method === "HEAD" ? null : responses.get(options.path);
    } }
  });
  provider.arch = arch;
  provider.setRequestHeaders({ Authorization: "synthetic-secret", "x-user-staging-id": "synthetic-id" });
  return { provider, calls, updater };
}
const previous = () => publicRelease("1.10.1-preview.1");
const newest = () => publicRelease("1.10.1-preview.2");

test("orphan tags cannot block a published complete update; URLs stay pinned to its tag", async () => {
  // The Atom feed may contain preview.2; the published releases response does not.
  const good = previous(), h = harness([good]);
  const info = await h.provider.getLatestVersion();
  assert.equal(info.version, "1.10.1-preview.1");
  assert.equal(info.tag, good.release.tag_name);
  assert.equal(h.provider.resolveFiles(info)[0].url.href, `https://github.com${good.assetPath}`);
  assert.equal(h.provider.resolveFiles(info)[0].info.sha512, good.file.sha512);
  assert(h.calls.every(call => !call.path.includes(".atom")));
  assert(h.calls.every(call => !JSON.stringify(call.headers).includes("synthetic-")));
});

for (const missing of ["metadata-list", "metadata-404", "asset-list", "asset-pending", "asset-404", "platform-file"]) {
  test(`incomplete newer release (${missing}) falls back to complete newer release`, async () => {
    const bad = newest(), good = previous(), overrides = new Map();
    if (missing === "metadata-list") bad.release.assets.shift();
    if (missing === "metadata-404") overrides.set(bad.metadataPath, new HttpError(404));
    if (missing === "asset-list") bad.release.assets.pop();
    if (missing === "asset-pending") bad.release.assets[1].state = "starter";
    if (missing === "asset-404") overrides.set(bad.assetPath, new HttpError(404));
    if (missing === "platform-file") { bad.info.files[0].url = bad.info.path = bad.info.path.replace("x86_64", "arm64"); }
    assert.equal((await harness([bad, good], { overrides }).provider.getLatestVersion()).version, good.info.version);
  });
}

test("candidate order is SemVer, not response order or publication date", async () => {
  const h = harness([publicRelease("1.10.1-preview.2"), publicRelease("1.10.1-preview.10"), publicRelease("1.10.1-preview.3")]);
  assert.equal((await h.provider.getLatestVersion()).version, "1.10.1-preview.10");
});

test("an incomplete sole newer candidate reports up to date without selecting an older release", async () => {
  const broken = newest(); broken.release.assets.pop();
  const h = harness([broken, publicRelease("1.9.9")]);
  assert.equal((await h.provider.getLatestVersion()).version, "1.10.0-preview.1");
  assert(h.calls.every(call => !call.path.includes("v1.9.9/")));
});

test("drafts, unpublished releases and non-SemVer tags are excluded", async () => {
  const fixtures = [publicRelease("9.0.0"), publicRelease("8.0.0"), publicRelease("7.0.0"), previous()];
  fixtures[0].release.draft = true; fixtures[1].release.published_at = null; fixtures[2].release.tag_name = "website";
  assert.equal((await harness(fixtures).provider.getLatestVersion()).version, "1.10.1-preview.1");
});

for (const allowPrerelease of [true, false]) {
  test(`prerelease preference ${allowPrerelease} is respected`, async () => {
    const h = harness([publicRelease("1.11.0-preview.1"), publicRelease("1.10.1")], { allowPrerelease });
    assert.equal((await h.provider.getLatestVersion()).version, allowPrerelease ? "1.11.0-preview.1" : "1.10.1");
  });
}

test("a preview can advance to stable; a GitHub-prerelease flag is respected even on a stable tag", async () => {
  const flagged = publicRelease("1.11.0"); flagged.release.prerelease = true;
  assert.equal((await harness([flagged, publicRelease("1.10.1")], { allowPrerelease: false }).provider.getLatestVersion()).version, "1.10.1");
});

for (const fixtures of [[], [publicRelease("1.9.9"), publicRelease("1.10.0-preview.1")], [newest()]]) {
  test("no eligible newer complete update reports installed version without downgrade", async () => {
    const h = harness(fixtures, { allowPrerelease: false });
    const info = await h.provider.getLatestVersion();
    assert.equal(info.version, "1.10.0-preview.1"); assert.deepEqual(info.files, []);
    assert(h.calls.every(call => call.path.startsWith("/repos/")));
  });
}

for (const [platform, arch, channel] of [["linux", "x64", "latest-linux.yml"], ["linux", "arm64", "latest-linux-arm64.yml"],
  ["darwin", "x64", "latest-mac.yml"], ["darwin", "arm64", "latest-mac.yml"], ["win32", "x64", "latest.yml"]]) {
  test(`platform/architecture ${platform}/${arch} selects its installer and metadata`, async () => {
    const fixture = publicRelease("1.11.0", { platform, arch });
    const h = harness([fixture], { platform, arch });
    const info = await h.provider.getLatestVersion();
    assert.equal(info.files[0].url, fixture.file.url);
    assert(h.calls.some(call => call.path.endsWith(channel)));
  });
}

test("a macOS DMG alone and a Windows portable alone cannot be offered as an auto-update", async () => {
  for (const platform of ["darwin", "win32"]) {
    const fixture = publicRelease("1.11.0", { platform });
    fixture.info.path = fixture.file.url = fixture.file.url.replace(/\.zip$/, ".dmg").replace("-Setup.exe", "-portable.exe");
    assert.equal((await harness([fixture], { platform }).provider.getLatestVersion()).version, "1.10.0-preview.1");
  }
});

test("a universal macOS ZIP is eligible for Apple Silicon", async () => {
  const fixture = publicRelease("1.11.0", { platform: "darwin" });
  const info = await harness([fixture], { platform: "darwin", arch: "arm64" }).provider.getLatestVersion();
  assert.equal(info.files[0].url, fixture.file.url);
});

test("channel-specific metadata is tried first and defaults only on an actual 404", async () => {
  const fixture = newest(), customPath = fixture.metadataPath.replace("latest-linux", "preview-linux");
  fixture.release.assets.push({ name: "preview-linux.yml", state: "uploaded" });
  const h = harness([fixture]);
  assert.equal((await h.provider.getLatestVersion()).version, fixture.info.version);
  assert(h.calls.findIndex(call => call.path === customPath) < h.calls.findIndex(call => call.path === fixture.metadataPath));
});

for (const location of ["api", "metadata", "asset"]) {
  for (const status of [401, 403, 429, 500, 503]) {
    test(`${location} HTTP ${status} remains a sanitized error without fallback`, async () => {
      const bad = newest(), good = previous();
      const key = location === "api" ? "/repos/kollinger/llm-usage-dashboard/releases?per_page=100&page=1"
        : location === "metadata" ? bad.metadataPath : bad.assetPath;
      const h = harness([bad, good], { overrides: new Map([[key, new HttpError(status, "synthetic-secret raw payload /private/file")]]) });
      await assert.rejects(h.provider.getLatestVersion(), error => error.message === `ERR_UPDATER_HTTP_${status}` && !error.cause);
      assert(h.calls.every(call => !call.path.includes(good.release.tag_name)));
    });
  }
}

test("403 on channel metadata never falls back to the default channel", async () => {
  const fixture = newest(), customPath = fixture.metadataPath.replace("latest-linux", "preview-linux");
  fixture.release.assets.push({ name: "preview-linux.yml", state: "uploaded" });
  const h = harness([fixture], { overrides: new Map([[customPath, new HttpError(403)]]) });
  await assert.rejects(h.provider.getLatestVersion(), { code: "ERR_UPDATER_HTTP_403" });
  assert(h.calls.every(call => call.path !== fixture.metadataPath));
});

for (const mutate of [info => { info.version = "1.10.1-preview.1"; }, info => { delete info.files[0].sha512; },
  info => { info.files[0].sha512 = "invalid"; }, info => { info.files[0].url = "https://other.example/update.AppImage"; },
  info => { info.files[0].url = "../update.AppImage"; }, info => { info.files[0].size++; },
  info => { info.sha512 = Buffer.alloc(64, 8).toString("base64"); }, info => { info.packages = { x64: {} }; },
  info => { info.files.push({ ...info.files[0] }); }]) {
  test("inconsistent version/asset/integrity information fails closed", async () => {
    const bad = newest(), good = previous(); mutate(bad.info);
    const h = harness([bad, good]);
    await assert.rejects(h.provider.getLatestVersion(), { code: "ERR_UPDATER_INTEGRITY" });
    assert(h.calls.every(call => !call.path.includes(good.release.tag_name)));
  });
}

test("malformed metadata, JSON and network errors never leak upstream content", async () => {
  const fixture = newest();
  for (const [key, value, code] of [[fixture.metadataPath, "private: [ malformed secret", "ERR_UPDATER_INVALID_METADATA"],
    ["/repos/kollinger/llm-usage-dashboard/releases?per_page=100&page=1", "secret", "ERR_UPDATER_INVALID_RELEASES"],
    [fixture.assetPath, new Error("ECONNRESET secret /private/file"), "ERR_UPDATER_NETWORK"]]) {
    await assert.rejects(harness([fixture], { overrides: new Map([[key, value]]) }).provider.getLatestVersion(), error => error.code === code && error.message === code);
  }
});

test("pagination sees newer candidates beyond the first page", async () => {
  const good = newest(), old = publicRelease("1.0.0");
  const h = harness([good], { rows: [...Array(100).fill(old.release), good.release] });
  assert.equal((await h.provider.getLatestVersion()).version, good.info.version);
  assert.equal(h.calls.filter(call => call.path.startsWith("/repos/")).length, 2);
});

test("truncated release history produces an error, never false up-to-date", async () => {
  const h = harness([], { rows: Array(1000).fill(publicRelease("1.0.0").release) });
  await assert.rejects(h.provider.getLatestVersion(), { code: "ERR_UPDATER_RELEASE_LIMIT" });
});

test("production configuration uses the custom provider and disables downgrade on the real updater", async () => {
  const updater = new AppImageUpdater(null, { version: "1.10.0-preview.1", isPackaged: true, whenReady: async () => {} });
  updater.allowDowngrade = true;
  configurePublishedUpdates(updater);
  assert.equal(updater.allowDowngrade, false);
  const provider = await updater.clientPromise;
  assert(provider instanceof PublishedGitHubProvider);
  assert.equal(await updater.isUpdateAvailable({ version: "1.9.9" }), false);
  // The updater's own SemVer implementation must work across the dependency
  // boundary, independently of the fixture's semver version.
  const h = harness([previous()]); h.provider.updater = updater;
  updater.allowPrerelease = true;
  assert.equal((await h.provider.getLatestVersion()).version, "1.10.1-preview.1");
});

test("source overrides and unsupported platforms fail before network access", async () => {
  assert.throws(() => new PublishedGitHubProvider({ owner: "other", repo: "llm-usage-dashboard", token: "synthetic" }, {}, {}), { code: "ERR_UPDATER_INVALID_SOURCE" });
  const h = harness([], { platform: "freebsd" });
  await assert.rejects(h.provider.getLatestVersion(), { code: "ERR_UPDATER_UNSUPPORTED_PLATFORM" });
  assert.deepEqual(h.calls, []);
});

test("download errors retain checksum/signature categories without exposing private paths or hashes", () => {
  for (const code of ["ERR_SHA512_CHECKSUM_MISMATCH", "ERR_UPDATER_INVALID_SIGNATURE"]) {
    const safe = safeUpdateError(Object.assign(new Error("secret /private/path raw body"), { code }));
    assert.equal(safe.message, code); assert.equal(safe.cause, undefined);
  }
  assert.equal(safeUpdateError({ code: "ERR_CHECKSUM_MISMATCH", message: "private hashes" }).code, "ERR_UPDATER_INTEGRITY");
});
