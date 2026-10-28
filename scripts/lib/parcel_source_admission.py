"""Bridge a reviewed discovery receipt and adapter qualification into app admission.

All qualification inputs are copied unchanged into ignored runner state. The existing
admission program remains the writer of app data; this module only prepares its
single-city inputs, runs its dry-run/apply checks, and verifies the resulting release.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parcel_discovery_outcomes
from parcel_qualification_policy import REQUIRED_CHECKS, initial_qualification_review
from parcel_city_storage import export_settings

REQUIRED = (
    "candidate.json",
    "evidence/qualification.json",
    "evidence/metric-report.json",
    "evidence/independent-metric-report.json",
    "evidence/full-safe.geojson",
)
GATES = REQUIRED_CHECKS
OPTIONAL = ("evidence/initial-review.json", "evidence/alignment-report.json", "evidence/independent-alignment-report.json",
            "evidence/alignment-evidence.json", "evidence/alignment-metadata.json", "evidence/alignment-native.json")
ADMISSION_FILES = (
    "frontend/data/source-catalog.json", "frontend/data/city-configs.js", "frontend/data/city-index.js", "world-parcels/registry.json",
    "world-parcels/report/city-demographics.json", "frontend/data/parcel-coverage-report.json",
    "frontend/data/world-coverage.json", "frontend/data/boot-coverage.js", "frontend/i18n/en.json", "frontend/i18n/es.json",
    "frontend/i18n/hr.json", "frontend/i18n/sr.json",
)
RELEASE_TESTS = (
    "scripts/tests/admit-qualified-cities.test.mjs",
    "backend/test/qualified-city-release.test.js",
    "backend/test/parcel-catalog-startup.test.js",
    "backend/test/parcel-coverage-report.test.js",
    "backend/test/world-coverage-build.test.js",
    "backend/test/world-coverage-geography.test.js",
    "backend/test/frontend-world-coverage.test.js",
)
RELEASE_TEST_EXCLUDES = ("**/tmp/**", "**/node_modules/**")


def _json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp-{__import__('os').getpid()}")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _url_identity(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            return None
        default_port = 443 if scheme == "https" else 80
        netloc = parsed.hostname.lower() + (f":{parsed.port}" if parsed.port and parsed.port != default_port else "")
        return urlunsplit((scheme, netloc, parsed.path or "/", parsed.query, ""))
    except ValueError:
        return None


def _point_matches(candidate_point: Any, queue_point: Any) -> bool:
    if not (isinstance(candidate_point, list) and len(candidate_point) == 2
            and isinstance(queue_point, list) and len(queue_point) == 2):
        return False
    try:
        lon, lat = map(float, candidate_point)
        queue_lat, queue_lon = map(float, queue_point)
    except (TypeError, ValueError):
        return False
    return (all(math.isfinite(v) for v in (lon, lat, queue_lat, queue_lon))
            and math.isclose(lon, queue_lon, rel_tol=0, abs_tol=1e-12)
            and math.isclose(lat, queue_lat, rel_tol=0, abs_tol=1e-12))


def _run(command: list[str], *, cwd: Path, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, timeout=timeout, check=False)


def _existing_bindings(root: Path) -> list[dict[str, Any]]:
    script = """import fs from 'node:fs';
import { parseCityConfigs } from './scripts/build-world-coverage.mjs';
const rows = parseCityConfigs(fs.readFileSync('frontend/data/city-configs.js', 'utf8'));
process.stdout.write(JSON.stringify(rows.map(({id,wupCityCode,sourceId,countryCode})=>({id,wupCityCode,sourceId,countryCode}))));
"""
    result = _run(["node", "--input-type=module", "-e", script], cwd=root, timeout=30)
    if result.returncode:
        raise RuntimeError(f"could not inspect current city config: {result.stderr[-1000:]}")
    rows = json.loads(result.stdout)
    return rows


def _verify_published_evidence(root: Path, artifact_root: Path, source_id: str) -> str | None:
    script = """import fs from 'node:fs';
