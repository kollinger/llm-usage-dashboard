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
EVIDENCE = ROOT / ".cache" / "kol-652" / ("plasma-" + MODE)
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
    log = (EVIDENCE / (name + ".log")).open("w")
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
    before = geometry(widget_id)
    # Enter Plasma's native edit mode, then drag its southeast resize handle.
    run(["qdbus6", "org.kde.plasmashell", "/PlasmaShell", "org.kde.PlasmaShell.editMode", "true"])
    time.sleep(1)
    if MODE == "wayland":
        host_windows = run(["xdotool", "search", "--onlyvisible", "--pid", str(compositor.pid)]).splitlines()
        run(["xdotool", "windowfocus", host_windows[-1]])
    edited = geometry(widget_id)
    run(["xdotool", "mousemove", str(round(edited["x"] + 40)), str(round(edited["y"] + 20)), "click", "1"])
    time.sleep(.5)
    # Plasma scales the whole desktop while editing; Widget.geometry reports
    # mapped coordinates but unscaled dimensions. Derive the scale from x.
    scale = (edited["x"] - 800) / (before["x"] - 800)
    x, y = round(edited["x"] + (edited["width"] + 16) * scale), round(edited["y"] + (edited["height"] + 16) * scale)
    run(["xdotool", "mousemove", str(x), str(y)])
    time.sleep(1)
    capture("resize-handle")
    run(["xdotool", "mousedown", "1"])
    # Multiple real motion events exercise the native drag/constraint path.
    for step in range(1, 11):
        run(["xdotool", "mousemove", str(x - 20 * step), str(y - 20 * step)])
        time.sleep(.03)
    run(["xdotool", "mouseup", "1"])
    time.sleep(1)
    after = geometry(widget_id)
    (EVIDENCE / "resize-dimensions.json").write_text(json.dumps({"before": before, "after": after}, indent=2))
    assert after["width"] < before["width"] - 80 and after["height"] < before["height"] - 80, "Native resize handle must change actual applet dimensions"
    run(["qdbus6", "org.kde.plasmashell", "/PlasmaShell", "org.kde.PlasmaShell.editMode", "false"])


def update(fixture, **values):
    fixture.stdin.write(json.dumps(values) + "\n")
    fixture.stdin.flush()
    assert fixture.stdout.readline().strip() == "fixture-updated"


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
    for cycle in range(2):
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
    # Leave one normal widget for a final screenshot and verify actual load logs.
    evaluate("desktops()[0].addWidget('" + PLUGIN + "');")
    time.sleep(3)
    capture("desktop-final")
    run(["plasma-apply-colorscheme", "BreezeDark"])
    time.sleep(1)
    capture("desktop-dark")
    log = (EVIDENCE / "plasmashell.log").read_text()
    for marker in ["Type AccountView unavailable", "Cannot assign", "ReferenceError", "SyntaxError"]:
        assert marker not in log, "Native QML load error: " + marker
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
