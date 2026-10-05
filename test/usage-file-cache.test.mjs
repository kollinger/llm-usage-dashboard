import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir, chmod, stat, rm, rename, utimes } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

const root = await mkdtemp(path.join(os.tmpdir(), "llm-usage-file-cache-"));
process.env.LLM_USAGE_DATA_DIR = path.join(root, "data");
process.env.CODEX_LIVE_RATE_LIMITS = "false";
const require = createRequire(import.meta.url);
const { readUsageFileEvents } = require("../lib/usage-file-cache");
const { _test } = require("../server");
const decompress = promisify(gunzip);
try {
  const file = path.join(root, "session.jsonl");
  const directory = path.join(root, "cache");
  const record = { file, realPath: file };
  const options = { directory, version: "fixture-parser-v1" };
  const transcript = "PRIVATE TRANSCRIPT MARKER";
  const timestamp = new Date().toISOString();
  const fixture = (total) => [
    { type: "turn_context", payload: { model: "fixture-model", effort: "high" } },
    { type: "response_item", payload: { content: transcript } },
    { type: "event_msg", timestamp, payload: { type: "token_count", info: { last_token_usage: { input_tokens: total, total_tokens: total } } } }
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(file, fixture(3), { mode: 0o600 });
  let parses = 0;
  const parse = async value => { parses += 1; return _test.parseCodexSessionFileEvents(value); };
  const first = await readUsageFileEvents(new Map(), record, parse, options);
  assert.equal(first[0].usage.total_tokens, 3);
  const saved = path.join(directory, (await readdir(directory))[0]);
  const decoded = (await decompress(await readFile(saved))).toString();
  assert(!decoded.includes(transcript), "the cache must contain extracted usage, never transcript content");
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(saved)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readUsageFileEvents(new Map(), record, parse, options), first);
  assert.equal(parses, 1, "a new process can reuse unchanged extraction without parsing the transcript");
  await writeFile(file, fixture(5));
  assert.equal((await readUsageFileEvents(new Map(), record, parse, options))[0].usage.total_tokens, 5);
  assert.equal(parses, 2, "changed source files must be read again");
  await writeFile(saved, "damaged cache");
  assert.equal((await readUsageFileEvents(new Map(), record, parse, options))[0].usage.total_tokens, 5);
  assert.equal(parses, 3, "a corrupt cache cannot hide usage or break reading");
  await readUsageFileEvents(new Map(), record, parse, { ...options, version: "fixture-parser-v2" });
  assert.equal(parses, 4, "changed parser versions invalidate previous extraction");
  const previousStat = await stat(file);
  const replacement = path.join(root, "replacement.jsonl");
  await writeFile(replacement, fixture(7));
  await utimes(replacement, previousStat.atime, previousStat.mtime);
  await rename(replacement, file);
  const memory = new Map();
  assert.equal((await readUsageFileEvents(memory, record, parse, options))[0].usage.total_tokens, 7);
  if (process.platform === "win32") {
    const account = os.userInfo().username;
    execFileSync("icacls", [file, "/deny", `${account}:(R)`], { stdio: "ignore" });
    try {
      assert.deepEqual(await readUsageFileEvents(memory, record, parse, options), [], "cached values do not bypass Windows source ACLs");
    } finally { execFileSync("icacls", [file, "/remove:d", account], { stdio: "ignore" }); }
  } else if (process.getuid?.() !== 0) {
    await chmod(file, 0o000);
    assert.deepEqual(await readUsageFileEvents(memory, record, parse, options), [], "cached values do not bypass source read permissions");
    await chmod(file, 0o600);
  }
  await rm(file);
  assert.deepEqual(await readUsageFileEvents(memory, record, parse, options), []);
  assert.equal(memory.size, 0);
  console.log("Usage file cache: restart reuse, changed/replaced sources, parser invalidation, corruption fallback, permissions and transcript privacy passed.");
} finally { await rm(root, { recursive: true, force: true }); }
