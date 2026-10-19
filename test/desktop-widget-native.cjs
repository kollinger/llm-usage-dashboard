"use strict";

// Run with Electron through run-desktop-widget-native.mjs. The backend is a
// synthetic local fixture; no app server, provider collector or login is started.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { createDesktopWidget } = require("../electron/desktop-widget");
const { buildDesktopWidgetSnapshot } = require("../lib/desktop-widget");
const { widgetUsageFixture } = require("./fixtures/desktop-widget.cjs");
const { readPlasmaSnapshot } = require("../lib/plasma-bridge");
const { createPlasmaWidget } = require("../electron/plasma-widget");
app.setPath("userData", process.env.WIDGET_NATIVE_PROFILE);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
let count = 5, fixture = widgetUsageFixture(5), status = 200, generation = 0, requirePlasmaAuth = false;
const requests = new Map();
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/desktop-widget") {
      const id = req.headers["x-widget-test-generation"] || "initial";
      const startedAt = Number(req.headers["x-widget-test-started"]);
      requests.set(id, [...(requests.get(id) || []), Number.isFinite(startedAt) ? startedAt : Date.now()]);
      const responseStatus = requirePlasmaAuth && !req.headers.cookie?.includes("plasma-fixture=yes") ? 401 : status;
      res.writeHead(responseStatus, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(responseStatus === 200 ? buildDesktopWidgetSnapshot(fixture) : { error: "fixture_unavailable" })); return;
    }
    if (req.url === "/api/auth/me") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ authenticated: false, protected: true, methods: { password: true } })); return;
    }
    if (req.url.startsWith("/api/")) { res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":"auth_required"}'); return; }
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><script src="/test-main.js"></script>'); return; }
    if (req.url === "/test-main.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end('window.accountRequests = 0; window.registerAccountHandler = () => window.llmUsageDashboard.onWidgetDashboard(() => { window.accountRequests++; });'); return;
    }
    const url = new URL(req.url, "http://localhost");
    const relative = decodeURIComponent(url.pathname).slice(1);
    const root = path.resolve(__dirname, "../public");
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${root}${path.sep}`)) { res.writeHead(403); res.end(); return; }
    let body = await fs.readFile(file);
    if (relative === "widget.js") {
      // Shorten only the display poll for bounded lifecycle tests. Track each
      // renderer separately to prove destroyed windows stop requesting data.
      const id = String(++generation);
      body = `const fixtureFetch = window.fetch.bind(window); window.fetch = (input, options = {}) => fixtureFetch(input, { ...options, headers: { ...options.headers, "X-Widget-Test-Generation": "${id}", "X-Widget-Test-Started": String(Date.now()) } });\n` + body.toString().replace("setTimeout(refresh, 60_000)", "setTimeout(refresh, 200)");
    }
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" }[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { if (await fn()) return; await pause(40); }
  throw new Error(`Timed out: ${label}`);
}
const evaluate = (window, source) => window.webContents.executeJavaScript(source, true);
async function ready(window) {
  await until(() => evaluate(window, `document.querySelectorAll('.widget-account').length === ${count} && document.getElementById('widgetList')?.getAttribute('aria-busy') === 'false'`).catch(() => false), `render ${count} accounts`);
}
async function layout(window, expectAll = false) {
  const result = await evaluate(window, `(() => {
    const list = document.getElementById('widgetList'), rows = [...document.querySelectorAll('.widget-account')];
    const rect = list.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, rootOverflow: document.documentElement.scrollWidth > innerWidth,
      listHeight: list.clientHeight, listContent: list.scrollHeight, rowHeights: rows.map(row => row.getBoundingClientRect().height),
      listScroll: list.scrollHeight > list.clientHeight + 1,
      overlap: rows.some((row, i) => i && row.getBoundingClientRect().top < rows[i-1].getBoundingClientRect().bottom),
      horizontal: rows.some((row) => row.getBoundingClientRect().right > rect.right + 1),
      fonts: [...document.querySelectorAll('.widget-name, .widget-reset, .widget-quality')].map((node) => parseFloat(getComputedStyle(node).fontSize)),
      visible: rows.every((row) => row.getBoundingClientRect().bottom <= rect.bottom + 1) };
  })()`);
  assert.equal(result.rootOverflow, false, JSON.stringify(result));
  assert.equal(result.overlap, false, JSON.stringify(result));
  assert.equal(result.horizontal, false, JSON.stringify(result));
  assert(result.fonts.every((size) => size >= 12), "quota and reset text stays readable");
  if (expectAll) { assert.equal(result.listScroll, false, JSON.stringify(result)); assert.equal(result.visible, true); }
  return result;
}
async function capture(window, name) {
  if (!process.env.WIDGET_SCREENSHOTS_DIR) return;
  await fs.mkdir(process.env.WIDGET_SCREENSHOTS_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.WIDGET_SCREENSHOTS_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
}
let controller, main, plasmaInstaller;
app.on("window-all-closed", () => {});
(async () => {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://localhost:${server.address().port}`;
  main = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, "../electron/preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await main.loadURL(`${origin}/`);
  main.webContents.send("widget:open-accounts");
  await evaluate(main, "window.registerAccountHandler()");
  await until(() => evaluate(main, "window.accountRequests === 1"), "account action queued before dashboard initialization");
  let language = "en", theme = "light";
  const wayland = process.platform === "linux" && process.env.WIDGET_NATIVE_OZONE === "wayland";
  const targets = [];
  controller = createDesktopWidget({ BrowserWindow, ipcMain, screen, origin,
    stateFile: path.join(process.env.WIDGET_NATIVE_PROFILE, "widget.json"), getMainWindow: () => main,
    getTheme: () => ({ preference: theme, color: theme === "dark" ? "#0f1512" : "#f6f7f4" }), getLanguage: () => language,
    isWayland: wayland, showDashboard: (target) => { targets.push(target); } });
  await evaluate(main, "window.llmUsageDashboard.desktopWidget.open()");
  let widget = controller.getWindow(); await ready(widget);
  assert.equal(await evaluate(widget, "typeof require"), "undefined");
  assert.equal(await evaluate(widget, "typeof process"), "undefined");
  assert.equal(await evaluate(widget, "typeof window.llmUsageDashboard.mobileAccess"), "undefined");
  assert.equal(widget.webContents.getLastWebPreferences().contextIsolation, true);
  assert.equal(widget.webContents.getLastWebPreferences().sandbox, true);
  await evaluate(widget, "location.href = '/'; true"); await pause(70);
  assert.equal(widget.webContents.getURL(), `${origin}/widget.html`, "navigation cannot escape the widget document");
  assert.equal(await evaluate(widget, "window.open('/');"), null, "renderer-created windows are denied");
  await evaluate(main, "window.llmUsageDashboard.desktopWidget.open()");
  assert.equal(controller.getWindow(), widget);
  await layout(widget, true);
  assert.equal(await evaluate(widget, "document.querySelector('.widget-track').getAttribute('aria-valuenow')"), "0");
  assert.equal(await evaluate(widget, "document.querySelectorAll('.widget-window[data-status=unavailable] .widget-track').length"), 0);

  for (const size of [0, 1, 2, 5, 10, 24]) {
    count = size; fixture = widgetUsageFixture(size);
    await evaluate(widget, "document.getElementById('widgetRefresh').click()"); await ready(widget);
    const result = await layout(widget, size <= 5);
    if (size >= 10) assert(result.listScroll, "larger account sets stay in a bounded, scrollable list");
  }
  count = 5; fixture = widgetUsageFixture(count);
  await evaluate(widget, "document.getElementById('widgetRefresh').click()"); await ready(widget);
  theme = "dark"; controller.updateTheme({ preference: theme, color: "#0f1512" });
  await until(() => evaluate(widget, "document.documentElement.dataset.theme === 'dark'"), "dark appearance");
  await layout(widget, true); await capture(widget, "five-accounts-dark");

  const languages = (await fs.readdir(path.resolve(__dirname, "../public/i18n"))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  for (const code of languages) {
    language = code; controller.updateTheme({ preference: theme, color: "#0f1512" });
    await until(() => evaluate(widget, `document.documentElement.lang === '${code}'`), `locale ${code}`);
    assert(await evaluate(widget, "document.querySelector('h1').textContent.length > 0"));
    await layout(widget, true);
  }
  language = "ar"; theme = "light"; controller.updateTheme({ preference: theme, color: "#f6f7f4" });
  await until(() => evaluate(widget, "document.documentElement.lang === 'ar' && document.documentElement.dataset.theme === 'light'"), "Arabic RTL light");
  assert.equal(await evaluate(widget, "document.documentElement.dir"), "rtl");
  await layout(widget, true); await capture(widget, "five-accounts-arabic-light");
  for (const scale of ["1.15", "1.3", "1"]) {
    await evaluate(widget, `document.getElementById('widgetScale').value = '${scale}'; document.getElementById('widgetScale').dispatchEvent(new Event('change'));`);
    assert.equal(controller.state().preferences.scale, Number(scale));
    await layout(widget);
  }
  if (!wayland) {
    for (const width of [601, 600, 599, 420, 780]) {
      widget.setSize(width, 680); await pause(70); await layout(widget);
    }
  }
  language = "fi"; controller.updateTheme({ preference: theme, color: "#f6f7f4" });
  count = 12; fixture = widgetUsageFixture(count);
  await evaluate(widget, "document.getElementById('widgetRefresh').click()"); await ready(widget);
  await capture(widget, "twelve-accounts-finnish-light");
  await evaluate(widget, "document.querySelector('[data-favorite]').click(); document.getElementById('widgetFavorites').click()");
  await until(() => evaluate(widget, "document.querySelectorAll('.widget-account').length === 1"), "favorites filter");
  assert.equal(controller.state().preferences.favorites.length, 1);
  await evaluate(widget, "document.querySelector('[data-favorite]').focus(); document.querySelector('[data-favorite]').click()");
  await until(() => evaluate(widget, "document.querySelectorAll('.widget-account').length === 0"), "empty favorites view");
  assert.equal(await evaluate(widget, "document.activeElement.id"), "widgetList", "removing the final favorite preserves a keyboard focus target");
  await evaluate(widget, "document.getElementById('widgetAll').click(); document.querySelector('[data-favorite]').click()");
  await evaluate(widget, "document.getElementById('widgetAll').click(); document.getElementById('widgetProvider').value = 'claude'; document.getElementById('widgetProvider').dispatchEvent(new Event('change'));");
  assert.equal(await evaluate(widget, "[...document.querySelectorAll('.widget-group h2')].map(node => node.textContent).join()"), "Claude Code");
  await evaluate(widget, "document.getElementById('widgetProvider').value = 'all'; document.getElementById('widgetProvider').dispatchEvent(new Event('change'));");
  assert.equal(await evaluate(widget, "document.querySelectorAll('.widget-account').length"), count);
  await evaluate(widget, "document.getElementById('widgetAccounts').click()");
  await until(() => targets.length > 0, "open account management"); assert.equal(targets[0], "accounts");
  if (!wayland) {
    for (let cycle = 0; cycle < 2; cycle++) {
      await evaluate(widget, "document.getElementById('widgetPin').click()");
      await until(async () => controller.state().pinned && await evaluate(widget,
        "document.getElementById('widgetPin').getAttribute('aria-pressed') === 'true' && !document.getElementById('widgetPin').disabled"), "pin on");
      await evaluate(widget, "document.getElementById('widgetPin').click()");
      await until(async () => !controller.state().pinned && await evaluate(widget,
        "document.getElementById('widgetPin').getAttribute('aria-pressed') === 'false' && !document.getElementById('widgetPin').disabled"), "pin off");
    }
  } else assert.equal(await evaluate(widget, "document.getElementById('widgetPin').hidden"), true);

  fixture.connectedAccounts[0].updatedAt = new Date(Date.now() - 3600_000).toISOString();
  await evaluate(widget, "document.getElementById('widgetRefresh').click()");
  await until(() => evaluate(widget, "document.querySelectorAll('.widget-window[data-status=stale]').length > 0"), "stale readings");
  status = 503;
  await evaluate(widget, "document.getElementById('widgetRefresh').click()");
  await until(() => evaluate(widget, "!document.getElementById('widgetNotice').hidden"), "offline notice");
  assert.equal(await evaluate(widget, "document.querySelectorAll('.widget-account').length"), count, "failed polls preserve explicitly stale readings");
  status = 401;
  await pause(250);
  await until(() => evaluate(widget, "document.querySelectorAll('.widget-account').length === 0"), "logout clears saved readings");
  status = 200; await ready(widget);

  // The fixture backend stays alive while the main window is gone. Closing and
  // reopening the widget must retire the previous renderer's display timer.
  await new Promise((resolve) => { main.once("closed", resolve); main.close(); }); main = null;
  for (let cycle = 0; cycle < 3; cycle++) {
    const oldGeneration = String(generation);
    await new Promise((resolve) => { widget.once("closed", resolve); widget.close(); });
    const retiredAt = Date.now();
    await pause(350);
    // Chromium may finish delivering a request that began before closure.
    // Observe when a request started, rather than when its server callback ran.
    assert.equal((requests.get(oldGeneration) || []).filter((startedAt) => startedAt > retiredAt).length, 0, "closed renderer starts no new polls");
    controller.open(); widget = controller.getWindow(); await ready(widget);
    assert.equal(controller.state().preferences.favorites.length, 1);
    assert.equal(BrowserWindow.getAllWindows().length, 1, "only one widget remains without main window");
  }
  const rogue = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, "../electron/widget-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await rogue.loadURL(`${origin}/widget.html`);
  assert.equal(await evaluate(rogue, "window.llmUsageWidget.getState().then(() => false, () => true)"), true, "another same-origin renderer cannot invoke widget IPC");
  rogue.close();
  // Native Plasma uses this same authenticated cookie jar, including after the
  // dashboard window closes. Verify the real Electron fetch implementation on
  // each CI platform; no credentials are copied into the native package.
  requirePlasmaAuth = true;
  const desktopSession = widget.webContents.session;
  assert.equal((await readPlasmaSnapshot(desktopSession, origin)).status, "locked");
  await desktopSession.cookies.set({ url: origin, name: "plasma-fixture", value: "yes", httpOnly: true, sameSite: "lax" });
  assert.equal((await readPlasmaSnapshot(desktopSession, origin)).snapshot.accounts.length, count);
  await desktopSession.cookies.remove(origin, "plasma-fixture");
  assert.equal((await readPlasmaSnapshot(desktopSession, origin)).status, "locked", "logout clears native access on the next read");
  console.log("Plasma adapter: real Electron session cookies, HttpOnly authentication, closed main window and logout passed.");
  ipcMain.handle("theme:set-preference", (_event, preference) => ({ preference }));
  main = new BrowserWindow({ width: 900, height: 820, show: true,
    webPreferences: { preload: path.resolve(__dirname, "../electron/preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false,
      additionalArguments: ["--llm-usage-language=de"] } });
  plasmaInstaller = createPlasmaWidget({ app: { isPackaged: false, getVersion: () => require("../package.json").version },
    ipcMain, session: desktopSession, origin, getMainWindow: () => main, getLanguage: () => "de",
    environment: { ...process.env, XDG_DATA_HOME: path.join(process.env.WIDGET_NATIVE_PROFILE, "plasma-data") } });
  await main.loadURL(`${origin}/index.html`);
  await until(() => evaluate(main, "!document.getElementById('desktopWidgetBtn').hidden"), "real dashboard widget entry");
  for (const code of ["de", "ar"]) {
    await evaluate(main, `loadLanguage('${code}', { persist: false, rerender: false })`);
    await evaluate(main, "document.getElementById('desktopWidgetBtn').click()");
    await until(() => evaluate(main, "document.getElementById('desktopWidgetDialog').open && document.getElementById('plasmaWidgetStatus').textContent !== t('widget.loading')"), "native installer dialog");
    if (code === "de" && (await plasmaInstaller.status()).supported) {
      await evaluate(main, "document.getElementById('plasmaWidgetInstall').click()");
      await until(async () => (await plasmaInstaller.status()).installed, "installation from real dashboard IPC");
      await until(() => evaluate(main, "document.getElementById('plasmaWidgetInstall').disabled && document.getElementById('plasmaWidgetStatus').textContent.includes('" + require("../package.json").version + "')"), "truthful installed package version");
    }
    if (code === "ar" && !wayland) main.setSize(480, 800);
    const dimensions = await evaluate(main, `(() => {
      const dialog = document.getElementById('desktopWidgetDialog'), bounds = dialog.getBoundingClientRect();
      return { width: bounds.width, left: bounds.left, right: bounds.right, height: bounds.height, overflow: dialog.scrollWidth > dialog.clientWidth + 1,
        viewport: innerWidth, compact: document.getElementById('compactWidgetBtn').textContent, native: document.getElementById('plasmaWidgetInstall').textContent };
    })()`);
    assert(dimensions.width > 0 && dimensions.left >= 0 && dimensions.right <= dimensions.viewport && !dimensions.overflow, JSON.stringify(dimensions));
    assert(dimensions.compact && dimensions.native);
    await capture(main, `plasma-installer-${code}`);
    await evaluate(main, "document.getElementById('compactWidgetBtn').click()");
    await until(() => evaluate(main, "!document.getElementById('desktopWidgetDialog').open"), "compact-window choice closes installer dialog");
  }
  console.log("Plasma installer UI: actual dashboard HTML/JS/IPC, separate compact/native choices and German/Arabic responsive dialog passed.");
  console.log(`Desktop widget native: ${process.platform}/${wayland ? "Wayland" : "native"}; ${process.env.WIDGET_NATIVE_NO_SANDBOX === "1" ? "CI OS-sandbox exception; " : "standard launcher; "}0/1/2/5/10/24 accounts, 27 locales, theme/scale, boundary layouts, zero/missing/stale, controls, isolation and three lifecycle cycles passed.`);
})().then(async () => {
  controller?.dispose(); main?.close(); server.closeAllConnections();
  await plasmaInstaller?.dispose();
  await new Promise((resolve) => server.close(resolve)); app.exit(0);
}).catch(async (error) => {
  console.error(error);
  if (controller?.getWindow() && !controller.getWindow().isDestroyed()) await capture(controller.getWindow(), "failure").catch(() => {});
  controller?.dispose(); main?.close(); server.closeAllConnections(); server.close(); app.exit(1);
});
