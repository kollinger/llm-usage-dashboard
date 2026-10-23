#!/usr/bin/python3
"""Start the owner-registered installed app without a shell or provider data."""
import json
import os
import stat
import subprocess


def open_dashboard():
    data_home = os.environ.get("XDG_DATA_HOME", "")
    if not os.path.isabs(data_home):
        data_home = os.path.expanduser("~/.local/share")
    directory = os.path.join(data_home, "llm-usage-dashboard")
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("private_directory")
    descriptor = os.open(os.path.join(directory, "launcher.json"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 16384:
            raise ValueError("private_file")
        value = json.loads(stream.read(16385))
    executable = value.get("executable")
    if value.get("schema") != 1 or not isinstance(executable, str) or not os.path.isabs(executable) or "\0" in executable:
        raise ValueError("launcher")
    if not stat.S_ISREG(os.stat(executable).st_mode) or not os.access(executable, os.X_OK):
        raise ValueError("executable")
    # No --background: Electron's existing single-instance handler shows/focuses
    # the main window, or queues that request while the first instance starts.
    child = subprocess.Popen([executable], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)
    try:
        if child.wait(timeout=0.75) != 0:
            return "failed"
    except subprocess.TimeoutExpired:
        pass
    return "started"


if __name__ == "__main__":
    try:
        status = open_dashboard()
    except FileNotFoundError:
        status = "missing"
    except (OSError, ValueError, TypeError, AttributeError):
        status = "failed"
    # Never return executable paths, exception text or child process output.
    print(json.dumps({"schema": 1, "status": status}, separators=(",", ":")))
