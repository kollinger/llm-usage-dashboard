#!/usr/bin/python3
"""Read only the owner-private desktop projection. Never print paths or errors."""
import json
import os
import socket
import stat

MAX_BYTES = 2 * 1024 * 1024


def private(path, kind):
    info = os.lstat(path)
    return kind(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077


def read_snapshot():
    runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    if not os.path.isabs(runtime) or not private(runtime, stat.S_ISDIR):
        return {"schema": 1, "status": "unavailable"}
    directory = os.path.join(runtime, "llm-usage-dashboard")
    target = os.path.join(directory, "plasma.sock")
    if not private(directory, stat.S_ISDIR) or not private(target, stat.S_ISSOCK):
        return {"schema": 1, "status": "unavailable"}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(92)
        client.connect(target)
        chunks, size = [], 0
        while True:
            chunk = client.recv(min(65536, MAX_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_BYTES:
                raise ValueError("oversize")
    value = json.loads(b"".join(chunks))
    if value.get("schema") != 1 or value.get("status") not in ("ready", "locked", "unavailable"):
        raise ValueError("schema")
    if value["status"] == "ready" and not isinstance(value.get("snapshot", {}).get("accounts"), list):
        raise ValueError("snapshot")
    return value


if __name__ == "__main__":
    try:
        result = read_snapshot()
    except (OSError, ValueError, TypeError, AttributeError):
        result = {"schema": 1, "status": "unavailable"}
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
