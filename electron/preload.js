"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("llmUsageDashboard", {
  refreshSubscriptionProvider(provider) {
    return ipcRenderer.invoke("subscription:refresh", {
      provider: String(provider || "")
    });
  }
});
