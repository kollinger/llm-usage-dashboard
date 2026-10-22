import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createGptAccountLifecycle } from "./fixtures/gpt-account-lifecycle.mjs";
const require = createRequire(import.meta.url);
const { buildDesktopWidgetSnapshot } = require("../lib/desktop-widget");
const { widgetUsageFixture, claudeUsageFixture, claudeQuotaLabelsFixture, kimiQuotaLabelsFixture, providerColorsUsageFixture } = require("./fixtures/desktop-widget.cjs");
const { gptDuplicateUsageFixture } = require("./fixtures/gpt-duplicate.cjs");
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = {};
for (const count of [0, 1, 5, 12, 80]) {
  const usage = widgetUsageFixture(count);
  if (count > 1) usage.gptAccounts.accounts[1].label = "Example workspace with a very long account name for testing desktop label truncation and tooltips · Team";
  fixtures[count] = buildDesktopWidgetSnapshot(usage);
}
fixtures.claude = buildDesktopWidgetSnapshot(claudeUsageFixture());
fixtures.claudeLabels = buildDesktopWidgetSnapshot(claudeQuotaLabelsFixture());
fixtures.kimiLabels = buildDesktopWidgetSnapshot(kimiQuotaLabelsFixture());
fixtures.providerColors = buildDesktopWidgetSnapshot(providerColorsUsageFixture());
fixtures.gptDuplicate = buildDesktopWidgetSnapshot(gptDuplicateUsageFixture());
// Feed the actual packaged QML with the helper's production HTTP/Unix-bridge
// output after raw auth collection and disk persistence, not a hand-built row.
const lifecycle = await createGptAccountLifecycle();
let lifecycleBridge;
try {
  await lifecycle.scan();
  lifecycleBridge = await lifecycle.serve();
  fixtures.gptLifecycle = [(await lifecycleBridge.read()).snapshot];
  for (let cycle = 0; cycle < 2; cycle++) {
    await lifecycle.login(); await lifecycle.scan(); await lifecycle.reload();
    fixtures.gptLifecycle.push((await lifecycleBridge.read()).snapshot);
  }
  lifecycle.setFailed(true); await lifecycle.scan();
  fixtures.gptLifecycle.push((await lifecycleBridge.read()).snapshot);
  await lifecycle.login("synthetic-unavailable-workspace");
  fixtures.gptLifecycleUnknown = (await lifecycleBridge.read()).snapshot;
} finally { await lifecycleBridge?.close(); await lifecycle.close(); }
await fs.mkdir(path.join(root, "dist/plasma"), { recursive: true });
if (process.env.PLASMA_SCREENSHOTS_DIR) await fs.mkdir(process.env.PLASMA_SCREENSHOTS_DIR, { recursive: true });
await fs.writeFile(path.join(root, "dist/plasma/Fixtures.js"), ".pragma library\nvar cases = " + JSON.stringify(fixtures) +
  ";\nvar screenshots = " + JSON.stringify(process.env.PLASMA_SCREENSHOTS_DIR || "") + ";\n");
const child = spawn(process.env.QML_TEST_RUNNER || "/usr/lib/qt6/bin/qmltestrunner", ["-input", path.join(root, "test/plasma-native"), "-import", "/usr/lib/qt6/qml"], { stdio: "inherit" });
const timeout = setTimeout(() => child.kill(), 120_000);
try {
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (value) => resolve(value ?? 1)); });
  if (code !== 0) process.exitCode = code;
} finally { clearTimeout(timeout); }
