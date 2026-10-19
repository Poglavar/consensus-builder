"""Bound qualification checkpoint growth by externalizing historical base snapshots."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any


_LIVE_STATUSES = {"running", "ready-isolated"}


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


@contextmanager
def _lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def _store(path: Path, payload: bytes) -> None:
    digest = hashlib.sha256(payload).hexdigest()
    if path.exists():
        existing = path.read_bytes()
        if hashlib.sha256(existing).hexdigest() != digest or existing != payload:
            raise ValueError(f"base snapshot sidecar hash mismatch: {path.name}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _workspace(record: Any) -> dict[str, Any] | None:
    if not isinstance(record, dict):
        return None
    isolation = record.get("isolation")
    if not isinstance(isolation, dict):
        return None
    workspace = isolation.get("workspace")
    return workspace if isinstance(workspace, dict) else None


def compact_city_histories(root: Path, state_dir: Path, cities: dict[str, Any]) -> None:
    """Replace non-live inline base snapshots with immutable content-addressed refs."""
    root = Path(root).resolve()
    state_dir = Path(state_dir)
    state_dir = (root / state_dir).resolve() if not state_dir.is_absolute() else state_dir.resolve()
    state_dir.relative_to(root)
    if not isinstance(cities, dict):
        raise ValueError("cities must be an object")
    sidecars = state_dir / "qualification-workspaces" / "base-snapshots"
    planned: list[tuple[dict[str, Any], dict[str, Any], Path, bytes]] = []
    for city in cities.values():
        if not isinstance(city, dict):
            continue
        records = [item for item in city.get("qualificationHistory", []) if isinstance(item, dict)]
        current = city.get("qualification")
        if isinstance(current, dict) and current.get("status") not in _LIVE_STATUSES:
            records.append(current)
        for record in records:
            workspace = _workspace(record)
            snapshot = workspace.get("baseSnapshot") if workspace else None
            if not isinstance(snapshot, dict):
                continue
            payload = _canonical(snapshot)
            digest = hashlib.sha256(payload).hexdigest()
            path = sidecars / f"{digest}.json"
            ref = {"path": path.relative_to(root).as_posix(), "sha256": digest,
                   "entries": len(snapshot)}
            planned.append((workspace, ref, path, payload))
    with _lock(sidecars / ".lock"):
        unique: dict[Path, bytes] = {}
        for _, _, path, payload in planned:
            previous = unique.setdefault(path, payload)
            if previous != payload:
                raise ValueError("base snapshot SHA-256 collision")
        for path, payload in unique.items():
            _store(path, payload)
        for workspace, ref, _, _ in planned:
            workspace.pop("baseSnapshot")
            workspace["baseSnapshotRef"] = ref
