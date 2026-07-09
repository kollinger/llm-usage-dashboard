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

const openAiGenericPro5xBilling = _test.sanitizeAccountBillingSnapshots(
  {
    providers: {
      openai: {
        amount: 115,
        currency: "EUR",
        period: "month",
        plan: "Pro",
        sourceType: "browser_account_snapshot",
        fetchedAt: "2026-07-08T10:30:00Z"
      }
    }
  },
  { nowMs }
);
const codexGenericPro5x = _test.mergeProviderSubscription(
  { id: "codex", status: "live", planType: "Pro" },
  {},
  "codex",
  officialPricing,
  openAiGenericPro5xBilling
);
assert.equal(codexGenericPro5x.planType, "Pro 5x");
assert.equal(codexGenericPro5x.subscription.planType, "Pro 5x");
assert.equal(codexGenericPro5x.subscription.monthlyCost, 115);
assert.equal(codexGenericPro5x.subscription.currency, "EUR");
assert.equal(codexGenericPro5x.subscription.actualBillingKnown, true);

const openAiGenericPro20xBilling = _test.sanitizeAccountBillingSnapshots(
  {
    providers: {
      openai: {
        amount: 229,
        currency: "EUR",
        period: "month",
        plan: "Pro",
        sourceType: "browser_account_snapshot",
        fetchedAt: "2026-07-08T10:35:00Z"
      }
    }
  },
  { nowMs }
);
const codexGenericPro20x = _test.mergeProviderSubscription(
  { id: "codex", status: "live", planType: "Pro" },
  {},
  "codex",
  officialPricing,
  openAiGenericPro20xBilling
);
assert.equal(codexGenericPro20x.planType, "Pro 20x");
assert.equal(codexGenericPro20x.subscription.planType, "Pro 20x");
assert.equal(codexGenericPro20x.subscription.monthlyCost, 229);
assert.equal(codexGenericPro20x.subscription.currency, "EUR");
assert.equal(codexGenericPro20x.subscription.actualBillingKnown, true);

const claudeMax5xSnapshot = _test.normalizeClaudeBrowserCreditsSnapshot({
  subscription: { planType: "Claude Max", monthlyPrice: 90, currency: "EUR" },
  updatedAt: "2026-07-08T10:40:00Z"
});
assert.equal(claudeMax5xSnapshot.subscription.planType, "Claude Max 5x");
assert.equal(claudeMax5xSnapshot.subscription.monthlyCost, 90);

const claudeMax20xSnapshot = _test.normalizeClaudeBrowserCreditsSnapshot({
  subscription: { planType: "Claude Max", monthlyPrice: 180, currency: "EUR" },
  updatedAt: "2026-07-08T10:45:00Z"
});
assert.equal(claudeMax20xSnapshot.subscription.planType, "Claude Max 20x");
assert.equal(claudeMax20xSnapshot.subscription.monthlyCost, 180);

const openAiOnlyBilling = _test.sanitizeAccountBillingSnapshots(
  {
    providers: {
      openai: {
        status: "missing",
        reason: "account_billing_amount_missing",
        sourceType: "browser_account_snapshot",
        fetchedAt: "2026-07-08T10:45:00Z"
      }
    }
  },
  { nowMs }
);
const claudeBrowserSubscriptionMerged = _test.mergeProviderSubscription(
  {
    id: "claudeCode",
    status: "live",
    planType: "Claude Max 20x",
    planSource: "claude_browser_sync",
    subscription: claudeMax20xSnapshot.subscription
  },
  {},
  "claudeCode",
  officialPricing,
  openAiOnlyBilling
);
assert.equal(claudeBrowserSubscriptionMerged.subscription.planType, "Claude Max 20x");
assert.equal(claudeBrowserSubscriptionMerged.subscription.monthlyCost, 180);
assert.equal(claudeBrowserSubscriptionMerged.subscriptionConnectionAction, null);

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
assert.equal(claudeConflict.connectionAction.labelKey, "subscriptions.connectionActions.claudeRefresh");
assert.equal(claudeConflict.connectionAction.statusKey, "subscriptions.connectionActions.claudeRefresh");
assert.equal(claudeConflict.connectionAction.rereadOnly, true);

