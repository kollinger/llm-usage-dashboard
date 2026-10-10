"use strict";

(async () => {
  const pairingKey = "mobile-prototype-pairing";
  let pairingCode = "";
  if (document.body.dataset.prototype === "pair") {
    const supplied = location.hash.slice(1) || /^\/pair\/([\w.-]+)$/.exec(location.pathname)?.[1] || "";
    try {
      if (supplied) sessionStorage.setItem(pairingKey, supplied);
      pairingCode = supplied || sessionStorage.getItem(pairingKey) || "";
    } catch { pairingCode = supplied; }
    // Remove the one-use secret before any network request. Retain it only in
    // this tab until redemption, so reloading the cleaned URL still works.
    history.replaceState(null, "", "/pair");
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
    const button = document.getElementById("prototypePair");
    if (!pairingCode) { button.disabled = true; message("scanAgain"); }
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch("/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairingCode }) });
        if (response.status === 401) {
          try { sessionStorage.removeItem(pairingKey); } catch { /* Storage may be unavailable. */ }
          message("scanAgain"); return;
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
