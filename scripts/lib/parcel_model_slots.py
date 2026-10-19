"""Small cross-process priority queue for the shared model-call budget."""
from __future__ import annotations

import fcntl
import json
import os
import socket
import subprocess
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Callable

_PROCESS_START = uuid.uuid4().hex
_PRIORITY = {"review": 0, "qualification": 0, "research": 1}


def _pid_start(pid: int) -> str | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat[stat.rfind(")") + 2:].split()[19]
    except (OSError, IndexError):
        try:
            value = subprocess.check_output(
                ["ps", "-o", "lstart=", "-p", str(pid)], text=True,
                stderr=subprocess.DEVNULL).strip()
            return value or None
        except (OSError, subprocess.CalledProcessError):
            return _PROCESS_START if pid == os.getpid() else None


def _alive(ticket: dict) -> bool:
    if ticket.get("host") != socket.gethostname():
        return True
    try:
        pid = int(ticket["ownerPID"])
        os.kill(pid, 0)
    except (KeyError, TypeError, ValueError, ProcessLookupError):
        return False
    except PermissionError:
        return True
    actual = _pid_start(pid)
    return actual is None or str(actual) == str(ticket.get("pidStartIdentity"))


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def _queue_lock(base: Path):
    path = base / "queue.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _queue(base: Path) -> list[tuple[Path, dict]]:
    rows = []
    for path in (base / "queue").glob("*.json"):
        try:
            ticket = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not _alive(ticket):
            path.unlink(missing_ok=True)
        else:
            rows.append((path, ticket))
    return sorted(rows, key=lambda row: (row[1]["priority"], row[1]["queuedAtNs"], row[1]["token"]))


@contextmanager
def acquire_model_slot(shared_root, *, role, limit=4, stop_requested=lambda: False,
                       poll_seconds=0.1, task_id=None, on_wait: Callable[[dict], None] | None = None):
    """Wait fairly for one filesystem-backed slot and hold its flock through the caller's work."""
    if role not in _PRIORITY:
        raise ValueError(f"unknown model-slot role: {role}")
    if type(limit) is not int or limit < 1:
        raise ValueError("model-slot limit must be a positive integer")
    base = Path(shared_root).resolve() / "tmp/parcel-model-slots"
    token = uuid.uuid4().hex
    identity = _pid_start(os.getpid())
    if identity is None:
        raise RuntimeError("cannot identify model-slot owner process")
    ticket = {"token": token, "role": role, "priority": _PRIORITY[role],
              "queuedAtNs": time.time_ns(), "ownerPID": os.getpid(),
              "pidStartIdentity": identity, "host": socket.gethostname(), "taskId": task_id}
    ticket_path = base / "queue" / f"{token}.json"
    slot_handle = None
    slot = None
    with _queue_lock(base):
        _atomic_json(ticket_path, ticket)
    try:
        while slot_handle is None:
            if stop_requested():
                raise InterruptedError("model-slot wait stopped")
            waiting = None
            with _queue_lock(base):
                rows = _queue(base)
                position = next((i for i, (path, _) in enumerate(rows) if path == ticket_path), None)
                if position is None:
                    raise RuntimeError("model-slot queue ticket was lost")
                if position == 0:
                    for candidate in range(limit):
                        handle = (base / f"slot-{candidate}.lock").open("a+")
                        try:
                            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        except BlockingIOError:
                            handle.close()
                            continue
                        slot_handle, slot = handle, candidate
                        ticket_path.unlink()
                        owner = {**ticket, "slot": slot, "acquiredAt": time.time()}
                        handle.seek(0)
                        handle.truncate()
                        handle.write(json.dumps(owner, separators=(",", ":")) + "\n")
                        handle.flush()
                        os.fsync(handle.fileno())
                        break
                if slot_handle is None:
                    waiting = {"status": "waiting-model-slot", "role": role, "taskId": task_id,
                               "position": position + 1, "queued": len(rows), "limit": limit}
            if slot_handle is None:
                if on_wait:
                    on_wait(waiting)
                time.sleep(max(0.001, float(poll_seconds)))
        yield {"slot": slot, "role": role, "taskId": task_id, "limit": limit,
               "ownerPID": os.getpid(), "pidStartIdentity": identity}
    finally:
        with _queue_lock(base):
            ticket_path.unlink(missing_ok=True)
        if slot_handle is not None:
            fcntl.flock(slot_handle, fcntl.LOCK_UN)
            slot_handle.close()
