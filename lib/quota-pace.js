"use strict";

const fs = require("node:fs/promises");

const WINDOWS = [30, 60, 120, 300];
const HISTORY_MS = 6 * 60 * 60 * 1000;
const MAX_TAIL_BYTES = 24 * 1024 * 1024;
const RESET_JITTER_MS = 60 * 1000;
const MAX_RECENT_SAMPLE_AGE_MS = 15 * 60_000;
const MIN_OBSERVED_SPAN_MS = 5 * 60_000;

function quotaPaceSample(event, nowMs) {
  if (event?.type !== "quota_window" || event.windowMinutes !== 10080) return null;
  if (!event.provider || !event.windowKey) return null;
  const capturedMs = Date.parse(event.capturedAt || "");
  const resetMs = Date.parse(event.resetsAt || "");
  const usedPercent = Number(event.usedPercent);
  if (!Number.isFinite(capturedMs) || !Number.isFinite(resetMs) || !Number.isFinite(usedPercent)) return null;
  if (capturedMs < nowMs - HISTORY_MS || capturedMs > nowMs + 60_000 || resetMs <= capturedMs) return null;
  if (usedPercent < 0 || usedPercent > 100) return null;
  return {
    provider: event.provider,
    windowKey: event.windowKey,
    capturedAt: new Date(capturedMs).toISOString(),
    resetsAt: new Date(resetMs).toISOString(),
    usedPercent
  };
}

function mergeQuotaPaceSamples(existing, events, nowMs) {
  const samples = new Map();
  for (const event of [...existing.map((sample) => ({ ...sample, type: "quota_window", windowMinutes: 10080 })), ...events]) {
    const sample = quotaPaceSample(event, nowMs);
    if (!sample) continue;
    samples.set(`${sample.provider}:${sample.windowKey}:${sample.capturedAt}`, sample);
  }
  return [...samples.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).slice(-1200);
}

async function readQuotaPaceTail(filePath, nowMs) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_TAIL_BYTES);
    if (!length) return [];
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const chunk = await handle.read(buffer, bytesRead, length - bytesRead, size - length + bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.slice(size > length ? text.indexOf("\n") + 1 : 0).split("\n");
    return lines.flatMap((line) => {
      if (!line) return [];
      try {
        const sample = quotaPaceSample(JSON.parse(line), nowMs);
        return sample ? [sample] : [];
      } catch {
        return [];
      }
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close();
  }
}

function assessQuotaPace(samples, nowMs) {
  const result = {};
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.provider}:${sample.windowKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const latest = group.at(-1);
    if (!latest) continue;
    const provider = (result[latest.provider] ||= {});
    const row = (provider[latest.windowKey] = {});
    for (const windowMinutes of WINDOWS) {
      row[windowMinutes] = assessWindow(group, latest, windowMinutes, nowMs);
    }
  }
  return result;
}

function assessWindow(group, latest, windowMinutes, nowMs) {
  const latestMs = Date.parse(latest.capturedAt);
  const resetMs = Date.parse(latest.resetsAt);
  const windowMs = windowMinutes * 60_000;
  if (nowMs - latestMs > MAX_RECENT_SAMPLE_AGE_MS || resetMs <= nowMs) {
    return { status: "stale" };
  }
  const targetMs = latestMs - windowMs;
  const toleranceMs = Math.min(10 * 60_000, windowMs * 0.2);
  const candidates = group
    .filter((sample) => Math.abs(Date.parse(sample.resetsAt) - resetMs) <= RESET_JITTER_MS && Date.parse(sample.capturedAt) < latestMs);
  const nearest = candidates
    .reduce((best, sample) =>
      !best || Math.abs(Date.parse(sample.capturedAt) - targetMs) < Math.abs(Date.parse(best.capturedAt) - targetMs)
        ? sample
        : best, null);
  // A gap near the window boundary must not hide newer, measured activity.
  // Use the available portion of the window and report its actual duration.
  const baseline = nearest && Math.abs(Date.parse(nearest.capturedAt) - targetMs) <= toleranceMs
    ? nearest
    : candidates.find((sample) => Date.parse(sample.capturedAt) >= targetMs &&
        latestMs - Date.parse(sample.capturedAt) >= MIN_OBSERVED_SPAN_MS);
  if (!baseline) {
    return { status: "collecting" };
  }
  const observedMinutes = (latestMs - Date.parse(baseline.capturedAt)) / 60_000;
  const deltaPercent = latest.usedPercent - baseline.usedPercent;
  if (deltaPercent < 0) return { status: "changed" };
  if (deltaPercent < 0.5) return { status: "flat", observedMinutes, deltaPercent: 0 };
  const remaining = Math.max(0, 100 - latest.usedPercent);
  const hitMs = nowMs + remaining * observedMinutes * 60_000 / deltaPercent;
  const earliestHitMs = nowMs + Math.max(0, remaining - 0.5) * observedMinutes * 60_000 / (deltaPercent + 1);
  const latestHitMs = deltaPercent > 1
    ? nowMs + (remaining + 0.5) * observedMinutes * 60_000 / (deltaPercent - 1)
    : Infinity;
  return {
    status: latestHitMs < resetMs ? "risk" : earliestHitMs >= resetMs ? "safe" : "possible",
    deltaPercent: Math.round(deltaPercent * 10) / 10,
    observedMinutes: Math.round(observedMinutes),
    hitAt: Number.isFinite(hitMs) ? new Date(hitMs).toISOString() : null,
    resetsAt: latest.resetsAt,
    measuredAt: latest.capturedAt
  };
}

module.exports = { WINDOWS, assessQuotaPace, mergeQuotaPaceSamples, readQuotaPaceTail };
