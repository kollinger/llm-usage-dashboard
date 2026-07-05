import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = await mkdtemp(path.join(tmpdir(), "llm-usage-cache-smoke-"));

let child;
try {
  const home = path.join(tempRoot, "home");
  const dataDir = path.join(tempRoot, "data");
  const codexHome = path.join(home, ".codex");
  const codexSessions = path.join(codexHome, "sessions");
  await mkdir(codexSessions, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const timestamp = new Date().toISOString();
  await writeFile(
    path.join(codexSessions, "rollout-smoke.jsonl"),
    `${JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15
          }
        }
      }
    })}\n`
  );

  const port = await getFreePort();
  const ollamaProxyPort = await getFreePort();
  child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      COPILOT_HOME: path.join(home, ".copilot"),
      CLAUDE_HOME: path.join(home, ".claude"),
      GEMINI_HOME: path.join(home, ".gemini"),
      LLM_USAGE_DATA_DIR: dataDir,
      PORT: String(port),
      OLLAMA_PROXY_PORT: String(ollamaProxyPort),
      OLLAMA_HOST: "http://127.0.0.1:9",
      CODEX_LIVE_RATE_LIMITS: "false",
      COPILOT_LIVE_QUOTA_ENABLED: "false",
      USAGE_CACHE_SECONDS: "600"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await waitForServer(port);

  const first = await fetchUsage(port);
  const second = await fetchUsage(port);
  assert.equal(second.generatedAt, first.generatedAt, "normal polling should reuse the usage cache");
  assert.equal(second.local.totals.allTime.totalTokens, 15);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const forced = await fetchUsage(port, "force=1");
  assert.notEqual(forced.generatedAt, first.generatedAt, "force=1 should recompute usage");

  const warmAfterForce = await fetchUsage(port);
  assert.equal(warmAfterForce.generatedAt, forced.generatedAt, "normal polling should reuse the forced result");

  await new Promise((resolve) => setTimeout(resolve, 20));
  const [parallelA, parallelB] = await Promise.all([fetchUsage(port, "force=1"), fetchUsage(port, "force=1")]);
  assert.equal(parallelA.generatedAt, parallelB.generatedAt, "parallel forced requests should share one pending computation");

  if (stderr.trim()) {
    console.warn(stderr.trim());
  }
  console.log("usage cache smoke passed");
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(tempRoot, { recursive: true, force: true });
}

async function fetchUsage(port, query = "") {
  const response = await fetch(`http://127.0.0.1:${port}/api/usage${query ? `?${query}` : ""}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForServer(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fetchUsage(port);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("server did not become ready");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
