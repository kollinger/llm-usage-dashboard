import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { discoverSources } = require("../lib/source-discovery.js");
const { _test } = require("../server.js");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "source-diagnostics-"));

try {
  const codexHome = path.join(tmp, ".codex");
  await fs.mkdir(path.join(codexHome, "sessions"), { recursive: true });

  const discovery = await discoverSources({ platform: "darwin", codexHomes: [codexHome] });
  const codex = discovery.candidates.find((source) => source.providerId === "codex");

  assert.ok(codex, "configured current-user Codex candidate should be present on host-discovery stubs");
  assert.equal(codex.accessStatus, "readable");
  assert.equal(codex.paths.find((entry) => entry.role === "sessions")?.permission, "readable");
  assert.equal(codex.paths.find((entry) => entry.role === "archived_sessions")?.permission, "missing");
  assert.equal(discovery.counts.readable, 1);

  const diagnostics = _test.buildSourceDiagnosticsPayload({ version: 1, sources: [] }, discovery);
  assert.equal(diagnostics.status, "connected_live");
  assert.equal(diagnostics.counts.connected, 1);
  assert.equal(diagnostics.counts.connectedAutomatic, 1);
  assert.equal(diagnostics.counts.connectedSaved, 0);
  assert.equal(diagnostics.connected[0]?.providerId, "codex");
  assert.equal(diagnostics.connected[0]?.automatic, true);
  assert.equal(diagnostics.candidates[0]?.connected, true);
  assert.equal(diagnostics.candidates[0]?.automatic, true);

  const missingDiscovery = await discoverSources({ platform: "darwin", codexHomes: [path.join(tmp, "missing-codex")] });
  const missingDiagnostics = _test.buildSourceDiagnosticsPayload({ version: 1, sources: [] }, missingDiscovery);
  assert.equal(missingDiagnostics.connected.length, 0);
  assert.equal(missingDiagnostics.candidates[0]?.accessStatus, "missing");
  assert.equal(missingDiagnostics.candidates[0]?.connected, false);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
