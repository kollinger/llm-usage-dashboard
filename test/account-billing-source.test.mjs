import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { _test } = require("../server.js");

const nowMs = Date.parse("2026-07-08T12:00:00Z");
const officialPricing = {
  version: 1,
  fetchedAt: "2026-07-08T09:00:00Z",
  families: {
    openai: {
      source: "official_pricing_page",
      sourceUrl: "https://developers.openai.com/codex/pricing",
      fetchedAt: "2026-07-08T09:00:00Z",
      parserStatus: "parsed",
      entries: [
        {
          planKey: "pro",
          planName: "Pro",
          aliases: ["pro", "chatgpt pro", "codex pro"],
          monthlyCost: 100,
          currency: "USD",
          source: "official_pricing_page",
          sourceUrl: "https://developers.openai.com/codex/pricing",
          fetchedAt: "2026-07-08T09:00:00Z",
          parserStatus: "parsed",
          priceType: "official_starting_list_price",
          priceVariant: "from",
          actualBillingKnown: false
        }
      ]
    },
    anthropic: {
      source: "official_pricing_page",
      sourceUrl: "https://claude.com/pricing",
      fetchedAt: "2026-07-08T09:00:00Z",
      parserStatus: "parsed",
      entries: [
        {
          planKey: "max",
          planName: "Claude Max",
          aliases: ["max", "claude max"],
          monthlyCost: 100,
          currency: "USD",
          source: "official_pricing_page",
          sourceUrl: "https://claude.com/pricing",
          fetchedAt: "2026-07-08T09:00:00Z",
          parserStatus: "parsed",
          priceType: "official_list_price",
          actualBillingKnown: false
        }
      ]
    }
  }
};

const freshBilling = _test.sanitizeAccountBillingSnapshots(
  {
    providers: {
      openai: {
        amount: "$200.00",
        currency: "USD",
        period: "month",
        plan: "Pro 20x",
        sourceType: "browser_account_snapshot",
        sourceUrl: "https://chatgpt.com/account/billing?session=secret-token#token",
        fetchedAt: "2026-07-08T10:00:00Z",
        confidence: "high",
        cookie: "do-not-return",
        nested: {
          access_token: "also-do-not-return"
        }
      },
      anthropic: {
        amountCents: 15000,
        currency: "USD",
        period: "monthly",
        plan: "Claude Max",
        sourceType: "sanitized_snapshot",
        sourceUrl: "https://claude.com/settings/billing/customer_123456789012345678901234",
        fetchedAt: "2026-07-08T10:00:00Z"
      }
    }
  },
  { nowMs }
);

const redactedOutput = JSON.stringify(freshBilling);
assert.equal(redactedOutput.includes("do-not-return"), false);
assert.equal(redactedOutput.includes("also-do-not-return"), false);
assert.equal(redactedOutput.includes("secret-token"), false);
assert.equal(freshBilling.providers.openai.redacted, true);
assert.equal(freshBilling.providers.openai.sourceUrl, "https://chatgpt.com/account/billing");

const unsafeReasonBilling = _test.sanitizeAccountBillingSnapshots(
  {
    reason: "fetch failed with session token secret-value",
    providers: {
      openai: {
        status: "parse_failed",
        error: "cookie abc123 and bearer secret-value leaked by parser"
      }
    }
  },
  { nowMs }
);
const unsafeReasonOutput = JSON.stringify(unsafeReasonBilling);
assert.equal(unsafeReasonOutput.includes("secret-value"), false);
assert.equal(unsafeReasonOutput.includes("abc123"), false);
assert.equal(unsafeReasonOutput.includes("bearer"), false);
assert.equal(unsafeReasonBilling.reason, null);
assert.equal(unsafeReasonBilling.providers.openai.unavailableReason, "account_billing_source_parse_failed");

const codexWithAccountBilling = _test.mergeProviderSubscription(
  { id: "codex", status: "live", planType: "Pro" },
  { planType: "Pro", monthlyCost: 125, currency: "USD" },
  "codex",
  officialPricing,
  freshBilling
);
assert.equal(codexWithAccountBilling.subscription.monthlyCost, 200);
assert.equal(codexWithAccountBilling.subscription.currency, "USD");
assert.equal(codexWithAccountBilling.subscription.source, "account_billing");
assert.equal(codexWithAccountBilling.subscription.actualBillingKnown, true);
assert.equal(codexWithAccountBilling.subscription.accountBillingStatus, "available");

