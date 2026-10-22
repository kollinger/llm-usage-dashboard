import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { zstdCompressSync } from "node:zlib";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "compressed-usage-"));
process.env.LLM_USAGE_DATA_DIR = path.join(root, "data");
process.env.CODEX_LIVE_RATE_LIMITS = "false";
const require = createRequire(import.meta.url);
const { readCodexUsage, _test } = require("../server.js");
const { exportUsageEvents } = require("../lib/device-sync-data.js");
const { readUsageFileEvents } = require("../lib/usage-file-cache.js");

try {
  const sessions = path.join(root, "sessions");
  const archived = path.join(root, "archived_sessions");
  await Promise.all([mkdir(sessions), mkdir(archived)]);
  const source = { id: "fixture-codex", providerId: "codex", paths: [
    { role: "sessions", path: sessions }, { role: "archived_sessions", path: archived }
  ] };
  const filename = "rollout-2026-10-01T12-00-00-fixture.jsonl";
  const plain = path.join(sessions, filename);
  const compressed = path.join(archived, filename + ".zst");
  const contents = [
    { type: "session_meta", payload: { id: "compressed-fixture", model: "fixture-initial" } },
    { type: "response_item", payload: { content: "PRIVATE TRANSCRIPT".repeat(10_000) } },
    { type: "turn_context", payload: { model: "fixture-model", effort: "high" } },
    { timestamp: "2026-10-01T12:00:00Z", type: "event_msg", payload: { type: "token_count",
      info: { last_token_usage: { input_tokens: 80, cached_input_tokens: 40, output_tokens: 20, total_tokens: 100 } } } },
    { timestamp: "2026-10-01T12:01:00Z", type: "event_msg", payload: { type: "token_count",
      info: { last_token_usage: { input_tokens: 160, cached_input_tokens: 80, output_tokens: 40, total_tokens: 200 } } } }
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(plain, contents);
  const before = await readCodexUsage({ sources: [source] });
  assert.equal(before.totals.allTime.totalTokens, 300);
  const beforeEvents = exportUsageEvents([before]).events;

  const bytes = zstdCompressSync(Buffer.from(contents));
  await writeFile(compressed, bytes);
  const both = await readCodexUsage({ sources: [source] });
  assert.equal(both.totals.allTime.totalTokens, 300, "plain and compressed copies count once");
  assert.equal(both.source.filesScanned, 1, "compression must preserve the rollout file identity");
  await unlink(plain);
  const after = await readCodexUsage({ sources: [source] });
  assert.equal(after.totals.allTime.totalTokens, 300, "compression/archive must retain lifetime usage");
  assert.equal(after.source.filesScanned, 1);
  assert.equal(after.source.eventCount, 2);
  assert.deepEqual(after.totals, before.totals, "all usage windows survive compression");
  assert.deepEqual(exportUsageEvents([after]).events, beforeEvents,
    "sync identities, conversation attribution, model and usage survive compression");
  assert.deepEqual(await readFile(compressed), bytes, "scanning must not alter or unpack the source archive");

  const parsed = await _test.parseCodexSessionFileEvents({ file: compressed, realPath: compressed });
  assert.deepEqual(parsed.map(row => [row.model, row.reasoningEffort, row.line]), [
    ["fixture-model", "high", 4], ["fixture-model", "high", 5]
  ]);
  let parses = 0;
  const parse = async record => { parses += 1; return _test.parseCodexSessionFileEvents(record); };
  const record = { file: compressed, realPath: compressed };
  const options = { directory: path.join(root, "restart-cache"), version: "compressed-fixture" };
  await readUsageFileEvents(new Map(), record, parse, options);
  await readUsageFileEvents(new Map(), record, parse, options);
  assert.equal(parses, 1, "restarting reuses the compressed-file extraction without unpacking it again");
  const corrupt = path.join(root, "corrupt.jsonl.zst");
  await writeFile(corrupt, Buffer.from("invalid zstd frame"));
  await assert.rejects(_test.parseCodexSessionFileEvents({ file: corrupt, realPath: corrupt }),
    "damaged compression must report a source error instead of a false zero");
  const missing = path.join(root, "missing.jsonl.zst");
  await assert.rejects(_test.parseCodexSessionFileEvents({ file: missing, realPath: missing }),
    "compressed source read errors must propagate without an unhandled stream error");
  console.log("Compressed usage: archive continuity, totals/windows, copy dedupe, model/chat/sync identity, restart cache, source preservation and source errors passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
