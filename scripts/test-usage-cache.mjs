import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "llm-usage-cache-"));
const homeDir = path.join(tempRoot, "home");
const dataDir = path.join(tempRoot, "data");
const ollamaFile = path.join(dataDir, "ollama-usage.jsonl");

process.env.HOME = homeDir;
process.env.LLM_USAGE_DATA_DIR = dataDir;
process.env.CODEX_HOME = path.join(homeDir, ".codex");
process.env.COPILOT_HOME = path.join(homeDir, ".copilot");
process.env.CLAUDE_HOME = path.join(homeDir, ".claude");
process.env.GEMINI_HOME = path.join(homeDir, ".gemini");
process.env.OPENAI_ADMIN_KEY = "";
process.env.ANTHROPIC_ADMIN_KEY = "";
process.env.CODEX_LIVE_RATE_LIMITS = "false";
process.env.COPILOT_LIVE_QUOTA_ENABLED = "false";
process.env.USAGE_CACHE_SECONDS = "300";

const require = createRequire(import.meta.url);
const {
  createTimedCache,
  invalidateTimedCache,
  readThroughCache,
  startDashboard
} = require("../server.js");

await testTimedCacheInvalidationRace();

await fsp.mkdir(dataDir, { recursive: true });
await fsp.mkdir(homeDir, { recursive: true });
await appendOllamaEvents(ollamaFile, 0, 5000, 1);

const { dashboardServer } = startDashboard({ port: 0, ollamaProxy: false });
if (!dashboardServer.listening) await once(dashboardServer, "listening");

try {
  const address = dashboardServer.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const first = await fetchUsage(baseUrl);
  assert.equal(totalTokens(first), 5000);

  await appendOllamaEvents(ollamaFile, 5000, 250, 1);
  const warm = await fetchUsage(baseUrl);
  assert.equal(totalTokens(warm), 5000, "warm /api/usage should serve the cached usage response");
  assert.equal(warm.generatedAt, first.generatedAt, "warm /api/usage should reuse the cached response object");

  const forced = await fetchUsage(baseUrl, { force: true });
  assert.equal(totalTokens(forced), 5250, "force=1 should recompute usage from disk");

  await appendOllamaEvents(ollamaFile, 5250, 5000, 1);
  const [parallelA, parallelB] = await Promise.all([
    fetchUsage(baseUrl, { force: true }),
    fetchUsage(baseUrl, { force: true })
  ]);
  assert.equal(totalTokens(parallelA), 10250);
  assert.equal(totalTokens(parallelB), 10250);
  assert.equal(parallelA.generatedAt, parallelB.generatedAt, "parallel forced requests should share one pending recompute");
} finally {
  await closeServer(dashboardServer);
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

async function fetchUsage(baseUrl, options = {}) {
  const url = new URL("/api/usage", baseUrl);
  url.searchParams.set("ts", String(Date.now()));
  if (options.force) url.searchParams.set("force", "1");
  const response = await fetch(url);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

function totalTokens(payload) {
  return Number(payload?.local?.totals?.allTime?.totalTokens || 0);
}

async function testTimedCacheInvalidationRace() {
  const cache = createTimedCache();
  let releaseFirst;
  const first = readThroughCache(cache, 1000, () => {
    return new Promise((resolve) => {
      releaseFirst = () => resolve({ marker: "old" });
    });
  });

  invalidateTimedCache(cache);
  const second = readThroughCache(cache, 1000, async () => ({ marker: "new" }));
  assert.deepEqual(await second, { marker: "new" });

  releaseFirst();
  assert.deepEqual(await first, { marker: "old" });
  assert.deepEqual(cache.value, { marker: "new" }, "obsolete recomputes must not overwrite newer cache values");
  assert.equal(cache.pending, null, "obsolete recomputes must not clear newer pending state");
}

async function appendOllamaEvents(file, start, count, totalTokens) {
  const lines = [];
  const now = Date.now();
  for (let index = 0; index < count; index += 1) {
    lines.push(JSON.stringify({
      id: `event-${start + index}`,
      timestamp: new Date(now - (start + index) * 1000).toISOString(),
      model: "fixture",
      endpoint: "/api/generate",
      usage: {
        input_tokens: 0,
        output_tokens: totalTokens,
        total_tokens: totalTokens
      }
    }));
  }
  await fsp.appendFile(file, `${lines.join("\n")}\n`);
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
