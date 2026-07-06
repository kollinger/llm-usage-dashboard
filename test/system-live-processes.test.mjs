import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { _test } = require("../server.js");

assertDarwinSwapParsing();
assertLinuxSwapParsing();
assertProcessParsingAndSanitizing();
assertAiLoadFactors();

function assertDarwinSwapParsing() {
  const parsed = _test.parseDarwinSwapUsage("total = 13312.00M  used = 12004.94M  free = 1307.06M  (encrypted)");
  assert.equal(parsed.quality, "measured");
  assert.equal(parsed.totalGb, 13);
  assert.equal(parsed.usedGb, 11.7);
  assert.equal(parsed.freeGb, 1.3);
  assert(parsed.usedPercent > 90);
}

function assertLinuxSwapParsing() {
  const parsed = _test.parseLinuxMeminfoSwap(`
MemTotal:       32768000 kB
SwapTotal:       8388608 kB
SwapFree:        2097152 kB
`);
  assert.equal(parsed.quality, "measured");
  assert.equal(parsed.totalGb, 8);
  assert.equal(parsed.usedGb, 6);
  assert.equal(parsed.usedPercent, 75);
}

function assertProcessParsingAndSanitizing() {
  const psOutput = `
  100     1 160.0 1048576 /Applications/Codex.app/Contents/MacOS/Codex
  101   100  40.0  524288 /usr/local/bin/node
  102     1  80.0  262144 /Applications/Claude.app/Contents/MacOS/Claude
  103     1  20.0  131072 /Users/gerhard/private/tool --token secret-value
`;
  const rows = _test.parseProcessRows(psOutput);
  assert.equal(rows.length, 4);
  assert.equal(_test.classifyAiProcess(rows[0].command)?.id, "codex");
  assert.equal(_test.classifyAiProcess(rows[2].command)?.id, "claude");
  assert.equal(_test.classifyAiProcess(rows[3].command), null);

  const metrics = _test.buildLiveProcessMetrics({ psOutput });
  assert.equal(metrics.quality, "measured");
  assert(metrics.ai.processCount >= 3);
  assert(metrics.ai.rssGb > 0);
  assert(metrics.ai.memorySharePercent > 0);
  const codexGroup = metrics.groups.find((group) => group.id === "codex");
  assert.equal(codexGroup?.processCount, 2);
  assert(codexGroup.memorySharePercent > 0);
  assert(metrics.groups.some((group) => group.id === "claude"));

  const serialized = JSON.stringify(metrics);
  assert(!serialized.includes("/Applications/"));
  assert(!serialized.includes("/Users/gerhard"));
  assert(!serialized.includes("secret-value"));
  assert(!serialized.includes("command"));
  assert(!serialized.includes("path"));
}

function assertAiLoadFactors() {
  const score = _test.buildAiLoadScore(
    { usedPercent: 45 },
    { usedPercent: 96 },
    100_000,
    {
      processes: { quality: "measured", ai: { cpuPercent: 12, memorySharePercent: 8 } },
      swap: { usedPercent: 70 }
    }
  );
  assert.equal(score.quality, "estimated");
  assert.equal(score.factors.systemCpu, 45);
  assert.equal(score.factors.systemRam, 96);
  assert.equal(score.factors.aiCpu, 12);
  assert.equal(score.factors.aiRam, 8);
  assert.equal(score.factors.swap, 70);
  assert.equal(score.factors.tokens, 10);
  assert(score.score > 0);
}
