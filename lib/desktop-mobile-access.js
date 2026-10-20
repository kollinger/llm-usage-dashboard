"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { startMobilePrototype, lanInterfaces } = require("./mobile-lan-prototype");
const { parseVpnNetworks } = require("./mobile-access-policy");

function createDesktopMobileAccess(options) {
  const directory = path.join(options.dataDir, "mobile-access");
  const settingsFile = path.join(directory, "settings.json");
  const interfaces = options.interfaces || lanInterfaces;
  const start = options.start || startMobilePrototype;
  let enabled = false, httpsOrigin = "", vpnNetworks = [], gateway = null, address = null, reason = null, controlPort = 0, queue = Promise.resolve();
  const serial = (fn) => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  const status = () => ({ enabled, running: !!gateway, reason,
    url: gateway?.url || null, directUrl: gateway ? `http://${address}:41780/` : null,
    controlUrl: gateway?.controlUrl || null, httpsOrigin, vpnNetworks: [...vpnNetworks], httpsProxyPort: httpsOrigin ? 41781 : null });
  const saveSettings = async (settings = { enabled, httpsOrigin, vpnNetworks }) => {
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${settingsFile}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(settings), { mode: 0o600 });
    await fs.rename(temporary, settingsFile);
  };
  const stop = async () => {
    const previous = gateway; gateway = null; address = null;
    if (previous) await previous.stop();
  };
  const migrate = async () => {
    await fs.mkdir(directory, { recursive: true });
    if (!options.legacyDirectory) return;
    // Keep the existing group and its consumed-link ledger together. Fresh
    // installations have no legacy directory and receive their own group.
    try { await fs.access(path.join(directory, "group.json")); return; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const name of ["mobile-prototype-spent.json", "mobile-prototype-node.json", "group.json"]) {
      try { await fs.copyFile(path.join(options.legacyDirectory, name), path.join(directory, name), constants.COPYFILE_EXCL); }
      catch (error) { if (!["ENOENT", "EEXIST"].includes(error.code)) throw error; }
    }
  };
  const reconcile = async () => {
    if (!enabled) { await stop(); reason = null; return status(); }
    const selected = interfaces()[0]?.address;
    if (gateway && selected === address) return status();
    await stop();
    if (!selected) { reason = "noLan"; return status(); }
    try {
      await migrate();
      gateway = await start({ address: selected, upstream: options.upstream,
        groupFile: path.join(directory, "group.json"), label: options.label, controlPort,
        httpsOrigin: httpsOrigin || undefined, httpsProxyPort: httpsOrigin ? 41781 : undefined,
        vpnNetworks: vpnNetworks.join("\n"),
        onJoin: () => serial(async () => { await stop(); return reconcile(); }) });
      address = selected; controlPort = Number(new URL(gateway.controlUrl).port); reason = null;
    } catch (error) { reason = error.code === "EADDRINUSE" ? "portBusy" : "failed"; }
    return status();
  };
  return {
    status,
    init: () => serial(async () => {
      try {
        const saved = JSON.parse(await fs.readFile(settingsFile, "utf8"));
        if (saved.vpnNetworks !== undefined && !Array.isArray(saved.vpnNetworks)) throw new Error("invalid_vpn_networks");
        vpnNetworks = parseVpnNetworks((saved.vpnNetworks || []).join("\n"));
        enabled = saved.enabled === true; httpsOrigin = saved.httpsOrigin || "";
      }
      catch (error) { if (error.code !== "ENOENT") reason = "failed"; }
      return enabled ? reconcile() : status();
    }),
    setEnabled: (value) => serial(async () => {
      if (typeof value !== "boolean") throw new Error("invalid_mobile_setting");
      enabled = value; await saveSettings();
      return reconcile();
    }),
    setHttpsOrigin: (value) => serial(async () => {
      if (typeof value !== "string" || value.length > 300) throw new Error("invalid_https_origin");
      let normalized = "";
      if (value.trim()) {
        const url = new URL(value.trim());
        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid_https_origin");
        normalized = url.origin;
      }
      httpsOrigin = normalized; await saveSettings(); await stop();
      return reconcile();
    }),
    setVpnNetworks: (value) => serial(async () => {
      const next = parseVpnNetworks(value);
      await saveSettings({ enabled, httpsOrigin, vpnNetworks: next });
      vpnNetworks = next;
      await stop();
      return reconcile();
    }),
    refresh: () => serial(reconcile),
    stop: () => serial(stop)
  };
}

module.exports = { createDesktopMobileAccess };
