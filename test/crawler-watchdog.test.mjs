import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WATCHDOG = path.join(ROOT, "scripts", "crawler-watchdog.mjs");
const FIXTURES = path.join(ROOT, "test", "fixtures", "crawler-watchdog");

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
