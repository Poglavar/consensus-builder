"""Verify a city in the real app and feed integration failures back to its worker."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

from parcel_city_knowledge import sync_failed_urls
from parcel_source_admission import ADMISSION_FILES, admit_candidate

MAX_IMPLEMENTATION_TURNS = 3


def verify_source_artifacts(root, city, artifact_root):
    """Run the trusted source verifier before a worker's interactive admission check."""
    import parcel_source_stage as stage
    qualification, _ = stage._support(root)
    city_root = artifact_root.parent
    prefix = artifact_root.name + "/"
    answer = artifact_root / "integration-answer.json"
    answer.write_text(json.dumps({"data": {
        "cityCode": str(city["cityCode"]), "status": "technical-qualified",
        "summary": "Source artifacts submitted for independent integration verification.",
        "evidenceFiles": [prefix + name for name in (
            "candidate.json", "evidence/qualification.json", "evidence/full-safe.geojson")]
    }}) + "\n")
    verifier = qualification.Runner.__new__(qualification.Runner)
    verifier.root = root
    verifier._verify_worker_answer({"answerPath": answer,
        "city": {"cityCode": str(city["cityCode"]), "cityName": city.get("name") or city.get("cityName"), "point": city["point"]},
        "cityDir": city_root, "attemptDir": artifact_root, "phase": "llm"})


def verify_baseline(root, shared_root):
    """Reject a broken shared application before spending a city implementation turn."""
    from parcel_source_stage import ADMISSION_INPUTS
    from parcel_source_admission import _run_checked, _release_test_command, _verify_release_test_scope
    for relative in ADMISSION_INPUTS:
        if not (Path(root) / relative).is_file():
            raise RuntimeError(f"required city admission input is missing: {relative}")
    sync_failed_urls(shared_root, root)
    rebuild_browser_adapters(root)
    for script in ("build-world-coverage.mjs", "build-parcel-coverage-report.mjs"):
        _run_checked(["node", str(Path(root) / "scripts" / script), "--run"], root, script, timeout=300)
    _verify_release_test_scope(root)
    _run_checked(_release_test_command(root, "run"), root, "shared integration baseline", timeout=300)


def rebuild_browser_adapters(root):
    for command in (["node", "backend/scripts/build-browser-parcels.mjs"],
                    ["node", "--input-type=module", "-e", """import catalog from './backend/parcels/source-catalog.json' with {type:'json'};
import {browserParcelFactories as factories} from './backend/parcels/browser-source-runtime.js';
const missing=[...new Set(catalog.sources.map(row=>row.adapter))].filter(adapter=>!factories[adapter]);
if(missing.length){console.error(missing.join(','));process.exit(1)}"""]):
        checked = subprocess.run(command, cwd=root, text=True, capture_output=True, timeout=300)
        if checked.returncode:
            raise RuntimeError(f"browser parcel build/registration failed: {(checked.stderr or checked.stdout)[-4000:]}")


def verify_in_app(root, city, artifact_root, admission):
    candidate = json.loads((artifact_root / "candidate.json").read_text())
    settings = json.loads((root / "world-parcels/cities" / str(city["cityCode"]) / "settings.json").read_text())
    bindings = settings.get("bindings", [])
    if len(bindings) != 1:
        raise RuntimeError("app verification requires one explicit city binding")
    features = json.loads((artifact_root / "evidence/full-safe.geojson").read_text()).get("features", [])
    polygons = [feature for feature in features if feature.get("geometry", {}).get("type") in {"Polygon", "MultiPolygon"}]
    if not polygons:
        raise RuntimeError("app verification has no real parcel polygon probe")
    # Probe the proven polygon, rather than assuming that the city's locator has parcels.
    feature = polygons[0]
    def points(value):
        if isinstance(value, list) and len(value) >= 2 and all(isinstance(v, (float, int)) for v in value[:2]):
            yield value[:2]
        elif isinstance(value, list):
            for child in value:
                yield from points(child)
    coordinates = list(points(feature["geometry"]["coordinates"]))
    bounds = [min(p[0] for p in coordinates), min(p[1] for p in coordinates),
              max(p[0] for p in coordinates), max(p[1] for p in coordinates)]
    ids = [str(feature.get("id") or feature.get("properties", {}).get("parcelId") or "")]
    if not ids[0]:
        raise RuntimeError("app verification parcel probe has no safe exact ID")
    output = artifact_root / "evidence/app-check.json"
    command = ["node", str(root / "scripts/verify-parcel-city-in-app.mjs"), "--root", str(root),
               "--city", bindings[0]["appCityId"], "--source", candidate["descriptor"]["id"],
               "--bounds", ",".join(map(str, bounds)), "--ids", ",".join(ids), "--output", str(output)]
    checked = subprocess.run(command, cwd=root, text=True, capture_output=True, timeout=200)
    report = json.loads(output.read_text()) if output.is_file() else {}
    if checked.returncode or report.get("passed") is not True:
        raise RuntimeError(f"in-app parcel verification failed: {report.get('error') or (checked.stderr or checked.stdout)[-4000:]}")
    return report


