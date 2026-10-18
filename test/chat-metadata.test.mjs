import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createChatMetadataReader } = require("../lib/chat-metadata.js");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "chat-metadata-test-"));
const codexHome = path.join(home, ".codex");
const issue = { id: "issue-a", identifier: "TEST-42", title: "Exact issue title", updated_at: "2026-10-18T08:00:00Z" };
const config = { serverUrl: "https://metadata.invalid", workspaceId: "workspace-a", token: "private-test-token" };
const session = { providerId: "claudeCode", sessionId: "session-a", cwd: "/example/test-42", file: path.join(home, "claude", "session-a.jsonl") };
let checks = 0;
function fakeApi(runs, issueRows = [issue]) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ path: url.pathname, workspace: url.searchParams.get("workspace_id") });
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer private-test-token");
    return { ok: true, json: async () => url.pathname === "/api/issues" ? { issues: issueRows, total: issueRows.length } : runs };
  };
  return { fetch, requests };
}
try {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "session_index.jsonl"), [
    JSON.stringify({ id: "thread-a", thread_name: "Old title" }),
    "unfinished-json",
    JSON.stringify({ id: "thread-a", thread_name: "New <title>\nwith spacing" })
  ].join("\n"));
  const native = createChatMetadataReader({ homeDir: home, env: {} });
  const nativeResult = await native.read();
  assert.equal(nativeResult.sessions["codex:thread-a"].title, "New title with spacing");
  assert.equal(nativeResult.multicaStatus, "not_configured");
  checks += 1;

  const api = fakeApi([
    { id: "run-a", kind: "direct", status: "completed", result: { session_id: "session-a", output: "private-transcript-sentinel" }, usage: [{ input_tokens: 999 }], work_dir: "/private/work-dir" },
    { id: "run-b", kind: "review", status: "completed", result: { session_id: "session-a" } }
  ]);
  const reader = createChatMetadataReader({ homeDir: home, env: {}, multica: config, fetch: api.fetch });
  const result = await reader.read({ sessions: [session] });
  const joined = result.sessions["claudeCode:session-a"];
  assert.equal(joined.issueId, issue.id);
  assert.equal(joined.identifier, "TEST-42");
  assert.equal(joined.title, issue.title);
  assert.equal(joined.kind, "multica");
  assert.equal(joined.runs.length, 2);
  assert.equal(result.multicaStatus, "ready");
  assert.deepEqual(api.requests.map((row) => row.path), ["/api/issues", "/api/issues/issue-a/task-runs"]);
  assert(api.requests.every((row) => row.workspace === "workspace-a"));
  for (const excluded of ["private-transcript-sentinel", "private-test-token", "/private/work-dir", "input_tokens", "metadata.invalid"]) assert(!JSON.stringify(result).includes(excluded));
  await reader.read({ sessions: [session] });
  assert.equal(api.requests.length, 2, "cache avoids repeated integration calls");
  checks += 1;

  const noMatchApi = fakeApi([{ id: "run-other", result: { session_id: "session-other" } }]);
  const noMatch = createChatMetadataReader({ homeDir: home, env: {}, multica: config, fetch: noMatchApi.fetch });
  const unmatched = await noMatch.read({ sessions: [{ ...session, providerId: "codex", originator: "multica-agent-sdk" }] });
  assert.equal(unmatched.sessions["codex:session-a"].kind, "multica");
  assert.equal(unmatched.sessions["codex:session-a"].issueId, undefined, "cwd identifier is only a candidate, not attribution");
  assert.equal(unmatched.multicaStatus, "partial");
  checks += 1;

  const taskRoot = path.join(home, "task");
  const taskFile = path.join(taskRoot, "codex-home", "sessions", "2026", "10", "rollout.jsonl");
  await fs.mkdir(path.dirname(taskFile), { recursive: true });
  await fs.writeFile(path.join(taskRoot, ".gc_meta.json"), JSON.stringify({ issue_id: "issue-a", task_id: "run-running", workspace_id: "workspace-a", unrelated: "private-meta-sentinel" }));
  const metaApi = fakeApi([]);
  const taskReader = createChatMetadataReader({ homeDir: home, env: {}, multica: config, fetch: metaApi.fetch });
  const taskResult = await taskReader.read({ sessions: [{ providerId: "codex", sessionId: "running-thread", file: taskFile }] });
  assert.equal(taskResult.sessions["codex:running-thread"].title, issue.title);
  assert.equal(taskResult.sessions["codex:running-thread"].runId, "run-running");
  assert.equal(taskResult.files[path.resolve(taskFile)].issueId, issue.id);
  assert(!JSON.stringify(taskResult).includes("private-meta-sentinel"));
  checks += 1;

  const slowApi = fakeApi([{ id: "run-a", result: { session_id: "session-a" } }]);
  const slowReader = createChatMetadataReader({ homeDir: home, env: {}, multica: config, fetch: async (url, options) => {
    if (url.pathname === "/api/issues") await new Promise((resolve) => setTimeout(resolve, 950));
    return slowApi.fetch(url, options);
  } });
  const early = await slowReader.read({ sessions: [session] });
  assert.equal(early.multicaStatus, "partial", "slow optional integration yields a progressive status");
  assert.equal(early.sessions["claudeCode:session-a"], undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const enriched = await slowReader.read({ sessions: [session] });
  assert.equal(enriched.sessions["claudeCode:session-a"].issueId, issue.id);
  assert.equal(enriched.multicaStatus, "ready");
  checks += 1;

  let failures = 0;
  const unavailable = createChatMetadataReader({ homeDir: home, env: {}, multica: config, fetch: async () => { failures += 1; throw new Error("private-error-sentinel"); } });
  const missing = await unavailable.read({ sessions: [session] });
  assert.equal(missing.multicaStatus, "unavailable");
  assert(!JSON.stringify(missing).includes("private-error-sentinel"));
  await unavailable.read({ sessions: [session] });
  assert.equal(failures, 1);
  checks += 1;

  const batchIssues = [issue, { id: "issue-b", identifier: "TEST-43", title: "Later issue", updated_at: "2026-10-17T08:00:00Z" }];
  const batchCalls = [];
  const batchReader = createChatMetadataReader({ homeDir: home, env: {}, multica: { ...config, maxRunIssues: 1 }, fetch: async (url) => {
    batchCalls.push(url.pathname);
    return { ok: true, json: async () => url.pathname === "/api/issues" ? { issues: batchIssues, total: 2 }
      : [{ id: url.pathname.includes("issue-b") ? "run-b" : "run-a", result: { session_id: url.pathname.includes("issue-b") ? "later-session" : "session-a" } }] };
  } });
  const batchOne = await batchReader.read({ sessions: [session] });
  assert.equal(batchOne.multicaStatus, "partial");
  assert.equal(batchOne.sessions["claudeCode:session-a"].issueId, "issue-a");
  const batchTwo = await batchReader.read({ sessions: [session] });
  assert.equal(batchTwo.multicaStatus, "ready");
  assert.equal(batchTwo.sessions["claudeCode:session-a"].issueId, "issue-a", "earlier joins survive later batches");
  assert.equal(batchTwo.sessions["claudeCode:later-session"].issueId, "issue-b");
  assert.deepEqual(batchCalls, ["/api/issues", "/api/issues/issue-a/task-runs", "/api/issues/issue-b/task-runs"]);
  checks += 1;
  console.log(`chat metadata: ${checks} checks passed`);
} finally {
  await fs.rm(home, { recursive: true, force: true });
}
