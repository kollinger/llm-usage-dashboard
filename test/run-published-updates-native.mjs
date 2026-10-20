import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

if (!process.argv.includes("--ci") || process.env.GITHUB_ACTIONS === "true") {
  const require = createRequire(import.meta.url);
  const profile = await mkdtemp(path.join(os.tmpdir(), "llm-updates-native-"));
  const env = { ...process.env, UPDATES_NATIVE_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [fileURLToPath(new URL("published-updates-native.cjs", import.meta.url))];
  const noSandbox = process.platform === "linux" && (process.env.GITHUB_ACTIONS === "true" || process.getuid?.() === 0);
  if (noSandbox) args.push("--no-sandbox");
  const headless = process.platform === "linux" && !process.env.DISPLAY;
  const command = headless ? "xvfb-run" : require("electron");
  const childArgs = headless ? ["-a", require("electron"), ...args] : args;
  try {
    const child = spawn(command, childArgs, { env, stdio: "inherit" });
    const timeout = setTimeout(() => child.kill(), 90_000);
    try {
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", status => resolve(status ?? 1)); });
      if (code !== 0) process.exitCode = code;
    } finally { clearTimeout(timeout); }
  } finally { await rm(profile, { recursive: true, force: true }); }
}
