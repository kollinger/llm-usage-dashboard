import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.env.CODEX_LIVE_RATE_LIMITS = "false";
process.env.COPILOT_LIVE_QUOTA_ENABLED = "false";
process.env.GLM_CODING_PLAN_QUOTA_ENABLED = "false";

const require = createRequire(import.meta.url);
const { readCodexUsage } = require("../server.js");
const root = await mkdtemp(path.join(os.tmpdir(), "codex-archive-dedupe-"));
const sessions = path.join(root, "sessions");
const archived = path.join(root, "archived_sessions");

try {
  await Promise.all([mkdir(sessions, { recursive: true }), mkdir(archived, { recursive: true })]);
  const tokenLine = JSON.stringify({
    timestamp: "2026-08-20T07:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 80,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 0,
          total_tokens: 130
        },
        total_token_usage: { total_tokens: 130 }
      }
    }
  });
  const contents = `${JSON.stringify({
    timestamp: "2026-08-20T06:59:59.000Z",
    type: "session_meta",
    payload: { model: "gpt-5.6" }
  })}\n${tokenLine}\n`;
  const liveFile = path.join(sessions, "rollout-live-copy.jsonl");
  const archiveFile = path.join(archived, "rollout-archive-copy.jsonl");
  await Promise.all([writeFile(liveFile, contents), writeFile(archiveFile, contents)]);

  const source = {
    id: "codex-test-source",
    providerId: "codex",
    paths: [
      { role: "sessions", path: sessions },
      { role: "archived_sessions", path: archived }
    ]
  };
  const withBothPaths = await readCodexUsage({ sources: [source] });
  assert.equal(withBothPaths.source.filesScanned, 2);
  assert.equal(withBothPaths.source.duplicateEventsSkipped, 1);
  assert.equal(withBothPaths.source.eventCount, 1);
  assert.equal(withBothPaths.totals.allTime.totalTokens, 130);
  assert.equal(withBothPaths._usageEvents.length, 1);

  await unlink(liveFile);
  const archiveOnly = await readCodexUsage({ sources: [source] });
  assert.equal(archiveOnly.source.filesScanned, 1);
  assert.equal(archiveOnly.source.eventCount, 1);
  assert.equal(archiveOnly.totals.allTime.totalTokens, 130, "moving a session into the archive must not change totals");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Codex session/archive dedupe regression passed");