const claudeBrowserWithoutPlan = _test.resolveClaudePlanSignals({
  browserCredits: {
    status: "available",
    credits: { included: 1, remaining: 1 },
    usage: { five_hour: { used: 1, limit: 10 } },
    updatedAt: "2026-07-08T10:10:00Z"
  }
});
assert.equal(claudeBrowserWithoutPlan.planType, null);
assert.equal(claudeBrowserWithoutPlan.subscription, null);
assert.equal(claudeBrowserWithoutPlan.connectionAction.url, "https://claude.ai/settings/billing");
assert.equal(claudeBrowserWithoutPlan.connectionAction.labelKey, "subscriptions.connectionActions.claudeRefresh");
assert.equal(claudeBrowserWithoutPlan.connectionAction.statusKey, "subscriptions.connectionActions.claudeRefresh");
assert.equal(claudeBrowserWithoutPlan.connectionAction.rereadOnly, true);

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
assert.equal(codexWithExpiredBilling.subscription.monthlyCost, 0);
assert.equal(codexWithExpiredBilling.subscription.monthlyCostMin, null);
assert.equal(codexWithExpiredBilling.subscription.monthlyCostMax, null);
assert.equal(codexWithExpiredBilling.subscription.planType, null);
assert.equal(codexWithExpiredBilling.subscription.priceType, null);
assert.equal(codexWithExpiredBilling.subscription.priceVariant, null);
assert.equal(codexWithExpiredBilling.subscription.actualBillingKnown, false);
assert.equal(codexWithExpiredBilling.subscription.accountBillingStatus, "expired");
assert.equal(codexWithExpiredBilling.subscription.accountBillingParserStatus, "expired");
assert.equal(codexWithExpiredBilling.subscriptionConnectionAction.labelKey, "subscriptions.connectionActions.chatgptLogin");

const genericCodexWithoutBilling = _test.mergeProviderSubscription(
  { id: "codex", status: "live", planType: "Pro", planSource: "codex_app_server" },
  {},
  "codex",
  officialPricing,
  _test.sanitizeAccountBillingSnapshots({}, { nowMs })
);
assert.equal(genericCodexWithoutBilling.subscription.monthlyCost, 0);
assert.equal(genericCodexWithoutBilling.subscription.planType, null);
assert.equal(genericCodexWithoutBilling.subscription.priceVariant, null);
assert.equal(genericCodexWithoutBilling.subscriptionConnectionAction.labelKey, "subscriptions.connectionActions.chatgptRefresh");

const concreteOpenAiPlanOnlyBilling = _test.sanitizeAccountBillingSnapshots(
  {
    providers: {
      openai: {
        plan: "Pro 20x",
        sourceType: "browser_account_snapshot",
        fetchedAt: "2026-07-08T10:50:00Z",
        reason: "account_billing_amount_missing"
      }
    }
  },
  { nowMs }
);
const concreteCodexPlanOnly = _test.mergeProviderSubscription(
  { id: "codex", status: "live", planType: "Pro" },
  {},
  "codex",
  officialPricing,
  concreteOpenAiPlanOnlyBilling
);
const localizedConcreteCodex = _test.localizeUsageSubscriptionPrices({ codex: concreteCodexPlanOnly }, "de").codex;
assert.equal(localizedConcreteCodex.subscription.planType, "Pro 20x");
assert.equal(localizedConcreteCodex.subscription.monthlyCost, 229);
assert.equal(localizedConcreteCodex.subscription.currency, "EUR");
assert.equal(localizedConcreteCodex.subscriptionConnectionAction, null);

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
