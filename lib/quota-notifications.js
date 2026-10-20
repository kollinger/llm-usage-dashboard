"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const MAX_GAP_MS = 10 * 60000;
const JITTER_MS = 90 * 1000;
const EVENT_TYPES = ["unexpected_reset", "scheduled_reset", "limit_reached", "availability_restored", "quota_changed"];

function notificationSettings(raw = {}) {
  return { enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    resetsEnabled: typeof raw.resetsEnabled === "boolean" ? raw.resetsEnabled : true,
    pacingPercent: Number.isFinite(Number(raw.pacingPercent)) ? Number(raw.pacingPercent) : 100,
    hardLimitPercent: Number.isFinite(Number(raw.hardLimitPercent)) ? Number(raw.hardLimitPercent) : 95 };
}

function codexNotificationSample(response, at = new Date().toISOString()) {
  const bucket = response?.rateLimitsByLimitId?.codex || response?.rateLimits;
  if (!response?.accountId || !bucket) return null;
  const windows = ["primary", "secondary"].flatMap((slot) => {
    const win = bucket[slot], minutes = Number(win?.windowDurationMins);
    if (![300, 10080].includes(minutes) || !Number.isFinite(win?.resetsAt)) return [];
    return [{ key: minutes === 300 ? "five_hour" : "weekly", windowMinutes: minutes,
      usedPercent: win.usedPercent, resetsAt: new Date(win.resetsAt * 1000).toISOString() }];
  });
  const longest = windows.slice().sort((a, b) => b.windowMinutes - a.windowMinutes)[0];
  if (longest && (response.ordinaryUsageAllowed === false || bucket.rateLimitReachedType || response.rateLimitReachedType)) longest.limited = true;
  return { accountKey: hash(response.accountId), planType: bucket.planType || null, at, windows };
}

function quotaTransitions(previous, sample) {
  if (!previous || !sample?.accountKey || previous.accountKey !== sample.accountKey || previous.planType !== sample.planType ||
      Date.parse(sample.at) <= Date.parse(previous.at) || Date.parse(sample.at) - Date.parse(previous.at) > MAX_GAP_MS) return [];
  return sample.windows.flatMap((win) => {
    const before = previous.windows.find((row) => row.key === win.key && row.windowMinutes === win.windowMinutes);
    if (!before) return [];
    const planned = Date.parse(before.resetsAt), reset = Date.parse(win.resetsAt), now = Date.parse(sample.at);
    const dropped = win.usedPercent < before.usedPercent;
    const wasLimited = before.limited || before.usedPercent >= 100, limited = win.limited || win.usedPercent >= 100;
    let type;
    if (reset > planned + JITTER_MS && (dropped || wasLimited && !limited || now >= planned - 5 * 60000) &&
        !(before.usedPercent === 0 && win.usedPercent === 0 && !wasLimited)) {
      type = now >= planned - 5 * 60000 ? "scheduled_reset" : "unexpected_reset";
    } else if (!wasLimited && limited) type = "limit_reached";
    else if (wasLimited && !limited) type = "availability_restored";
    else if (dropped || Math.abs(reset - planned) > JITTER_MS && before.usedPercent > 0) type = "quota_changed";
    if (!type) return [];
    return [{ id: hash([sample.accountKey, sample.at, win.key, type].join(":")), type, at: sample.at,
      accountKey: sample.accountKey, accountLabel: sample.accountLabel || previous.accountLabel || null,
      windowKey: win.key, windowMinutes: win.windowMinutes, usedPercent: win.usedPercent,
      previousUsedPercent: before.usedPercent, previousResetAt: before.resetsAt, resetsAt: win.resetsAt }];
  });
}

function createQuotaNotifications(file, now = Date.now) {
  let queue = Promise.resolve(), state;
  const serial = (fn) => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const load = async () => {
    if (state) return;
    try { state = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; state = { version: 1, samples: {}, events: [] }; }
  };
  const save = async () => {
    state.events = state.events.filter((event) => Date.parse(event.at) > now() - 7 * 86400000).slice(-200);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temp, file);
  };
  return {
    observe: (provider, raw, accountKey) => serial(async () => {
      await load();
      if (!raw?.accountKey || !Number.isFinite(Date.parse(raw.at))) {
        for (const key of Object.keys(state.samples)) if (key === provider || key.startsWith(provider + ":") && (!accountKey || (state.samples[key].accountKey === accountKey || state.samples[key].accountKey.slice(0, 24) === accountKey))) delete state.samples[key];
        await save(); return [];
      }
      if (state.samples[provider]) { const old = state.samples[provider]; state.samples[provider + ":" + old.accountKey] = old; delete state.samples[provider]; }
      const sampleKey = provider + ":" + raw.accountKey;
      const sample = { accountKey: raw.accountKey, accountLabel: typeof raw.accountLabel === "string" ? raw.accountLabel.slice(0, 160) : state.samples[sampleKey]?.accountLabel || null, planType: raw.planType || null, at: raw.at,
        windows: [...new Map((raw.windows || []).filter((win) => win.usedPercent !== null && Number.isFinite(Number(win.usedPercent)) && Number(win.usedPercent) >= 0 &&
          Number.isFinite(Date.parse(win.resetsAt)) && Number(win.windowMinutes) > 0).map((win) => ({
          key: win.key, windowMinutes: Number(win.windowMinutes), usedPercent: Math.min(100, Number(win.usedPercent)),
          resetsAt: win.resetsAt, limited: win.limited === true })).map((win) => [win.key, win])).values()] };
      if (Date.parse(sample.at) > now() + 60000 || now() - Date.parse(sample.at) > MAX_GAP_MS) return [];
      const previous = state.samples[sampleKey];
      if (previous && Date.parse(sample.at) <= Date.parse(previous.at)) return [];
      const events = quotaTransitions(previous, sample).map((event) => ({ ...event, provider }));
      state.samples[sampleKey] = sample; state.events.push(...events); await save(); return events;
    }),
    events: (settings) => serial(async () => {
      await load();
      if (!settings.enabled || !settings.resetsEnabled) return [];
      return state.events.filter((event) => EVENT_TYPES.includes(event.type) && Date.parse(event.at) > now() - MAX_GAP_MS &&
        Date.parse(event.at) <= now());
    })
  };
}

module.exports = { notificationSettings, codexNotificationSample, quotaTransitions, createQuotaNotifications, EVENT_TYPES };
