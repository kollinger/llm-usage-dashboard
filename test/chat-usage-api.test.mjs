import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const root = await mkdtemp(path.join(os.tmpdir(), "llm-chat-api-"));
// Isolate provider discovery while retaining the real runtime environment.
os.homedir = () => root;
process.env.LLM_USAGE_DATA_DIR = path.join(root, "data");
process.env.CODEX_HOME = path.join(root, ".codex");
process.env.CLAUDE_HOME = path.join(root, ".claude");
process.env.CODEX_LIVE_RATE_LIMITS = "false";
process.env.DASHBOARD_PASSWORD = "fixture-password";
process.env.OLLAMA_HOST = "http://127.0.0.1:1";
process.env.LLM_USAGE_MULTICA_CONFIG_FILE = path.join(root, "missing-config.json");
const require = createRequire(import.meta.url);
const workerThreads = require("node:worker_threads");
const NativeWorker = workerThreads.Worker;
let aggregationWorker;
workerThreads.Worker = class extends NativeWorker {
  constructor(file, options) {
    super(file, options);
    if (String(file).endsWith("usage-aggregation-worker.js")) aggregationWorker = this;
  }
};
const childProcess = require("node:child_process");
// No real auth helpers, keychain or provider processes run in this test.
childProcess.execFile = (_file, _args, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  queueMicrotask(() => done(Object.assign(new Error("fixture unavailable"), { code: "ENOENT" }), "", ""));
  return { kill() {} };
};
childProcess.spawn = () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  queueMicrotask(() => child.emit("error", Object.assign(new Error("fixture unavailable"), { code: "ENOENT" })));
  return child;
};
const nativeFetch = globalThis.fetch;
let base;
globalThis.fetch = (url, options) => String(url).startsWith(`${base}/`) ? nativeFetch(url, options) : Promise.resolve(new Response("{}", { status: 503 }));
const session = "11111111-2222-4333-8444-555555555555";
const codexDir = path.join(root, ".codex", "sessions", "2026", "10", "18");
const claudeDir = path.join(root, ".claude", "projects", "fixture-project");
await mkdir(codexDir, { recursive: true });
await mkdir(claudeDir, { recursive: true });
const timestamp = new Date(Date.now() - 1000).toISOString();
const jsonl = (rows) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
await writeFile(path.join(codexDir, `rollout-2026-10-18T12-00-00-${session}.jsonl`), jsonl([
  { type: "session_meta", payload: { id: session, cwd: "/private/fixture", originator: "codex_cli" } },
  { type: "turn_context", payload: { model: "fixture-codex" } },
  { type: "response_item", payload: { content: "SECRET PROMPT MUST STAY PRIVATE" } },
  { type: "event_msg", timestamp, payload: { type: "token_count", info: { last_token_usage: { input_tokens: 80, cached_input_tokens: 20, output_tokens: 20, total_tokens: 100 } } } }
]));
await writeFile(path.join(root, ".codex", "session_index.jsonl"), jsonl([{ id: session, thread_name: "Native title" }]));
await writeFile(path.join(claudeDir, "claude-session.jsonl"), jsonl([
  { type: "custom-title", customTitle: "Claude title" },
  { type: "assistant", timestamp, sessionId: "claude-session", requestId: "request1", uuid: "fixture-uuid", message: {
    id: "message1", model: "fixture-claude", content: "SECRET RESPONSE MUST STAY PRIVATE",
    usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 40 }
  } }
]));
const { app } = require("../server");
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
base = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal((await fetch(`${base}/api/chat-usage`)).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "fixture-password" }) });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get("set-cookie").split(";")[0] };
  const get = (query = "") => fetch(`${base}/api/chat-usage${query}`, { headers });
  assert.equal((await get("?period=wrong")).status, 400);
  assert.equal((await get("?timeZone=wrong")).status, 400);
  assert.equal((await get("?id=../secret")).status, 400);
  assert.equal((await get("?device=all")).status, 400);
  const response = await get("?period=all&timeZone=Europe/Vienna");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const report = await response.json();
  assert.equal(report.rows.length, 2);
  assert.deepEqual(new Set(report.rows.map(row => row.title)), new Set(["Native title", "Claude title"]));
  assert.equal(report.coverage.totalTokens, 200);
  assert.equal(report.coverage.unassignedTokens, 0);
  assert.equal(report.coverage.multicaStatus, "not_configured");
  const serialized = JSON.stringify(report);
  for (const secret of ["SECRET", "/private/fixture", root, session, "request1", "message1"]) assert(!serialized.includes(secret), secret);
  const detail = await get(`?id=${report.rows[0].id}`).then(response => response.json());
  assert.equal(detail.row.runs.length, 1);
  assert.equal((await get(`?id=${"f".repeat(64)}`)).status, 404);
  const dashboard = await fetch(`${base}/api/usage`, { headers }).then(response => response.json());
  assert.equal(dashboard.local.totals.allTime.totalTokens, report.coverage.totalTokens, "chat query preserves the established dashboard totals");
  await aggregationWorker.terminate();
  const recovered = await get();
  assert.equal(recovered.status, 200, "a restarted worker rebuilds its index despite a fresh dashboard cache");
  assert.equal((await recovered.json()).coverage.totalTokens, 200);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await aggregationWorker?.terminate();
  await rm(root, { recursive: true, force: true });
}
console.log("Chat usage API: auth, validation, isolated parser-to-report integration, native titles, details, privacy, no-store and dashboard-total preservation passed.");
