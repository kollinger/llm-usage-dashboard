import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const profile = await mkdtemp(path.join(os.tmpdir(), "llm-widget-native-"));
const env = { ...process.env, WIDGET_NATIVE_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const args = [fileURLToPath(new URL("desktop-widget-native.cjs", import.meta.url))];
if (env.WIDGET_NATIVE_NO_SANDBOX === "1") args.push("--no-sandbox");
if (env.WIDGET_NATIVE_OZONE) args.push(`--ozone-platform=${env.WIDGET_NATIVE_OZONE}`);
try {
  const child = spawn(require("electron"), args, { env, stdio: "inherit" });
  const timeout = setTimeout(() => child.kill(), 180_000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (status) => resolve(status ?? 1)); });
  clearTimeout(timeout);
  if (code !== 0) process.exitCode = code;
} finally { await rm(profile, { recursive: true, force: true }); }
