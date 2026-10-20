import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "llm-codex-jsonl-"));
process.env.LLM_USAGE_DATA_DIR = path.join(root, "data");
process.env.CODEX_LIVE_RATE_LIMITS = "false";
const { _test } = createRequire(import.meta.url)("../server");
try {
  const timestamp = new Date().toISOString();
  const token = (amount) => ({ type: "token_count", info: { last_token_usage: { input_tokens: amount, total_tokens: amount } } });
  const file = path.join(root, "session.jsonl");
  const rows = [
    JSON.stringify({ timestamp, type: "session_meta", payload: { model: "fixture-initial" } }),
    JSON.stringify({ type: "response_item", payload: { type: "event_msg", content: "ignored".repeat(100_000), usage: token(999) } }),
    "",
    JSON.stringify({ timestamp, type: "event_msg", payload: token(3) }),
    // A nested type before the root type must not be mistaken for its header.
    JSON.stringify({ payload: { type: "response_item", model: "fixture-next", effort: "high" }, type: "turn_context" }),
    JSON.stringify({ payload: token(5), timestamp, type: "event_msg" }),
    JSON.stringify({ type: "turn_context", payload: { model: "fixture-escaped" } }).replace('"turn_context"', '"turn_\\u0063ontext"'),
    JSON.stringify({ type: "event_msg", timestamp, payload: token(7) }).replace('{"type"', '{\t"type"'),
    "{unfinished"
  ];
  await writeFile(file, rows.join("\n") + "\n");
  const events = await _test.parseCodexSessionFileEvents({ file, realPath: file });
  assert.deepEqual(events.map(event => [event.model, event.usage.total_tokens, event.line]), [
    ["fixture-initial", 3, 4], ["fixture-next", 5, 6], ["fixture-escaped", 7, 8]
  ]);
  assert.equal(events[1].reasoningEffort, "high");
  console.log("Codex JSONL: ignored large messages, nested types, alternate key orders, escaped values, tabs and line identities passed.");
} finally { await rm(root, { recursive: true, force: true }); }
