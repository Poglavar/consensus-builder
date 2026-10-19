"""Two persistent, isolated Git workspaces for parallel parcel qualification."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import uuid
import copy
from pathlib import Path
from typing import Any

MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024
SLOT_IDS = {1, 2}


def _load_script(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load support script: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(command: list[str], *, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{result.stderr.strip()}")
    return result


def _git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return _run(["git", *args], cwd=root, check=check)


def _safe_component(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", value).strip("-_")
    if not safe:
        raise ValueError("workspace identity must contain a safe name")
    return safe[:80]


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temp.open("w", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    dir_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _read_nul_paths(raw: bytes) -> list[str]:
    return [item.decode("utf-8", "surrogateescape") for item in raw.split(b"\0") if item]


def _adapter_build(root: Path):
    return _load_script(root / "scripts/run-parcel-adapter-build.py", "_qualification_workspace_build")


def _stage(root: Path):
    return _load_script(root / "scripts/lib/parcel_source_stage.py", "_qualification_workspace_stage")


def _snapshot(root: Path) -> dict[str, str | None]:
    build = _adapter_build(root)
    return build.worktree_snapshot(root)


def _head(root: Path) -> str:
    return _git(root, "rev-parse", "HEAD").stdout.strip()


def _tracked_paths(root: Path, revision: str = "HEAD") -> set[str]:
    raw = _git(root, "ls-tree", "-r", "--name-only", "-z", revision).stdout.encode()
    return set(_read_nul_paths(raw))


def _untracked_paths(root: Path, *, ignored: bool = False) -> set[str]:
    args = ["ls-files", "--others"]
    if ignored:
        args.append("--ignored")
    args.extend(["--exclude-standard", "-z"])
    raw = _git(root, *args).stdout.encode()
    return set(_read_nul_paths(raw))


def _sensitive_path(rel: str) -> bool:
    parts = Path(rel).parts
    lower = [part.casefold() for part in parts]
    name = lower[-1] if lower else ""
    return (any(part in {".aws", ".ssh", "credentials", "secrets"} for part in lower)
            or name == ".env" or name.startswith(".env.")
            or name in {"id_rsa", "id_ed25519"}
            or name.endswith((".pem", ".key", ".p12", ".pfx")))


def _is_allowed_untracked(rel: str) -> bool:
    return rel.startswith(("backend/parcels/", "backend/test/"))


def _parent_overlay_paths(root: Path) -> tuple[set[str], set[str]]:
    tracked = set(_read_nul_paths(_git(root, "diff", "--no-renames", "--name-only", "-z", "HEAD").stdout.encode()))
    untracked = {rel for rel in _untracked_paths(root) if _is_allowed_untracked(rel)}
    return tracked, untracked


def _ignored_inventory(root: Path) -> set[str]:
    return _untracked_paths(root, ignored=True)


def _ignored_snapshot(root: Path) -> dict[str, str]:
    snapshot = {}
    for rel in _ignored_inventory(root):
        path = root / rel
        if path.is_symlink():
            payload = os.fsencode(os.readlink(path))
        elif path.is_file():
            payload = path.read_bytes()
        else:
            continue
        snapshot[rel] = _sha(payload)
    return snapshot


def _check_path_overlap(paths: set[str], ignored: set[str]) -> None:
    for path in paths:
        for private in ignored:
            if (path == private or path.startswith(private + "/") or private.startswith(path + "/")):
                raise RuntimeError(f"operation would overwrite or remove ignored private path: {private}")


def _remove_path(root: Path, rel: str, *, preserve_ignored: bool = True) -> None:
    path = root / rel
    if not path.exists() and not path.is_symlink():
        return
    if preserve_ignored and rel in _ignored_inventory(root):
        return
    if path.is_dir() and not path.is_symlink():
        raise RuntimeError(f"refusing to recursively remove workspace directory: {rel}")
    path.unlink()


def _copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        if destination.exists() or destination.is_symlink():
            destination.unlink()
        destination.symlink_to(os.readlink(source))
    else:
        shutil.copy2(source, destination)


def _apply_parent_overlay(parent: Path, child: Path, tracked: set[str], untracked: set[str]) -> None:
    ignored = _ignored_inventory(child)
    _check_path_overlap(tracked, ignored)
    _check_path_overlap(untracked, ignored)
    for rel in sorted(tracked):
        if _sensitive_path(rel):
            continue
        source = parent / rel
        destination = child / rel
        if source.exists() or source.is_symlink():
            if destination.exists() or destination.is_symlink():
                if rel in ignored:
                    raise RuntimeError(f"parent overlay would replace ignored private path: {rel}")
                if destination.is_dir() and not destination.is_symlink():
                    raise RuntimeError(f"parent overlay encountered a directory collision: {rel}")
                destination.unlink()
            _copy_file(source, destination)
        else:
            _remove_path(child, rel)
    for rel in sorted(untracked):
        if _sensitive_path(rel):
            continue
        source, destination = parent / rel, child / rel
        if not source.is_file() and not source.is_symlink():
            raise RuntimeError(f"allowed parent untracked path is not a file: {rel}")
        if destination.exists() or destination.is_symlink():
            if rel in ignored:
                raise RuntimeError(f"parent overlay would replace ignored private path: {rel}")
            if destination.is_dir() and not destination.is_symlink():
                raise RuntimeError(f"parent overlay encountered a directory collision: {rel}")
            destination.unlink()
        _copy_file(source, destination)


def _input_paths(hashes: dict[str, Any]) -> set[str]:
    paths = {hashes["packetPath"], hashes["reviewPath"]}
    paths.update(hashes.get("sampleFiles", {}).keys())
    paths.update(hashes.get("receiptEvidenceFiles", {}).keys())
    paths.update(hashes.get("coverageProbeEvidenceFiles", {}).keys())
    return paths


def _check_inputs(parent: Path, child: Path, paths: set[str], owned: dict[str, str]) -> dict[str, str]:
    """Identify only unchanged, runner-owned ignored copies that need refreshing."""
    ignored = _ignored_inventory(child)
    replacements = {}
    for rel in sorted(paths):
        raw = Path(rel)
        if raw.is_absolute() or ".." in raw.parts or not raw.parts or _sensitive_path(rel):
            raise ValueError(f"qualification input path is unsafe: {rel}")
        source, destination = parent / raw, child / raw
        for root in (parent, child):
            if any((root / Path(*raw.parts[:index])).is_symlink() for index in range(1, len(raw.parts) + 1)):
                raise RuntimeError(f"qualification input cannot follow a symlink: {rel}")
        if not source.is_file():
            raise ValueError(f"qualification input is missing: {rel}")
        if destination.exists() and not destination.is_file():
            raise RuntimeError(f"qualification input collides with a directory: {rel}")
        if rel in ignored:
            digest = _sha(destination.read_bytes())
            if digest == _sha(source.read_bytes()):
                continue
            if owned.get(rel) != digest:
                raise RuntimeError(f"qualification input conflicts with ignored private data: {rel}")
            replacements[rel] = digest
    return replacements


def _copy_inputs(parent: Path, child: Path, paths: set[str], owned: dict[str, str], history: Path) -> dict[str, str]:
    replacements = _check_inputs(parent, child, paths, owned)
    if replacements:
        entries = []
        for rel, digest in sorted(replacements.items()):
            stored_rel = f"files/{rel}"
            _copy_file(child / rel, history / stored_rel)
            with (history / stored_rel).open("rb") as stream:
                os.fsync(stream.fileno())
            entries.append({"path": rel, "kind": "file", "storedPath": stored_rel, "sha256": digest})
        manifest = {"entries": entries}
        _json_write(history / "manifest.json", manifest)
        _verify_archive(history, manifest)
    copied = dict(owned)
    for rel in sorted(paths):
        source, destination = parent / rel, child / rel
        if rel in replacements and _sha(destination.read_bytes()) != replacements[rel]:
            raise RuntimeError(f"qualification input changed during backup: {rel}")
        # Even equal bytes need the current source mtime for seed provenance checks.
        if destination.exists() or destination.is_symlink():
            destination.unlink()
        _copy_file(source, destination)
        digest = _sha(destination.read_bytes())
        if digest != _sha(source.read_bytes()):
            raise IOError(f"qualification input copy verification failed: {rel}")
        if destination.stat().st_mtime_ns != source.stat().st_mtime_ns:
            raise IOError(f"qualification input copy did not preserve mtime: {rel}")
        copied[rel] = digest
    return copied


def _remap_value(value: Any, parent: Path, child: Path) -> Any:
    if isinstance(value, Path):
        return _remap_value(str(value), parent, child)
    if isinstance(value, str):
        candidate = Path(value)
        if candidate.is_absolute():
            try:
                rel = candidate.resolve().relative_to(parent.resolve())
                return str(child / rel)
            except ValueError:
                return value
        return value
    if isinstance(value, dict):
        return {key: _remap_value(item, parent, child) for key, item in value.items()}
    if isinstance(value, list):
        return [_remap_value(item, parent, child) for item in value]
    if isinstance(value, tuple):
        return tuple(_remap_value(item, parent, child) for item in value)
    return value


def _archive_changes(root: Path, state_dir: Path, run_id: str) -> dict[str, Any]:
    history = state_dir / "qualification-workspaces/history" / run_id
    snapshot = _snapshot(root)
    tracked_changes = set(_read_nul_paths(_git(root, "diff", "--no-renames", "--name-only", "-z", "HEAD").stdout.encode()))
    untracked = _untracked_paths(root)
    if history.exists():
        # A failed preparation can leave a complete backup before any reset.
        manifest = _read_metadata(history / "manifest.json")
        _verify_archive(history, manifest)
        expected = {entry["path"]: entry["sha256"] for entry in manifest["entries"]}
        actual = {rel: _sha(os.fsencode(os.readlink(root / rel))) if (root / rel).is_symlink()
                  else snapshot.get(rel) for rel in tracked_changes | untracked}
        if manifest.get("runId") != run_id or manifest.get("root") != str(root) or expected != actual:
            raise RuntimeError("workspace history differs from current changes; refusing reuse")
        return manifest
    history.mkdir(parents=True)
    entries: list[dict[str, Any]] = []
    for rel in sorted(tracked_changes | untracked):
        if rel not in snapshot or snapshot[rel] is None:
            entries.append({"path": rel, "kind": "deleted", "sha256": None})
            continue
        path = root / rel
        if path.is_symlink():
            target = os.readlink(path)
            entries.append({"path": rel, "kind": "symlink", "target": target,
                            "sha256": _sha(os.fsencode(target))})
        elif path.is_file():
            content = path.read_bytes()
            stored_rel = f"files/{rel}"
            stored_path = history / stored_rel
            stored_path.parent.mkdir(parents=True, exist_ok=True)
            with stored_path.open("wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            entries.append({"path": rel, "kind": "file", "storedPath": stored_rel,
                            "sha256": _sha(content), "mode": path.stat().st_mode & 0o777})
        else:
            raise RuntimeError(f"cannot archive non-file workspace change: {rel}")
    manifest = {"runId": run_id, "root": str(root), "entries": entries}
    _json_write(history / "manifest.json", manifest)
    _verify_archive(history, manifest)
    return manifest


def _verify_archive(history: Path, manifest: dict[str, Any]) -> None:
    for entry in manifest["entries"]:
        kind = entry["kind"]
        if kind == "file":
            stored = (history / entry["storedPath"]).resolve()
            stored.relative_to(history.resolve())
            if not stored.is_file() or _sha(stored.read_bytes()) != entry["sha256"]:
                raise IOError(f"workspace history backup failed verification: {entry['path']}")
        elif kind == "symlink":
            if _sha(os.fsencode(entry["target"])) != entry["sha256"]:
                raise IOError(f"workspace symlink history backup failed verification: {entry['path']}")
        elif kind != "deleted" or entry.get("sha256") is not None:
            raise IOError(f"invalid deletion marker in workspace history: {entry['path']}")


def _remove_archived_untracked(root: Path, manifest: dict[str, Any]) -> None:
    untracked = _untracked_paths(root)
    archived = {entry["path"] for entry in manifest["entries"]}
    for rel in sorted(untracked):
        if rel not in archived:
            raise RuntimeError(f"untracked workspace file was not archived: {rel}")
        path = root / rel
        if path.is_symlink() or path.is_file():
            path.unlink()
        else:
            raise RuntimeError(f"refusing to remove non-file untracked path: {rel}")
    # Remove only now-empty directories; ignored data prevents rmdir and is preserved.
    dirs = sorted({parent for rel in untracked for parent in (root / rel).parents if root in parent.parents},
                  key=lambda p: len(p.parts), reverse=True)
    for directory in dirs:
        try:
            directory.rmdir()
        except OSError:
            pass


def _ensure_node_modules(parent: Path, child: Path) -> None:
    source = parent / "backend/node_modules"
    target = child / "backend/node_modules"
    if not source.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink():
        if target.resolve() != source.resolve():
            raise RuntimeError("workspace backend/node_modules symlink points somewhere unexpected")
        return
    if target.exists():
        raise RuntimeError("workspace backend/node_modules exists and is not the approved symlink")
    target.symlink_to(source.resolve(), target_is_directory=True)


def _write_metadata(path: Path, metadata: dict[str, Any]) -> None:
    _json_write(path, metadata)


def _read_metadata(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"invalid qualification workspace metadata: {path}")
    return value


def prepare_workspace(root: Path, state_dir: Path, slot: int, city: dict[str, Any],
                      receipt: dict[str, Any], packet: dict[str, Any]) -> dict[str, Any]:
    """Prepare one persistent private worktree and copy the exact reviewed input set."""
    root = Path(root).resolve()
    state_dir = Path(state_dir)
    state_dir = (root / state_dir).resolve() if not state_dir.is_absolute() else state_dir.resolve()
    if slot not in SLOT_IDS:
        raise ValueError("qualification workspace slot must be 1 or 2")
    top = Path(_git(root, "rev-parse", "--show-toplevel").stdout.strip()).resolve()
    if top != root:
        raise ValueError("workspace root must be the Git repository root")
    state_probe = state_dir
    while not state_probe.exists() and state_probe != state_probe.parent:
        state_probe = state_probe.parent
    if min(shutil.disk_usage(root.parent).free, shutil.disk_usage(state_probe).free) < MIN_FREE_BYTES:
        raise OSError("at least 2 GB free disk space is required for a qualification workspace")

    identity = _safe_component(f"{root.name}-{state_dir.name}")
    parent_dir = root.parent
    branch = f"qualification-{identity}-slot-{slot}"
    child = parent_dir / f"{root.name}-{branch}"
    metadata_path = state_dir / "qualification-workspaces" / f"slot-{slot}.json"
    parent_head = _head(root)
    stage = _stage(root)
    parent_hashes = stage._input_hashes(root, city, receipt, packet)
    inputs = _input_paths(parent_hashes)
    tracked_overlay, untracked_overlay = _parent_overlay_paths(root)
    run_id = uuid.uuid4().hex
    owned_inputs = {}

    if metadata_path.exists():
        metadata = _read_metadata(metadata_path)
        if (metadata.get("slot") != slot or metadata.get("branch") != branch
                or Path(metadata.get("root", "")).resolve() != child.resolve()):
            raise RuntimeError("qualification workspace metadata identity mismatch")
        if not child.is_dir():
            raise RuntimeError("persistent qualification worktree is missing; refusing to recreate it")
        if metadata.get("status") != "finished" or not isinstance(metadata.get("finishSnapshot"), dict):
            raise RuntimeError("previous qualification workspace run was not finished before reuse")
        if _head(child) != metadata.get("finishHead"):
            raise RuntimeError("qualification worktree HEAD changed outside the completed run")
        actual = _snapshot(child)
        if actual != metadata["finishSnapshot"]:
            raise RuntimeError("qualification worktree changed after finish; refusing to overwrite foreign drift")

        owned_inputs = metadata.get("inputCopies", {})
        _check_inputs(root, child, inputs, owned_inputs)
        ignored = _ignored_inventory(child)
        ignored_before = _ignored_snapshot(child)
        parent_paths = tracked_overlay | untracked_overlay | _tracked_paths(root, parent_head)
        _check_path_overlap(parent_paths, ignored)
        manifest = _archive_changes(child, state_dir, metadata["runId"])
        _remove_archived_untracked(child, manifest)
        _git(child, "reset", "--hard", parent_head)
        ignored_after = _ignored_snapshot(child)
        if any(ignored_after.get(path) != digest for path, digest in ignored_before.items()):
            raise RuntimeError("Git reset changed ignored private files; refusing workspace reuse")
        _apply_parent_overlay(root, child, tracked_overlay, untracked_overlay)
    else:
        if child.exists():
            raise RuntimeError("qualification worktree path exists without owned metadata; refusing reuse")
        branch_ref = _git(root, "show-ref", "--verify", f"refs/heads/{branch}", check=False)
        if branch_ref.returncode == 0:
            raise RuntimeError("qualification worktree branch exists without owned metadata; refusing reuse")
        _git(root, "worktree", "add", "-b", branch, str(child), parent_head)
        _apply_parent_overlay(root, child, tracked_overlay, untracked_overlay)

    owned_inputs = _copy_inputs(root, child, inputs, owned_inputs,
                                state_dir / "qualification-workspaces/input-history" / run_id)
    _ensure_node_modules(root, child)
    worker_state = child / "tmp/parcel-qualification-jobs" / run_id
    worker_state.mkdir(parents=True, exist_ok=False)
    child_city = _remap_value(city, root, child)
    child_receipt = copy.deepcopy(receipt)
    child_packet = _remap_value(packet, root, child)
    if stage._input_hashes(child, child_city, child_receipt, child_packet) != parent_hashes:
        raise RuntimeError("isolated qualification inputs differ from their reviewed parent evidence")
    snapshot_after_prepare = _snapshot(child)
    metadata = {"schemaVersion": 1, "slot": slot, "root": str(child), "branch": branch,
                "status": "prepared", "runId": run_id, "parentHead": parent_head,
                "preparedSnapshot": snapshot_after_prepare, "metadataPath": str(metadata_path),
                "inputCopies": owned_inputs}
    _write_metadata(metadata_path, metadata)
    return {"root": child, "stateDir": worker_state, "city": child_city, "receipt": child_receipt,
            "packet": child_packet, "baseSnapshot": snapshot_after_prepare,
            "baseBackendAdapters": _backend_adapter_hashes(child),
            "parentInputHashes": parent_hashes, "runId": run_id, "slot": slot,
            "metadataPath": metadata_path}


def _backend_adapter_hashes(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    adapter_root = root / "backend/parcels"
    if not adapter_root.is_dir():
        return result
    for path in sorted(adapter_root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"backend adapter source cannot be a symlink: {path}")
        if path.is_file() and path.name != "source-catalog.json":
            result[path.relative_to(root).as_posix()] = _sha(path.read_bytes())
    return result


def finish_workspace(workspace: dict[str, Any]) -> None:
    """Persist the last safe snapshot so only verified owned edits are archived on reuse."""
    root = Path(workspace["root"]).resolve()
    state_dir = Path(workspace["stateDir"]).resolve()
    metadata_path = Path(workspace["metadataPath"]).resolve()
    metadata = _read_metadata(metadata_path)
    if (metadata.get("status") not in {"prepared", "finished"} or metadata.get("runId") != workspace.get("runId")
            or metadata.get("slot") != workspace.get("slot") or Path(metadata.get("root", "")).resolve() != root):
        raise RuntimeError("qualification workspace finish identity mismatch")
    if metadata.get("status") == "finished":
        if _head(root) != metadata.get("finishHead") or _snapshot(root) != metadata.get("finishSnapshot"):
            raise RuntimeError("qualification workspace changed after finish; refusing recovery")
        return
    if _head(root) != metadata.get("parentHead"):
        raise RuntimeError("qualification worker changed its private worktree HEAD")
    metadata["finishSnapshot"] = _snapshot(root)
    metadata["finishHead"] = _head(root)
    metadata["status"] = "finished"
    _write_metadata(metadata_path, metadata)
