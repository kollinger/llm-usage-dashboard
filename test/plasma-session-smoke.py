#!/usr/bin/python3
"""Isolated internal Plasma desktop lifecycle. Run inside dbus-run-session/Xvfb.

Requires Plasma 6, KWin, Xvfb, qdbus6, ImageMagick and Python/Node; never changes
the running user's desktop/config. Evidence contains only synthetic accounts.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import signal
import re

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = "local.llm-usage-dashboard.quotas"
MODE = sys.argv[1] if len(sys.argv) > 1 else "x11"
PANEL = "--panel" in sys.argv
QUOTA_LABELS = "--quota-labels" in sys.argv
GPT_LIFECYCLE = "--gpt-lifecycle" in sys.argv
UPGRADE = os.environ.get("PLASMA_UPGRADE_ARCHIVE")
LIVE_UPGRADE = "--live-upgrade" in sys.argv
assert not UPGRADE or PANEL, "Use --panel with PLASMA_UPGRADE_ARCHIVE"
assert not LIVE_UPGRADE or UPGRADE, "Use PLASMA_UPGRADE_ARCHIVE with --live-upgrade"
EVIDENCE = Path(os.environ.get("PLASMA_QA_EVIDENCE", ROOT / ".cache" / ("kol-664" if GPT_LIFECYCLE else "quota-labels" if QUOTA_LABELS else "kol-654" if PANEL else "kol-652") / ("plasma-" + MODE)))
EVIDENCE.mkdir(parents=True, exist_ok=True)
profile = Path(tempfile.mkdtemp(prefix="llm-plasma-qa-"))
env = os.environ.copy()
env.update({"XDG_RUNTIME_DIR": str(profile), "XDG_CONFIG_HOME": str(profile / "config"),
            "XDG_DATA_HOME": str(profile / "data"), "XDG_CACHE_HOME": str(profile / "cache"),
            "QSG_RHI_BACKEND": "opengl", "LIBGL_ALWAYS_SOFTWARE": "1",
            "KDE_FULL_SESSION": "true", "KDE_SESSION_VERSION": "6", "XDG_CURRENT_DESKTOP": "KDE",
            "XDG_SESSION_TYPE": MODE, "QT_QPA_PLATFORM": "xcb"})
children = []
logs = []
env.pop("QT_QUICK_BACKEND", None)


def run(args, timeout=20):
    return subprocess.run(args, env=env, cwd=ROOT, check=True, text=True, capture_output=True, timeout=timeout).stdout.strip()


def start(args, name, stdin=None, stdout=None):
    log = (EVIDENCE / (name + ".log")).open("a")
    logs.append(log)
    child = subprocess.Popen(args, env=env, cwd=ROOT, stdin=stdin, stdout=stdout or log, stderr=log)
    children.append(child)
    return child


def evaluate(script):
    return run(["qdbus6", "org.kde.plasmashell", "/PlasmaShell", "org.kde.PlasmaShell.evaluateScript", script])


def wait_for(fn, label, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = fn()
            if value:
                return value
        except (subprocess.SubprocessError, OSError):
            pass
        time.sleep(0.25)
    raise RuntimeError("Timed out: " + label)


def capture(name):
    # For Wayland this captures the nested KWin X11 host surface; the applet
    # itself runs natively on Wayland. Host input is forwarded by KWin as well.
    run(["import", "-window", "root", str(EVIDENCE / (name + ".png"))])


def geometry(widget_id):
    return json.loads(evaluate("print(JSON.stringify(desktops()[0].widgetById(" + str(widget_id) + ").geometry))"))


def resize(widget_id):
    # Two real applet positions determine the desktop edit transform without
    # assuming its origin or amplifying rounding near the screen centre.
    anchor_id = int(evaluate("print(desktops()[0].addWidget('org.kde.plasma.analogclock').id);"))
    time.sleep(1)
    before = geometry(widget_id)
    anchor_before = geometry(anchor_id)
    # Enter Plasma's native edit mode, then drag its southeast resize handle.
    run(["qdbus6", "org.kde.plasmashell", "/PlasmaShell", "org.kde.PlasmaShell.editMode", "true"])
    time.sleep(1)
    if MODE == "wayland":
        host_windows = run(["xdotool", "search", "--onlyvisible", "--pid", str(compositor.pid)]).splitlines()
        run(["xdotool", "windowfocus", host_windows[-1]])
    edited = geometry(widget_id)
    run(["xdotool", "mousemove", str(round(edited["x"] + 40)), str(round(edited["y"] + 20)), "mousedown", "1"])
    # A press-and-hold selects the applet's own native resize overlay; global
    # desktop edit mode alone does not guarantee that overlay is open.
    time.sleep(1.2)
    run(["xdotool", "mouseup", "1"])
    time.sleep(.5)
    capture("desktop-selected")
    # Plasma scales the whole desktop while editing; Widget.geometry reports
    # mapped coordinates but unscaled dimensions. Compare two distinct origins.
    edited = geometry(widget_id)
    anchor_edited = geometry(anchor_id)
    axis = max(["x", "y"], key=lambda key: abs(before[key] - anchor_before[key]))
    assert abs(before[axis] - anchor_before[axis]) > 50, "Need distinct native applet positions"
    scale = (edited[axis] - anchor_edited[axis]) / (before[axis] - anchor_before[axis])
    x, y = round(edited["x"] + (edited["width"] + 12) * scale), round(edited["y"] + (edited["height"] + 12) * scale)
    run(["xdotool", "mousemove", str(x), str(y), "mousedown", "1"])
    time.sleep(.1)
    capture("resize-handle")
    # Multiple real motion events exercise the native drag/constraint path.
    for step in range(1, 11):
        run(["xdotool", "mousemove", str(x - 20 * step), str(y - 20 * step)])
        time.sleep(.03)
    run(["xdotool", "mouseup", "1"])
    time.sleep(1)
    after = geometry(widget_id)
    (EVIDENCE / "resize-dimensions.json").write_text(json.dumps({"before": before, "edited": edited, "scale": scale, "after": after}, indent=2))
    assert after["width"] < before["width"] - 80 and after["height"] < before["height"] - 80, "Native resize handle must change actual applet dimensions"
    run(["qdbus6", "org.kde.plasmashell", "/PlasmaShell", "org.kde.PlasmaShell.editMode", "false"])
    evaluate("desktops()[0].widgetById(" + str(anchor_id) + ").remove();")


def update(fixture, **values):
    fixture.stdin.write(json.dumps(values) + "\n")
    fixture.stdin.flush()
    assert fixture.stdout.readline().strip() == "fixture-updated"


def exercise_gpt(shell, fixture):
    widget_id = int(evaluate("print(desktops()[0].addWidget('" + PLUGIN + "').id);"))

    def rendered(name, count=2, stale=False):
        def observed():
            capture(name)
            text = run(["tesseract", str(EVIDENCE / (name + ".png")), "stdout", "-l", os.environ.get("PLASMA_OCR_LANGUAGE", "eng"), "--psm", "11"])
            return re.search(str(count) + r"\s*of\s*2\s+accounts", text) and (("stale" in text.lower()) == stale)
        wait_for(observed, "native rendered account count and freshness: " + name, timeout=20)

    def refresh():
        rect = geometry(widget_id)
        run(["xdotool", "mousemove", str(round(rect["x"] + rect["width"] - 28)),
             str(round(rect["y"] + 60)), "click", "1"])

    time.sleep(3)
    rendered("gpt-initial-two-workspaces")
    for cycle in range(2):
        update(fixture, action="login")
        refresh()
        rendered("gpt-relogin-" + str(cycle))
        update(fixture, failed=True)
        refresh()
        rendered("gpt-failed-refresh-" + str(cycle), stale=True)
        update(fixture, action="restart")
        refresh()
        rendered("gpt-restored-registry-" + str(cycle), stale=True)
        update(fixture, failed=False)
        refresh()
        rendered("gpt-recovered-" + str(cycle))
    snapshot = json.loads(run(["/usr/bin/python3", "-I", str(ROOT / "plasma/contents/code/read_snapshot.py")]))["snapshot"]
    assert len(snapshot["accounts"]) == 2
    assert any(a["windows"][0]["remainingPercent"] == 0 for a in snapshot["accounts"])
    favorite = snapshot["accounts"][0]["id"]
    evaluate("var w=desktops()[0].widgetById(" + str(widget_id) + ");w.currentConfigGroup=['General'];w.writeConfig('favorites'," + json.dumps([favorite]) + ");w.writeConfig('view','favorites');")
    shell.terminate()
    shell.wait(timeout=15)
    shell = start(["plasmashell", "--no-respawn"], "plasmashell-restarted")
    wait_for(lambda: evaluate("print(desktops()[0].widgets().length)") != "0", "native shell restored")
    time.sleep(3)
    rendered("gpt-native-restarted-favorite", count=1)
    evaluate("var w=desktops()[0].widgetById(" + str(widget_id) + ");w.currentConfigGroup=['General'];w.writeConfig('view','all');")
    # Reload the private shell so its typed config binding consumes the change.
    shell.terminate()
    shell.wait(timeout=15)
    shell = start(["plasmashell", "--no-respawn"], "plasmashell-normal")
    time.sleep(3)
    rendered("gpt-native-restored-all")
    (EVIDENCE / "gpt-lifecycle-results.json").write_text(json.dumps({"mode": MODE,
        "nativeAccountCount": 2, "nativeFavoriteCount": 1, "reloginRefreshRestartCycles": 2,
        "realHttpBridgeHelper": True, "installedPackageUpdated": True, "normalViewRestored": True}, indent=2))
    print("Plasma GPT lifecycle: actual rendered 2-of-2 accounts, two re-login/refresh/failure/registry-restart cycles, native shell restart with 1-of-2 favorite and restored All passed.")


def exercise_panels(shell, fixture):
    # Observe real compositor windows over this private bus. No instrumentation
    # is added to the packaged applet and all input uses the real panel surface.
    import dbus
    import dbus.service
    from dbus.mainloop.glib import DBusGMainLoop
    from gi.repository import GLib

    interface = "local.llm_usage_dashboard.PanelQA"
    bus = dbus.SessionBus(mainloop=DBusGMainLoop())
    name = dbus.service.BusName(interface, bus=bus)

    class Probe(dbus.service.Object):
        value = None

        @dbus.service.method(interface, in_signature="s", out_signature="")
        def report(self, value):
            self.value = json.loads(str(value))

    probe = Probe(name, "/qa")
    sequence = []
    shell_classes = ["plasmashell", "org.kde.plasmashell"]

    def windows():
        probe.value = None
        source = profile / "panel-observe.js"
        source.write_text("callDBus('" + interface + "','/qa','" + interface + "','report',"
                          "JSON.stringify(workspace.windowList().map(w=>({caption:w.caption,"
                          "resourceClass:w.resourceClass,dock:w.dock,desktop:w.desktopWindow,"
                          "x:w.frameGeometry.x,y:w.frameGeometry.y,width:w.frameGeometry.width,"
                          "height:w.frameGeometry.height}))));")
        script_id = run(["qdbus6", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", str(source), "panel-qa-observe"])
        try:
            run(["qdbus6", "org.kde.KWin", "/Scripting/Script" + script_id, "org.kde.kwin.Script.run"])

            def reported():
                while GLib.MainContext.default().pending():
                    GLib.MainContext.default().iteration(False)
                return probe.value is not None

            wait_for(reported, "compositor window observation", timeout=5)
            (EVIDENCE / "window-observation.json").write_text(json.dumps(probe.value, indent=2))
            return probe.value
        finally:
            run(["qdbus6", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", "panel-qa-observe"])

    def popups():
        return [w for w in windows() if w["resourceClass"] in shell_classes and not w["dock"]
                and not w["desktop"] and 320 <= w["width"] < 1000 and 300 <= w["height"] < 1050]

    def pointer(x, y, button="1"):
        if MODE == "wayland":
            host = run(["xdotool", "search", "--onlyvisible", "--pid", str(compositor.pid)]).splitlines()[-1]
            run(["xdotool", "windowfocus", host])
            run(["xdotool", "mousemove", "--window", host, str(round(x)), str(round(y))])
        else:
            run(["xdotool", "mousemove", str(round(x)), str(round(y))])
        time.sleep(.15)
        run(["xdotool", "click", button])

    def icon(panel_id, widget_id):
        rect = json.loads(evaluate("print(JSON.stringify(panelById(" + str(panel_id) + ").widgetById(" + str(widget_id) + ").geometry))"))
        assert 16 <= rect["width"] <= 80 and abs(rect["width"] - rect["height"]) <= 1, "Panel widget must occupy one square icon: " + str(rect)
        edge = evaluate("print(panelById(" + str(panel_id) + ").location)")
        panel = next(w for w in windows() if w["dock"] and w["resourceClass"] in shell_classes
                     and (w["width"] < w["height"]) == (edge in ["left", "right"]))
        return rect, (panel["x"] + rect["x"] + rect["width"] / 2, panel["y"] + rect["y"] + rect["height"] / 2)

    def opened(point):
        pointer(*point)
        try:
            popup = wait_for(lambda: popups(), "click opens actual account popup")[0]
        except RuntimeError:
            capture("panel-failure")
            raise
        assert 0 <= popup["x"] and popup["x"] + popup["width"] <= 1600
        assert 0 <= popup["y"] and popup["y"] + popup["height"] <= 1100
        return popup

    def closed():
        wait_for(lambda: not popups(), "native popup closes")
        time.sleep(.2)  # Plasma synchronizes expanded after native hide.

    # The private first-run shell may create its default panel asynchronously.
    time.sleep(3)
    evaluate("panels().forEach(p=>p.remove());")
    if UPGRADE:
        # Load the real historical package before upgrading: changing only its
        # metadata cannot exercise Plasma's in-process QML component cache.
        desktop = int(evaluate("print(desktops()[0].addWidget('" + PLUGIN + "').id);"))
        retained = []
        neighbors = []
        for edge in ["bottom", "right"]:
            retained.append(json.loads(evaluate("var p=new Panel; p.location='" + edge + "'; p.height=48; p.floating=false; p.hiding='none';" +
                ("p.addWidget('org.kde.plasma.analogclock');" if LIVE_UPGRADE else "") +
                "var w=p.addWidget('" + PLUGIN + "');" +
                ("p.addWidget('org.kde.plasma.analogclock');" if LIVE_UPGRADE else "") +
                "print(JSON.stringify({panel:p.id,widget:w.id}));")))
        if LIVE_UPGRADE:
            neighbors = json.loads(evaluate("print(JSON.stringify(panels().map(p=>({panel:p.id,widgets:p.widgets().sort((a,b)=>a.geometry[p.location==='right'?'y':'x']-b.geometry[p.location==='right'?'y':'x']).map((w,index)=>({id:w.id,type:w.type,index:index}))}))));"))
        time.sleep(2)
        def panel_geometry(info):
            return json.loads(evaluate("print(JSON.stringify(panelById(" + str(info["panel"]) + ").widgetById(" + str(info["widget"]) + ").geometry))"))
        before = [panel_geometry(info) for info in retained]
        assert all(max(r["width"], r["height"]) >= 300 for r in before), "Historical package must actually load its full panel view"
        snapshot = json.loads(run(["/usr/bin/python3", "-I", str(ROOT / "plasma/contents/code/read_snapshot.py")]))["snapshot"]
        config = {"favorites": [a["id"] for a in snapshot["accounts"][:2]], "view": "favorites", "provider": "all", "scale": 1.15}
        targets = ["desktops()[0].widgetById(" + str(desktop) + ")"] + [
            "panelById(" + str(info["panel"]) + ").widgetById(" + str(info["widget"]) + ")" for info in retained]
        for target in targets:
            evaluate("var w=" + target + "; w.currentConfigGroup=['General'];" +
                     ";".join("w.writeConfig(" + json.dumps(k) + "," + json.dumps(v) + ")" for k, v in config.items()) + ";")
        capture("upgrade-old-package")
        desktop_before = geometry(desktop)
        if LIVE_UPGRADE:
            result = json.loads(run(["node", "test/fixtures/plasma-install.cjs", "--startup"]))
            assert result["panelsReady"] and result.get("success") is not False, "Actual app startup must update and repair existing panels"
            assert shell.poll() is None, "Live update must not restart Plasma"
            assert geometry(desktop) == desktop_before, "Live repair must not replace/resize the desktop instance"
            for i, info in enumerate(retained):
                info["widget"] = int(evaluate("print(panelById(" + str(info["panel"]) + ").widgets().filter(w=>w.type==='" + PLUGIN + "')[0].id);"))
                targets[i + 1] = "panelById(" + str(info["panel"]) + ").widgetById(" + str(info["widget"]) + ")"
            for original in neighbors:
                current = json.loads(evaluate("var p=panelById(" + str(original["panel"]) + ");print(JSON.stringify(p.widgets().sort((a,b)=>a.geometry[p.location==='right'?'y':'x']-b.geometry[p.location==='right'?'y':'x']).map((w,index)=>({id:w.id,type:w.type,index:index}))));"))
                (EVIDENCE / ("panel-order-" + str(original["panel"]) + ".json")).write_text(json.dumps({"before": original, "after": current}, indent=2))
                assert [w["type"] for w in current] == [w["type"] for w in original["widgets"]], "Panel order must survive repair"
                assert [w for w in current if w["type"] != PLUGIN] == [w for w in original["widgets"] if w["type"] != PLUGIN], "Unrelated widgets must retain identity and position"
            unchanged = json.loads(evaluate("print(JSON.stringify(panels().map(p=>p.widgets().map(w=>w.id))));"))
            run(["node", "test/fixtures/plasma-install.cjs", "--startup"])
            assert json.loads(evaluate("print(JSON.stringify(panels().map(p=>p.widgets().map(w=>w.id))));")) == unchanged, "Repeated startup must not replace healthy instances"
            assert (profile / "data/plasma/plasmoids" / PLUGIN).is_symlink(), "New instances must resolve the versioned canonical source"
            # Explicit repair also has to preserve the positions of multiple
            # healthy instances in one panel, including between other widgets.
            horizontal = str(retained[0]["panel"])
            extra = int(evaluate("print(panelById(" + horizontal + ").addWidget('" + PLUGIN + "').id);"))
            time.sleep(.5)
            order_script = "var p=panelById(" + horizontal + ");print(JSON.stringify(p.widgets().sort((a,b)=>a.geometry.x-b.geometry.x).map(w=>w.type)));"
            multi_order = json.loads(evaluate(order_script))
            run(["node", "test/fixtures/plasma-install.cjs"])
            assert json.loads(evaluate(order_script)) == multi_order, "Explicit multi-instance repair must preserve native visual order"
            for i, info in enumerate(retained):
                ids = json.loads(evaluate("print(JSON.stringify(panelById(" + str(info["panel"]) + ").widgets().filter(w=>w.type==='" + PLUGIN + "').map(w=>w.id)));"))
                info["widget"] = ids[0]
                targets[i + 1] = "panelById(" + str(info["panel"]) + ").widgetById(" + str(info["widget"]) + ")"
                if i == 0:
                    assert len(ids) == 2
                    evaluate("panelById(" + horizontal + ").widgetById(" + str(ids[1]) + ").remove();")
        else:
            run(["kpackagetool6", "--type", "Plasma/Applet", "--packageroot", env["XDG_DATA_HOME"] + "/plasma/plasmoids", "--upgrade", str(ROOT / "dist/plasma/llm-usage-dashboard.plasmoid")])
        installed = profile / "data/plasma/plasmoids" / PLUGIN
        assert json.loads((installed / "metadata.json").read_text())["KPlugin"]["Version"] == json.loads((ROOT / "package.json").read_text())["version"]
        assert (installed / "contents/ui/main.qml").read_bytes() == (ROOT / "plasma/contents/ui/main.qml").read_bytes(), "Active per-user source must equal the new package"
        after = [panel_geometry(info) for info in retained]
        if LIVE_UPGRADE:
            assert all(16 <= r["width"] <= 80 and abs(r["width"] - r["height"]) <= 1 for r in after), "Regression: full AccountView must not remain embedded in either live panel"
            for target in targets:
                stored = json.loads(evaluate("var w=" + target + "; w.currentConfigGroup=['General']; print(JSON.stringify({favorites:w.readConfig('favorites'),view:w.readConfig('view'),provider:w.readConfig('provider'),scale:w.readConfig('scale')}));"))
                stored["scale"] = float(stored["scale"])
                if isinstance(stored["favorites"], str):
                    stored["favorites"] = stored["favorites"].split(",")
                assert stored == config, "Live repair must preserve all desktop/panel display preferences: " + str(stored)
            for info in retained:
                rect, point = icon(info["panel"], info["widget"])
                for cycle in range(2):
                    opened(point); pointer(*point); closed()
                    opened(point); run(["xdotool", "key", "Escape"]); closed()
                    opened(point); pointer(800, 550); closed()
                    assert icon(info["panel"], info["widget"])[0] == rect
            capture("upgrade-live-repaired")
        else:
            assert before == after, "Existing QML is retained until the private shell reloads"
        # Also check the commonly suggested remove/re-add within the same shell.
        evaluate("panelById(" + str(retained[0]["panel"]) + ").widgetById(" + str(retained[0]["widget"]) + ").remove();")
        retained[0]["widget"] = int(evaluate("print(panelById(" + str(retained[0]["panel"]) + ").addWidget('" + PLUGIN + "').id);"))
        time.sleep(1)
        readded = panel_geometry(retained[0])
        if LIVE_UPGRADE:
            assert max(readded["width"], readded["height"]) <= 80, "Newly added instance must bypass the old component cache as well"
        else:
            assert max(readded["width"], readded["height"]) >= 300, "Remove/re-add still reuses the old QML component on this Plasma version"
        capture("upgrade-before-reload")
        shell.terminate()
        shell.wait(timeout=15)
        shell = start(["plasmashell", "--no-respawn"], "plasmashell")
        wait_for(lambda: evaluate("print(panels().length)") == "2", "upgrade restores existing panels")
        time.sleep(2)
        restored = [panel_geometry(info) for info in retained]
        assert all(16 <= r["width"] <= 80 and abs(r["width"] - r["height"]) <= 1 for r in restored), "Restored horizontal/vertical panels must use one square icon"
        desktop_size = geometry(desktop)
        assert desktop_size["width"] >= 720 and desktop_size["height"] >= 780, "Existing desktop must keep its large view"
        # The vertical panel and desktop are retained unchanged; the horizontal
        # instance was deliberately removed/re-added and has default settings.
        for target in [targets[0], targets[2]]:
            stored = json.loads(evaluate("var w=" + target + "; w.currentConfigGroup=['General']; print(JSON.stringify({favorites:w.readConfig('favorites'),view:w.readConfig('view'),provider:w.readConfig('provider'),scale:w.readConfig('scale')}));"))
            stored["scale"] = float(stored["scale"])
            if isinstance(stored["favorites"], str):
                stored["favorites"] = stored["favorites"].split(",")
            assert stored == config, "Upgrade/reload must preserve existing desktop/panel preferences"
        for info in retained:
            rect, point = icon(info["panel"], info["widget"])
            opened(point); pointer(*point); closed()
        capture("upgrade-after-reload")
        # Changing the same containment between horizontal and vertical must
        # keep the restored applet compact without requiring another install.
        for edge in ["top", "left", "bottom", "right"]:
            evaluate("panelById(" + str(retained[0]["panel"]) + ").location='" + edge + "';")
            time.sleep(.5)
            icon(retained[0]["panel"], retained[0]["widget"])
        (EVIDENCE / "upgrade-results.json").write_text(json.dumps({"mode": MODE, "before": before, "afterPackageUpgrade": after, "readdedBeforeReload": readded, "restored": restored, "desktop": desktop_size, "realOldPackage": True, "activeSourceVerified": True, "preferencesPreserved": True, "formFactorChanges": True, "liveRepair": LIVE_UPGRADE, "neighborsAndIdempotentStartup": LIVE_UPGRADE}, indent=2))
        evaluate("panels().forEach(p=>p.remove()); desktops()[0].widgetById(" + str(desktop) + ").remove();")

    for edge in (["bottom"] if QUOTA_LABELS else ["bottom", "top", "left", "right"]):
        if edge == "left":
            run(["plasma-apply-colorscheme", "BreezeDark"])
        info = json.loads(evaluate("var p=new Panel; p.location='" + edge + "'; p.height=48; p.floating=false; p.hiding='none'; var w=p.addWidget('" + PLUGIN + "'); print(JSON.stringify({panel:p.id,widget:w.id}));"))
        time.sleep(2)
        rect, point = icon(info["panel"], info["widget"])
        print("Panel QA " + edge + ": " + json.dumps({"icon": rect, "pointer": point}), flush=True)
        for cycle in range(2):
            popup = opened(point)
            time.sleep(.3)  # Compositor discovery can precede the first painted frame.
            capture("panel-" + edge + "-open-" + str(cycle))
            pointer(*point)
            closed()
            opened(point)
            run(["xdotool", "key", "Escape"])
            closed()
            opened(point)
            pointer(800, 550)
            closed()
            stable, point = icon(info["panel"], info["widget"])
            assert stable == rect, "Opening and closing must not grow the panel icon"
            sequence.append({"edge": edge, "cycle": cycle, "icon": rect, "popup": popup})
        # Remove and re-add through the actual containment, then reopen it.
        evaluate("panelById(" + str(info["panel"]) + ").widgetById(" + str(info["widget"]) + ").remove();")
        assert evaluate("print(panelById(" + str(info["panel"]) + ").widgets().length)") == "0"
        info["widget"] = int(evaluate("print(panelById(" + str(info["panel"]) + ").addWidget('" + PLUGIN + "').id);"))
        time.sleep(1)
        _, point = icon(info["panel"], info["widget"])
        opened(point)
        pointer(*point)
        closed()
        if edge != ("bottom" if QUOTA_LABELS else "right"):
            evaluate("panelById(" + str(info["panel"]) + ").remove();")
            time.sleep(1)

    # Persist display preferences and restart only the private shell. This also
    # verifies a fresh Arabic/scaled view after reconnecting to the same bridge.
    update(fixture, localClaude=True, language="ar")
    snapshot = json.loads(run(["/usr/bin/python3", "-I", str(ROOT / "plasma/contents/code/read_snapshot.py")]))["snapshot"]
    favorite = next(a["id"] for a in snapshot["accounts"] if a["provider"] == "claude" and (QUOTA_LABELS or "local" in a["sources"]))
    config = {"favorites": [favorite], "view": "favorites", "provider": "claude", "scale": 1.3}
    evaluate("var w=panelById(" + str(info["panel"]) + ").widgetById(" + str(info["widget"]) + "); w.currentConfigGroup=['General'];" +
             ";".join("w.writeConfig(" + json.dumps(k) + "," + json.dumps(v) + ")" for k, v in config.items()) + ";")
    shell.terminate()
    shell.wait(timeout=15)
    shell = start(["plasmashell", "--no-respawn"], "plasmashell")
    wait_for(lambda: evaluate("print(panels().length)") == "1", "saved panel restoration")
    time.sleep(2)
    stored = json.loads(evaluate("var w=panelById(" + str(info["panel"]) + ").widgetById(" + str(info["widget"]) + "); w.currentConfigGroup=['General']; print(JSON.stringify({favorites:w.readConfig('favorites'),view:w.readConfig('view'),provider:w.readConfig('provider'),scale:w.readConfig('scale')}));"))
    # Plasma's scripting API returns raw KConfig strings; the applet's typed
    # configuration decodes the same values using contents/config/main.xml.
    stored["scale"] = float(stored["scale"])
    if isinstance(stored["favorites"], str):
        stored["favorites"] = stored["favorites"].split(",")
    assert stored == config, "Panel display preferences must survive shell restart: " + str(stored)
    _, point = icon(info["panel"], info["widget"])
    opened(point)
    time.sleep(.5)
    capture("panel-restored-arabic-scaled")
    pointer(*point)
    closed()
    (EVIDENCE / "panel-results.json").write_text(json.dumps({"mode": MODE, "cycles": sequence, "restoredPreferences": True,
                                                           "localClaudeSource": not QUOTA_LABELS, "quotaScopes": QUOTA_LABELS}, indent=2))
    print("Plasma " + MODE + ": " + ("Claude weekly quota labels, bottom panel" if QUOTA_LABELS else "all four panel edges") + "; two click/Escape/outside-close cycles each; square stable icon; native remove/re-add and persisted shell restoration passed.")


try:
    # Refuse a user's existing session bus even if this script is accidentally
    # invoked without its documented wrapper. Both daemon and test must be
    # direct children of the same dbus-run-session process.
    parent_command = Path("/proc", str(os.getppid()), "cmdline").read_bytes().split(b"\0")[0]
    assert Path(os.fsdecode(parent_command)).name == "dbus-run-session", "Run inside a fresh dbus-run-session"
    bus_pid = int(run(["qdbus6", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.GetConnectionUnixProcessID", "org.freedesktop.DBus"]))
    bus_status = Path("/proc", str(bus_pid), "status").read_text()
    assert ("PPid:\t" + str(os.getppid()) + "\n") in bus_status, "Private D-Bus parent mismatch"
    if os.environ.get("PLASMA_QA_PREFLIGHT_ONLY") == "1":
        print("Private session bus guard passed; no desktop started.")
        sys.exit(0)
    Path(env["XDG_CONFIG_HOME"]).mkdir(parents=True)
    (Path(env["XDG_CONFIG_HOME"]) / "plasma-org.kde.plasma.desktop-appletsrc").write_text(
        "[Containments][1]\nactivityId=\nformfactor=0\nimmutability=1\nlastScreen=0\nlocation=0\nplugin=org.kde.desktopcontainment\nwallpaperplugin=org.kde.color\n")
    # Update only this private D-Bus, never the user's systemd environment.
    run(["dbus-update-activation-environment", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "DISPLAY", "QSG_RHI_BACKEND", "XDG_SESSION_TYPE"])
    run(["kpackagetool6", "--type", "Plasma/Applet", "--install", str(Path(UPGRADE).resolve()) if UPGRADE else str(ROOT / "dist/plasma/llm-usage-dashboard.plasmoid")])
    assert PLUGIN in run(["kpackagetool6", "--type", "Plasma/Applet", "--list"])
    # KPackage update is version-aware. Install an older synthetic version first,
    # then upgrade with the exact current archive (no privileged/system paths).
    metadata = profile / "data/plasma/plasmoids" / PLUGIN / "metadata.json"
    if not UPGRADE:
        installed = json.loads(metadata.read_text())
        installed["KPlugin"]["Version"] = "0.0.0"
        metadata.write_text(json.dumps(installed))
        run(["kpackagetool6", "--type", "Plasma/Applet", "--upgrade", str(ROOT / "dist/plasma/llm-usage-dashboard.plasmoid")])
        assert json.loads(metadata.read_text())["KPlugin"]["Version"] == json.loads((ROOT / "package.json").read_text())["version"]
    fixture = start(["node", "test/fixtures/plasma-gpt-lifecycle.mjs" if GPT_LIFECYCLE else "test/fixtures/plasma-bridge.cjs"], "fixture", stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    # Popen pipe is bytes so only this controlled fixture stream gets text mode.
    import io
    fixture.stdin = io.TextIOWrapper(fixture.stdin, encoding="utf8", write_through=True)
    fixture.stdout = io.TextIOWrapper(fixture.stdout, encoding="utf8")
    assert fixture.stdout.readline().strip() == "fixture-ready"
    if PANEL:
        update(fixture, language="de", count=12, quotaLabels=QUOTA_LABELS)
    if MODE == "wayland":
        compositor = start(["kwin_wayland", "--x11-display", env["DISPLAY"], "--width", "1600", "--height", "1100", "--socket", "plasma-test", "--no-lockscreen", "--no-global-shortcuts", "--no-kactivities"], "kwin")
        wait_for(lambda: (profile / "plasma-test").exists(), "nested Wayland compositor")
        env["WAYLAND_DISPLAY"] = "plasma-test"
        env["QT_QPA_PLATFORM"] = "wayland"
    else:
        start(["kwin_x11", "--replace"], "kwin")
    shell = start(["plasmashell", "--no-respawn"], "plasmashell")
    wait_for(lambda: evaluate("print(desktops().length)") != "0", "private Plasma desktop")
    assert evaluate("print(knownWidgetTypes.indexOf('" + PLUGIN + "') >= 0)") == "true", "Add Widgets registry must discover the installed applet"
    (EVIDENCE / "dbus-api.txt").write_text(run(["qdbus6", "org.kde.plasmashell", "/PlasmaShell"]))
    if GPT_LIFECYCLE:
        exercise_gpt(shell, fixture)
    if PANEL:
        if QUOTA_LABELS:
            widget_id = int(evaluate("print(desktops()[0].addWidget('" + PLUGIN + "').id);"))
            time.sleep(3)
            capture("claude-scopes-desktop-german")
            evaluate("desktops()[0].widgetById(" + str(widget_id) + ").remove();")
        exercise_panels(shell, fixture)
    for cycle in range(0 if PANEL or GPT_LIFECYCLE else 2):
        result = evaluate("var d=desktops()[0]; var w=d.addWidget('" + PLUGIN + "'); print(w.id);")
        widget_id = int(result)
        time.sleep(3)
        actual = geometry(widget_id)
        assert actual["width"] >= 720 and actual["height"] >= 780, "Native initial size must fit five accounts"
        capture("desktop-added-" + str(cycle))
        assert str(widget_id) in evaluate("print(desktops()[0].widgets().filter(w=>w.type==='" + PLUGIN + "').map(w=>w.id).join(','))")
        resize(widget_id)
        capture("desktop-resized-" + str(cycle))
        evaluate("var w=desktops()[0].widgetById(" + str(widget_id) + "); w.remove();")
        assert evaluate("print(desktops()[0].widgets().filter(w=>w.type==='" + PLUGIN + "').length)") == "0"
    if not PANEL and not GPT_LIFECYCLE:
        # Leave one normal widget for a final screenshot and verify load logs.
        evaluate("desktops()[0].addWidget('" + PLUGIN + "');")
        time.sleep(3)
        capture("desktop-final")
        run(["plasma-apply-colorscheme", "BreezeDark"])
        time.sleep(1)
        capture("desktop-dark")
    log = (EVIDENCE / "plasmashell.log").read_text()
    for marker in ["Type AccountView unavailable", "Cannot assign", "ReferenceError", "SyntaxError"]:
        assert marker not in log, "Native QML load error: " + marker
    if not PANEL and not GPT_LIFECYCLE:
        print("Plasma " + MODE + ": per-user install/update/discovery; two add/resize/remove cycles; re-add passed. Synthetic evidence: " + str(EVIDENCE.relative_to(ROOT)))
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
    for log in logs:
        log.close()
    # Clean up only services activated on this private bus whose process
    # environment proves they belong to this synthetic runtime.
    try:
        names = run(["qdbus6", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames"]).splitlines()
        for name in names:
            try:
                pid = int(run(["qdbus6", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.GetConnectionUnixProcessID", name]))
                if pid == os.getpid():
                    continue
                context = Path("/proc") / str(pid) / "environ"
                if ("XDG_RUNTIME_DIR=" + str(profile)).encode() in context.read_bytes().split(b"\0"):
                    os.kill(pid, signal.SIGTERM)
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
        time.sleep(1)
    except subprocess.SubprocessError:
        pass
    shutil.rmtree(profile)
