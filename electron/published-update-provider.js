"use strict";

const semver = require("semver");
const yaml = require("js-yaml");
const { CancellationToken } = require("builder-util-runtime");
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider");

const UPDATE_SOURCE = Object.freeze({ owner: "kollinger", repo: "llm-usage-dashboard" });
const MAX_RELEASE_PAGES = 10;
const SAFE_CODES = new Set([
  "ERR_UPDATER_INVALID_RELEASES", "ERR_UPDATER_RELEASE_LIMIT", "ERR_UPDATER_INVALID_METADATA",
  "ERR_UPDATER_INTEGRITY", "ERR_UPDATER_UNSUPPORTED_PLATFORM", "ERR_UPDATER_INVALID_SOURCE",
  "ERR_SHA512_CHECKSUM_MISMATCH", "ERR_UPDATER_INVALID_SIGNATURE", "ERR_UPDATER_CANCELLED"
]);

function updateError(code) {
  return Object.assign(new Error(code), { code });
}

// Upstream HTTP/download errors can contain response bodies, headers and local
// paths. Persist only a fixed category; never copy their message/stack/cause.
function safeUpdateError(error) {
  const status = error?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return updateError(`ERR_UPDATER_HTTP_${status}`);
  }
  if (SAFE_CODES.has(error?.code) || /^ERR_UPDATER_HTTP_[45]\d{2}$/.test(error?.code || "")) {
    return updateError(error.code);
  }
  if (["ERR_CHECKSUM_MISMATCH", "ERR_UPDATER_CHECKSUM_MISMATCH"].includes(error?.code)) return updateError("ERR_UPDATER_INTEGRITY");
  if (error?.name === "CancellationError") return updateError("ERR_UPDATER_CANCELLED");
  return updateError("ERR_UPDATER_NETWORK");
}

class PublishedGitHubProvider extends GitHubProvider {
  constructor(options, updater, runtimeOptions) {
    super(options, updater, runtimeOptions);
    // This is the public project update route, never a credentialed/enterprise
    // provider. Do not inherit GH_TOKEN or follow metadata to another repository.
    if (options.owner !== UPDATE_SOURCE.owner || options.repo !== UPDATE_SOURCE.repo ||
        options.host || options.token || options.private || options.protocol) {
      throw updateError("ERR_UPDATER_INVALID_SOURCE");
    }
    this.platform = runtimeOptions.platform;
    this.arch = process.arch;
  }

  getChannelFilePrefix() {
    if (this.platform === "linux") return `-linux${this.arch === "x64" ? "" : `-${this.arch}`}`;
    return this.platform === "darwin" ? "-mac" : "";
  }

  async requestPublic(url, cancellationToken, method = "GET") {
    const options = this.createRequestOptions(url, { Accept: "application/json" });
    options.method = method;
    options.timeout = 20_000;
    // The route is public. In particular, do not propagate updater staging IDs
    // or caller-supplied credentials to GitHub or redirected asset hosts.
    options.headers = { Accept: "application/json" };
    return this.executor.request(options, cancellationToken);
  }

