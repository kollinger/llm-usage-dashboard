"use strict";

// Separate review application: separate userData, no updater, no autostart,
// no changes to the user's installed dashboard or existing device pairings.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { startMobilePrototype, lanInterfaces } = require("../lib/mobile-lan-prototype");

app.setName("LLM Usage Dashboard LAN Prototype");
let prototype, backend, window, closing = false;
app.whenReady().then(async () => {
  const directory = app.getPath("userData");
  await fs.mkdir(directory, { recursive: true });
  process.env.LLM_USAGE_DATA_DIR = path.join(directory, "data");
  process.env.LLM_USAGE_ELECTRON_SYNC_TOKEN = require("node:crypto").randomUUID();
  // Fresh real readings from this host. The prototype never copies credentials
  // or state from the normal app's userData directory.
  backend = require("../server").startDashboard({ port: 0, host: "127.0.0.1", ollamaProxy: false });
  await new Promise((resolve) => backend.dashboardServer.once("listening", resolve));
  const start = () => startMobilePrototype({ address: lanInterfaces()[0]?.address,
    upstream: `http://127.0.0.1:${backend.dashboardServer.address().port}`,
    groupFile: path.join(directory, "mobile-prototype", "group.json"),
    onJoin: async () => { await prototype.stop(); prototype = await start(); await window.loadURL(prototype.controlUrl); }
  });
  prototype = await start();
  window = new BrowserWindow({ width: 850, height: 870, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== prototype.controlUrl) event.preventDefault(); });
  await window.loadURL(prototype.controlUrl);
}).catch((error) => { console.error(error.code || error.message); app.quit(); });

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (closing || !prototype) return;
  event.preventDefault(); closing = true;
  prototype.stop().finally(() => { backend?.dashboardServer.close(); backend?.dashboardServer.closeAllConnections(); app.exit(0); });
});
