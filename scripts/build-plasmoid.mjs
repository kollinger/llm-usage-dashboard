import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist", "plasma");
const directory = path.join(output, "package");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
await fs.mkdir(output, { recursive: true });
await fs.rm(directory, { recursive: true, force: true });
const files = ["metadata.json", "contents/config/main.xml", "contents/ui/main.qml", "contents/ui/AccountView.qml",
  "contents/code/ViewModel.js", "contents/code/read_snapshot.py"];
for (const file of files) {
  const destination = path.join(directory, file);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(path.join(root, "plasma", file), destination);
}
await fs.copyFile(path.join(root, "scripts", "open-plasma-dashboard.py"), path.join(directory, "contents/code/open_dashboard.py"));
await fs.writeFile(path.join(directory, "contents", "code", "ProviderColors.js"),
  ".pragma library\n" + await fs.readFile(path.join(root, "public", "provider-colors.js"), "utf8"));
const catalog = {};
const metadata = JSON.parse(await fs.readFile(path.join(directory, "metadata.json"), "utf8"));
metadata.KPlugin.Version = pkg.version;
for (const file of (await fs.readdir(path.join(root, "public", "i18n"))).filter((file) => file.endsWith(".json")).sort()) {
  const locale = file.slice(0, -5);
  const data = JSON.parse(await fs.readFile(path.join(root, "public", "i18n", file), "utf8"));
  catalog[locale] = { widget: data.widget, plasma: data.plasma, actions: { refresh: data.actions.refresh },
    limits: Object.fromEntries(["fiveHour", "weekly", "kimiMonthlyTotal", "kimiMonthlyCode", "allModels", "sonnetOnly", "claudeDesign", "default", "resetPrefix", "leftValue"].map((key) => [key, data.limits[key]])) };
  metadata.KPlugin[`Description[${locale}]`] = data.widget.title;
}
metadata.KPlugin.Description = catalog.en.widget.title;
await fs.writeFile(path.join(directory, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
await fs.writeFile(path.join(directory, "contents", "code", "Translations.js"),
  "// Generated from public/i18n; edit the source translations.\n.pragma library\nvar catalog = " + JSON.stringify(catalog) + ";\n");
// Python is already a runtime dependency of this Linux-only widget. Zip entries
// have fixed timestamps and contain only allowlisted source/generated UI files.
execFileSync("python3", ["-I", "-c", `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', compression=zipfile.ZIP_DEFLATED) as archive:
 for p in sorted(root.rglob('*')):
  if p.is_file():
   info=zipfile.ZipInfo(p.relative_to(root).as_posix(), (2020,1,1,0,0,0))
   info.compress_type=zipfile.ZIP_DEFLATED
   info.external_attr=0o100644 << 16
   archive.writestr(info,p.read_bytes())
`, directory, path.join(output, "llm-usage-dashboard.plasmoid")]);
// The existing desktop-build workflow already publishes dist/*.zip. KPackage
// accepts the same native ZIP archive with either extension; keep that workflow
// contract and bundle the conventional .plasmoid name inside the Linux app.
await fs.copyFile(path.join(output, "llm-usage-dashboard.plasmoid"),
  path.join(root, "dist", `LLM-Usage-Dashboard-${pkg.version}-plasma.zip`));
console.log(`Plasma package built for ${pkg.version}`);
