"""Small, deterministic checks for a research run that requires a new parcel source."""
from __future__ import annotations

from urllib.parse import urlsplit
from typing import Any


def normalized_endpoint(value: Any) -> tuple[str, str, str, int | None] | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = urlsplit(value.strip())
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            return None
        scheme = parsed.scheme.lower()
        host = parsed.hostname.lower().rstrip(".")
        port = parsed.port
        if (scheme, port) in {("http", 80), ("https", 443)}:
            port = None
        pathname = parsed.path.rstrip("/")
        return scheme, host, pathname, port
    except ValueError:
        return None


def endpoint_identity(value: Any) -> tuple[str, str, int | None] | None:
    normalized = normalized_endpoint(value)
    if normalized is None:
        return None
    _scheme, host, pathname, port = normalized
    return host, pathname, port


def _sources(document: Any) -> list[dict[str, Any]]:
    values = document.get("sources", []) if isinstance(document, dict) else []
    if not isinstance(values, list):
        return []
    return [item for item in values if isinstance(item, dict)]


def known_source_rows(document: Any) -> list[dict[str, Any]]:
    return _sources(document)


def novelty_error(candidate: Any, snapshot: Any, live_catalog: Any) -> str | None:
    """Return why a candidate is known; blocked/rejected receipts should not call this."""
    if not isinstance(candidate, dict):
        return "candidate receipt has no source object"
    candidate_id = candidate.get("sourceId") or candidate.get("id")
    endpoint = endpoint_identity(candidate.get("endpoint"))
    known = _sources(snapshot) + _sources(live_catalog)
    for source in known:
        source_id = source.get("id") or source.get("sourceId")
        if candidate_id and source_id and str(candidate_id) == str(source_id):
            return f"candidate source ID {candidate_id} is already known"
        source_endpoint = endpoint_identity(source.get("endpoint"))
        if endpoint is not None and source_endpoint == endpoint:
            return f"candidate endpoint for {source_id or 'a known source'} is already known"

    if endpoint is not None and isinstance(snapshot, dict):
        known_hosts = snapshot.get("knownProviderHosts", [])
        if isinstance(known_hosts, list):
            candidate_host = endpoint[0]
            for item in known_hosts:
                raw_host = item.get("host") if isinstance(item, dict) else item
                if not isinstance(raw_host, str):
                    continue
                parsed = urlsplit(raw_host if "://" in raw_host else f"https://{raw_host}")
                known_host = parsed.hostname.lower().rstrip(".") if parsed.hostname else ""
                if known_host and (candidate_host == known_host or candidate_host.endswith("." + known_host)):
                    return f"candidate endpoint uses known provider host {candidate_host}"
    return None
