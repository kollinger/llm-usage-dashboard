import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WATCHDOG = path.join(ROOT, "scripts", "crawler-watchdog.mjs");
const STATUSLINE_CAPTURE = path.join(ROOT, "scripts", "claude-statusline-capture.js");
const FIXTURES = path.join(ROOT, "test", "fixtures", "crawler-watchdog");
const require = createRequire(import.meta.url);

const cases = [
  {
    name: "baseline fixture stays ok",
    fixture: "baseline",
    expectedExitCode: 0,
    assert(report) {
      assert.equal(report.status, "ok");
      assert.equal(report.providers[0].status, "ok");
      assert.equal(report.providers[1].status, "ok");
    }
  },
  {
    name: "missing Codex field reports needsCrawlerUpdate",
    fixture: "codex-missing-field",
    expectedExitCode: 1,
    assert(report) {
      assert.equal(report.status, "needsCrawlerUpdate");
      const codex = report.providers.find((provider) => provider.provider === "codex");
      assert.equal(codex.status, "needsCrawlerUpdate");
      assert(codex.drifts.some((drift) => drift.driftType === "missing"));
    }
  },
  {
    name: "renamed Codex field reports needsCrawlerUpdate",
    fixture: "codex-renamed-field",
    expectedExitCode: 1,
    assert(report) {
      const codex = report.providers.find((provider) => provider.provider === "codex");
      assert(codex.drifts.some((drift) => drift.driftType === "renamed"));
    }
  },
  {
    name: "unexpected Claude bucket reports needsCrawlerUpdate",
    fixture: "claude-unexpected-bucket",
    expectedExitCode: 1,
    assert(report) {
      const claude = report.providers.find((provider) => provider.provider === "claudeCode");
      assert(claude.drifts.some((drift) => drift.driftType === "unexpected"));
    }
  },
  {
    name: "missing Claude auth reports authMissing",
    fixture: "claude-auth-missing",
    expectedExitCode: 2,
    assert(report) {
      assert.equal(report.status, "authMissing");
      const claude = report.providers.find((provider) => provider.provider === "claudeCode");
      assert.equal(claude.status, "authMissing");
      assert.equal(claude.drifts.length, 0);
    }
  }
];

for (const testCase of cases) {
  const fixtureDir = path.join(FIXTURES, testCase.fixture);
  const result = spawnSync(process.execPath, [WATCHDOG, "--fixture", fixtureDir], {
    cwd: ROOT,
    encoding: "utf8"
  });

  assert.equal(result.status, testCase.expectedExitCode, `${testCase.name}: exit code mismatch\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  testCase.assert(report);
}

const triggerResult = spawnSync(process.execPath, [WATCHDOG, "--fixture", path.join(FIXTURES, "codex-missing-field"), "--print-trigger"], {
  cwd: ROOT,
  encoding: "utf8"
});

assert.equal(triggerResult.status, 1, "print-trigger should retain drift exit code");
const trigger = JSON.parse(triggerResult.stdout);
assert.equal(trigger.shouldCreateTicket, true);
assert.match(trigger.dedupeKey, /^codex\|readCodexUsage\|missing\|/u);

{
  const fixtureDir = path.join(FIXTURES, "baseline");
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    HOME: fixtureDir,
    CLAUDE_HOME: path.join(fixtureDir, "claude-home"),
    CLAUDE_BIN: path.join(fixtureDir, "bin", "claude"),
    LLM_USAGE_DATA_DIR: path.join(fixtureDir, "data"),
    DATA_DIR: path.join(fixtureDir, "data"),
    CODEX_LIVE_RATE_LIMITS: "false",
    COPILOT_LIVE_QUOTA_ENABLED: "false",
    ANTHROPIC_ADMIN_KEY: ""
  });
  const serverPath = path.join(ROOT, "server.js");
  delete require.cache[serverPath];
  try {
    const server = require(serverPath);
    const claude = await server.readClaudeCodeUsage();
    assert(claude.byModel.some((row) => row.model === "claude-fable-5"), "Claude Fable model usage should be preserved");
    assert.equal(claude.limits?.fable?.usedPercent, 29);
    assert(claude.limits.rows.some((row) => row.key === "fable"), "Claude Fable limit row should render when present");
  } finally {
    delete require.cache[serverPath];
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

{
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-statusline-"));
  const claudeHome = path.join(tmpHome, ".claude");
  try {
    const result = spawnSync(process.execPath, [STATUSLINE_CAPTURE], {
      cwd: ROOT,
      encoding: "utf8",
      input: JSON.stringify({
        plan_type: "max",
        rate_limits: {
          weekly: {
            fable: {
              used_percentage: 21,
              remaining_percentage: 79,
              resets_at: "2099-12-31T00:00:00.000Z",
              window_minutes: 10080
            }
          }
        }
      }),
      env: { ...process.env, CLAUDE_HOME: claudeHome }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Fable 79% frei/u);
    const captured = JSON.parse(fs.readFileSync(path.join(claudeHome, "usage-dashboard-statusline.json"), "utf8"));
    assert.equal(captured.rate_limits.fable.used_percentage, 21);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}
