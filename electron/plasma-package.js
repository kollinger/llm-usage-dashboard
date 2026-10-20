"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

const PLUGIN_ID = "local.llm-usage-dashboard.quotas";

// KPackage canonicalizes package paths. An immutable, content-addressed package
// gives Qt a new component URL, including when an old main.qml is still cached.
// Keep prior packages: a running desktop instance may still load their files.
async function activatePackage({ archive, dataHome, version, run, options }) {
  const digest = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  const storage = path.join(dataHome, "llm-usage-dashboard", "plasma-packages");
  const packageRoot = path.join(storage, digest);
  const source = path.join(packageRoot, PLUGIN_ID);
  const destination = path.join(dataHome, "plasma", "plasmoids", PLUGIN_ID);
  let existing, existingTarget;
  try { existing = await fs.lstat(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing && existing.uid !== process.getuid()) throw new Error("unsafe_plasma_package");
  if (existing?.isSymbolicLink()) {
    existingTarget = path.resolve(path.dirname(destination), await fs.readlink(destination));
    if (!existingTarget.startsWith(storage + path.sep)) throw new Error("unsafe_plasma_package");
  } else if (existing && !existing.isDirectory()) throw new Error("unsafe_plasma_package");
  await fs.mkdir(packageRoot, { recursive: true });
  try { await fs.access(path.join(source, "metadata.json")); } catch {
    await run("kpackagetool6", ["--type", "Plasma/Applet", "--packageroot", packageRoot, "--install", archive], options);
  }
  const metadata = JSON.parse(await fs.readFile(path.join(source, "metadata.json"), "utf8"));
  if (metadata.KPlugin?.Id !== PLUGIN_ID || metadata.KPlugin?.Version !== version) throw new Error("invalid_plasma_package");
  if (existingTarget === source) return { source, changed: false };
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = destination + "." + randomUUID();
  let backup;
  try {
    await fs.symlink(source, temporary, "dir");
    if (existing?.isDirectory()) {
      backup = path.join(storage, "legacy-" + randomUUID(), PLUGIN_ID);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.rename(destination, backup);
    }
    await fs.rename(temporary, destination);
  } catch (error) {
    if (backup) await fs.rename(backup, destination);
    throw error;
  } finally { await fs.rm(temporary, { force: true }); }
  return { source, changed: true };
}

async function repairPanels({ source, version, force, run, options }) {
  // dbus-send ships with D-Bus; no Qt developer tools or Python D-Bus module
  // are required by the app. All scripts/paths originate in this package.
  const owner = await run("dbus-send", ["--session", "--print-reply=literal", "--reply-timeout=5000",
    "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.kde.plasmashell"], options);
  if (!/\btrue\b/.test(owner.stdout)) return null;
  const evaluate = async (script) => {
    const { stdout } = await run("dbus-send", ["--session", "--print-reply=literal", "--reply-timeout=5000",
      "--dest=org.kde.plasmashell", "/PlasmaShell", "org.kde.PlasmaShell.evaluateScript", "string:" + script], options);
    return JSON.parse(stdout.trim());
  };
  const identity = `const plugin=${JSON.stringify(PLUGIN_ID)};`;
  // Stage replacements before retiring anything. No desktop, unrelated widget,
  // panel settings or global shell lifecycle is changed. The four General keys
  // are the complete persistent display configuration of this applet.
  const staged = await evaluate(`(function(){${identity}
    const items=[];
    try {
      panels().forEach(p=>p.widgets().filter(w=>w.type===plugin).forEach(old=>{
        const g=old.geometry;
        if (!${Boolean(force)} && old.version===${JSON.stringify(version)} && g.width>0 && g.height>0 && Math.abs(g.width-g.height)<=1) return;
        // Use the old native position. Widget.index can be -1 on Plasma even
        // for a visible panel applet; assigning it would move the replacement.
        const next=p.addWidget(${JSON.stringify(source)},g.x+g.width/2,g.y+g.height/2);
        items.push({panel:p.id,old:old.id,next:next.id});
        if(next.type!==plugin) throw new Error();
        // Copy the explicit lock setting, not old.locked: that property also
        // includes a lock inherited from the panel and must not be persisted.
        old.currentConfigGroup=[]; next.currentConfigGroup=[];
        if(old.configKeys.includes('immutability'))next.writeConfig('immutability',old.readConfig('immutability'));
        old.currentConfigGroup=['General']; next.currentConfigGroup=['General'];
        const favorites=old.readConfig('favorites','');
        next.writeConfig('favorites',typeof favorites==='string'?(favorites?favorites.split(','):[]):favorites);
        ['view','provider'].forEach(k=>next.writeConfig(k,old.readConfig(k,'all')));
        // KConfig converts through the default's type: an integer default
        // silently truncates a saved 1.15/1.3 scale. Read its string form first.
        const scale=Number(old.readConfig('scale','1'));
        next.writeConfig('scale',Number.isFinite(scale)&&scale>0?scale:1);
        next.reloadConfig();
      }));
      print(JSON.stringify({ok:true,items:items}));
    } catch(e) {
      items.forEach(i=>{const w=panelById(i.panel)?.widgetById(i.next);if(w?.type===plugin)w.remove();});
      print(JSON.stringify({ok:false}));
    }
  })();`);
  if (!staged.ok || !Array.isArray(staged.items)) throw new Error("plasma_repair_failed");
  const items = JSON.stringify(staged.items);
  try {
    let ready = staged.items.length === 0;
    for (let attempt = 0; !ready && attempt < 20; attempt++) {
      await delay(100);
      ready = await evaluate(`(function(){${identity}print(JSON.stringify(${items}.every(i=>{
        const p=panelById(i.panel),w=p?.widgetById(i.next),old=p?.widgetById(i.old),g=w?.geometry;
        if(w?.type!==plugin || old?.type!==plugin || !(g.width>0 && g.height>0 && Math.abs(g.width-g.height)<=1 && g.width<=p.height+1))return false;
        w.currentConfigGroup=['General'];old.currentConfigGroup=['General'];
        const defaults={favorites:'',view:'all',provider:'all'};
        return Object.keys(defaults).every(k=>String(w.readConfig(k,defaults[k]))===String(old.readConfig(k,defaults[k]))) && Number(w.readConfig('scale','1'))===Number(old.readConfig('scale','1'));
      })));})();`);
    }
    if (!ready) throw new Error("plasma_repair_failed");
    const committed = await evaluate(`(function(){${identity}const items=${items};
      if(!items.every(i=>{const p=panelById(i.panel);return p?.widgetById(i.old)?.type===plugin && p.widgetById(i.next)?.type===plugin;})){print('false');return;}
      items.forEach(i=>{
        const p=panelById(i.panel),old=p.widgetById(i.old),next=p.widgetById(i.next);
        const shortcut=old.globalShortcut;
        // Plasma retires old applets asynchronously. Release their shortcut
        // before assigning it, so the old action cannot reserve the same key.
        if(shortcut)old.globalShortcut='';
        old.remove(); next.globalShortcut=shortcut;
      }); print('true');
    })();`);
    if (!committed) throw new Error("plasma_repair_failed");
    return staged.items.length;
  } catch (error) {
    await evaluate(`(function(){${identity}${items}.forEach(i=>{
      const p=panelById(i.panel),old=p?.widgetById(i.old),next=p?.widgetById(i.next);
      if(old?.type===plugin && next?.type===plugin)next.remove();
    });print('true');})();`).catch(() => {});
    throw error;
  }
}

module.exports = { activatePackage, repairPanels, PLUGIN_ID };
