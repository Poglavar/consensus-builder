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
    # Loading scripts from a worktree must not leave ignored __pycache__ files there;
    # only the generated tmp state and the approved node_modules link may be discarded.
    exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)
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
            or name.startswith(".env") or name.endswith(".env")
            or any(marker in name for marker in ("credential", "secret", "password", "access_token", "api_key"))
            or name in {"id_rsa", "id_ed25519"}
            or name.endswith((".pem", ".key", ".p12", ".pfx")))


def _is_allowed_untracked(rel: str) -> bool:
    return rel.startswith(("backend/parcels/", "backend/test/"))


def _matches_revision(root: Path, rel: str, revision: str) -> bool:
    path = root / rel
    if not path.is_file() or path.is_symlink():
        return False
    blob = _git(root, "rev-parse", f"{revision}:{rel}", check=False)
    if blob.returncode:
        return False
    actual = _git(root, "hash-object", "--", rel, check=False)
    if actual.returncode or actual.stdout.strip() != blob.stdout.strip():
        return False
    tree = _git(root, "ls-tree", revision, "--", rel, check=False).stdout.split()
    if not tree:
        return False
    expected_executable = tree[0] == "100755"
    return bool(path.stat().st_mode & 0o111) == expected_executable


def _parent_overlay_paths(root: Path, base_revision: str = "HEAD") -> tuple[set[str], set[str]]:
    tracked = set(_read_nul_paths(_git(
        root, "diff", "--no-renames", "--name-only", "-z", base_revision).stdout.encode()))
    tracked = {rel for rel in tracked if not _matches_revision(root, rel, base_revision)}
    base_tracked = _tracked_paths(root, base_revision)
    applied = root / "tmp/parcel-shared-runtime/applied.json"
    published = set(json.loads(applied.read_text()).get("files", {})) if applied.is_file() else set()
    untracked = {rel for rel in _untracked_paths(root) - base_tracked
                 if _is_allowed_untracked(rel) or rel in published}
    return tracked, untracked


def _resolve_base_revision(root: Path, revision: str | None, parent_head: str) -> str:
    if revision is None:
        return parent_head
    if not isinstance(revision, str) or not revision.strip():
        raise ValueError("qualification base revision must be a non-empty Git revision")
    resolved = _git(root, "rev-parse", "--verify", f"{revision.strip()}^{{commit}}", check=False)
    if resolved.returncode or not re.fullmatch(r"[0-9a-f]{40,64}", resolved.stdout.strip()):
        raise ValueError("qualification base revision is not a commit in this Git repository")
    return resolved.stdout.strip()


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
    paths.update(hashes.get("integrationInputs", {}).keys())
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


def _copy_inputs(parent: Path, child: Path, paths: set[str], owned: dict[str, str]) -> dict[str, str]:
    replacements = _check_inputs(parent, child, paths, owned)
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


def _ensure_node_modules(parent: Path, child: Path) -> None:
    for relative in ("backend/node_modules", "e2e/node_modules"):
        source, target = parent / relative, child / relative
        if not source.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink():
            if target.resolve() != source.resolve():
                raise RuntimeError(f"workspace {relative} symlink points somewhere unexpected")
            continue
        if target.exists():
            raise RuntimeError(f"workspace {relative} exists and is not the approved symlink")
        target.symlink_to(source.resolve(), target_is_directory=True)


def _write_metadata(path: Path, metadata: dict[str, Any]) -> None:
    _json_write(path, metadata)


def _read_metadata(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"invalid qualification workspace metadata: {path}")
    return value


def prepare_workspace(root: Path, state_dir: Path, slot: int, city: dict[str, Any],
                      receipt: dict[str, Any], packet: dict[str, Any],
                      base_revision: str | None = None) -> dict[str, Any]:
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
    parent_head = _resolve_base_revision(root, base_revision, _head(root))
    stage = _stage(root)
    parent_hashes = stage._input_hashes(root, city, receipt, packet)
    inputs = _input_paths(parent_hashes)
    tracked_overlay, untracked_overlay = _parent_overlay_paths(root, parent_head)
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
        # Imported worker changes belong to the parent workflow. Reuse resets the
        # finished worktree without creating a permanent rescue archive.
        _git(child, "clean", "-fd")
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

    owned_inputs = _copy_inputs(root, child, inputs, owned_inputs)
    _ensure_node_modules(root, child)
    from parcel_city_knowledge import sync_failed_urls
    sync_failed_urls(root, child)
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
            "branch": branch, "metadataPath": metadata_path}


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


def reopen_workspace(workspace: dict[str, Any]) -> None:
    """Continue the same verified owned city task after an integration failure."""
    finish_workspace(workspace)
    path = Path(workspace["metadataPath"])
    metadata = _read_metadata(path)
    metadata["status"] = "prepared"
    _write_metadata(path, metadata)


