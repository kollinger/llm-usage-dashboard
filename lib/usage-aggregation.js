"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { hash, refreshCombinedUsageMetadata } = require("./device-sync-data");

// One worker holds only the current immutable origin snapshots. Send changed
// revisions once; repeated chart requests must not clone the whole history.
function createUsageAggregation({ ttlMs = 30_000, maxEntries = 5, timeoutMs = 120_000, now = Date.now, viewCache = null, createWorker = () => new Worker(path.join(__dirname, "usage-aggregation-worker.js")) } = {}) {
  const cache = new Map();
  let worker = null, pending = null, sequence = 0, closed = false;
  const revisions = new Map();
  const limit = Math.min(10, Math.max(1, maxEntries));

  function dispose() {
    const previous = worker;
    worker = null; revisions.clear();
    return previous?.terminate();
  }

  async function run(type, snapshots, payload) {
    while (pending) await pending.catch(() => {});
    if (closed) throw new Error("usage_aggregation_closed");
    if (!worker) {
      worker = createWorker();
      const created = worker;
      created.on("error", () => {});
      created.once("exit", () => { if (worker === created) { worker = null; revisions.clear(); } });
    }
    const current = worker;
    current.ref?.();
    const origins = snapshots.map((snapshot) => snapshot.device.id);
    const updates = snapshots.filter((snapshot) => revisions.get(snapshot.device.id) !== (snapshot.revision || snapshot));
    const id = ++sequence;
    const operation = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        current.off("message", onMessage); current.off("error", onError); current.off("exit", onExit);
        if (error) { dispose(); reject(error); }
        else {
          for (const key of revisions.keys()) if (!origins.includes(key)) revisions.delete(key);
          for (const snapshot of updates) revisions.set(snapshot.device.id, snapshot.revision || snapshot);
          current.unref?.();
          resolve(value);
        }
      };
      const onMessage = (message) => { if (message.id === id) finish(message.error ? new Error(message.error) : null, message.value); };
      const onError = () => finish(new Error("usage_aggregation_failed"));
      const onExit = () => finish(new Error(closed ? "usage_aggregation_closed" : "usage_aggregation_failed"));
      const timer = setTimeout(() => finish(new Error("usage_aggregation_timeout")), timeoutMs);
      current.on("message", onMessage); current.once("error", onError); current.once("exit", onExit);
      try { current.postMessage({ id, type, origins, updates, ...payload }); }
      catch { finish(new Error("usage_aggregation_failed")); }
    });
    pending = operation;
    try { return await operation; }
    finally { if (pending === operation) pending = null; }
  }

  function viewInput(local, snapshots, selected) {
    const sorted = snapshots.slice().sort((a, b) => a.device.id.localeCompare(b.device.id));
    const origins = sorted.map((snapshot) => snapshot.device.id).join(":");
    const labels = [...(local.gptAccounts?.accounts || []), ...(local.connectedAccounts || [])]
      .map((account) => [account.accountId || account.id, account.label]);
    const key = hash(JSON.stringify([selected, labels, sorted.map((snapshot) => [snapshot.device.id, snapshot.revision || null, snapshot.capturedAt || null])]));
    return { key, origins, devices: sorted.map((snapshot) => ({ id: snapshot.device.id, name: snapshot.device.name,
      capturedAt: snapshot.capturedAt, eventCount: snapshot.events.length, excludedEvents: snapshot.excludedEvents })) };
  }

  async function compute(local, snapshots, selected, input) {
    const fingerprint = await viewCache?.context();
    // Quotas and other volatile provider metadata are overlaid on the main
    // thread, so an unchanged consumption cache cannot freeze account status.
    const labels = { gptAccounts: { accounts: (local.gptAccounts?.accounts || []).map(({ id, label }) => ({ id, label, sources: [] })) },
      connectedAccounts: (local.connectedAccounts || []).map(({ id, accountId, label }) => ({ id, accountId, label })) };
    const value = await run("combined", snapshots, { local: labels, selected });
    if (closed) throw new Error("usage_aggregation_closed");
    const entry = { ...input, value, expiresAt: now() + ttlMs };
    cache.delete(selected); cache.set(selected, entry);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
    if (viewCache) await viewCache.write(selected, fingerprint, value, input);
    return entry;
  }

  let refresh = null;
  async function get(local, snapshots, selected = "all", { force = false } = {}) {
    if (closed) throw new Error("usage_aggregation_closed");
    const input = viewInput(local, snapshots, selected);
    let entry = cache.get(selected);
    if (!entry && viewCache && !force) {
      const restored = await viewCache.read(selected, await viewCache.context());
      if (restored?.origins === input.origins) { entry = restored; cache.set(selected, entry); }
    }
    const sameOrigins = entry?.origins === input.origins;
    const fresh = sameOrigins && entry.key === input.key && entry.expiresAt > now();
    if (!force && fresh) return refreshCombinedUsageMetadata(local, entry.value, snapshots, selected);
    const launch = () => {
      if (!refresh) {
        const task = compute(local, snapshots, selected, input);
        refresh = { selected, key: input.key, promise: task };
        task.finally(() => { if (refresh?.promise === task) refresh = null; }).catch(() => {});
      }
      return refresh;
    };
    if (!force && sameOrigins) {
      launch().promise.catch(() => {});
      const value = refreshCombinedUsageMetadata(local, entry.value, snapshots, selected);
      return { ...value, cache: { ...(value.cache || {}), stale: true, refreshing: true, staleReason: "usage_refresh_in_progress", aggregateUpdatedAt: entry.value.local.updatedAt } };
    }
    // Never reuse stale consumption after an origin is removed or a different
    // installation is selected. The first result waits for its own computation.
    while (true) {
      const running = launch();
      await running.promise;
      if (running.selected === selected && running.key === input.key) {
        entry = cache.get(selected);
        return refreshCombinedUsageMetadata(local, entry.value, snapshots, selected);
      }
    }
  }

  return {
    get,
    aggregateLocal(providers, options) {
      return run("local", options.snapshots || [], { providers: providers.map((provider) => ({ _usageEvents: provider?._usageEvents || [] })),
        options: { device: options.device, accounts: options.accounts, dailyHistoryDays: options.dailyHistoryDays, exportEvents: options.exportEvents } });
    },
    async close() {
      closed = true; cache.clear();
      const active = pending;
      await dispose();
      await active?.catch(() => {});
    },
    size() { return cache.size; }
  };
}

module.exports = { createUsageAggregation };
