"use strict";

const STALE_AFTER_MS = 15 * 60_000;
const iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const percent = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

function gptQuotaMeasuredAt(row, updatedAt) {
  // An explicitly missing/invalid row timestamp must not inherit a fresh scan.
  if (Object.hasOwn(row, "updatedAt")) return iso(row.updatedAt);
  if (Object.hasOwn(row, "observedAt")) return iso(row.observedAt);
  return iso(updatedAt);
}

function gptQuotaWindowKey(row, index) {
  if (row.windowMinutes === 300 || row.key === "fiveHour") return "fiveHour";
  if (row.windowMinutes === 10080 || row.key === "weekly") return "weekly";
  return typeof row.key === "string" && row.key ? row.key : `window-${index + 1}`;
}

// Candidates must already belong to one verified account. The selection never
// uses labels, emails, profile paths, scan times, or provider-wide fallbacks.
function selectGptQuotaRows(candidates, now = Date.now(), preferCurrent = false) {
  const windows = new Map();
  const rank = (candidate) => {
    const row = candidate.row;
    if (!percent(row.remainingPercent) && !percent(row.usedPercent)) return 0;
    const measured = Date.parse(candidate.updatedAt);
    const reset = row.resetsAt == null ? null : Date.parse(row.resetsAt);
    if (!Number.isFinite(measured) || measured > now + 60_000 ||
        (reset !== null && (!Number.isFinite(reset) || reset <= now))) return 1;
    return preferCurrent && candidate.current && now - measured <= STALE_AFTER_MS ? 3 : 2;
  };
  const compare = (left, right) => rank(left) - rank(right) ||
    ((Date.parse(left.updatedAt) <= now + 60_000 ? Date.parse(left.updatedAt) : 0) || 0) -
      ((Date.parse(right.updatedAt) <= now + 60_000 ? Date.parse(right.updatedAt) : 0) || 0) ||
    Number(Boolean(left.current)) - Number(Boolean(right.current)) ||
    JSON.stringify(left.row).localeCompare(JSON.stringify(right.row));
  for (const candidate of candidates || []) {
    (candidate.limits?.rows || []).forEach((row, index) => {
      if (!row || typeof row !== "object") return;
      const key = gptQuotaWindowKey(row, index);
      const entry = { ...candidate, row: { ...row, key }, updatedAt: gptQuotaMeasuredAt(row, candidate.limitsUpdatedAt) };
      const previous = windows.get(key);
      if (!previous || compare(entry, previous) > 0) windows.set(key, entry);
    });
  }
  const order = (key) => key === "fiveHour" ? 0 : key === "weekly" ? 1 : 2;
  return [...windows.values()].sort((a, b) => order(a.row.key) - order(b.row.key) ||
    (a.row.windowMinutes || 0) - (b.row.windowMinutes || 0) || a.row.key.localeCompare(b.row.key));
}

function mergeGptQuotaLimits(candidates, now = Date.now()) {
  const selected = selectGptQuotaRows(candidates, now);
  return selected.length ? { rows: selected.map(({ row, updatedAt }) => ({ ...row, updatedAt })) } : null;
}

module.exports = { gptQuotaMeasuredAt, mergeGptQuotaLimits, selectGptQuotaRows };
