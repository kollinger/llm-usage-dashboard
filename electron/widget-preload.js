"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const argument = (name) => process.argv.find((value) => value.startsWith(`--llm-usage-${name}=`))?.split("=").slice(1).join("=") || null;

// This window cannot change accounts, logins, mobile access, or subscriptions.
contextBridge.exposeInMainWorld("llmUsageDashboard", {
  initialThemePreference: argument("theme") || "system",
  initialLanguagePreference: argument("language")
});
contextBridge.exposeInMainWorld("llmUsageWidget", {
  getState: () => ipcRenderer.invoke("widget:state"),
  setPinned: (pinned) => ipcRenderer.invoke("widget:pin", pinned),
  savePreferences: (preferences) => ipcRenderer.invoke("widget:preferences", preferences),
  openDashboard: (target = "dashboard") => ipcRenderer.invoke("widget:dashboard", target),
  close: () => ipcRenderer.invoke("widget:close"),
  onAppearance(callback) {
    if (typeof callback !== "function") return;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("widget:appearance", listener);
    return () => ipcRenderer.removeListener("widget:appearance", listener);
  }
});
