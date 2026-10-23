"use strict";

// Exercise the production handlers verbatim, without starting usage collectors,
// login items, updater traffic or reading real accounts in the native QA app.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PLASMA_DESKTOP_ID } = require("../../electron/plasma-launcher");

module.exports = function dashboardActivation(app, createWindow) {
  const source = fs.readFileSync(path.join(__dirname, "../../electron/main.js"), "utf8");
  const context = vm.createContext({ app, PLASMA_DESKTOP_ID, process: { platform: process.platform }, createWindow, mainWindow: null, dashboardPort: null, openWindowWhenReady: false,
    BACKGROUND_START_ARG: "--background", lastBillingSyncStartedAt: Date.now(), CLAUDE_SYNC_INTERVAL_MS: 60_000,
    runBillingSyncs() {} });
  vm.runInContext(source.slice(source.indexOf("function showDashboardWindow("), source.indexOf("async function configureBackgroundLoginItem(")), context);
  vm.runInContext(source.slice(source.indexOf('// Stable identity lets Plasma'), source.indexOf('ipcMain.handle("subscription:refresh"')), context);
  return context;
};
