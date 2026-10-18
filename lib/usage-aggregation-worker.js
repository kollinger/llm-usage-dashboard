"use strict";

const { parentPort } = require("node:worker_threads");
const { prepareCombinedUsage, combinedUsage, attributeLocalUsageEvents, exportUsageEvents, usageEventSyncKey } = require("./device-sync-data");
const { aggregateUsageEvents, normalizeAttribution } = require("./usage-events");
const { createChatUsageIndex, queryChatUsage } = require("./chat-usage");

const snapshots = new Map();
let prepared = null, preparedLabels = null;
let localChats = null, combinedChats = null, localMulticaStatus = "not_configured";
parentPort.on("message", ({ id, type, updates = [], origins = [], local, selected, providers, options }) => {
  try {
    for (const key of snapshots.keys()) if (!origins.includes(key)) { snapshots.delete(key); prepared = null; combinedChats = null; }
    if (updates.length) { prepared = null; combinedChats = null; }
    for (const snapshot of updates) snapshots.set(snapshot.device.id, snapshot);
    let value;
    if (type === "chats") {
      if (selected === "local") {
        value = localChats ? queryChatUsage(localChats, { ...options, multicaStatus: localMulticaStatus }) : null;
      } else {
        if (!combinedChats) combinedChats = new Map();
        if (!combinedChats.has(selected)) {
          const chatEvents = prepareCombinedUsage({}, [...snapshots.values()]);
          combinedChats.set(selected, createChatUsageIndex(selected === "all" ? chatEvents.events : chatEvents.byDevice.get(selected) || []));
          while (combinedChats.size > 3) combinedChats.delete(combinedChats.keys().next().value);
        }
        value = queryChatUsage(combinedChats.get(selected), options);
      }
    } else if (type === "combined") {
      const labels = JSON.stringify(local);
      const current = [...snapshots.values()];
      if (!prepared || labels !== preparedLabels) {
        prepared = prepareCombinedUsage(local, current);
        preparedLabels = labels;
      }
      value = combinedUsage(local, current, selected, prepared);
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
      localChats = createChatUsageIndex(events.map((event) => ({ ...event, syncKey: usageEventSyncKey(event) })));
      localMulticaStatus = options.multicaStatus || "not_configured";
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
