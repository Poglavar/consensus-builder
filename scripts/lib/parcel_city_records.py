"""Persistent per-city research records and conservative URL extraction."""
from __future__ import annotations

import fcntl
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit, parse_qsl


_URL_KEYS = {"url", "endpoint", "href", "request"}
_SECRET_QUERY_KEYS = re.compile(
    r"(?:^|[-_])(token|access_token|api[_-]?key|key|secret|password|passwd|authorization|signature|sig)(?:$|[-_])",
    re.I,
)
_FAIL_STATUS = re.compile(r"(?:fail|error|blocked|held|reject|denied|timeout|unavailable)", re.I)
_SUCCESS_STATUS = re.compile(r"(?:success|complete|verified|accepted|ok|200|201|204)", re.I)


def _canonical_url(value: Any) -> str | None:
    if not isinstance(value, str) or not value or value != value.strip() or any(ord(c) < 32 for c in value):
        return None
    try:
        parts = urlsplit(value)
        scheme = parts.scheme.lower()
        if scheme not in {"http", "https"} or not parts.hostname or parts.username is not None or parts.password is not None:
            return None
        if any(_SECRET_QUERY_KEYS.search(key) for key, _ in parse_qsl(parts.query, keep_blank_values=True)):
            return None
        host = parts.hostname.lower()
        if ":" in host:
            host = f"[{host}]"
        port = parts.port
        if port and port != (443 if scheme == "https" else 80):
            host = f"{host}:{port}"
        # Preserve path and meaningful query bytes; only normalize origin and discard fragments.
        return urlunsplit((scheme, host, parts.path or "/", parts.query, ""))
    except (ValueError, UnicodeError):
        return None


