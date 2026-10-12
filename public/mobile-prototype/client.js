"use strict";

(async () => {
  const pairingKey = "mobile-prototype-pairing";
  let pairingCode = "";
  if (document.body.dataset.prototype === "pair") {
    const supplied = location.hash.slice(1) || document.getElementById("prototypeCode")?.value || /^\/pair\/([\w.-]+)\/?$/.exec(location.pathname)?.[1] || "";
    try {
      if (supplied) sessionStorage.setItem(pairingKey, supplied);
      pairingCode = supplied || sessionStorage.getItem(pairingKey) || "";
    } catch { pairingCode = supplied; }
    // Keep the one-use code in the address until pairing so opening this page
    // in another browser works without sharing cookies or tab storage.
    if (pairingCode && !location.hash && !/^\/pair\/[\w.-]+\/?$/.test(location.pathname)) history.replaceState(null, "", `/pair/${pairingCode}`);
  }
  const language = (navigator.language || "en").slice(0, 2);
  let copy;
  try { copy = (await (await fetch(`/i18n/${language}.json`)).json()).mobilePrototype; }
  catch { copy = (await (await fetch("/i18n/en.json")).json()).mobilePrototype; }
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  const text = (key) => copy[key];
  if (document.body.dataset.prototype) document.title = text("prototype");
  document.querySelectorAll("[data-copy-aria]").forEach((item) => { item.setAttribute("aria-label", text(item.dataset.copyAria)); });
  document.querySelectorAll("[data-copy]").forEach((item) => { item.textContent = text(item.dataset.copy); });
  const message = (key) => { document.getElementById("prototypeMessage").textContent = text(key); };
  const pairingMessage = (state) => ({ missing: "missingCode", expired: "expiredCode", used: "usedCode", invalid: "invalidCode" })[state] || "scanAgain";
  if (document.body.dataset.prototype === "control") {
    const refresh = async () => {
      try {
        const status = await (await fetch("/api/status")).json();
        document.getElementById("prototypeLeader").textContent = `${text("leader")}: ${status.leader || text("waiting")}`;
        const list = document.getElementById("prototypePeers"); list.replaceChildren();
        for (const peer of status.peers) { const row = document.createElement("li"); row.textContent = peer.label; list.append(row); }
        if (status.diagnostic) message("networkError");
      } catch { message("networkError"); }
    };
    const code = async (direct = false) => {
      const button = document.getElementById("prototypeNewCode"); button.disabled = true;
      try {
        const response = await fetch("/api/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ direct }) });
        if (!response.ok) throw new Error("code_unavailable");
        const value = await response.json();
        document.getElementById("prototypeQr").innerHTML = value.svg;
        document.getElementById("prototypeUrl").value = value.url;
        message("expires");
      } catch { message("networkError"); }
      button.disabled = false;
    };
    document.getElementById("prototypeNewCode").addEventListener("click", () => code());
    document.getElementById("prototypeDirectCode").addEventListener("click", () => code(true));
    document.getElementById("prototypeGroupCode").addEventListener("click", async () => {
      try {
        const value = await (await fetch("/api/group-code", { method: "POST" })).json();
        const field = document.getElementById("prototypeGroupInvite"); field.hidden = false; field.value = value.code; field.select();
      } catch { message("networkError"); }
    });
    document.getElementById("prototypeJoin").addEventListener("click", async () => {
      try {
        const response = await fetch("/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: document.getElementById("prototypeJoinCode").value.trim() }) });
        if (!response.ok) throw new Error("join_failed");
        document.getElementById("prototypeJoinCode").value = ""; message("joining");
      } catch { message("joinError"); }
    });
    await refresh(); await code(); setInterval(refresh, 2000);
  } else if (document.body.dataset.prototype === "pair") {
    // External navigation can omit the Strict cookie. Check again from this
    // origin before asking an already paired browser to connect another time.
    try {
      if ((await fetch("/api/mobile-prototype/status")).ok) {
        try { sessionStorage.removeItem(pairingKey); } catch { /* Storage may be unavailable. */ }
        location.replace("/"); return;
      }
    } catch { /* Keep the pairing page usable when the server is unreachable. */ }
    const button = document.getElementById("prototypePair");
    if (!pairingCode) {
      button.disabled = true;
      message(pairingMessage(document.querySelector('meta[name="mobile-prototype-pairing-state"]')?.content || "missing"));
    }
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch("/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairingCode }) });
        if (response.status === 401) {
          try { sessionStorage.removeItem(pairingKey); } catch { /* Storage may be unavailable. */ }
          history.replaceState(null, "", "/pair");
          const error = await response.json();
          message(pairingMessage(error.error?.replace(/^pair_/, ""))); return;
        }
        if (!response.ok) throw new Error("pair_failed");
        try { sessionStorage.removeItem(pairingKey); } catch { /* Storage may be unavailable. */ }
        location.replace("/");
      } catch { message("networkError"); button.disabled = false; }
    });
  } else {
    document.body.classList.add("prototype-read-only");
    const banner = document.createElement("aside"); banner.className = "prototype-mobile-banner";
    const heading = document.createElement("strong"); heading.textContent = text("readOnly"); banner.append(heading);
    const node = document.createElement("span"); banner.append(node); document.body.prepend(banner);
    const notices = document.createElement("details"); notices.className = "prototype-notifications";
    const summary = document.createElement("summary"); summary.textContent = text("notificationsTitle"); notices.append(summary);
    const warningsState = document.createElement("p"); notices.append(warningsState);
    const state = document.createElement("p"); state.setAttribute("role", "status"); notices.append(state);
    const help = document.createElement("details");
    const helpTitle = document.createElement("summary"); helpTitle.textContent = text("notificationsConnectionHelp"); help.append(helpTitle);
    const helpBody = document.createElement("p"); helpBody.textContent = text("notificationsHelp"); help.append(helpBody); notices.append(help);
    const enable = document.createElement("button"); enable.type = "button"; enable.textContent = text("notificationsEnable"); enable.disabled = true;
    const testButton = document.createElement("button"); testButton.type = "button"; testButton.textContent = text("notificationsTest"); testButton.hidden = true;
    const disable = document.createElement("button"); disable.type = "button"; disable.textContent = text("notificationsDisable"); disable.hidden = true;
    notices.append(enable, testButton, disable);
    const list = document.createElement("ul"); notices.append(list); banner.after(notices);
    let feed, registration, busy = false, lastWarningCount = 0;
    const standalone = () => navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const updateNotifications = () => {
      enable.disabled = true; enable.hidden = true; testButton.hidden = true; disable.hidden = true;
      state.hidden = feed?.enabled === false;
      warningsState.textContent = feed ? text(feed.enabled ? "notificationsWarningsOn" : "notificationsDesktopDisabled") : "";
      if (feed?.enabled && feed.resetsEnabled === false) warningsState.textContent += ` ${text("notificationsResetsOff")}`;
      if (!feed) { state.textContent = text("notificationsUnavailable"); return; }
      if (!feed.enabled) { state.textContent = text("notificationsDesktopDisabled"); return; }
      if (!window.isSecureContext || !feed.pushAvailable) state.textContent = text("notificationsLan");
      else if (ios && !standalone()) state.textContent = text("notificationsInstall");
      else if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) state.textContent = text("notificationsUnsupported");
      else if (Notification.permission === "denied") state.textContent = text("notificationsDenied");
      else if (feed.subscribed && Notification.permission === "granted") {
        state.textContent = text(feed.lastError ? "notificationsError" : "notificationsActive");
        testButton.hidden = false; disable.hidden = false;
      } else { state.textContent = text("notificationsInvite"); enable.hidden = false; enable.disabled = busy; }
    };
    const post = async (action, body = {}) => {
      const response = await fetch(`/api/mobile-prototype/push/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error("push_failed");
      return response.json();
    };
    const refreshNotifications = async () => {
      try {
        const response = await fetch("/api/mobile-prototype/notifications");
        if (!response.ok) throw new Error("unavailable");
        feed = await response.json();
        list.replaceChildren();
        const items = [...(feed.alerts || []), ...(feed.events || [])];
        const seen = new Set();
        for (const item of items) {
          const identity = item.id || `${item.provider}:${item.type}:${item.windowKey}`;
          if (seen.has(identity)) continue; seen.add(identity);
          const provider = { codex: "Codex", claudeCode: "Claude", copilot: "Copilot" }[item.provider] || "LLM";
          const values = { provider, window: text(item.windowKey === "five_hour" ? "notificationFiveHour" : item.windowKey === "weekly" ? "notificationWeekly" : "notificationWindow"),
            previous: Math.round(item.previousUsedPercent || 0), observed: item.at ? new Date(item.at).toLocaleString(language) : "",
            percent: Math.round(item.usedPercent || 0), projected: Math.round(item.projectedPercent || 0), time: item.previousResetAt ? new Date(item.previousResetAt).toLocaleString(language) : "",
            balance: new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(item.balance || 0),
            date: item.expiresOn ? new Date(`${item.expiresOn}T12:00:00`).toLocaleDateString(language) : "" };
          const eventKeys = { unexpected_reset: "notificationReset", scheduled_reset: "notificationResetScheduled",
            limit_reached: "notificationLimitReached", availability_restored: "notificationAvailable", quota_changed: "notificationAdjusted" };
          const key = item.type === "credit_expiry" ? "notificationCreditsExpiry" : eventKeys[item.type] || (item.type === "hard_limit" ? "notificationHardLimit" : "notificationPacing");
          const row = document.createElement("li"); row.textContent = text(key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? "")); list.append(row);
        }
        summary.textContent = text("notificationsTitle") + (seen.size ? ` (${seen.size})` : "");
        if (seen.size && !lastWarningCount) notices.open = true;
        lastWarningCount = seen.size;
        if (!items.length) { const row = document.createElement("li"); row.textContent = text("notificationsEmpty"); list.append(row); }
        updateNotifications();
      } catch { feed = null; list.replaceChildren(); updateNotifications(); }
    };
    enable.addEventListener("click", async () => {
      busy = true; enable.disabled = true;
      try {
        // Permission is requested only from this explicit user gesture.
        if (await Notification.requestPermission() !== "granted") { updateNotifications(); return; }
        registration = await navigator.serviceWorker.register("/mobile-prototype/sw.js", { scope: "/" });
        await navigator.serviceWorker.ready;
        const raw = atob(feed.publicKey.replace(/-/g, "+").replace(/_/g, "/"));
        const publicKey = Uint8Array.from(raw, (value) => value.charCodeAt(0));
        const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
        await post("subscribe", { subscription: subscription.toJSON(), language });
        await refreshNotifications();
      } catch { state.textContent = text("notificationsError"); }
      finally { busy = false; enable.disabled = !!feed?.subscribed || Notification.permission === "denied"; }
    });
    testButton.addEventListener("click", async () => {
      testButton.disabled = true;
      try { const result = await post("test"); state.textContent = text(result.accepted ? "notificationsTestAccepted" : "notificationsError"); }
      catch { state.textContent = text("notificationsError"); }
      testButton.disabled = false;
    });
    disable.addEventListener("click", async () => {
      disable.disabled = true;
      try {
        await post("unsubscribe");
        registration ||= await navigator.serviceWorker.getRegistration("/");
        await (await registration?.pushManager.getSubscription())?.unsubscribe();
        await refreshNotifications();
      } catch { state.textContent = text("notificationsError"); }
      disable.disabled = false;
    });
    if (standalone()) notices.open = true;
    await refreshNotifications(); setInterval(refreshNotifications, 30000);
    const refresh = async () => {
      try {
        const response = await fetch("/api/mobile-prototype/status");
        if (!response.ok) throw new Error("offline");
        const status = await response.json(); node.textContent = `${text("servedBy")}: ${status.label}`;
      } catch { node.textContent = text("offline"); }
    };
    await refresh(); setInterval(refresh, 3000);
  }
})();
