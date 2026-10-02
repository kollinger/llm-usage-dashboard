"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const initialThemePreference = process.argv
  .find((argument) => argument.startsWith("--llm-usage-theme="))
  ?.slice("--llm-usage-theme=".length) || "system";
const initialLanguagePreference = process.argv
  .find((argument) => argument.startsWith("--llm-usage-language="))
  ?.slice("--llm-usage-language=".length) || null;

contextBridge.exposeInMainWorld("llmUsageDashboard", {
  initialThemePreference,
  initialLanguagePreference,
  setLanguagePreference(language) {
    return ipcRenderer.invoke("language:set-preference", String(language || ""));
  },
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