def _safe_reason(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    # Error messages sometimes echo a full request URL, including credentials/tokens.
    if re.search(r"https?://|(?:token|api[_-]?key|secret|password)=", value, re.I):
        return "request failed"
    if re.search(r"/(?:Users|home)/[^/\s]+/|/root/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", value):
        return "attempt failed in the temporary workspace"
    return value.strip()[:500]


def _city_path(root: str | os.PathLike[str], code: str | int) -> Path:
    text = str(code)
    if not text.isdigit() or int(text) <= 0:
        raise ValueError("city code must be a positive numeric WUP code")
    return Path(root) / "world-parcels" / "cities" / text / "failed-urls.json"


def record_failed_urls(root: str | os.PathLike[str], code: str | int,
                       urls: Iterable[str | dict[str, Any]]) -> list[dict[str, str]]:
    """Merge explicitly failed URL records under a per-city advisory lock."""
    path = _city_path(root, code)
    path.parent.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, str]] = []
    for item in urls:
        raw = item.get("url") if isinstance(item, dict) else item
        url = _canonical_url(raw)
        if not url:
            continue
        row = {"url": url}
        reason = _safe_reason(item.get("reason")) if isinstance(item, dict) else None
        if reason:
            row["reason"] = reason
        rows.append(row)

    lock_path = Path(root) / "tmp" / "parcel-city-locks" / f"{code}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                existing = []
            if not isinstance(existing, list):
                raise ValueError(f"invalid failed URL record at {path}")
            merged: dict[str, dict[str, str]] = {}
            for row in [*existing, *rows]:
                if not isinstance(row, dict):
                    continue
                url = _canonical_url(row.get("url"))
                if not url:
                    continue
                clean = {"url": url}
                reason = _safe_reason(row.get("reason"))
                if reason:
                    clean["reason"] = reason
                merged.setdefault(url, clean)
                if "reason" not in merged[url] and "reason" in clean:
                    merged[url]["reason"] = clean["reason"]
            result = list(merged.values())
            fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(result, stream, ensure_ascii=False, indent=2)
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(tmp_name, path)
            finally:
                if os.path.exists(tmp_name):
                    os.unlink(tmp_name)
            return result
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _explicit_urls(value: Any, *, successful: bool = False) -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        # Ignore geometry and prose entirely; only these named request fields qualify.
        state = value.get("status", value.get("httpStatus", value.get("statusCode")))
        is_success = successful or _is_success(value)
        if not is_success:
            for key in _URL_KEYS:
                if key in value:
                    vals = value[key] if isinstance(value[key], list) else [value[key]]
                    found.extend(url for item in vals if (url := _canonical_url(item)))
        for key, child in value.items():
            if key in {"geometry", "coordinates", "point", "polygon", "polygons"}:
                continue
            # A document-level success label does not describe each nested request.
            found.extend(_explicit_urls(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(_explicit_urls(child, successful=successful))
    return found


def _is_success(row: dict[str, Any]) -> bool:
    status = row.get("status", row.get("httpStatus", row.get("statusCode")))
    if isinstance(status, (int, float)):
        return 200 <= status < 300
    return isinstance(status, str) and bool(_SUCCESS_STATUS.search(status)) and not bool(_FAIL_STATUS.search(status))


def urls_from_document(doc: Any) -> list[str]:
    """Collect safe URLs from explicit URL fields, excluding identifiable successes."""
    return list(dict.fromkeys(_explicit_urls(doc)))


def _failure_reason(row: dict[str, Any]) -> str | None:
    explicit_error = next((row.get(key) for key in ("error", "failure", "blockedReason")
                           if row.get(key) not in (None, "", False, [], {})), None)
    status = row.get("status", row.get("decision", row.get("serviceReviewStatus",
                      row.get("httpStatus", row.get("statusCode")))))
    failed_status = (
        isinstance(status, (int, float)) and status >= 400
        or isinstance(status, str) and bool(_FAIL_STATUS.search(status))
    )
    if explicit_error is None and not failed_status:
        return None
    for key in ("error", "failure", "blockedReason", "reason", "message"):
        value = row.get(key)
        if value not in (None, "", False, [], {}):
            reason = _safe_reason(value)
            if reason:
                return reason
    if explicit_error is not None:
        return "request failed"
    return _safe_reason(str(status))


def extract_failed_urls(doc: Any, *, include_candidates: bool = False) -> list[dict[str, str]]:
    """Extract URLs only from records with an explicit failure/blocked/error signal.

    ``include_candidates`` admits URL-bearing attempt records with no outcome field,
    useful for a separately reviewed collection pass; it never treats arbitrary citations
    or successful request records as failed.
    """
    result: dict[str, dict[str, str]] = {}

    def visit(value: Any, inherited_failure: bool = False) -> None:
        if isinstance(value, dict):
            own_failure = bool(_failure_reason(value))
            failure = inherited_failure or own_failure
            success = _is_success(value)
            if success:
                failure = False
            # Whole-packet rejected/held states authorize attempted URLs in children.
            status = value.get("status", value.get("decision", value.get("serviceReviewStatus")))
            packet_failed = isinstance(status, str) and bool(_FAIL_STATUS.search(status))
            if packet_failed and not _is_success(value):
                failure = True
            urls = []
            for key in _URL_KEYS:
                raw = value.get(key)
                vals = raw if isinstance(raw, list) else [raw]
                urls.extend(url for item in vals if (url := _canonical_url(item)))
            explicit_attempt = any(k in value for k in ("stage", "method", "httpStatus", "statusCode", "error", "failure"))
            if urls and (failure or (include_candidates and explicit_attempt and not success and not any(k in value for k in ("error", "failure", "httpStatus", "statusCode", "status")))):
                reason = _failure_reason(value)
                for url in urls:
                    row = result.setdefault(url, {"url": url})
                    if reason and "reason" not in row:
                        row["reason"] = reason
            for key, child in value.items():
                if key in {"geometry", "coordinates", "point", "polygon", "polygons"}:
                    continue
                # Packet outcomes apply to explicit request collections, never to cited
                # evidence, provider descriptors, or other arbitrary nested URLs.
                visit(child, failure and key in {"attempts", "queries", "requests", "requestOutcomes", "queryEvidence"})
        elif isinstance(value, list):
            for child in value:
                visit(child, inherited_failure)

    visit(doc)
    return list(result.values())


__all__ = ["record_failed_urls", "extract_failed_urls", "urls_from_document"]
