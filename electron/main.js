"use strict";

const path = require("node:path");
const { app, BrowserWindow, shell } = require("electron");

let dashboardServer = null;
let ollamaProxyServer = null;
let mainWindow = null;

function setDefaultEnv(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

function configureDashboardEnv() {
  setDefaultEnv("PORT", "0");
  setDefaultEnv("LLM_USAGE_DATA_DIR", path.join(app.getPath("userData"), "data"));
  setDefaultEnv("OLLAMA_HOST", "http://localhost:11434");
}

async function startBackend() {
  configureDashboardEnv();
  const { startDashboard } = require("../server");
  const servers = startDashboard({ port: Number(process.env.PORT || 0) });
  dashboardServer = servers.dashboardServer;
  ollamaProxyServer = servers.ollamaProxyServer;
  await new Promise((resolve) => dashboardServer.once("listening", resolve));
  const address = dashboardServer.address();
  return typeof address === "object" && address ? address.port : Number(process.env.PORT || 4177);
}

function createWindow(port) {
  const appUrl = `http://localhost:${port}`;
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 980,
    minHeight: 680,
    title: "LLM Usage Dashboard",
    backgroundColor: "#f6f7f4",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.loadURL(appUrl);
}

function closeServer(server) {
  if (!server?.listening) return;
  server.close();
}

app.whenReady().then(async () => {
  const port = await startBackend();
  createWindow(port);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  closeServer(dashboardServer);
  closeServer(ollamaProxyServer);
});
