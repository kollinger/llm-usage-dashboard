"use strict";

// Called only inside the private native session. Exercise the actual app
// startup/installer, rather than duplicating its KPackage and D-Bus operations.
const { createPlasmaWidget } = require("../../electron/plasma-widget");
const handlers = new Map();
const window = { isDestroyed: () => false, webContents: { mainFrame: { url: "http://localhost:45678/" } } };
const installer = createPlasmaWidget({
  app: { isPackaged: false, getVersion: () => require("../../package.json").version },
  origin: "http://localhost:45678", getMainWindow: () => window, getLanguage: () => "de",
  session: { fetch: async () => { throw new Error("synthetic_no_server"); } },
  ipcMain: { handle: (key, handler) => handlers.set(key, handler), removeHandler: (key) => handlers.delete(key) }
});
(async () => {
  try {
    if (process.argv.includes("--startup")) await installer.start();
    else await handlers.get("plasma:install")({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
    const result = await installer.status();
    console.log(JSON.stringify(result));
    if (!result.installed || result.success === false || !result.panelsReady) process.exitCode = 1;
  } finally { await installer.dispose(); }
})().catch(() => { console.error("synthetic_install_failed"); process.exitCode = 1; });
