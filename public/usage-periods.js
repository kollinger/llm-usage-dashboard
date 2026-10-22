(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.UsagePeriods = api;
})(globalThis, function () {
  "use strict";

  function monthBoundary(anchor, delta) {
    const month = new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1);
    month.setDate(Math.min(anchor.getDate(), new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()));
    return month;
  }

  function calendarPeriod(kind, offset = 0, now = new Date(), anchorValue = "", months = 1) {
    let from, to;
    if (kind === "all") return { from: new Date(0).toISOString(), to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString() };
    if (kind === "week") {
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      from.setDate(from.getDate() - (from.getDay() + 6) % 7 + offset * 7);
      to = new Date(from); to.setDate(to.getDate() + 7);
    } else if (kind === "billing") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorValue)) return null;
      const anchor = new Date(`${anchorValue}T00:00:00`);
      if (!Number.isFinite(anchor.getTime()) || anchor.getDate() !== Number(anchorValue.slice(-2))) return null;
      const step = months === 12 ? 12 : 1;
      let delta = Math.floor(((now.getFullYear() - anchor.getFullYear()) * 12 + now.getMonth() - anchor.getMonth()) / step) * step;
      if (monthBoundary(anchor, delta) > now) delta -= step;
      from = monthBoundary(anchor, delta + offset * step);
      to = monthBoundary(anchor, delta + (offset + 1) * step);
    } else return null;
    return { from: from.toISOString(), to: to.toISOString() };
  }

  function resetPeriods(history, quotaWindows, windowKey, now = Date.now()) {
    const rows = history && windowKey === "weekly"
      ? [history.current, ...(history.windows || [])].filter(Boolean).map((window) => ({
        from: window.startsAt, to: window.closedAt || window.scheduledResetAt,
        estimated: Boolean(window.startEstimated || window.gap || window.overlap),
        cause: window.resetCause?.type || "unknown"
      }))
      : (quotaWindows || []).filter((window) => window.windowKey === windowKey).map((window) => ({
        from: window.startsAt, to: window.resetsAt, estimated: true, cause: "unknown"
      }));
    const unique = new Map();
    for (const row of rows) {
      const from = Date.parse(row.from), to = Date.parse(row.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || from > now) continue;
      unique.set(`${from}:${to}`, row);
    }
    const periods = [...unique.values()].sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
    // An early reset ends the previous interval; overlapping nominal windows
    // must never count the same request in both adjacent periods.
    for (let i = 0; i < periods.length - 1; i++) {
      if (Date.parse(periods[i].to) > Date.parse(periods[i + 1].from)) {
        periods[i] = { ...periods[i], to: periods[i + 1].from, estimated: true };
      }
    }
    return periods.reverse();
  }

  return { calendarPeriod, monthBoundary, resetPeriods };
});
