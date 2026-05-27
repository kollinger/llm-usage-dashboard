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
    const target = path.join(os.homedir(), ".claude", "usage-dashboard-statusline.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(formatStatusLine(payload));
  } catch {
    process.stdout.write("Claude usage: status unavailable");
  }
});

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
