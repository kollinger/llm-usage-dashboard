import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

if (process.platform !== "darwin") throw new Error("macOS package verification requires the native macOS CI runner");
const { extractFile } = require("@electron/asar");
const app = path.resolve("dist/mac-universal/LLM Usage Dashboard.app/Contents");
const archive = path.join(app, "Resources/app.asar");
for (const file of ["electron/mac-menu-bar.js", "electron/desktop-widget.js", "electron/widget-preload.js", "electron/main.js",
  "electron/assets/menu-barTemplate.png", "electron/assets/menu-barTemplate@2x.png", "public/widget.html", "public/widget.js", "public/provider-colors.js"]) {
  assert.deepEqual(extractFile(archive, file), await fs.readFile(file), `packaged ${file} matches this exact commit`);
}
const architectures = execFileSync("/usr/bin/lipo", ["-archs", path.join(app, "MacOS/LLM Usage Dashboard")], { encoding: "utf8" });
assert(architectures.includes("arm64") && architectures.includes("x86_64"), "both Mac architectures are present");
const plistVersion = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print:CFBundleShortVersionString", path.join(app, "Info.plist")], { encoding: "utf8" }).trim();
assert.equal(plistVersion, require("../package.json").version);
console.log("macOS package: exact menu-bar/renderer/Retina assets in ASAR, matching bundle version, arm64 + x86_64 verified.");
