"use strict";

// Internal synthetic session fixture: no dashboard server or provider collectors.
const readline = require("node:readline");
const { startPlasmaBridge } = require("../../lib/plasma-bridge");
const { buildDesktopWidgetSnapshot } = require("../../lib/desktop-widget");
const { widgetUsageFixture, claudeUsageFixture } = require("./desktop-widget.cjs");
let count = 5, status = "ready", language = "en", localClaude = false;
const bridge = startPlasmaBridge({ readSnapshot: async () => ({ status,
  snapshot: buildDesktopWidgetSnapshot(localClaude ? claudeUsageFixture() : widgetUsageFixture(count)) }), getLanguage: () => language });
bridge.then(() => console.log("fixture-ready")).catch(() => { console.error("fixture-failed"); process.exitCode = 1; });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const value = JSON.parse(line);
  count = value.count ?? count; status = value.status ?? status; language = value.language ?? language;
  localClaude = value.localClaude ?? localClaude;
  console.log("fixture-updated");
}).once("close", async () => { await (await bridge).close(); });
