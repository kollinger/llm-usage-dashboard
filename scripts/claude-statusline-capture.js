#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  try {
    const payload = input.trim() ? JSON.parse(input) : {};
    const captured = sanitizeStatuslinePayload(payload);
    const target = path.join(os.homedir(), ".claude", "usage-dashboard-statusline.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(captured, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(formatStatusLine(captured));
  } catch {
    process.stdout.write("Claude usage: status unavailable");
  }
});

function sanitizeStatuslinePayload(payload) {
  const limits = payload.rate_limits || payload.rateLimits || {};
  const fiveHour = sanitizeLimitWindow(findLimitWindow(limits, ["five_hour", "fiveHour", "current_session", "currentSession", "session", "primary", "5h"]));
  const weekly = sanitizeLimitWindow(findLimitWindow(limits, ["seven_day", "sevenDay", "all_models", "allModels", "secondary", "7d"]));
  const design = sanitizeLimitWindow(findLimitWindow(limits.weekly || limits.weekly_limits || limits.weeklyLimits || limits, ["claude_design", "claudeDesign", "design"]));
  const credits = sanitizeCredits(findCredits(payload) || findCredits(limits));
  const plan =
    payload.subscriptionType ||
    payload.subscription_type ||
    payload.plan_type ||
    payload.planType ||
    payload.plan ||
    limits.plan_type ||
    limits.planType ||
    limits.plan;
  const captured = {};
  if (plan) captured.plan_type = String(plan);
  if (fiveHour || weekly || design) {
    captured.rate_limits = {};
    if (fiveHour) captured.rate_limits.five_hour = fiveHour;
    if (weekly) captured.rate_limits.seven_day = weekly;
    if (design) captured.rate_limits.claude_design = design;
  }
  if (credits) captured.usage_credits = credits;
  return captured;
}

function findLimitWindow(source, keys) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    if (source[key]) return source[key];
  }
  return null;
}

function sanitizeLimitWindow(window) {
  if (!window || typeof window !== "object") return null;
  const used = numberOrNull(window.used_percentage ?? window.usedPercent ?? window.used_percent ?? window.percent_used);
  const remaining = numberOrNull(
    window.remaining_percentage ?? window.remainingPercent ?? window.remaining_percent ?? window.percent_remaining
  );
  if (used === null && remaining === null) return null;
  const sanitized = {};
  if (used !== null) sanitized.used_percentage = Math.max(0, Math.min(100, used));
  if (remaining !== null) sanitized.remaining_percentage = Math.max(0, Math.min(100, remaining));
  const resetsAt = numberOrString(window.resets_at ?? window.resetsAt ?? window.reset_at ?? window.resetAt);
  if (resetsAt !== null) sanitized.resets_at = resetsAt;
  const resetLabel = shortString(window.reset_label ?? window.resetLabel ?? window.resets_in ?? window.resetsIn);
  if (resetLabel) sanitized.reset_label = resetLabel;
  const windowMinutes = numberOrNull(window.window_minutes ?? window.windowMinutes);
  if (windowMinutes !== null) sanitized.window_minutes = windowMinutes;
  return sanitized;
}

function sanitizeCredits(credits) {
  if (!credits || typeof credits !== "object") return null;
  const sanitized = {};
  for (const [target, keys] of Object.entries({
    spentAmount: ["spentAmount", "spent", "usedAmount", "amountSpent"],
    monthlyLimitAmount: ["monthlyLimitAmount", "monthlyLimit", "limitAmount", "spendingLimit"],
    currentCreditAmount: ["currentCreditAmount", "currentCredit", "balance", "remainingCredit"]
  })) {
    const value = firstValue(credits, keys);
    const amountValue = amount(value);
    if (amountValue !== null) sanitized[target] = amountValue;
  }
  const currency = shortString(credits.currency);
  if (currency && /^[A-Za-z]{3}$/.test(currency)) sanitized.currency = currency.toUpperCase();
  const reset = numberOrString(credits.resetsAt ?? credits.resetAt);
  if (reset !== null) sanitized.resetsAt = reset;
  return Object.keys(sanitized).length ? sanitized : null;
}

function firstValue(source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  return null;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrString(value) {
  const number = numberOrNull(value);
  if (number !== null) return number;
  return shortString(value);
}

function shortString(value) {
  const text = String(value || "").trim();
  return text.length && text.length <= 120 ? text : null;
}

function formatStatusLine(payload) {
  const limits = payload.rate_limits || payload.rateLimits || {};
  const weeklyRoot = limits.weekly || limits.weekly_limits || limits.weeklyLimits || {};
  const plan = payload.plan_type || payload.planType || payload.plan || limits.plan_type || limits.planType || limits.plan;
  const fiveHour =
    limits.current_session || limits.currentSession || limits.session || limits.five_hour || limits.fiveHour || limits.primary || limits["5h"];
  const weekly =
    weeklyRoot.all_models ||
    weeklyRoot.allModels ||
    limits.all_models ||
    limits.allModels ||
    limits.seven_day ||
    limits.sevenDay ||
    limits.secondary ||
    limits["7d"];
  const design = weeklyRoot.claude_design || weeklyRoot.claudeDesign || limits.claude_design || limits.claudeDesign;
  const credits = findCredits(payload) || findCredits(limits);
  const fiveHourFree = freePercent(fiveHour);
  const weeklyFree = freePercent(weekly);
  const designFree = freePercent(design);
  const spent = amount(credits?.spentAmount ?? credits?.spent ?? credits?.usedAmount ?? credits?.amountSpent);
  const monthlyLimit = amount(
    credits?.monthlyLimitAmount ?? credits?.monthlyLimit ?? credits?.limitAmount ?? credits?.spendingLimit
  );
  const parts = [];
  if (plan) parts.push(String(plan));
  if (fiveHourFree !== null) parts.push(`5h ${fiveHourFree}% frei`);
  if (weeklyFree !== null) parts.push(`Woche ${weeklyFree}% frei`);
  if (designFree !== null) parts.push(`Design ${designFree}% frei`);
  if (spent !== null && monthlyLimit !== null) parts.push(`Guthaben ${spent}/${monthlyLimit} EUR`);
  return parts.length ? `Claude ${parts.join(" · ")}` : "Claude usage: keine Limits";
}

function findCredits(source) {
  if (!source || typeof source !== "object") return null;
  return (
    source.usage_credits ||
    source.usageCredits ||
    source.guthaben ||
    source.credits ||
    source.billing?.usage_credits ||
    source.billing?.usageCredits ||
    source.billing?.credits ||
    source.account?.usage_credits ||
    source.account?.usageCredits ||
    source.account?.credits ||
    null
  );
}

function amount(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = typeof value === "string" ? value.replace(",", ".").replace(/[^\d.-]/g, "") : value;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function freePercent(window) {
  if (!window || typeof window !== "object") return null;
  const used = window.used_percentage ?? window.usedPercent ?? window.used_percent ?? window.percent_used;
  const remaining =
    window.remaining_percentage ?? window.remainingPercent ?? window.remaining_percent ?? window.percent_remaining;
  if (used !== undefined && !Number.isNaN(Number(used))) return Math.max(0, Math.round(100 - Number(used)));
  if (remaining !== undefined && !Number.isNaN(Number(remaining))) return Math.max(0, Math.round(Number(remaining)));
  return null;
}
