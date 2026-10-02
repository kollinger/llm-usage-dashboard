import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assessQuotaPace, mergeQuotaPaceSamples } = require("../lib/quota-pace.js");
const now = Date.parse("2026-10-01T12:00:00.000Z");
const reset = new Date(now + 10 * 60 * 60_000).toISOString();

function event(usedPercent, minutesAgo, resetsAt = reset, windowMinutes = 10080) {
  return {
    type: "quota_window",
    provider: "codex",
    windowKey: "weekly",
    windowMinutes,
    usedPercent,
    capturedAt: new Date(now - minutesAgo * 60_000).toISOString(),
    resetsAt
  };
}

function status(before, after, minutes = 120) {
  const samples = mergeQuotaPaceSamples([], [event(before, minutes), event(after, 0)], now);
  return assessQuotaPace(samples, now).codex.weekly[minutes];
}

assert.equal(status(30, 50).status, "risk");
assert.equal(status(9, 10).status, "safe");
assert.equal(status(88, 90).status, "possible");
assert.equal(status(10, 10).status, "flat");
assert.equal(status(30, 20).status, "changed");
assert.equal(status(30, 50, 30).status, "risk");

const wrongReset = mergeQuotaPaceSamples([], [event(30, 120, new Date(now + 8 * 60 * 60_000).toISOString()), event(50, 0)], now);
assert.equal(assessQuotaPace(wrongReset, now).codex.weekly[120].status, "collecting");

const sameResetWithClockJitter = mergeQuotaPaceSamples([], [event(30, 120, new Date(Date.parse(reset) - 30_000).toISOString()), event(50, 0)], now);
assert.equal(assessQuotaPace(sameResetWithClockJitter, now).codex.weekly[120].status, "risk");

const stale = mergeQuotaPaceSamples([], [event(30, 126), event(50, 6)], now);
assert.equal(assessQuotaPace(stale, now).codex.weekly[120].status, "stale");

assert.equal(mergeQuotaPaceSamples([], [event(20, 0, reset, 300)], now).length, 0);
console.log("quota pace scenarios passed");
