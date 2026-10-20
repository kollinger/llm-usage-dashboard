"use strict";

// Test-only entry point, including in an explicitly configured QA package.
// Every network request is redirected internally to public-shaped local data.
// Never start the dashboard, collectors, credentials or installer in this test.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { app } = require("electron");
const { configurePublishedUpdates, safeUpdateError } = require("../electron/published-update-provider");
const { publicRelease, publicResponses } = require("./fixtures/public-updates.cjs");

const profile = process.env.UPDATES_NATIVE_PROFILE;
assert(profile, "isolated test profile required");
app.setPath("userData", profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});

let responseMode = "complete", corruptDownload = false, server;
const requests = [];
(async () => {
  await app.whenReady();
  if (process.env.UPDATES_REQUIRE_PACKAGED === "1") assert.equal(app.isPackaged, true);
  const platform = process.platform, arch = process.arch;
  const bad = publicRelease("1.10.1-preview.2", { platform, arch });
  const good = publicRelease("1.10.1-preview.1", { platform, arch });
  const responses = publicResponses([bad, good]);
  server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.setHeader("Cache-Control", "no-store");
    if (req.url.startsWith("/repos/")) {
      if (responseMode === "rate-limit") { res.writeHead(429); res.end("synthetic secret payload"); return; }
      const releases = responseMode === "stable-only" ? [] : [bad.release, good.release];
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(releases)); return;
    }
    if (req.url === bad.metadataPath) { res.writeHead(404); res.end(); return; }
    let body = responses.get(req.url);
    if (!body) { res.writeHead(404); res.end(); return; }
    if (req.url === good.assetPath && corruptDownload && req.method === "GET") body = Buffer.alloc(body.length, 1);
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  if (platform === "linux") process.env.APPIMAGE = path.join(profile, "synthetic-installed.AppImage");
  const { autoUpdater } = require("electron-updater");
  autoUpdater.logger = null;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  autoUpdater.currentVersion = new autoUpdater.currentVersion.constructor("1.10.0-preview.1");
  autoUpdater.allowPrerelease = true;
  configurePublishedUpdates(autoUpdater);
  const { DownloadedUpdateHelper } = require("electron-updater/out/DownloadedUpdateHelper");
  autoUpdater.downloadedUpdateHelper = new DownloadedUpdateHelper(path.join(profile, "update-cache"));
  const realCreateRequest = autoUpdater.httpExecutor.createRequest.bind(autoUpdater.httpExecutor);
  autoUpdater.httpExecutor.createRequest = (options, callback) => {
    assert(["github.com", "api.github.com"].includes(options.hostname), "no external or unrelated destination");
    return realCreateRequest({ ...options, protocol: "http:", hostname: "127.0.0.1", port: server.address().port }, callback);
  };
  const events = [];
  for (const name of ["update-available", "update-not-available", "update-downloaded"]) autoUpdater.on(name, info => events.push({ name, version: info.version }));
  const errors = [];
  autoUpdater.on("error", error => errors.push(safeUpdateError(error).code));
  const found = await autoUpdater.checkForUpdates();
  assert.equal(found.isUpdateAvailable, true);
  assert.equal(found.updateInfo.version, good.info.version);
  assert.equal(found.updateInfo.tag, good.release.tag_name);
  assert(events.some(event => event.name === "update-available" && event.version === good.info.version));

  let checksumVerified = false;
  if (platform === "linux") {
    // First verify rejection with a real Electron HTTP download/digest stream,
    // then verify recovery and a valid download. Never install the fixture.
    corruptDownload = true;
    await assert.rejects(autoUpdater.downloadUpdate(), error => safeUpdateError(error).code === "ERR_UPDATER_INTEGRITY");
    assert(!events.some(event => event.name === "update-downloaded"));
    corruptDownload = false;
    const downloads = await autoUpdater.downloadUpdate();
    assert.equal(downloads.length, 1);
    assert.deepEqual(await fs.readFile(downloads[0]), good.body);
    assert(events.some(event => event.name === "update-downloaded" && event.version === good.info.version));
    checksumVerified = true;
  }
  autoUpdater.allowPrerelease = false;
  assert.equal((await autoUpdater.checkForUpdates()).isUpdateAvailable, false);
  autoUpdater.allowPrerelease = true;
  responseMode = "rate-limit";
  await assert.rejects(autoUpdater.checkForUpdates(), { code: "ERR_UPDATER_HTTP_429" });
  responseMode = "stable-only";
  assert.equal((await autoUpdater.checkForUpdates()).isUpdateAvailable, false);
  console.log(JSON.stringify({ result: "PASS", platform, arch, packaged: app.isPackaged, packageVersion: app.getVersion(),
    detectedVersion: found.updateInfo.version, checksumVerified, requests: requests.length, errors, events }));
})().then(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  app.exit(0);
}, async error => {
  console.error(error);
  if (server) await new Promise(resolve => server.close(resolve));
  app.exit(1);
});
