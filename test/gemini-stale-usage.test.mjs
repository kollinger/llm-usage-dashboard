import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { _test } = require("../server.js");

const staleUsageMessage = "Gemini local usage updates only when local log files contain new usage metadata.";

async function withTempGeminiHome(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gemini-usage-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function geminiSource(root) {
  return [
    {
      id: "test-gemini",
      paths: [
        { role: "home", path: root },
        { role: "tmp", path: path.join(root, "tmp") }
      ]
    }
  ];
}

async function writeGeminiChat(root, timestamp) {
  const chatDir = path.join(root, "tmp", "project", "chats");
  await mkdir(chatDir, { recursive: true });
  await writeFile(
    path.join(chatDir, "session-1.jsonl"),
    `${JSON.stringify({
      timestamp,
      model: "gemini-3-flash-preview",
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15
      }
    })}\n`
  );
}

await withTempGeminiHome(async (root) => {
  await writeGeminiChat(root, "2026-01-01T12:00:00.000Z");

  const usage = await _test.readGeminiUsage({ sources: geminiSource(root) });

  assert.equal(usage.status, "live");
  assert.equal(usage.message, staleUsageMessage);
  assert.equal(usage.source.staleLocalLogs, true);
  assert.equal(usage.source.latestUsageAt, "2026-01-01T12:00:00.000Z");
  assert.equal(usage.source.recentWindowDays, 7);
  assert.equal(usage.totals.allTime.totalTokens, 15);
  assert.equal(usage.totals.last7d.totalTokens, 0);
});

await withTempGeminiHome(async (root) => {
  const freshTimestamp = new Date().toISOString();
  await writeGeminiChat(root, freshTimestamp);

  const usage = await _test.readGeminiUsage({ sources: geminiSource(root) });

  assert.equal(usage.status, "live");
  assert.equal(usage.message, null);
  assert.equal(usage.source.staleLocalLogs, false);
  assert.equal(usage.source.latestUsageAt, freshTimestamp);
  assert.equal(usage.totals.last7d.totalTokens, 15);
});