def check_integration(root, state_dir, city, receipt, artifact_root, *, shared_root=None):
    """Exercise admission and the app privately; only the coordinator publishes app records."""
    root, artifact_root = Path(root).resolve(), Path(artifact_root).resolve()
    artifact_root.relative_to(root)
    if shared_root and not (root / "tmp/parcel-city-knowledge.json").exists():
        sync_failed_urls(shared_root, root)
    paths = {root / relative for relative in ADMISSION_FILES}
    paths.add(root / "world-parcels/cities" / str(city["cityCode"]) / "settings.json")
    assets = root / "frontend/assets/parcel-adapters"
    paths.update(p for p in assets.rglob("*") if p.is_file())
    before = {path: path.read_bytes() if path.is_file() else None for path in paths}
    research = root / "world-parcels/research"
    research_before = set(research.rglob("*")) if research.exists() else set()
    report = {"passed": False, "cityCode": str(city["cityCode"])}
    try:
        verify_source_artifacts(root, city, artifact_root)
        admission = admit_candidate(SimpleNamespace(root=root, state_dir=Path(state_dir)), city, receipt,
                                    {"status": "adapter-ready", "artifactRoot": str(artifact_root)})
        report["admission"] = admission
        if admission.get("status") != "integrated":
            raise RuntimeError(admission.get("summary") or "city admission did not complete")
        rebuild_browser_adapters(root)
        report["app"] = verify_in_app(root, city, artifact_root, admission)
        report["passed"] = True
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        # These paths are generated by our admission tool. Adapter implementations
        # and source evidence remain intact for repair and guarded serial import.
        for path in set(before) | {p for p in assets.rglob("*") if p.is_file()}:
            original = before.get(path)
            if original is None:
                path.unlink(missing_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(original)
        for path in sorted(set(research.rglob("*")) - research_before, key=lambda p: len(p.parts), reverse=True):
            if path.is_file():
                path.unlink()
            elif path.is_dir():
                path.rmdir()
        output = artifact_root / "evidence/integration-review.json"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return report


def run_city_task(child, workspace, *, feedback=None, turns_used=0):
    """Own source verification, implementation, integration and app testing to completion."""
    import parcel_source_stage as stage
    city, receipt, packet = (workspace[key] for key in ("city", "receipt", "packet"))
    hashes = stage._input_hashes(child.root, city, receipt, packet)
    frozen_paths = {hashes.get("packetPath"), hashes.get("reviewPath"), *hashes.get("sampleFiles", {}),
                    *hashes.get("receiptEvidenceFiles", {}), *hashes.get("coverageProbeEvidenceFiles", {}),
                    *hashes.get("integrationInputs", {})}
    frozen = {rel: (child.root / rel).read_bytes() for rel in frozen_paths if rel}
    result = {"status": "integration-blocked", "summary": "city implementation turn budget exhausted"}
    for turn in range(turns_used, MAX_IMPLEMENTATION_TURNS):
        if child.stop_requested:
            return {**result, "status": "interrupted"}
        child.integration_feedback = feedback
        result = stage.run_candidate(child, city, receipt, packet)
        result["implementationTurns"] = turn + 1
        if result.get("artifactRoot"):
            child.qualification_attempt_name = Path(result["artifactRoot"]).name
        if result.get("status") in {"blocked-source", "rejected-source", "interrupted"}:
            return result
        if result.get("status") == "adapter-ready":
            review = check_integration(child.root, child.state_dir, city, receipt, Path(result["artifactRoot"]),
                                       shared_root=getattr(child.args, "shared_root", None))
            result["integrationReview"] = review
            result["artifactHashes"] = stage._artifact_hashes(child.root, Path(result["artifactRoot"]))
            if review["passed"]:
                return result
            feedback = review["error"]
        else:
            feedback = result.get("summary") or "source implementation did not pass verification"
        # Repair turns may change implementation, never their frozen source evidence.
        for rel, data in frozen.items():
            (child.root / rel).parent.mkdir(parents=True, exist_ok=True)
            (child.root / rel).write_bytes(data)
        child.log("city implementation needs repair", cityCode=str(city["cityCode"]), turn=turn + 1, error=feedback)
    return {**result, "status": "integration-blocked", "summary": str(feedback), "implementationTurns": MAX_IMPLEMENTATION_TURNS}
