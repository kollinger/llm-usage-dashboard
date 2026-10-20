import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createMacMenuBar, popupBounds } = require("../electron/mac-menu-bar");

for (const area of [
  { x: 0, y: 25, width: 1440, height: 875 },
  { x: -1280, y: -800, width: 1280, height: 775 },
  { x: 500, y: 35, width: 360, height: 300 }
]) for (const scaleFactor of [1, 1.5, 2]) for (const edge of [0, 0.5, 1]) {
  const anchor = { x: area.x + (area.width - 18) * edge, y: area.y - 25, width: 18, height: 25 };
  const result = popupBounds(anchor, { ...area, scaleFactor });
  assert(result.x >= area.x && result.y >= area.y);
  assert(result.x + result.width <= area.x + area.width);
  assert(result.y + result.height <= area.y + area.height);
  assert.equal(result.width, Math.min(780, area.width), "Retina coordinates stay in DIP");
}

let creations = 0, popup = null, opened = 0, destroyed = 0;
class FakeTray extends EventEmitter {
  constructor(image) { super(); creations++; assert.equal(image.template, true); }
  setToolTip(value) { assert.equal(value, "LLM Usage Dashboard"); }
  setIgnoreDoubleClickEvents(value) { assert.equal(value, true); }
  getBounds() { return { x: 1000, y: 0, width: 18, height: 25 }; }
  destroy() { destroyed++; }
}
const nativeImage = { createFromPath(file) {
  assert(file.endsWith("menu-barTemplate.png"));
  return { setTemplateImage(value) { this.template = value; } };
} };
const screen = new EventEmitter();
screen.getDisplayMatching = () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } });
const widget = {
  getPopupWindow: () => popup,
  closePopup: () => { popup = null; },
  openPopup(bounds) { opened++; popup = { bounds, isDestroyed: () => false }; }
};
for (const platform of ["linux", "win32"]) {
  const ignored = createMacMenuBar({ platform });
  assert.equal(ignored.getTray(), null); ignored.dispose();
}
const controller = createMacMenuBar({ Tray: FakeTray, nativeImage, screen, widget, platform: "darwin" });
const tray = controller.getTray();
for (let cycle = 0; cycle < 3; cycle++) {
  tray.emit("mouse-down"); tray.emit("click");
  assert(popup);
  assert.equal(popup.bounds.y, 29);
  tray.emit("mouse-down");
  widget.closePopup(); // Native blur may arrive before the tray click.
  tray.emit("click");
  assert.equal(popup, null, "second click must not reopen after blur");
}
tray.emit("click"); assert(popup, "keyboard activation without mouse-down works");
tray.emit("click"); assert.equal(popup, null);
for (const event of ["display-added", "display-removed", "display-metrics-changed"]) {
  tray.emit("click"); assert(popup);
  screen.emit(event); assert.equal(popup, null);
}
tray.getBounds = () => ({ x: 0, y: 0, width: 0, height: 0 });
const before = opened; tray.emit("click"); assert.equal(opened, before, "hidden/unplaced tray cannot position a popup");
controller.dispose(); controller.dispose();
assert.equal(controller.getTray(), null);
assert.equal(creations, 1); assert.equal(destroyed, 1);
assert.equal(screen.eventNames().length, 0); assert.equal(tray.eventNames().length, 0);
console.log("macOS menu bar: DIP geometry, display edges, tiny/negative-origin displays, platform gating, click/blur ordering and cleanup passed.");
