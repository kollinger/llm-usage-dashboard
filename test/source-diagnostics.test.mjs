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

  const privateClaudePath = path.join(tmp, "private-home", ".claude", "projects");
  const supportReport = _test.buildSupportReportFromInputs({
    generatedAt: "2026-07-11T15:00:00.000Z",
    reportId: "support-test",
    diagnostics: {
      status: "candidates_denied",
      generatedAt: "2026-07-11T14:59:00.000Z",
      os: { platform: "linux", supported: true, supportLevel: "full", container: false },
      counts: { readable: 0, denied: 1, candidates: 1, connected: 0 },
      connected: [],
      candidates: [
        {
          id: "claude-denied",
          providerId: "claudeCode",
          label: "Claude Code - current user",
          accessStatus: "denied",
          owner: { current: true, name: "secret-user" },
          paths: [
            {
              role: "projects",
              kind: "directory",
              path: privateClaudePath,
              exists: true,
              readable: false,
              permission: "denied",
              mtime: "2026-07-11T14:30:00.000Z"
            }
          ]
        }
      ]
    },
    usage: {
      claudeCode: {
        id: "claudeCode",
        status: "empty",
        updatedAt: "2026-07-11T14:59:00.000Z",
        source: {
          filesScanned: 0,
          eventCount: 0,
          authStatus: { available: true, status: "logged_out" }
        },
        setup: {
          claudeAvailable: true,
          configured: false,
          settingsError: "invalid_json",
          scriptInstalled: false,
          statusFileFound: false,
          hasLimits: false,
          staleLimits: false
        },
        browserCredits: { status: "missing" },
        totals: {
          allTime: { totalTokens: 0 },
          last7d: { totalTokens: 0 }
        },
        latest: null,
        limitSource: null
      }
    }
  });
  const claudeReport = supportReport.providers.find((provider) => provider.providerId === "claudeCode");
  assert.equal(claudeReport.status, "permission_error");
  assert(claudeReport.findings.includes("permission_error"));
  assert(claudeReport.findings.includes("parser_error"));
  assert(claudeReport.findings.includes("live_quota_source_not_active"));
  assert.equal(claudeReport.source.paths[0]?.path, "source:claudeCode/projects");

  const supportJson = JSON.stringify(supportReport);
  assert(!supportJson.includes(privateClaudePath), "support report must not include raw local paths");
  assert(!supportJson.includes("secret-user"), "support report must not include local usernames");
  assert(!supportReport.compactSummary.includes(privateClaudePath), "compact summary must not include raw local paths");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