def discard_workspace(workspace: dict[str, Any]) -> None:
    """Remove a collected qualification worktree after validating ownership and local data."""
    root = Path(workspace["root"]).resolve()
    metadata_path = Path(workspace["metadataPath"]).resolve()
    slot = workspace.get("slot")
    run_id = workspace.get("runId")
    branch = workspace.get("branch")
    if slot not in SLOT_IDS or metadata_path.name != f"slot-{slot}.json":
        raise RuntimeError("qualification workspace discard identity mismatch")
    metadata = _read_metadata(metadata_path)
    metadata_branch = metadata.get("branch")
    if branch is not None and branch != metadata_branch:
        raise RuntimeError("qualification workspace discard identity mismatch")
    branch = metadata_branch
    if (metadata.get("status") != "finished" or metadata.get("slot") != slot
            or metadata.get("runId") != run_id or not isinstance(branch, str)
            or not re.fullmatch(r"qualification-[A-Za-z0-9_-]+", branch)
            or Path(metadata.get("root", "")).resolve() != root
            or not isinstance(metadata.get("finishSnapshot"), dict)):
        raise RuntimeError("qualification workspace discard identity mismatch")
    if not root.is_dir() or _head(root) != metadata.get("finishHead"):
        raise RuntimeError("qualification workspace changed after finish; refusing discard")
    if _git(root, "branch", "--show-current").stdout.strip() != branch:
        raise RuntimeError("qualification worktree branch changed; refusing discard")
    if _snapshot(root) != metadata["finishSnapshot"]:
        raise RuntimeError("qualification workspace changed after finish; refusing discard")

    common_raw = _git(root, "rev-parse", "--git-common-dir").stdout.strip()
    common = Path(common_raw)
    if not common.is_absolute():
        common = (root / common).resolve()
    parent_repo = common.parent.resolve()
    if not (parent_repo / ".git").exists() or parent_repo == root:
        raise RuntimeError("could not verify qualification worktree owner")
    registrations = _git(parent_repo, "worktree", "list", "--porcelain").stdout.split("\n\n")
    registered = any(
        f"worktree {root}" in block.splitlines()
        and f"branch refs/heads/{branch}" in block.splitlines()
        for block in registrations
    )
    if not registered:
        raise RuntimeError("qualification worktree registration does not match owned metadata")

    # A runner may itself be a worktree; dependency links belong to that runner,
    # rather than necessarily to the repository's main checkout.
    state_dir = metadata_path.parent.parent
    owner = state_dir.parent.parent
    if state_dir.parent.name != "tmp" or not owner.is_dir():
        raise RuntimeError("could not verify qualification dependency owner")
    owner_common = Path(_git(owner, "rev-parse", "--git-common-dir").stdout.strip())
    if not owner_common.is_absolute():
        owner_common = (owner / owner_common).resolve()
    if owner_common.resolve() != common.resolve():
        raise RuntimeError("qualification dependency owner belongs to another repository")
    ignored = _ignored_inventory(root)
    for rel in sorted(ignored):
        if rel in {"node_modules", "backend/node_modules", "e2e/node_modules"}:
            link = root / rel
            if (not link.is_symlink()
                    or not (owner / rel).exists()
                    or link.resolve() != (owner / rel).resolve()):
                raise RuntimeError("workspace backend/node_modules is not the approved symlink")
            continue
        parts = Path(rel).parts
        if re.fullmatch(r"node_modules/\.vite/vitest/[0-9a-f]{40}/results\.json", rel):
            cached = root / rel
            if cached.is_file() and not any((root / Path(*parts[:i])).is_symlink()
                                            for i in range(1, len(parts) + 1)):
                continue
        if "__pycache__" in parts:
            cached = root / rel
            if (cached.is_file() and not cached.is_symlink() and cached.suffix == ".pyc"):
                continue
            if cached.is_dir() and not cached.is_symlink() and cached.name == "__pycache__":
                files = list(cached.rglob("*"))
                if all(path.is_file() and not path.is_symlink() and path.suffix == ".pyc"
                       for path in files):
                    continue
        if not rel.startswith("tmp/") or _sensitive_path(rel):
            raise RuntimeError(f"unexpected ignored private path prevents workspace discard: {rel}")

    _git(parent_repo, "worktree", "remove", "--force", str(root))
    _git(parent_repo, "branch", "-D", branch)
    if _git(parent_repo, "show-ref", "--verify", f"refs/heads/{branch}", check=False).returncode == 0:
        raise RuntimeError("qualification workspace branch remains after discard")
    metadata_path.unlink()
