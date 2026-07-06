import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { _test } = require("../server.js");

const zeroEntitlementLimits = _test.copilotLimitsFromQuota({
  status: "live",
  source: "copilot_sdk_account.getQuota",
  quotaSnapshots: {
    chat: {
      entitlementRequests: 200,
      usedRequests: 0,
      remainingPercentage: 100,
      resetDate: "2099-01-01T00:00:00.000Z"
    },
    completions: {
      entitlementRequests: 2000,
      usedRequests: 0,
      remainingPercentage: 100,
      resetDate: "2099-01-01T00:00:00.000Z"
    },
    premium_interactions: {
      entitlementRequests: 0,
      usedRequests: 16,
      remainingPercentage: 0,
      resetDate: "2099-01-01T00:00:00.000Z"
    }
  }
});

const unavailablePremium = zeroEntitlementLimits.rows.find((row) => row.key === "copilotPremiumInteractions");
assert.equal(unavailablePremium.status, "unavailable");
assert.equal(unavailablePremium.usedPercent, null);
assert.equal(unavailablePremium.remainingPercent, null);
assert.equal(unavailablePremium.resetsAt, null);
assert.equal(unavailablePremium.valueLabel, null);
assert.equal(
  zeroEntitlementLimits.rows.some((row) => /premium/i.test(`${row.key} ${row.label}`) && Number(row.usedPercent || 0) >= 99.5),
  false,
  "zero-entitlement Copilot premium buckets must not render as full live quota"
);

const fullEntitlementLimits = _test.copilotLimitsFromQuota({
  status: "live",
  source: "copilot_sdk_account.getQuota",
  quotaSnapshots: {
    premium_interactions: {
      entitlementRequests: 16,
      usedRequests: 16,
      remainingPercentage: 0,
      resetDate: "2099-01-01T00:00:00.000Z"
    }
  }
});

const fullPremium = fullEntitlementLimits.rows.find((row) => row.key === "copilotPremiumInteractions");
assert.equal(fullPremium.usedPercent, 100);
assert.equal(fullPremium.remainingPercent, 0);
assert.equal(fullPremium.valueLabel, "16 / 16");
assert.equal(fullPremium.resetsAt, "2099-01-01T00:00:00.000Z");
