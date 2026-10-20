"use strict";

const path = require("node:path");

const POPUP_SIZE = Object.freeze({ width: 780, height: 700 });
const TRAY_ID = "2e8e8ca5-cecf-4e22-9805-759216e07f69";

// Electron screen/tray rectangles are in DIP, including Retina displays and
// displays above or to the left of the primary one. Never multiply by scale.
function popupBounds(anchor, area) {
  const gap = 4;
  const width = Math.min(POPUP_SIZE.width, area.width);
  const height = Math.min(POPUP_SIZE.height, Math.max(1, area.height - gap));
  const clamp = (value, min, max) => Math.round(Math.max(min, Math.min(value, max)));
  return { width, height,
    x: clamp(anchor.x + anchor.width / 2 - width / 2, area.x, area.x + area.width - width),
    y: clamp(anchor.y + anchor.height + gap, area.y, area.y + area.height - height) };
}

function createMacMenuBar({ Tray, nativeImage, screen, widget, platform = process.platform }) {
  if (platform !== "darwin") return { dispose() {}, getTray: () => null };
  const image = nativeImage.createFromPath(path.join(__dirname, "assets", "menu-barTemplate.png"));
  image.setTemplateImage(true);
  const tray = new Tray(image, TRAY_ID);
  tray.setToolTip("LLM Usage Dashboard");
  tray.setIgnoreDoubleClickEvents(true);
  let disposed = false, openOnMouseDown = null;
  const isOpen = () => Boolean(widget.getPopupWindow() && !widget.getPopupWindow().isDestroyed());
  // A menu-bar click can blur/close the panel before Electron emits `click`.
  // Snapshot on mouse-down so a second click closes instead of reopening it.
  const onMouseDown = () => { openOnMouseDown = isOpen(); };
  const onClick = () => {
    if (disposed) return;
    const close = openOnMouseDown ?? isOpen();
    openOnMouseDown = null;
    if (close) { widget.closePopup(); return; }
    const anchor = tray.getBounds();
    if (anchor.width <= 0 || anchor.height <= 0) return;
    const display = screen.getDisplayMatching(anchor);
    widget.openPopup(popupBounds(anchor, display.workArea));
  };
  const onDisplayChange = () => { openOnMouseDown = null; widget.closePopup(); };
  tray.on("mouse-down", onMouseDown);
  tray.on("click", onClick);
  const events = ["display-added", "display-removed", "display-metrics-changed"];
  for (const event of events) screen.on(event, onDisplayChange);
  return {
    getTray: () => disposed ? null : tray,
    dispose() {
      if (disposed) return;
      disposed = true;
      widget.closePopup();
      for (const event of events) screen.removeListener(event, onDisplayChange);
      tray.removeListener("mouse-down", onMouseDown);
      tray.removeListener("click", onClick);
      tray.destroy();
    }
  };
}

module.exports = { createMacMenuBar, popupBounds, POPUP_SIZE };
