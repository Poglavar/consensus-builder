"""Content-addressed runtime snapshots shared by parcel pipeline job roots."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


SCHEMA_VERSION = 1
_ROOTS = ("scripts", "backend/parcels", "backend/test", "frontend", "world-parcels")
_SKIP_PARTS = {".git", "node_modules", "tmp", "__pycache__", ".cache", ".parcel-shared-runtime"}
_SECRET_NAME = re.compile(
    r"^(?:\.env(?:\..*)?|\.npmrc|\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|"
    r".*(?:credentials?|secrets?|api[-_]?key|service[-_]?account).*|"
    r".*\.(?:pem|key|p12|pfx|kubeconfig))$", re.I)
_process_locks: dict[str, threading.RLock] = {}
_process_locks_guard = threading.Lock()
_lock_state = threading.local()


class RuntimeConflict(RuntimeError):
    pass


class StaleGeneration(RuntimeError):
    pass


def _base(root: Path) -> Path:
    return Path(root) / "tmp" / "parcel-shared-runtime"


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def _sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_bytes(path: Path, value: bytes, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _atomic_json(path: Path, value: Any) -> None:
    _atomic_bytes(path, _canonical(value) + b"\n")


def _atomic_copy(path: Path, source: Path, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as out, source.open("rb") as incoming:
            shutil.copyfileobj(incoming, out, 1024 * 1024)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def runtime_lock(shared_root: Path) -> Iterator[None]:
    """Hold the global runtime lock; calls may be nested in the same thread."""
    key = str(_base(shared_root).resolve())
    with _process_locks_guard:
        process_lock = _process_locks.setdefault(key, threading.RLock())
    with process_lock:
        held = getattr(_lock_state, "held", {})
        depth = held.get(key, 0)
        if depth:
            held[key] = depth + 1
            _lock_state.held = held
            try:
                yield
            finally:
                held[key] -= 1
            return
        lock_path = _base(shared_root) / "runtime.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a+") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            held[key] = 1
            _lock_state.held = held
            try:
                yield
            finally:
                held.pop(key, None)
                fcntl.flock(handle, fcntl.LOCK_UN)


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeConflict(f"invalid runtime metadata: {path.name}")
    return value


def current_runtime(shared_root: Path) -> dict[str, Any]:
    path = _base(shared_root) / "current.json"
    if not path.is_file():
        return {"schemaVersion": SCHEMA_VERSION, "generation": None, "files": {}}
    pointer = _read_json(path)
    generation = pointer.get("generation")
    if not isinstance(generation, str) or not re.fullmatch(r"[0-9a-f]{64}", generation):
        raise RuntimeConflict("invalid current runtime generation")
    manifest_path = _base(shared_root) / "manifests" / f"{generation}.json"
    manifest = _read_json(manifest_path)
    content = {key: manifest[key] for key in ("schemaVersion", "files", "codeGeneration")}
    if manifest.get("generation") != generation or _sha_bytes(_canonical(content)) != generation:
        raise RuntimeConflict("current runtime manifest failed integrity validation")
    return manifest


def _safe_file(path: Path, relative: Path) -> bool:
    if path.is_symlink() or any(part in _SKIP_PARTS for part in relative.parts):
        return False
    if len(relative.parts) >= 2 and relative.parts[:2] == ("world-parcels", "research"):
        return False
    return not _SECRET_NAME.fullmatch(path.name)


def _managed_allowed(relative: str) -> bool:
    parts = Path(relative).parts
    return not (len(parts) >= 2 and parts[:2] == ("world-parcels", "research"))


def _source_files(root: Path) -> Iterator[tuple[str, Path]]:
    root = root.resolve()
    for top_name in _ROOTS:
        top = root / top_name
        if not top.exists() or top.is_symlink():
            continue
        if top.is_file():
            relative = top.relative_to(root)
            if _safe_file(top, relative):
                yield relative.as_posix(), top
            continue
        for directory, names, filenames in os.walk(top, followlinks=False):
            directory_path = Path(directory)
            names[:] = sorted(name for name in names
                              if name not in _SKIP_PARTS and not (directory_path / name).is_symlink()
                              and not _SECRET_NAME.fullmatch(name))
            for name in sorted(filenames):
                path = directory_path / name
                relative = path.relative_to(root)
                if _safe_file(path, relative) and path.is_file():
                    yield relative.as_posix(), path


def _publish_blob(base: Path, source: Path, digest: str) -> None:
    destination = base / "blobs" / digest
    if destination.exists():
        if not destination.is_file() or _sha_file(destination) != digest:
            raise RuntimeConflict(f"runtime blob integrity failure: {digest}")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{digest}.", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as out, source.open("rb") as incoming:
            shutil.copyfileobj(incoming, out, 1024 * 1024)
            out.flush()
            os.fsync(out.fileno())
        if _sha_file(Path(temporary)) != digest:
            raise RuntimeConflict("source changed while publishing runtime")
        try:
            os.link(temporary, destination)
        except FileExistsError:
            if _sha_file(destination) != digest:
                raise RuntimeConflict(f"runtime blob integrity failure: {digest}")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def publish_runtime(shared_root: Path, source_root: Path, *,
                    expected_generation: str | None = None) -> dict[str, Any]:
    """Publish source_root using compare-and-swap against the current generation."""
    source_root = Path(source_root).resolve()
    with runtime_lock(shared_root):
        current = current_runtime(shared_root)
        if current["generation"] != expected_generation:
            raise StaleGeneration(
                f"expected runtime generation {expected_generation!r}, found {current['generation']!r}")
        files: dict[str, dict[str, Any]] = {}
        code_entries = []
        base = _base(shared_root)
        for relative, path in _source_files(source_root):
            digest = _sha_file(path)
            entry = {"sha256": digest, "size": path.stat().st_size,
                     "mode": path.stat().st_mode & 0o777}
            files[relative] = entry
            _publish_blob(base, path, digest)
            if not relative.startswith("world-parcels/"):
                code_entries.append([relative, entry])
        code_generation = _sha_bytes(_canonical(code_entries))
        content = {"schemaVersion": SCHEMA_VERSION, "files": files,
                   "codeGeneration": code_generation}
        generation = _sha_bytes(_canonical(content))
        manifest = {**content, "generation": generation}
        manifest_path = base / "manifests" / f"{generation}.json"
        if not manifest_path.exists():
            _atomic_json(manifest_path, manifest)
        _atomic_json(base / "current.json", {"schemaVersion": SCHEMA_VERSION,
                                              "generation": generation})
        return manifest


def _target_state(path: Path) -> tuple[str, int] | None:
    if not path.exists() and not path.is_symlink():
        return None
    if path.is_symlink() or not path.is_file():
        raise RuntimeConflict(f"managed runtime path is not a regular file: {path.name}")
    return _sha_file(path), path.stat().st_mode & 0o777


def _destination(root: Path, relative: str) -> Path:
    rel = Path(relative)
    if rel.is_absolute() or ".." in rel.parts:
        raise RuntimeConflict(f"unsafe runtime path: {relative}")
    destination = root / rel
    parent = root
    for part in rel.parts[:-1]:
        parent = parent / part
        if parent.is_symlink():
            raise RuntimeConflict(f"runtime path traverses a symlink: {relative}")
    return destination


def runtime_paths(root: Path) -> list[str]:
    """List the safe runtime paths currently present in a job root."""
    return [relative for relative, _ in _source_files(Path(root))]


def _validate_manifest(manifest: dict[str, Any]) -> None:
    try:
        content = {key: manifest[key] for key in ("schemaVersion", "files", "codeGeneration")}
        generation = manifest["generation"]
    except (KeyError, TypeError) as error:
        raise RuntimeConflict("invalid rollback runtime manifest") from error
    if generation != _sha_bytes(_canonical(content)):
        raise RuntimeConflict("rollback runtime manifest failed integrity validation")


def restore_runtime(shared_root: Path, target_root: Path, manifest: dict[str, Any],
                    before_paths: list[str] | tuple[str, ...] | set[str]) -> dict[str, Any]:
    """Restore a pre-transaction manifest and remove paths created by that transaction."""
    target_root = Path(target_root).resolve()
    before = {str(item) for item in before_paths}
    with runtime_lock(shared_root):
        _validate_manifest(manifest)
        restored = []
        for relative, entry in manifest["files"].items():
            if not _managed_allowed(relative):
                continue
            destination = _destination(target_root, relative)
            blob = _base(shared_root) / "blobs" / entry["sha256"]
            if not blob.is_file() or _sha_file(blob) != entry["sha256"]:
                raise RuntimeConflict(f"runtime blob integrity failure: {entry['sha256']}")
            if _target_state(destination) != (entry["sha256"], entry["mode"]):
                _atomic_copy(destination, blob, entry["mode"])
                restored.append(relative)
        removed = []
        for relative in runtime_paths(target_root):
            if relative in before or relative in manifest["files"]:
                continue
            destination = _destination(target_root, relative)
            destination.unlink()
            removed.append(relative)
        state_base = target_root / "tmp" / "parcel-shared-runtime"
        _atomic_json(state_base / "applied.json", {
            "schemaVersion": SCHEMA_VERSION, "generation": manifest["generation"],
            "codeGeneration": manifest["codeGeneration"], "files": manifest["files"]})
        return {"generation": manifest["generation"], "restored": restored, "removed": removed}


def sync_runtime(shared_root: Path, target_root: Path, *, adopt: bool = False) -> dict[str, Any]:
    """Atomically copy changed managed files, refusing unreviewed local overwrites."""
    target_root = Path(target_root).resolve()
    with runtime_lock(shared_root):
        runtime = current_runtime(shared_root)
        if runtime["generation"] is None:
            raise RuntimeConflict("no shared runtime has been published")
        state_base = target_root / "tmp" / "parcel-shared-runtime"
        applied_path = state_base / "applied.json"
        applied = _read_json(applied_path) if applied_path.is_file() else None
        if adopt and applied is not None:
            raise RuntimeConflict("adopt is allowed only for an initial bootstrap")
        marker = state_base / "write-in-progress.json"
        if (applied and applied.get("generation") == runtime["generation"] and not marker.exists()):
            return {"generation": runtime["generation"], "codeGeneration": runtime["codeGeneration"],
                    "written": [], "removed": [], "unchanged": len(runtime["files"]),
                    "backupPath": None, "fastPath": True}
        old_files = applied.get("files", {}) if applied else {}
        desired = runtime["files"]
        writes, removals, backups = [], [], []
        for relative, entry in desired.items():
            destination = _destination(target_root, relative)
            current = _target_state(destination)
            wanted = (entry["sha256"], entry["mode"])
            if current == wanted:
                continue
            previous = old_files.get(relative)
            if previous:
                if current != (previous["sha256"], previous["mode"]):
                    raise RuntimeConflict(f"locally changed managed runtime file: {relative}")
            elif current is not None:
                if not adopt:
                    raise RuntimeConflict(f"bootstrap would overwrite existing file: {relative}")
                backups.append((relative, destination))
            writes.append((relative, destination, entry))
        for relative, previous in old_files.items():
            if relative in desired or not _managed_allowed(relative):
                continue
            destination = _destination(target_root, relative)
            current = _target_state(destination)
            if current is None:
                continue
            if current != (previous["sha256"], previous["mode"]):
                raise RuntimeConflict(f"locally changed managed runtime file blocks removal: {relative}")
            removals.append((relative, destination))
        backup_root = None
        if backups:
            backup_root = state_base / "bootstrap-backups" / runtime["generation"]
            for relative, source in backups:
                backup = backup_root / relative
                backup.parent.mkdir(parents=True, exist_ok=True)
                if backup.exists() and _sha_file(backup) != _sha_file(source):
                    raise RuntimeConflict(f"bootstrap backup collision: {relative}")
                if not backup.exists():
                    shutil.copy2(source, backup, follow_symlinks=False)
        for relative, destination, entry in writes:
            blob = _base(shared_root) / "blobs" / entry["sha256"]
            if not blob.is_file() or _sha_file(blob) != entry["sha256"]:
                raise RuntimeConflict(f"runtime blob integrity failure: {entry['sha256']}")
            _atomic_copy(destination, blob, entry["mode"])
        for _, destination in removals:
            destination.unlink()
        applied_value = {"schemaVersion": SCHEMA_VERSION, "generation": runtime["generation"],
                         "codeGeneration": runtime["codeGeneration"], "files": desired}
        _atomic_json(applied_path, applied_value)
        return {"generation": runtime["generation"], "codeGeneration": runtime["codeGeneration"],
                "written": [item[0] for item in writes], "removed": [item[0] for item in removals],
                "unchanged": len(desired) - len(writes),
                "backupPath": str(backup_root.relative_to(target_root)) if backup_root else None}
