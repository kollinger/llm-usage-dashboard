"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const initialThemePreference = process.argv
  .find((argument) => argument.startsWith("--llm-usage-theme="))
  ?.slice("--llm-usage-theme=".length) || "system";

contextBridge.exposeInMainWorld("llmUsageDashboard", {
  initialThemePreference,
  setThemePreference(preference) {
    return ipcRenderer.invoke("theme:set-preference", String(preference || "system"));
  },
  onSystemThemeChange(callback) {
    if (typeof callback !== "function") return;
    ipcRenderer.on("theme:system-changed", (_event, payload) => callback(payload));
  },
  refreshSubscriptionProvider(provider) {
    return ipcRenderer.invoke("subscription:refresh", {
      provider: String(provider || "")
    });
  }
});