const claudeWithAnthropicBilling = _test.mergeProviderSubscription(
  { id: "claudeCode", status: "live", planType: "Max" },
  {},
  "claudeCode",
  officialPricing,
  freshBilling
);
assert.equal(claudeWithAnthropicBilling.subscription.monthlyCost, 150);
assert.equal(claudeWithAnthropicBilling.subscription.source, "account_billing");
assert.equal(claudeWithAnthropicBilling.subscription.actualBillingKnown, true);

const claudeConflict = _test.resolveClaudePlanSignals({
  browserCredits: { status: "expired", reason: "claude_login_required", updatedAt: "2026-07-08T10:00:00Z" },
  statusline: { planType: "Claude Max 20x", updatedAt: "2026-07-07T20:00:00Z" },
  authStatus: { planType: "Claude Max 5x" }
});
assert.equal(claudeConflict.planType, null);
assert.equal(claudeConflict.subscription, null);
assert.equal(claudeConflict.conflict.status, "conflict");
assert.deepEqual(
  claudeConflict.conflict.sources.map((source) => source.planType),
  ["Claude Max 20x", "Claude Max 5x"]
);
assert.equal(claudeConflict.connectionAction.url, "https://claude.ai/settings/billing");
assert.equal(claudeConflict.connectionAction.labelKey, "subscriptions.connectionActions.claudeLogin");

const claudeBrowserBillingWins = _test.resolveClaudePlanSignals({
  browserSubscription: { planType: "Claude Max 20x", monthlyCost: 180, currency: "EUR", updatedAt: "2026-07-08T10:10:00Z" },
  browserCredits: { status: "available", updatedAt: "2026-07-08T10:10:00Z" },
  statusline: { planType: "Claude Max 5x", updatedAt: "2026-07-08T10:00:00Z" },
  authStatus: { planType: "Claude Max 5x" }
});
assert.equal(claudeBrowserBillingWins.planType, "Claude Max 20x");
assert.equal(claudeBrowserBillingWins.planSource, "claude_browser_sync");
assert.equal(claudeBrowserBillingWins.conflict, null);
assert.equal(claudeBrowserBillingWins.connectionAction, null);

const expiredBilling = _test.sanitizeAccountBillingSnapshots(
  {
    providers: {
      openai: {
        amount: 200,
        currency: "USD",
        period: "month",
        plan: "Pro",
        fetchedAt: "2026-06-01T10:00:00Z"
      }
    }
  },
  { nowMs }
);
const codexWithExpiredBilling = _test.mergeProviderSubscription(
  { id: "codex", status: "live", planType: "Pro" },
  {},
  "codex",
  officialPricing,
  expiredBilling
);
assert.equal(codexWithExpiredBilling.subscription.monthlyCost, 100);
assert.equal(codexWithExpiredBilling.subscription.monthlyCostMin, 100);
assert.equal(codexWithExpiredBilling.subscription.monthlyCostMax, 200);
assert.equal(codexWithExpiredBilling.subscription.source, "official_pricing_page");
assert.equal(codexWithExpiredBilling.subscription.planType, "Pro 5x/20x");
assert.equal(codexWithExpiredBilling.subscription.priceType, "official_variant_range");
assert.equal(codexWithExpiredBilling.subscription.priceVariant, "pro_5x_20x");
assert.equal(codexWithExpiredBilling.subscription.actualBillingKnown, false);
assert.equal(codexWithExpiredBilling.subscription.accountBillingStatus, "expired");
assert.equal(codexWithExpiredBilling.subscription.accountBillingParserStatus, "expired");

const unknownBilling = _test.sanitizeAccountBillingSnapshots({}, { nowMs });
const enterpriseWithoutFallback = _test.mergeProviderSubscription(
  { id: "codex", status: "live", planType: "Enterprise" },
  {},
  "codex",
  { version: 1, families: {} },
  unknownBilling
);
assert.equal(enterpriseWithoutFallback.subscription.monthlyCost, 0);
assert.equal(enterpriseWithoutFallback.subscription.costStatus, "catalog_missing");
assert.equal(enterpriseWithoutFallback.subscription.accountBillingStatus, "missing");
