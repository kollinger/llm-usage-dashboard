"use strict";

// Run with Electron through run-desktop-widget-native.mjs. The backend is a
// synthetic local fixture; no app server, provider collector or login is started.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { app, BrowserWindow, ipcMain, screen, Tray, nativeImage } = require("electron");
const { createDesktopWidget } = require("../electron/desktop-widget");
const { createMacMenuBar, popupBounds } = require("../electron/mac-menu-bar");
const { buildDesktopWidgetSnapshot } = require("../lib/desktop-widget");
const { widgetUsageFixture, claudeUsageFixture, claudeQuotaLabelsFixture, providerColorsUsageFixture } = require("./fixtures/desktop-widget.cjs");
const providerColors = require("../public/provider-colors");
const { contrastRatio } = require("./fixtures/color-contrast.cjs");
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
    if (relative === "widget.css" && process.env.WIDGET_NATIVE_FONT) {
      body = body.toString() + `\n.desktop-widget { font-family: ${JSON.stringify(process.env.WIDGET_NATIVE_FONT)}, sans-serif; }\n`;
    }
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
    return { language: document.documentElement.lang, width: innerWidth, height: innerHeight, rootOverflow: document.documentElement.scrollWidth > innerWidth,
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
  await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fs.mkdir(process.env.WIDGET_SCREENSHOTS_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.WIDGET_SCREENSHOTS_DIR, `${name}.png`), (await window.webContents.capturePage()).toPNG());
}
async function checkProviderColors(window) {
  const accounts = buildDesktopWidgetSnapshot(fixture).accounts;
  const rendered = await evaluate(window, `([...document.querySelectorAll('.widget-account')].map(account => ({
    id: account.dataset.account,
    windows: [...account.querySelectorAll('.widget-window')].map(node => ({
      status: node.dataset.status, quality: node.querySelector('.widget-quality').textContent,
      value: node.querySelector('.widget-track')?.getAttribute('aria-valuenow') ?? null,
      color: node.querySelector('.widget-track span') ? getComputedStyle(node.querySelector('.widget-track span')).backgroundColor : null,
      track: node.querySelector('.widget-track') ? getComputedStyle(node.querySelector('.widget-track')).backgroundColor : null,
      ink: getComputedStyle(node.querySelector('.widget-window-value')).color,
      panel: getComputedStyle(account).backgroundColor
    }))
  })))`);
  assert.equal(rendered.length, accounts.length);
  for (const item of rendered) {
    const account = accounts.find((candidate) => candidate.id === item.id);
    assert.deepEqual(item.windows.map((row) => row.status), ["current", "stale", "current", "unavailable"]);
    assert.deepEqual(item.windows.map((row) => row.value), ["65", "40", "0", null]);
    assert(item.windows[1].quality && item.windows[3].quality, "stale and unavailable have explicit translated text");
    for (const row of item.windows.filter((row) => row.color)) {
      const background = "#" + row.track.match(/\d+/g).slice(0, 3).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("");
      const expected = providerColors.quotaAccent(account.provider, background);
      const channels = expected.slice(1).match(/../g).map((channel) => parseInt(channel, 16));
      assert.equal(row.color, `rgb(${channels.join(", ")})`, `${account.provider}: actual CSS colour`);
      assert(contrastRatio(row.color, row.track) >= 3, `${account.provider}: actual bar contrast`);
      assert(contrastRatio(row.ink, row.panel) >= 4.5, `${account.provider}: value and stale-warning readability`);
    }
    assert.equal(item.windows[0].color, item.windows[1].color, "stale status preserves provider identity");
    assert.equal(item.windows[0].color, item.windows[2].color, "real zero keeps its provider identity");
  }
}
let controller, main, plasmaInstaller, menuBar;
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

  count = 9; fixture = providerColorsUsageFixture();
  await evaluate(widget, "document.getElementById('widgetRefresh').click()"); await ready(widget);
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const appearance of ["dark", "light"]) {
      theme = appearance; controller.updateTheme({ preference: theme, color: theme === "dark" ? "#0f1512" : "#f6f7f4" });
      await until(() => evaluate(widget, `document.documentElement.dataset.theme === '${theme}'`), "provider theme change");
      await evaluate(widget, "new Promise(resolve => requestAnimationFrame(resolve))");
      await checkProviderColors(widget); await layout(widget);
      if (cycle === 0) await capture(widget, `provider-colors-${theme}`);
    }
  }
  language = "ar"; controller.updateTheme({ preference: theme, color: "#f6f7f4" });
  await until(() => evaluate(widget, "document.documentElement.lang === 'ar'"), "provider colours Arabic RTL");
  await checkProviderColors(widget); await layout(widget); await capture(widget, "provider-colors-arabic");
  language = "en"; controller.updateTheme({ preference: theme, color: "#f6f7f4" });
  await until(() => evaluate(widget, "document.documentElement.lang === 'en'"), "restore provider language");
  console.log("Provider colours native: all nine providers, identical labels/local sources, two light/dark cycles, Arabic RTL, current/stale/zero/missing, actual fill and text contrast passed.");

  count = 1; fixture = claudeQuotaLabelsFixture();
  await evaluate(widget, "document.getElementById('widgetRefresh').click()"); await ready(widget);
  const quotaRows = buildDesktopWidgetSnapshot(fixture).accounts[0].windows;
  const labels = await evaluate(widget, "[...document.querySelectorAll('.widget-window-label')].map(node => node.textContent.replace(/[\\u2068\\u2069]/g, ''))");
  assert.deepEqual(labels.slice(0, 6), ["5h", "All models · Week", "Sonnet only · Week", "Fable · Week", "Fable Extended · Week", "Claude Design · Week"]);
  assert.equal(new Set(labels).size, quotaRows.length);
  assert.deepEqual(await evaluate(widget, "[...document.querySelectorAll('.widget-window')].map(node => node.dataset.status)"), quotaRows.map(row => row.status));
  assert.deepEqual(await evaluate(widget, "[...document.querySelectorAll('.widget-window')].map(node => node.querySelector('.widget-track')?.getAttribute('aria-valuenow') ?? null)"), quotaRows.map(row => row.remainingPercent === null ? null : String(row.remainingPercent)));
  const english = JSON.parse(await fs.readFile(path.resolve(__dirname, "../public/i18n/en.json"), "utf8"));
  const date = value => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  assert.deepEqual(await evaluate(widget, "[...document.querySelectorAll('.widget-reset')].map(node => node.textContent)"),
    quotaRows.map(row => english.limits.resetPrefix.replace("{time}", date(row.resetsAt))));
  for (const code of ["de", "ar", "fi"]) {
    language = code; controller.updateTheme({ preference: theme, color: "#f6f7f4" });
    await until(() => evaluate(widget, `document.documentElement.lang === '${code}'`), `quota scopes ${code}`);
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const width of wayland ? [780] : [601, 600, 599, 420, 780]) {
        if (!wayland) widget.setSize(width, 700);
        await pause(70); await layout(widget);
        assert.equal(await evaluate(widget, `(() => {
          return [...document.querySelectorAll('.widget-window-heading')].every(node => {
            const label = node.querySelector('.widget-window-label'), value = node.querySelector('.widget-window-value');
            const a = label.getBoundingClientRect(), b = value.getBoundingClientRect();
            return label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1 &&
              (a.right <= b.left + 1 || b.right <= a.left + 1);
          });
        })()`), true, `${code}/${width}: scope wraps without truncation or value overlap`);
      }
    }
    if (code !== "fi") await capture(widget, `claude-scopes-${code}`);
  }
  language = "en"; controller.updateTheme({ preference: theme, color: "#f6f7f4" });
  await until(() => evaluate(widget, "document.documentElement.lang === 'en'"), "restore quota scope language");

  count = 3; fixture = claudeUsageFixture();
  await evaluate(widget, "document.getElementById('widgetRefresh').click()"); await ready(widget);
  assert.equal(await evaluate(widget, "[...document.querySelectorAll('.widget-account .widget-window:first-child .widget-window-value')].map(node => node.textContent).join('|')"), "73% left|41% left|0% left");
  assert.equal(await evaluate(widget, "document.querySelectorAll('.widget-source')[2].textContent"), "Local source");
  assert.equal(await evaluate(widget, "document.querySelectorAll('.widget-account')[2].querySelector('.widget-window').dataset.status"), "current");
  const localHandle = buildDesktopWidgetSnapshot(fixture).accounts[2].id;
  await evaluate(widget, "document.querySelectorAll('[data-favorite]')[2].click(); document.getElementById('widgetFavorites').click()");
  await until(() => evaluate(widget, "document.querySelectorAll('.widget-account').length === 1"), "local Claude favorite");
  assert.deepEqual(controller.state().preferences.favorites, [localHandle]);
  for (let cycle = 0; cycle < 2; cycle++) {
    count = 2; const quota = fixture.claudeCode; fixture.claudeCode = null;
    await evaluate(widget, "document.getElementById('widgetRefresh').click()");
    await until(() => evaluate(widget, "document.querySelectorAll('.widget-account').length === 0"), "temporarily missing local favorite");
    count = 3; fixture.claudeCode = quota;
    await evaluate(widget, "document.getElementById('widgetRefresh').click()");
    await until(() => evaluate(widget, "document.querySelectorAll('.widget-account').length === 1"), "local favorite returns with stable handle");
  }
  await evaluate(widget, "document.querySelector('[data-favorite]').click(); document.getElementById('widgetAll').click()"); await ready(widget);
  for (const code of ["de", "ar"]) {
    language = code; controller.updateTheme({ preference: theme, color: "#f6f7f4" });
    await until(() => evaluate(widget, `document.documentElement.lang === '${code}'`), `local Claude ${code}`);
    await layout(widget, true); await capture(widget, `claude-local-${code}`);
  }
  language = "en"; controller.updateTheme({ preference: theme, color: "#f6f7f4" });
  await until(() => evaluate(widget, "document.documentElement.lang === 'en'"), "restore language");

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

  // Real macOS CI exposes only 645px of content in the default outer window.
  // Keep five full rows visible there, including wrapped translated scopes.
  if (!wayland) { widget.setContentSize(780, 645); await pause(70); }
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
  count = 3; fixture = claudeUsageFixture();
  const desktopSession = widget.webContents.session;
  assert.equal((await readPlasmaSnapshot(desktopSession, origin)).status, "locked");
  await desktopSession.cookies.set({ url: origin, name: "plasma-fixture", value: "yes", httpOnly: true, sameSite: "lax" });
  const nativeClaude = (await readPlasmaSnapshot(desktopSession, origin)).snapshot.accounts;
  assert.equal(nativeClaude.length, count);
  assert.deepEqual(nativeClaude[2].sources, ["local"]);
  assert.equal(nativeClaude[2].windows[0].remainingPercent, 0);
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
  // Reuse the real, sandboxed widget renderer and synthetic authenticated server
  // for menu-bar/native-panel checks on every desktop CI runner.
  await evaluate(widget, "window.llmUsageWidget.savePreferences({ favorites: [], view: 'all', provider: 'all', scale: 1 })");
  widget.close(); main.close(); main = null;
  count = 5; fixture = widgetUsageFixture(count); requirePlasmaAuth = false;
  language = "en"; theme = "light";
  menuBar = createMacMenuBar({ Tray, nativeImage, screen, widget: controller });
  const tray = menuBar.getTray();
  const area = screen.getPrimaryDisplay().workArea;
  const openPopup = () => {
    if (tray) tray.emit("click");
    else controller.openPopup(popupBounds({ x: area.x + area.width - 30, y: area.y - 24, width: 18, height: 24 }, area));
    return controller.getPopupWindow();
  };
  if (process.platform === "darwin") {
    assert(tray, "actual native macOS Tray exists");
    const template = nativeImage.createFromPath(path.resolve(__dirname, "../electron/assets/menu-barTemplate.png"));
    assert(template.isTemplateImage());
    assert(template.getScaleFactors().includes(2), "Retina representation is packaged");
    assert(tray.getBounds().width > 0, "native menu-bar item is placed");
    const { execFile } = require("node:child_process");
    const { promisify } = require("node:util");
    const click = async (x, y) => promisify(execFile)("/usr/bin/swift", [path.join(__dirname, "mac-menu-bar-click.swift"), String(x), String(y)], { timeout: 60_000 });
    for (let cycle = 0; cycle < 2; cycle++) {
      const anchor = tray.getBounds();
      await click(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
      await until(() => Boolean(controller.getPopupWindow()?.isVisible()), "real macOS menu-bar click opens native panel");
      await ready(controller.getPopupWindow());
      const actual = controller.getPopupWindow().getBounds();
      const expected = popupBounds(anchor, screen.getDisplayMatching(anchor).workArea);
      assert.deepEqual(actual, expected, "native panel is anchored below menu-bar item");
      await click(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
      await until(() => !controller.getPopupWindow(), "real second menu-bar click closes native panel");
    }
    await click(tray.getBounds().x + 5, tray.getBounds().y + 5);
    await until(() => Boolean(controller.getPopupWindow()?.isVisible()), "native outside-click setup");
    await click(area.x + 5, area.y + area.height - 5);
    await until(() => !controller.getPopupWindow(), "real click outside dismisses panel");
    console.log("macOS native menu bar: template/Retina image, actual OS clicks, anchored panel, repeated toggle and outside-click dismissal passed.");
  } else assert.equal(tray, null, "Linux/Windows do not create a macOS tray");
  let popup = openPopup(); await ready(popup);
  assert.equal(await evaluate(popup, "typeof require + ':' + typeof process"), "undefined:undefined");
  assert.equal(await evaluate(popup, "document.getElementById('widgetPin').hidden"), true);
  assert.equal(await evaluate(popup, "document.getElementById('widgetClose').hidden"), false);
  assert.equal(await evaluate(popup, "window.llmUsageWidget.setPinned(true).then(() => false, () => true)"), true);
  await evaluate(popup, "location.href = '/'; true"); await pause(70);
  assert.equal(popup.webContents.getURL(), `${origin}/widget.html`);
  assert.equal(await evaluate(popup, "window.open('/')"), null);
  for (const code of languages) {
    language = code; controller.updateTheme({ preference: theme, color: "#f6f7f4" });
    await until(() => evaluate(popup, `document.documentElement.lang === '${code}'`), `popup locale ${code}`);
    await layout(popup, popup.getBounds().width >= 780 && popup.getBounds().height >= 645);
  }
  for (const [code, preference] of [["en", "light"], ["de", "dark"], ["ar", "light"]]) {
    language = code; theme = preference;
    controller.updateTheme({ preference: theme, color: theme === "dark" ? "#0f1512" : "#f6f7f4" });
    await until(() => evaluate(popup, `document.documentElement.lang === '${code}' && document.documentElement.dataset.theme === '${theme}'`), `popup ${code}/${theme}`);
    for (const scale of [1, 1.15, 1.3, 1]) {
      await evaluate(popup, `document.getElementById('widgetScale').value = '${scale}'; document.getElementById('widgetScale').dispatchEvent(new Event('change'))`);
      await layout(popup);
    }
    await capture(popup, `menubar-five-${code}-${theme}`);
  }
  count = 24; fixture = widgetUsageFixture(count);
  await evaluate(popup, "document.getElementById('widgetRefresh').click()"); await ready(popup);
  assert((await layout(popup)).listScroll);
  await evaluate(popup, "document.querySelector('[data-favorite]').click(); document.getElementById('widgetFavorites').click()");
  await until(() => evaluate(popup, "document.querySelectorAll('.widget-account').length === 1"), "popup favorites");
  await evaluate(popup, "document.getElementById('widgetAll').click(); document.getElementById('widgetProvider').value = 'claude'; document.getElementById('widgetProvider').dispatchEvent(new Event('change'))");
  assert.equal(controller.state().preferences.provider, "claude");
  popup.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await until(() => !controller.getPopupWindow(), "native Escape dismisses panel");
  for (let cycle = 0; cycle < 2; cycle++) {
    popup = openPopup();
    await until(() => evaluate(popup, "document.getElementById('widgetProvider').value === 'claude' && document.querySelectorAll('.widget-account').length > 0").catch(() => false), "popup filter survives reopening");
    const oldGeneration = String(generation);
    // Native OS focus transfer produces the real blur event (no event replay).
    const outside = new BrowserWindow({ width: 200, height: 150, show: false });
    outside.show(); outside.focus();
    await until(() => !controller.getPopupWindow(), "native focus outside dismisses panel");
    outside.close();
    const retiredAt = Date.now(); await pause(350);
    assert.equal((requests.get(oldGeneration) || []).filter((startedAt) => startedAt > retiredAt).length, 0, "closed popup renderer retires its display timer");
    assert.equal(controller.getWindow(), null, "tray never opens the full dashboard or compact window");
  }
  popup = openPopup();
  await until(() => evaluate(popup, "document.querySelectorAll('.widget-account').length > 0").catch(() => false), "popup before state synchronization");
  // Both views share one preferences owner and one IPC registration. Open the
  // compact window, dismiss the panel, then reopen it beside the compact view.
  controller.open(); widget = controller.getWindow();
  await until(() => evaluate(widget, "document.getElementById('widgetProvider').value === 'claude'").catch(() => false), "compact inherits popup filter");
  controller.closePopup(); popup = openPopup();
  await until(() => evaluate(popup, "document.querySelectorAll('.widget-account').length > 0").catch(() => false), "popup beside compact window");
  await evaluate(popup, "document.getElementById('widgetProvider').value = 'all'; document.getElementById('widgetProvider').dispatchEvent(new Event('change')); document.getElementById('widgetAll').click()");
  await until(() => evaluate(widget, "document.getElementById('widgetProvider').value === 'all' && document.querySelectorAll('.widget-account').length === 24"), "live preferences synchronized into compact window");
  status = 401; await pause(250);
  await until(() => evaluate(popup, "document.querySelectorAll('.widget-account').length === 0"), "popup logout clears quota data");
  status = 200; await ready(popup);
  await evaluate(popup, "document.getElementById('widgetClose').click(); true");
  await until(() => !controller.getPopupWindow(), "localized popup close button");
  assert.equal(controller.getWindow(), widget);
  menuBar.dispose(); menuBar = null;
  console.log(`Menu-bar popup native: ${process.platform}; all 27 locales, five/24 accounts, theme/scale, zero/missing/stale, Escape/focus/close, shared preferences, logout and renderer lifecycle passed.`);
  console.log(`Desktop widget native: ${process.platform}/${wayland ? "Wayland" : "native"}; ${process.env.WIDGET_NATIVE_NO_SANDBOX === "1" ? "CI OS-sandbox exception; " : "standard launcher; "}0/1/2/5/10/24 accounts, 27 locales, theme/scale, boundary layouts, zero/missing/stale, controls, isolation and three lifecycle cycles passed.`);
})().then(async () => {
  menuBar?.dispose(); controller?.dispose(); main?.close(); server.closeAllConnections();
  await plasmaInstaller?.dispose();
  await new Promise((resolve) => server.close(resolve)); app.exit(0);
}).catch(async (error) => {
  console.error(error);
  if (controller?.getWindow() && !controller.getWindow().isDestroyed()) await capture(controller.getWindow(), "failure").catch(() => {});
  menuBar?.dispose(); controller?.dispose(); main?.close(); server.closeAllConnections(); server.close(); app.exit(1);
});