import { verifyAdmissionEvidence } from './scripts/admit-qualified-cities.mjs';
const base=process.argv[1], id=process.argv[2];
const catalog=JSON.parse(fs.readFileSync('frontend/data/source-catalog.json','utf8'));
const source=catalog.sources.find(row=>row.id===id);
const evidence={candidate:`${base}/candidate.json`,qualification:`${base}/evidence/qualification.json`,
 metric:`${base}/evidence/metric-report.json`,independent:`${base}/evidence/independent-metric-report.json`,
 cache:`${base}/evidence/full-safe.geojson`,alignment:`${base}/evidence/alignment-report.json`,
 independentAlignment:`${base}/evidence/independent-alignment-report.json`,
 alignmentEvidence:`${base}/evidence/alignment-evidence.json`,alignmentMetadata:`${base}/evidence/alignment-metadata.json`,
 alignmentNative:`${base}/evidence/alignment-native.json`};
const result=verifyAdmissionEvidence(evidence,source);
if(typeof result==='string'){process.stdout.write(JSON.stringify({ok:false,reason:result}));process.exitCode=1;}
else process.stdout.write(JSON.stringify({ok:true,sourceId:result.candidate.descriptor.id,candidateSha256:result.qualification.candidateSha256}));
"""
    result = _run(["node", "--input-type=module", "-e", script, str(artifact_root), source_id], cwd=root, timeout=30)
    if result.returncode:
        try:
            detail = json.loads(result.stdout or "{}")
            return str(detail.get("reason") or result.stderr[-1000:])
        except (ValueError, TypeError):
            return result.stderr[-1000:] or "existing admission evidence verifier failed"
    try:
        answer = json.loads(result.stdout)
    except (ValueError, TypeError):
        return "existing admission evidence verifier returned invalid output"
    if answer.get("ok") is not True or answer.get("sourceId") != source_id:
        return str(answer.get("reason") or "existing admission evidence is not verified")
    return None


def _existing_integration(root: Path, code: str, name: str, source_id: str,
                          artifact_root: Path, qualification: dict[str, Any],
                          bindings: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not bindings:
        return None
    binding = next((row for row in bindings if row.get("sourceId") == source_id), None)
    if binding is None:
        first_source = bindings[0].get("sourceId")
        return _block(f"{name} is already configured with a different parcel source ({first_source}); source switching needs separate review")
    app_city_id = binding.get("id")
    catalog_doc = _json(root / "frontend/data/source-catalog.json")
    catalog_source = next((row for row in catalog_doc.get("sources", []) if row.get("id") == source_id), None)
    if not catalog_source or app_city_id not in catalog_source.get("cityIds", []):
        return _block(f"{name} config and source catalog disagree; admission needs manual review")
    verify_error = _verify_published_evidence(root, artifact_root, source_id)
    if verify_error:
        return _block(f"existing source binding does not pass independent admission evidence verification: {verify_error}")
    registry = _json(root / "world-parcels/registry.json")
    registry_city = next((row for row in registry.get("cities", [])
                          if str(row.get("wupCityCode")) == code and row.get("appCityId") == app_city_id), None)
    registry_source = next((row for row in registry.get("sources", []) if row.get("sourceId") == source_id), None)
    if (not registry_city or source_id not in registry_city.get("sourceIds", []) or not registry_source
            or registry_source.get("liveIntegration", {}).get("status") != "enabled"
            or app_city_id not in registry_source.get("liveIntegration", {}).get("cityIds", [])):
        return _block(f"{name} registry binding is missing or disagrees with the app config")
    parcel_report = _json(root / "frontend/data/parcel-coverage-report.json")
    parcel_row = next((row for row in parcel_report.get("cities", []) if str(row.get("wupCityCode")) == code), None)
    world_report = _json(root / "frontend/data/world-coverage.json")
    world_city = next((row for row in world_report.get("liveCities", []) if row.get("id") == app_city_id), None)
    if (not parcel_row or app_city_id not in parcel_row.get("appCityIds", [])
            or source_id not in parcel_row.get("sourceIds", [])
            or not world_city or world_city.get("sourceId") != source_id):
        return _block(f"{name} is configured but the coverage reports do not verify this source binding")
    manifest_rel = None
    for manifest_path in sorted((root / "world-parcels/research").glob("qualification-admission-*.json"), reverse=True):
        manifest = _json(manifest_path)
        row = next((item for item in manifest.get("cities", []) if str(item.get("cityCode")) == code), None)
        if row and row.get("sourceId") == source_id and row.get("appCityId") == app_city_id:
            manifest_rel = manifest_path.relative_to(root).as_posix()
            break
    return {"status": "integrated", "summary": f"{name} already has this source integrated; qualification, catalog, registry and reports were reverified.",
            "manifestFile": manifest_rel, "changedFiles": []}


def _run_checked(command: list[str], root: Path, label: str, timeout: int = 180) -> str:
    result = _run(command, cwd=root, timeout=timeout)
    output = (result.stdout or "") + (result.stderr or "")
    if result.returncode:
        raise RuntimeError(f"{label} failed ({result.returncode}): {output[-1600:]}")
    return output


def _release_test_command(root: Path, action: str) -> list[str]:
    command = ["node", str(root / "backend/node_modules/vitest/vitest.mjs"), action]
    if action == "list":
        command.extend(["--filesOnly", "--json"])
    else:
        command.extend(["--pool=threads", "--maxWorkers=4"])
    for pattern in RELEASE_TEST_EXCLUDES:
        command.extend(["--exclude", pattern])
    return [*command, *RELEASE_TESTS]


def _verify_release_test_scope(root: Path) -> None:
    result = _run(_release_test_command(root, "list"), cwd=root, timeout=120)
    if result.returncode:
        raise RuntimeError(f"headless release test scope listing failed: {(result.stderr or result.stdout)[-1200:]}")
    try:
        rows = json.loads(result.stdout)
        actual = {Path(row["file"]).resolve() for row in rows}
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise RuntimeError("headless release test scope listing was malformed") from error
    expected = {(root / relative).resolve() for relative in RELEASE_TESTS}
    if actual != expected or len(rows) != len(expected):
        unexpected = sorted(str(path) for path in actual - expected)
        missing = sorted(str(path) for path in expected - actual)
        raise RuntimeError(f"headless release test scope differs from the exact seven files; "
                           f"unexpected={unexpected}, missing={missing}")


def _block(summary: str, manifest: str | None = None, changed: list[str] | None = None) -> dict[str, Any]:
    return {"status": "integration-blocked", "summary": summary,
            "manifestFile": manifest, "changedFiles": changed or []}


def _fail(summary: str, manifest: str | None = None, changed: list[str] | None = None) -> dict[str, Any]:
    return {"status": "failed", "summary": summary,
            "manifestFile": manifest, "changedFiles": changed or []}


def _release_outputs(root: Path, release: str, code: str) -> list[str]:
    base = f"world-parcels/research/qualification-{release}/{code}"
    paths = [f"{base}/{name}" for name in (
        "candidate.json", "qualification.json", "metric-report.json", "independent-metric-audit.json",
        "alignment-report.json", "independent-alignment-report.json", "alignment-evidence.json",
        "alignment-metadata.json", "alignment-native.json")]
    paths.append(f"world-parcels/research/qualification-admission-{release}.json")
    return [rel for rel in paths if (root / rel).is_file()]


def _changed_files(root: Path, before: dict[str, str | None], release: str, code: str) -> list[str]:
    changed = [rel for rel in ADMISSION_FILES if (root / rel).is_file()
               and _sha(root / rel) != before.get(rel)]
    changed.extend(_release_outputs(root, release, code))
    return sorted(set(changed))


def admit_candidate(runner: Any, city: dict[str, Any], receipt: dict[str, Any], stageResult: dict[str, Any]) -> dict[str, Any]:
    """Admit one reviewed candidate through the existing evidence-verifying writer.

    `runner.root` and `runner.state_dir` are paths supplied by the discovery runner;
    `stageResult.artifactRoot` is the adapter-build attempt containing the candidate
    and its qualification evidence. Failures retain copied evidence and do not roll
    back app files that an earlier successful stage already wrote.
    """
    root = Path(runner.root).resolve()
    try:
        if getattr(runner, "stop_requested", False):
            return _block("runner stop was requested before admission")
        if not isinstance(city, dict) or not isinstance(receipt, dict) or not isinstance(stageResult, dict):
            return _block("admission inputs must be objects")
        code = str(city.get("cityCode", ""))
        if not code.isdigit() or receipt.get("taskId") != f"city:{code}":
            return _block("review receipt does not bind to this WUP city")
        errors = parcel_discovery_outcomes.validate_receipt(root, receipt)
        if errors or receipt.get("decision") != "candidate":
            return _block("discovery receipt is not an admissible candidate: " + "; ".join(errors or [str(receipt.get("decision"))]))
        source = receipt.get("source") or {}
        state_root = Path(runner.state_dir)
        state_root = (state_root if state_root.is_absolute() else root / state_root).resolve()
        artifact_root = Path(str(stageResult.get("artifactRoot", ""))).resolve()
        if stageResult.get("status") != "adapter-ready" or not artifact_root.is_dir():
            return _block("adapter stage is not ready or its artifact directory is missing")
        try:
            artifact_root.relative_to((state_root / "qualification" / "cities" / code).resolve())
        except ValueError:
            return _block("adapter artifact directory is outside this runner's ignored qualification state")
        original = {name: artifact_root / name for name in REQUIRED}
        original.update({name: artifact_root / name for name in OPTIONAL if (artifact_root / name).is_file()})
        missing = [name for name, path in original.items() if not path.is_file()]
        if missing:
            return _block("adapter qualification artifacts are incomplete: " + ", ".join(missing))
        candidate_bytes = original["candidate.json"].read_bytes()
        candidate = json.loads(candidate_bytes)
        descriptor, candidate_city = candidate.get("descriptor"), candidate.get("city")
        name = str(city.get("name") or city.get("cityName") or "").strip()
        country_code = str(city.get("iso2") or city.get("countryCode") or "").upper()
        if not name or not country_code:
            return _block("queue city lacks its exact name or ISO country code")
        if (str(candidate_city.get("code", candidate_city.get("cityCode", ""))) != code
                or str(candidate_city.get("name", "")).strip() != name
                or not _point_matches(candidate_city.get("point"), city.get("point"))):
            return _block("qualification candidate city identity differs from the frozen WUP queue")
        if receipt.get("cityCode") is not None and str(receipt["cityCode"]) != code:
            return _block("review receipt city code differs from the frozen queue")
        if receipt.get("cityName") is not None and receipt["cityName"] != name:
            return _block("review receipt city name differs from the frozen queue")
        if receipt.get("point") is not None and not _point_matches(candidate_city.get("point"), receipt["point"]):
            return _block("qualification point differs from the reviewed city point")
        if (not isinstance(descriptor, dict) or descriptor.get("id") != source.get("sourceId")
                or _url_identity(descriptor.get("endpoint")) is None
                or _url_identity(descriptor.get("endpoint")) != _url_identity(source.get("endpoint"))):
            return _block("candidate source ID or public HTTP(S) endpoint differs from the reviewed source")
        q = _json(original["evidence/qualification.json"])
        if (q.get("status") != "technical-qualified" or str(q.get("cityCode")) != code
                or str(q.get("cityName")) != name or q.get("candidateSha256") != hashlib.sha256(candidate_bytes).hexdigest()
                or not all(q.get("checks", {}).get(gate, {}).get("passed") is True for gate in GATES)):
            return _block("qualification record does not bind this exact candidate/city or pass parcel-availability core checks")

        country_code = str(descriptor.get("countryCode") or candidate_city.get("countryCode") or country_code).upper()
        if country_code != str(city.get("iso2") or city.get("countryCode") or "").upper():
            return _block("candidate country differs from the frozen WUP city")
        # Repeat the discovery/evidence checks just before preparing the existing admission tool's inputs.
        for ref in receipt.get("evidenceFiles", []):
            try:
                parcel_discovery_outcomes.evidence_file(root, ref)
            except (OSError, ValueError, TypeError) as error:
                return _block(f"reviewed discovery evidence is no longer intact: {error}")

        bindings = [row for row in _existing_bindings(root) if str(row.get("wupCityCode")) == code]
        integration = _existing_integration(root, code, name, descriptor["id"], artifact_root, q, bindings)
        if integration is not None:
            return integration

        # Keep every preparation and exporter artifact under ignored runner state.
        base = state_root / "admission-bridge" / code
        run_id = hashlib.sha256(candidate_bytes + str(datetime.now(timezone.utc).timestamp()).encode()).hexdigest()[:12]
        work = base / f"attempt-{run_id}"
        state_dir = work / "qualification-state"
        city_dir = state_dir / "cities" / code / "attempt-01"
        evidence_dir = city_dir / "evidence"
        evidence_dir.mkdir(parents=True, exist_ok=False)
        for name_rel, source_path in original.items():
            dest = city_dir / name_rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_path, dest)
            if _sha(dest) != _sha(source_path):
                return _fail(f"copied qualification artifact changed: {name_rel}")

        relative_files = [
            "attempt-01/candidate.json",
            *[f"attempt-01/{name}" for name in original if name.startswith("evidence/")],
        ]
        queue_path = state_dir / "frozen-queue.json"
        queue_record = {
            "cityCode": code, "rank": int(city.get("rank", city.get("queueRank", 0))),
            "cityName": name, "countryCode": country_code,
            "point": city["point"],
            "sourceAnnotations": {"sourceIds": [descriptor["id"]]},
        }
        _write_json(queue_path, {"schemaVersion": 1, "pointOrder": "latitude-longitude", "records": [queue_record]})
        state = {"schemaVersion": 1, "queuePath": str(queue_path), "cities": {code: {
            "status": "technical-qualified", "finishedAt": datetime.now(timezone.utc).isoformat(),
            "summary": "Working parcel source initially qualified; detailed quality findings are retained for follow-up.",
            "evidenceFiles": relative_files,
        }}}
        _write_json(state_dir / "state.json", state)
        outcomes_path = work / "qualification-outcomes.json"
        basis = f"Adapter-ready qualification for WUP city {code}; discovery receipt {receipt['taskId']} and initial parcel-availability evidence verified."
        _run_checked(["python3", str(root / "scripts/export-qualification-outcomes.py"), "--state", str(state_dir),
                      "--output", str(outcomes_path), "--basis", basis], root, "qualification-outcomes export")

        currency = candidate_city.get("currency")
        country_config_path = None
        if currency is not None:
            if not isinstance(currency, dict) or not currency.get("locale") or not currency.get("code"):
                return _block("candidate currency metadata is incomplete")
            country_config_path = work / "country-config.json"
            _write_json(country_config_path, {"countryCode": country_code, "currency": currency})

        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        release = f"{stamp}-bridge-{code}-{run_id}"
        manifest_rel = f"world-parcels/research/qualification-admission-{release}.json"
        admission = ["node", str(root / "scripts/admit-qualified-cities.mjs"), "--state", str(state_dir),
                    "--release", release, "--codes", code, "--outcomes", str(outcomes_path)]
        if country_config_path:
            admission.extend(["--country-config", str(country_config_path)])
        before = {rel: _sha(root / rel) if (root / rel).is_file() else None for rel in ADMISSION_FILES}
        preview = _run(admission, cwd=root, timeout=180)
        preview_text = (preview.stdout or "") + (preview.stderr or "")
        if preview.returncode:
            return _block(f"admission preflight failed before app writes: {preview_text[-1200:]}")
        match = re.search(r"plan: (\d+) cities to admit, (\d+) to switch source, (\d+) refused", preview_text)
        if not match or tuple(map(int, match.groups())) != (1, 0, 0):
            return _block(f"admission preflight did not approve exactly this city: {preview_text[-1200:]}")

        if getattr(runner, "stop_requested", False):
            return _block("runner stop was requested before applying admission")
        if any((root / rel).is_file() and _sha(root / rel) != before.get(rel) for rel in ADMISSION_FILES):
            return _block("app/catalog/report inputs changed during admission preflight")
        try:
            applied = _run([*admission, "--apply"], cwd=root, timeout=180)
        except subprocess.TimeoutExpired as error:
            return _fail(f"admission writer timed out after apply began: {error}", manifest_rel,
                         _changed_files(root, before, release, code))
        apply_text = (applied.stdout or "") + (applied.stderr or "")
        if applied.returncode:
            return _fail(f"admission writer failed: {apply_text[-1200:]}", manifest_rel,
                         _changed_files(root, before, release, code))

        manifest_path = root / manifest_rel
        changed = _changed_files(root, before, release, code)
        if not manifest_path.is_file():
            return _fail("admission command returned success but did not create its manifest", manifest_rel, changed)
        manifest = _json(manifest_path)
        manifest_city = next((row for row in manifest.get("cities", []) if str(row.get("cityCode")) == code), None)
        catalog = _json(root / "frontend/data/source-catalog.json")
        source_after = next((row for row in catalog.get("sources", []) if row.get("id") == descriptor["id"]), None)
        if (manifest_city is None or manifest_city.get("sourceId") != descriptor["id"]
                or manifest_city.get("candidate", {}).get("qualificationRecordedSha256") != q.get("candidateSha256")
                or source_after is None or not any(city_id == manifest_city.get("appCityId") for city_id in source_after.get("cityIds", []))):
            return _fail("admission manifest/catalog readback does not bind the qualified candidate", manifest_rel, changed)
        verify_error = _verify_published_evidence(root, artifact_root, descriptor["id"])
        if verify_error:
            return _fail(f"admission catalog contract failed qualification evidence readback: {verify_error}", manifest_rel, changed)
        configured = [row for row in _existing_bindings(root) if str(row.get("wupCityCode")) == code
                      and row.get("id") == manifest_city["appCityId"] and row.get("sourceId") == descriptor["id"]]
        if not configured:
            return _fail("admission did not create the expected city-config source binding", manifest_rel, changed)

        # The proven working configuration is the permanent city record. Reports
        # and release checks consume it while the qualification evidence is live.
        export_settings(root, [code])

        try:
            _run_checked(["node", str(root / "scripts/build-world-coverage.mjs"), "--run"], root,
                         "world coverage report build", timeout=300)
            _run_checked(["node", str(root / "scripts/build-parcel-coverage-report.mjs"), "--run"], root,
                         "parcel coverage report build", timeout=300)
        except Exception as error:
            changed = _changed_files(root, before, release, code)
            return _fail(f"admission was applied, but coverage report build/readiness failed: {error}", manifest_rel, changed)
        try:
            _verify_release_test_scope(root)
            _run_checked(_release_test_command(root, "run"), root,
                         "headless admission release checks", timeout=300)
        except Exception as error:
            changed = _changed_files(root, before, release, code)
            return _fail(f"admission was applied, but headless release checks failed: {error}", manifest_rel, changed)
        parcel_report = _json(root / "frontend/data/parcel-coverage-report.json")
        world_report = _json(root / "frontend/data/world-coverage.json")
        parcel_row = next((row for row in parcel_report.get("cities", []) if str(row.get("wupCityCode")) == code), None)
        world_row = next((row for row in world_report.get("liveCities", [])
                          if row.get("id") == manifest_city["appCityId"]), None)
        if (not parcel_row or manifest_city["appCityId"] not in parcel_row.get("appCityIds", [])
                or descriptor["id"] not in parcel_row.get("sourceIds", [])
                or not world_row or world_row.get("sourceId") != descriptor["id"]):
            changed = _changed_files(root, before, release, code)
            return _fail("admission succeeded but rebuilt coverage reports do not contain this city/source binding", manifest_rel, changed)
        changed = _changed_files(root, before, release, code)
        return {"status": "integrated", "summary": f"{name} is admitted to the working tree; both coverage reports were rebuilt and headless release checks passed. Release/deployment remains separate.",
                "manifestFile": manifest_rel, "changedFiles": sorted(set(changed + [manifest_rel]))}
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.TimeoutExpired) as error:
        message = str(error)
        if "adapter-ready" in message or "missing" in message or "differs" in message or "must" in message:
            return _block(message)
        return _fail(message)