  async publishedReleases(cancellationToken) {
    const releases = [];
    for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
      const url = new URL(`/repos/${this.options.owner}/${this.options.repo}/releases?per_page=100&page=${page}`, this.baseApiUrl);
      let rows;
      try { rows = JSON.parse(await this.requestPublic(url, cancellationToken)); }
      catch (error) {
        if (error instanceof SyntaxError) throw updateError("ERR_UPDATER_INVALID_RELEASES");
        throw error;
      }
      if (!Array.isArray(rows)) throw updateError("ERR_UPDATER_INVALID_RELEASES");
      for (const release of rows) {
        if (!release || typeof release !== "object" || !Array.isArray(release.assets)) {
          throw updateError("ERR_UPDATER_INVALID_RELEASES");
        }
        const version = typeof release.tag_name === "string" && semver.valid(release.tag_name);
        if (release.draft || !release.published_at || !version) continue;
        if (!this.updater.allowPrerelease && (release.prerelease || semver.prerelease(version))) continue;
        // electron-updater can carry another major of semver. Pass its version
        // string rather than a foreign SemVer instance across that boundary.
        if (!semver.gt(version, this.updater.currentVersion.version)) continue;
        releases.push({ ...release, version });
      }
      if (rows.length < 100) return releases.sort((a, b) => semver.rcompare(a.version, b.version));
    }
    // Do not silently claim up to date from a truncated release history.
    throw updateError("ERR_UPDATER_RELEASE_LIMIT");
  }

  installerNames(version) {
    const prefix = `LLM-Usage-Dashboard-${version}`;
    if (this.platform === "linux") {
      const arch = { x64: "x86_64", ia32: "i386" }[this.arch] || this.arch;
      return [`${prefix}-linux-${arch}.AppImage`];
    }
    if (this.platform === "darwin") return [`${prefix}-mac-universal.zip`, `${prefix}-mac-${this.arch}.zip`];
    if (this.platform === "win32") return [`${prefix}-windows-${this.arch}-Setup.exe`];
    throw updateError("ERR_UPDATER_UNSUPPORTED_PLATFORM");
  }

  async releaseMetadata(release, cancellationToken) {
    const prerelease = semver.prerelease(release.version)?.[0];
    const channels = [...new Set([
      prerelease ? this.getCustomChannelName(String(prerelease)) : this.channel,
      this.getDefaultChannelName()
    ])];
    for (const channel of channels) {
      const filename = `${channel}.yml`;
      if (!release.assets.some(asset => asset.name === filename && asset.state === "uploaded")) continue;
      let raw;
      try {
        raw = await this.requestPublic(new URL(this.getBaseDownloadPath(release.tag_name, filename), this.baseUrl), cancellationToken);
      } catch (error) {
        if (error?.statusCode === 404) continue;
        throw error;
      }
      let info;
      try {
        if (typeof raw !== "string" || raw.length > 1024 * 1024) throw new Error();
        info = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
      } catch { throw updateError("ERR_UPDATER_INVALID_METADATA"); }
      if (!info || info.version !== release.version || !Array.isArray(info.files) || !info.files.length || info.packages) {
        throw updateError("ERR_UPDATER_INTEGRITY");
      }
      const filenames = new Set();
      for (const file of info.files) {
        if (!file || typeof file.url !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(file.url) ||
            !file.url.startsWith(`LLM-Usage-Dashboard-${release.version}-`) ||
            typeof file.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
            Buffer.from(file.sha512, "base64").toString("base64") !== file.sha512 ||
            !Number.isSafeInteger(file.size) || file.size <= 0) {
          throw updateError("ERR_UPDATER_INTEGRITY");
        }
        if (filenames.has(file.url)) throw updateError("ERR_UPDATER_INTEGRITY");
        filenames.add(file.url);
      }
      if (info.path != null) {
        const legacyFile = info.files.find(file => file.url === info.path);
        if (!legacyFile || info.sha512 !== legacyFile.sha512) throw updateError("ERR_UPDATER_INTEGRITY");
      }
      return info;
    }
    return null;
  }

  async getLatestVersion() {
    try {
      const cancellationToken = new CancellationToken();
      this.installerNames("0.0.0"); // Validate platform before making requests.
      for (const release of await this.publishedReleases(cancellationToken)) {
        const info = await this.releaseMetadata(release, cancellationToken);
        if (!info) continue;
        const file = this.installerNames(release.version).map(name => info.files.find(item => item.url === name)).find(Boolean);
        if (!file) continue;
        const asset = release.assets.find(item => item.name === file.url && item.state === "uploaded");
        if (!asset) continue;
        if (asset.size !== file.size) throw updateError("ERR_UPDATER_INTEGRITY");
        const url = new URL(this.getBaseDownloadPath(release.tag_name, file.url), this.baseUrl);
        try { await this.requestPublic(url, cancellationToken, "HEAD"); }
        catch (error) {
          if (error?.statusCode === 404) continue;
          throw error;
        }
        // Preserve rollout/OS requirements. The existing updater still verifies
        // SHA512 during download and native signatures where required. Pin every
        // resolved file to this release, even if a newer tag appears meanwhile.
        return { ...info, tag: release.tag_name, files: [file], path: file.url, sha512: file.sha512,
          releaseName: release.name || release.tag_name, releaseNotes: release.body || "" };
      }
      // A normal no-update result; returning the installed version also prevents
      // downgrades even if another caller enables allowDowngrade.
      return { version: this.updater.currentVersion.version, files: [] };
    } catch (error) { throw safeUpdateError(error); }
  }
}

function configurePublishedUpdates(autoUpdater) {
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({ provider: "custom", updateProvider: PublishedGitHubProvider, ...UPDATE_SOURCE });
}

module.exports = { PublishedGitHubProvider, configurePublishedUpdates, safeUpdateError };
