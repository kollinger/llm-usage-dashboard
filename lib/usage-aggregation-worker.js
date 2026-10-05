"use strict";

const { parentPort } = require("node:worker_threads");
const { combinedUsage, attributeLocalUsageEvents, exportUsageEvents } = require("./device-sync-data");
const { aggregateUsageEvents, normalizeAttribution } = require("./usage-events");

const snapshots = new Map();
parentPort.on("message", ({ id, type, updates = [], origins = [], local, selected, providers, options }) => {
  try {
    for (const key of snapshots.keys()) if (!origins.includes(key)) snapshots.delete(key);
    for (const snapshot of updates) snapshots.set(snapshot.device.id, snapshot);
    let value;
    if (type === "combined") {
      value = combinedUsage(local, [...snapshots.values()], selected);
    } else if (type === "local") {
      const labels = new Map((options.accounts || []).map((account) => [account.accountId || account.id, account.label]));
      const events = attributeLocalUsageEvents(providers.flatMap((provider) => provider._usageEvents), {
        device: options.device, snapshots: [...snapshots.values()]
      }).map((event) => {
        const attribution = event.attribution;
        if (labels.has(attribution.accountId)) attribution.accountLabel = normalizeAttribution({ ...attribution, accountLabel: labels.get(attribution.accountId) }).accountLabel;
        return { ...event, attribution };
      });
      const aggregate = aggregateUsageEvents(events, { dailyHistoryDays: options.dailyHistoryDays });
      value = {
        local: { id: "local", status: aggregate.totals.allTime.totalTokens > 0 ? "live" : "empty", updatedAt: new Date().toISOString(),
          totals: aggregate.totals, daily: aggregate.daily, slots: aggregate.slots, sources: aggregate.sources,
          attribution: aggregate.attribution, eventStats: aggregate.stats },
        exported: options.exportEvents ? exportUsageEvents(providers) : null
      };
    } else throw new Error("unknown_aggregation");
    parentPort.postMessage({ id, value });
  } catch {
    parentPort.postMessage({ id, error: "usage_aggregation_failed" });
  }
});
