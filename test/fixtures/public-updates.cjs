"use strict";

// Public release-shaped synthetic data only; no real release payloads or tokens.
const { createHash } = require("node:crypto");
const yaml = require("js-yaml");
const ROOT = "/kollinger/llm-usage-dashboard/releases/download/";

function publicRelease(version, { platform = "linux", arch = "x64", body = Buffer.from("synthetic update\n") } = {}) {
  const suffix = platform === "darwin" ? `mac-${arch === "x64" ? "universal" : arch}.zip`
    : platform === "win32" ? `windows-${arch}-Setup.exe` : `linux-${arch === "x64" ? "x86_64" : arch}.AppImage`;
  const name = `LLM-Usage-Dashboard-${version}-${suffix}`;
  const metadataName = platform === "darwin" ? "latest-mac.yml" : platform === "win32" ? "latest.yml"
    : `latest-linux${arch === "x64" ? "" : `-${arch}`}.yml`;
  const file = { url: name, sha512: createHash("sha512").update(body).digest("base64"), size: body.length };
  const info = { version, files: [file], path: name, sha512: file.sha512 };
  const release = { tag_name: `v${version}`, name: `Synthetic ${version}`, body: "Fixture notes", draft: false,
    prerelease: version.includes("-"), published_at: "2026-01-01T00:00:00Z",
    assets: [{ name: metadataName, state: "uploaded", size: 100 }, { name, state: "uploaded", size: body.length }] };
  return { release, info, body, metadataName, file, metadataPath: `${ROOT}v${version}/${metadataName}`, assetPath: `${ROOT}v${version}/${name}` };
}

function publicResponses(fixtures) {
  const responses = new Map();
  for (const fixture of fixtures) {
    responses.set(fixture.metadataPath, yaml.dump(fixture.info));
    responses.set(fixture.assetPath, fixture.body);
  }
  return responses;
}

module.exports = { publicRelease, publicResponses, ROOT };
