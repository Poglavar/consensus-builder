"""Copy canonical failed URL records into an isolated coverage workspace."""

import hashlib
import json
import os
import fcntl
import tempfile
from pathlib import Path


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _read_record(path):
    if path.is_symlink():
        raise RuntimeError(f"refusing symlink: {path}")
    try:
        data = path.read_bytes()
        value = json.loads(data)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"invalid failed URL record: {path}") from exc
    if not isinstance(value, list):
        raise RuntimeError(f"failed URL record must be a list: {path}")
    return data


def _no_symlink_ancestors(root, path):
    current = Path(root)
    relative = path.relative_to(root)
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            raise RuntimeError(f"refusing symlink: {current}")


def sync_failed_urls(shared_root, target_root):
    """Synchronize canonical failed URL records into *target_root*.

    Only files previously copied by this helper may be removed, and only while
    their target bytes still match the recorded copy.  Returns a small change
    summary suitable for callers and logs.
    """
    shared = Path(shared_root).resolve()
    target = Path(target_root).resolve()
    if shared == target:
        return {"copied": [], "updated": [], "removed": [], "skipped": []}
    source_dir = shared / "world-parcels" / "cities"
    target_dir = target / "world-parcels" / "cities"
    state_dir = target / "tmp"
    lock_dir = shared / "tmp" / "parcel-city-locks"
    state_path = state_dir / "parcel-city-knowledge.json"
    _no_symlink_ancestors(shared, lock_dir)
    _no_symlink_ancestors(target, state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_dir.mkdir(parents=True, exist_ok=True)
    _no_symlink_ancestors(shared, source_dir)
    _no_symlink_ancestors(target, target_dir)
    try:
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
    except (OSError, json.JSONDecodeError):
        raise RuntimeError(f"invalid ownership marker: {state_path}")
    if not isinstance(state, dict):
        raise RuntimeError(f"invalid ownership marker: {state_path}")
    for code, value in state.items():
        if not code.isdigit() or not isinstance(value, dict) or not isinstance(value.get("sha256"), str):
            raise RuntimeError(f"invalid ownership marker entry: {code}")

    sources = {}
    if source_dir.exists():
        if source_dir.is_symlink():
            raise RuntimeError(f"refusing symlink: {source_dir}")
        for city in source_dir.iterdir():
            if city.is_symlink():
                raise RuntimeError(f"refusing symlink: {city}")
            if not city.is_dir() or not city.name.isdigit():
                continue
            record = city / "failed-urls.json"
            if record.exists() or record.is_symlink():
                sources[city.name] = record

    result = {"copied": [], "updated": [], "removed": [], "skipped": []}
    current = {}
    for code, source in sorted(sources.items()):
        lock = lock_dir / f"{code}.lock"
        lock.touch(mode=0o600, exist_ok=True)
        lock_handle = lock.open("r+")
        try:
            try:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError(f"city lock already held: {code}") from exc
            data = _read_record(source)
            destination = target_dir / code / "failed-urls.json"
            _no_symlink_ancestors(target, destination.parent)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.is_symlink():
                raise RuntimeError(f"refusing symlink: {destination}")
            digest = _digest(data)
            old = state.get(code)
            if old and destination.exists() and _digest(destination.read_bytes()) != old["sha256"]:
                raise RuntimeError(f"refusing foreign changed update: {destination}")
            if destination.exists() and destination.read_bytes() == data:
                result["skipped"].append(code)
            else:
                temp_fd, temp_name = tempfile.mkstemp(prefix=f".{code}-", dir=destination.parent)
                try:
                    with os.fdopen(temp_fd, "wb") as handle:
                        handle.write(data)
                        handle.flush()
                        os.fsync(handle.fileno())
                    os.replace(temp_name, destination)
                finally:
                    if os.path.exists(temp_name):
                        os.unlink(temp_name)
                result["updated" if old else "copied"].append(code)
            current[code] = {"sha256": digest}
        finally:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
            lock_handle.close()

    for code, old in state.items():
        if code in current or not isinstance(old, dict) or not isinstance(old.get("sha256"), str):
            continue
        destination = target_dir / code / "failed-urls.json"
        if destination.is_symlink():
            raise RuntimeError(f"refusing symlink: {destination}")
        if destination.exists() and _digest(destination.read_bytes()) != old["sha256"]:
            raise RuntimeError(f"refusing foreign changed removal: {destination}")
        if destination.exists():
            destination.unlink()
            result["removed"].append(code)
    marker_temp = state_path.with_suffix(".tmp")
    marker_temp.write_text(json.dumps(current, sort_keys=True, separators=(",", ":")) + "\n")
    os.replace(marker_temp, state_path)
    return result
