import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// CI fixtures only, created before the real main initializes its own Tray.
// No GUID/autosave name, preferences, permissions, or production item is changed.
export const createCrowdingItems = `(() => {
  const { Tray, nativeImage } = require('electron');
  globalThis.__desktopCrowdingItems = [];
  for (let index = 0; index < 24; index++) {
    const item = new Tray(nativeImage.createEmpty());
    globalThis.__desktopCrowdingItems.push(item);
    item.setTitle('Fixture ' + (index + 1) + ' ▪▪▪▪▪▪▪▪▪▪');
  }
  return globalThis.__desktopCrowdingItems.length;
})()`;

export async function probeMacMenuBarCrowding({ evaluate, state, quotaReady, until, pause, root, temporary }) {
  const click = bounds => execFileSync("/usr/bin/swift", [path.join(root, "test/mac-menu-bar-click.swift"),
    String(bounds.x + bounds.width / 2), String(bounds.y + bounds.height / 2)], { timeout: 60_000, stdio: "inherit" });
  const trayBounds = () => evaluate(`${state}.getTray().getBounds()`);
  const capture = async (label, windowName) => {
    await evaluate(`${state}.getWidget().${windowName}().webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")`);
    await pause(300);
    const { display, panel } = await evaluate(`({ display: ${state}.require('electron').screen.getPrimaryDisplay().bounds,
      panel: ${state}.getWidget().${windowName}().getBounds() })`);
    const height = Math.min(display.height, Math.ceil(panel.y + panel.height - display.y));
    const screenshot = path.join(temporary, `menu-bar-${label}.png`);
    execFileSync("/usr/sbin/screencapture", ["-x", "-R", `${display.x},${display.y},${display.width},${height}`, screenshot], { timeout: 15_000 });
    console.log(`DESKTOP_CROWDING_SCREENSHOT_${label.toUpperCase()}:${(await fs.readFile(screenshot)).toString("base64")}`);
  };
  const original = `${state}.getTray() === globalThis.__desktopCrowdingProductionTray`;
  await evaluate(`globalThis.__desktopCrowdingProductionTray = ${state}.getTray(); true`);
  let before, openedWhileCrowded = false, compactAccessible = false;
  try {
    assert.equal(await evaluate("globalThis.__desktopCrowdingItems.length"), 24);
    assert.equal(await evaluate(`globalThis.__desktopCrowdingItems.includes(${state}.getTray())`), false);
    assert.equal(await evaluate(`${state}.getTray().isDestroyed()`), false);
    await pause(500);
    before = await trayBounds();
    const display = await evaluate(`${state}.require('electron').screen.getPrimaryDisplay().bounds`);
    const targetOnDisplay = before.width > 0 && before.height > 0 && before.x >= display.x &&
      before.y >= display.y && before.x + before.width <= display.x + display.width &&
      before.y + before.height <= display.y + display.height;
    if (targetOnDisplay) {
      click(before);
      await pause(700);
      openedWhileCrowded = await evaluate(`Boolean(${state}.getWidget().getPopupWindow()?.isVisible())`);
      if (openedWhileCrowded) {
        await quotaReady("getPopupWindow");
        click(before);
        await until(() => evaluate(`!${state}.getWidget().getPopupWindow()`), "crowded popup closes");
      }
    }
    // Exercise the existing user-facing renderer route; the probe never opens
    // a replacement window or substitutes quota data/server responses.
    await evaluate(`${state}.getMain().webContents.executeJavaScript("window.llmUsageDashboard.desktopWidget.open()")`);
    await quotaReady("getWindow");
    await until(() => evaluate(`Boolean(${state}.getWidget().getWindow()?.isVisible())`), "compact quota window becomes visible");
    compactAccessible = true;
    if (process.env.GITHUB_ACTIONS === "true") await capture("crowded", "getWindow");
    console.log(`DESKTOP_CROWDING_OBSERVATION:${JSON.stringify({ before, targetOnDisplay, openedWhileCrowded,
      compactAccessible, fixtureItems: 24, interpretation: openedWhileCrowded ? "icon unavailability not reproduced" : "inspect native screenshot and bounds; not a user-machine diagnosis" })}`);
    await evaluate(`${state}.getWidget().getWindow().close(); true`);
  } finally {
    await evaluate(`globalThis.__desktopCrowdingItems.forEach(item => { if (!item.isDestroyed()) item.destroy(); }); true`);
    assert.equal(await evaluate("globalThis.__desktopCrowdingItems.every(item => item.isDestroyed())"), true);
  }
  assert.equal(await evaluate(original), true, "the production Tray is never replaced during the probe");
  assert.equal(await evaluate(`${state}.getTray().isDestroyed()`), false);
  await until(async () => { const bounds = await trayBounds(); return bounds.width > 0 && bounds.height > 0; }, "production Tray has bounds after fixture cleanup");
  await pause(500);
  const after = await trayBounds();
  click(after);
  await until(() => evaluate(`Boolean(${state}.getWidget().getPopupWindow()?.isVisible())`), "same production Tray opens popup after removing synthetic pressure");
  await quotaReady("getPopupWindow");
  if (process.env.GITHUB_ACTIONS === "true") await capture("recovered", "getPopupWindow");
  click(after);
  await until(() => evaluate(`!${state}.getWidget().getPopupWindow()`), "recovered popup closes");
  console.log(`DESKTOP_CROWDING_RECOVERY:${JSON.stringify({ before, after, openedWhileCrowded, compactAccessible,
    productionTrayUnchanged: await evaluate(original), fixturesDestroyed: true, realOSClickOpenedPopup: true })}`);
  await evaluate("delete globalThis.__desktopCrowdingItems; delete globalThis.__desktopCrowdingProductionTray; true");
}
