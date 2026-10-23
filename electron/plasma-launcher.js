"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const PLASMA_DESKTOP_ID = "local.llm-usage-dashboard.plasma-launcher";

function desktopExec(value) {
  // Desktop entries have two escaping layers: string values, then Exec args.
  return '"' + value.replace(/([\\"`$])/g, "\\$1").replace(/\\/g, "\\\\").replace(/%/g, "%%") + '"';
}

async function atomicWrite(directory, name, content) {
  const temporary = path.join(directory, `launcher-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, path.join(directory, name));
  } finally { await fs.rm(temporary, { force: true }); }
}

// Keep a durable reference to the installed app, never the temporary AppImage
// mount or a development Electron binary. Only the owning desktop user reads it.
async function registerPlasmaLauncher({ app, dataHome, environment = process.env, executable = process.execPath }) {
  if (!app.isPackaged) return;
  const target = environment.APPIMAGE || executable;
  if (typeof target !== "string" || !path.isAbsolute(target) || /[\x00-\x1f\x7f]/.test(target)) throw new Error("invalid_launcher");
  if (!(await fs.stat(target)).isFile()) throw new Error("invalid_launcher");
  await fs.access(target, fs.constants.X_OK);
  const directory = path.join(dataHome, "llm-usage-dashboard");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error("unsafe_launcher_directory");
  const applications = path.join(dataHome, "applications");
  await fs.mkdir(applications, { recursive: true, mode: 0o700 });
  const applicationInfo = await fs.lstat(applications);
  if (!applicationInfo.isDirectory() || applicationInfo.uid !== process.getuid() || (applicationInfo.mode & 0o022)) throw new Error("unsafe_applications_directory");
  // Hidden identity metadata avoids another app-menu entry while allowing KDE
  // to associate the exact Wayland surface with this installed app.
  await atomicWrite(directory, "open_dashboard.py", await fs.readFile(path.join(__dirname, "../scripts/open-plasma-dashboard.py")));
  await atomicWrite(applications, `${PLASMA_DESKTOP_ID}.desktop`,
    ["[Desktop Entry]", "Type=Application", "Name=LLM Usage Dashboard",
      `Exec=/usr/bin/python3 -I ${desktopExec(path.join(directory, "open_dashboard.py"))}`,
      "Terminal=false", "NoDisplay=true", "StartupNotify=true", ""].join("\n"));
  await atomicWrite(directory, "launcher.json", JSON.stringify({ schema: 1, executable: target }));
}

module.exports = { registerPlasmaLauncher, PLASMA_DESKTOP_ID };
