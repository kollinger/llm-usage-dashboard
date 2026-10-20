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

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = "local.llm-usage-dashboard.quotas"
MODE = sys.argv[1] if len(sys.argv) > 1 else "x11"
PANEL = "--panel" in sys.argv
QUOTA_LABELS = "--quota-labels" in sys.argv
EVIDENCE = ROOT / ".cache" / ("quota-labels" if QUOTA_LABELS else "kol-654" if PANEL else "kol-652") / ("plasma-" + MODE)
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
        panel = next(w for w in windows() if w["dock"] and w["resourceClass"] in shell_classes)
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
    run(["kpackagetool6", "--type", "Plasma/Applet", "--install", str(ROOT / "dist/plasma/llm-usage-dashboard.plasmoid")])
    assert PLUGIN in run(["kpackagetool6", "--type", "Plasma/Applet", "--list"])
    # KPackage update is version-aware. Install an older synthetic version first,
    # then upgrade with the exact current archive (no privileged/system paths).
    metadata = profile / "data/plasma/plasmoids" / PLUGIN / "metadata.json"
    installed = json.loads(metadata.read_text())
    installed["KPlugin"]["Version"] = "0.0.0"
    metadata.write_text(json.dumps(installed))
    run(["kpackagetool6", "--type", "Plasma/Applet", "--upgrade", str(ROOT / "dist/plasma/llm-usage-dashboard.plasmoid")])
    assert json.loads(metadata.read_text())["KPlugin"]["Version"] == json.loads((ROOT / "package.json").read_text())["version"]
    fixture = start(["node", "test/fixtures/plasma-bridge.cjs"], "fixture", stdin=subprocess.PIPE, stdout=subprocess.PIPE)
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
    if PANEL:
        if QUOTA_LABELS:
            widget_id = int(evaluate("print(desktops()[0].addWidget('" + PLUGIN + "').id);"))
            time.sleep(3)
            capture("claude-scopes-desktop-german")
            evaluate("desktops()[0].widgetById(" + str(widget_id) + ").remove();")
        exercise_panels(shell, fixture)
    for cycle in range(0 if PANEL else 2):
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
    if not PANEL:
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
    if not PANEL:
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
