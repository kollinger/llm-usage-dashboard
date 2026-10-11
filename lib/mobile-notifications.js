"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const webpush = require("web-push");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function resetNotifications(history, now = Date.now()) {
  if (history?.liveStatus !== "live") return [];
  return (history.windows || []).filter((win) => win.resetType === "early" && win.source === "live" &&
    win.accountScope === "current_account" && !win.gap && !win.overlap && win.confidence !== "uncertain" &&
    Date.parse(win.resetObservedBetween?.to) > now - 10 * 60000 && Date.parse(win.resetObservedBetween?.to) <= now)
    .map((win) => ({ id: hash(`${win.scheduledResetAt}:${win.resetObservedBetween.to}`), type: "unexpected_reset",
      provider: "codex", windowKey: "weekly", at: win.resetObservedBetween.to, previousResetAt: win.scheduledResetAt }));
}

function subscriptionValue(raw) {
  const url = new URL(raw?.endpoint);
  // A paired browser must not turn the local application into an HTTP proxy.
  const allowed = url.hostname.endsWith(".push.apple.com") || url.hostname === "fcm.googleapis.com" ||
    url.hostname === "updates.push.services.mozilla.com";
  if (!allowed || url.protocol !== "https:" || url.port || url.username || url.password || url.hash || url.href.length > 2048) throw new Error("invalid_subscription");
  const key = (value, length) => typeof value === "string" && /^[\w-]+$/.test(value) && Buffer.from(value, "base64url").length === length;
  if (!key(raw.keys?.p256dh, 65) || !key(raw.keys?.auth, 16)) throw new Error("invalid_subscription");
  crypto.ECDH.convertKey(Buffer.from(raw.keys.p256dh, "base64url"), "prime256v1");
  return { endpoint: url.href, keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth } };
}

function notificationMessage(item, copy, language = "en") {
  const provider = { codex: "Codex", claudeCode: "Claude", copilot: "Copilot" }[item.provider] || "LLM Usage Dashboard";
  const window = copy[item.windowKey === "five_hour" ? "notificationFiveHour" : item.windowKey === "weekly" ? "notificationWeekly" : "notificationWindow"];
  const values = { provider, window, percent: Math.round(item.usedPercent || 0), projected: Math.round(item.projectedPercent || 0), time: item.previousResetAt ? new Date(item.previousResetAt).toLocaleString(language) : "" };
  const key = item.type === "unexpected_reset" ? "notificationReset" : item.type === "hard_limit" ? "notificationHardLimit" : "notificationPacing";
  const body = copy[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  return { title: copy.notificationsTitle, body, tag: hash(item.id || `${item.provider}:${item.type}:${item.windowKey}:${item.resetsAt || ""}`) };
}

async function createMobilePush({ file, origin, send = webpush.sendNotification.bind(webpush), now = Date.now }) {
  let state;
  try { state = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (state && (state.version !== 1 || state.origin !== origin)) throw new Error("push_origin_changed");
  state ||= { version: 1, origin, vapid: webpush.generateVAPIDKeys(), phones: {} };
  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  };
  await save();
  let queue = Promise.resolve();
  const serial = (action) => { const next = queue.then(action); queue = next.catch(() => {}); return next; };
  const status = (id) => {
    const phone = state.phones[id];
    return { subscribed: !!phone && phone.expires > now(), lastAcceptedAt: phone?.lastAcceptedAt || null, lastError: phone?.lastError || null };
  };
  const copyFor = async (language) => {
    try { return JSON.parse(await fs.readFile(path.join(__dirname, "..", "public", "i18n", `${language}.json`), "utf8")).mobilePrototype; }
    catch { return JSON.parse(await fs.readFile(path.join(__dirname, "..", "public", "i18n", "en.json"), "utf8")).mobilePrototype; }
  };
  const deliver = async (id, item) => {
    const phone = state.phones[id];
    const message = item.type === "test" ? { title: (await copyFor(phone.language)).notificationsTitle,
      body: (await copyFor(phone.language)).notificationTestBody, tag: "mobile-push-test" } : notificationMessage(item, await copyFor(phone.language), phone.language);
    try {
      await send(phone.subscription, JSON.stringify(message), { vapidDetails: { subject: origin, ...state.vapid }, TTL: 300, timeout: 10000 });
      phone.lastAcceptedAt = new Date(now()).toISOString(); phone.lastError = null;
      return true;
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) delete state.phones[id];
      else phone.lastError = "push_send_failed";
      return false;
    }
  };
  return {
    publicKey: state.vapid.publicKey, status,
    subscribe: (id, expires, subscription, language) => serial(async () => {
      const value = subscriptionValue(subscription);
      for (const [key, phone] of Object.entries(state.phones)) if (phone.expires <= now()) delete state.phones[key];
      if (!state.phones[id] && Object.keys(state.phones).length >= 16) throw new Error("phone_limit_reached");
      // Reopening the app retains the subscription's deduplication history.
      const old = state.phones[id];
      const same = old?.subscription.endpoint === value.endpoint;
      state.phones[id] = { subscription: value, language: /^[a-z]{2}$/.test(language) ? language : "en", expires,
        since: same ? old.since : now(), sent: same ? old.sent : {}, lastAcceptedAt: same ? old.lastAcceptedAt : null };
      await save(); return status(id);
    }),
    unsubscribe: (id) => serial(async () => { delete state.phones[id]; await save(); }),
    test: (id) => serial(async () => {
      if (!status(id).subscribed) throw new Error("push_not_subscribed");
      const phone = state.phones[id];
      if (phone.lastTestAt && now() - phone.lastTestAt < 60000) throw new Error("push_test_rate_limited");
      phone.lastTestAt = now();
      const accepted = await deliver(id, { type: "test" }); await save(); return { accepted };
    }),
    publish: (feed) => serial(async () => {
      for (const [id, phone] of Object.entries(state.phones)) {
        if (phone.expires <= now()) { delete state.phones[id]; continue; }
        phone.sent = Object.fromEntries(Object.entries(phone.sent).filter(([, at]) => now() - at < 24 * 3600000));
        if (!feed.enabled) continue;
        for (const item of [...(feed.alerts || []), ...(feed.events || [])]) {
          if (item.at && (Date.parse(item.at) <= phone.since || now() - Date.parse(item.at) > 10 * 60000)) continue;
          const key = hash(item.id || `${item.provider}:${item.type}:${item.windowKey}:${item.resetsAt || ""}`);
          if (phone.sent[key] && (item.id || now() - phone.sent[key] < 30 * 60000)) continue;
          if (await deliver(id, item)) phone.sent[key] = now();
          if (!state.phones[id]) break;
        }
      }
      await save();
    }),
    flush: () => queue
  };
}

module.exports = { resetNotifications, notificationMessage, subscriptionValue, createMobilePush };
