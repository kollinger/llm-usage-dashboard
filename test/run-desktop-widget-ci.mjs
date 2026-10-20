import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The existing desktop-build workflow already runs npm run check on each native
// runner. Keep native/IPC verification in that lane without changing release or
// workflow permissions. Local checks keep their explicit graphical-session entry.
if (process.env.GITHUB_ACTIONS === "true") {
  const nativeTest = fileURLToPath(new URL("run-desktop-widget-native.mjs", import.meta.url));
  const headlessLinux = process.platform === "linux" && !process.env.DISPLAY;
  const command = headlessLinux ? "xvfb-run" : process.execPath;
  const args = headlessLinux ? ["-a", "-s", "-screen 0 1600x1000x24", process.execPath, nativeTest] : [nativeTest];
  // GitHub's Ubuntu image disallows the unprivileged Electron sandbox helper.
  // Do not change host permissions or production launch flags. Local KDE tests
  // exercise the ordinary sandboxed launcher; this CI-only lane tests UI/IPC.
  const env = { ...process.env, ...(process.platform === "linux" ? { WIDGET_NATIVE_NO_SANDBOX: "1" } : {}) };
  const child = spawn(command, args, { stdio: "inherit", env });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (status) => resolve(status ?? 1)); });
  if (code !== 0) process.exitCode = code;
}
